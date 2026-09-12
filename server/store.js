import { DataSource } from 'typeorm';
import pg from 'pg';
import { nanoid } from 'nanoid';
import { entities } from './entities.js';

const collections = {
  users: 'User',
  sessions: 'Session',
  contacts: 'Contact',
  invitations: 'Invitation',
  groups: 'Group',
  groupMembers: 'GroupMember',
  messages: 'Message',
  messageTimerPreferences: 'MessageTimerPreference',
  messageReadStates: 'MessageReadState',
  securityEvents: 'SecurityEvent',
  pushSubscriptions: 'PushSubscription'
};

const db = Object.fromEntries(Object.keys(collections).map((key) => [key, []]));

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function datasourceOptions() {
  const common = {
    type: 'postgres',
    entities,
    synchronize: boolEnv('TYPEORM_SYNCHRONIZE', true),
    logging: boolEnv('TYPEORM_LOGGING', false)
  };
  if (process.env.DATABASE_URL) {
    return {
      ...common,
      url: process.env.DATABASE_URL,
      ssl: boolEnv('PGSSL', false) ? { rejectUnauthorized: false } : false
    };
  }
  return {
    ...common,
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    username: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'otpchat'
  };
}

export const AppDataSource = new DataSource(datasourceOptions());

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function ensureDatabaseExists() {
  if (process.env.DATABASE_URL || boolEnv('PG_CREATE_DATABASE', true) === false) return;
  const database = process.env.PGDATABASE || 'otpchat';
  const client = new pg.Client({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGMAINTENANCE_DATABASE || 'postgres'
  });
  await client.connect();
  try {
    const found = await client.query('select 1 from pg_database where datname = $1', [database]);
    if (!found.rowCount) await client.query(`create database ${quoteIdentifier(database)}`);
  } finally {
    await client.end();
  }
}

function repo(key) {
  return AppDataSource.getRepository(collections[key]);
}

function uniqueKeyFor(key, item) {
  if (key === 'groupMembers') return `${item.groupId}:${item.userId}`;
  if (key === 'messageTimerPreferences' || key === 'messageReadStates') return `${item.userId}:${item.scope}:${item.targetId}`;
  if (key === 'pushSubscriptions') return item.endpoint;
  return item.id;
}

// Snapshot de lo ultimo que se escribio en la base, por coleccion:
// claveLogica -> { pk, json }. Comparar contra esto permite escribir SOLO las filas
// que cambiaron, en vez de reescribir la coleccion entera en cada mutacion.
const snapshots = Object.fromEntries(Object.keys(collections).map((key) => [key, new Map()]));

function snapshotOf(row) {
  return { pk: row.id, json: JSON.stringify(row) };
}

// Deduplica db[key] en memoria y devuelve que hay que insertar, actualizar y borrar.
function diffCollection(key) {
  const snapshot = snapshots[key];
  const vistos = new Map();
  const inserts = [];
  const updates = [];
  for (const row of db[key]) {
    const logicalKey = uniqueKeyFor(key, row);
    if (!logicalKey || vistos.has(logicalKey)) continue;
    vistos.set(logicalKey, row);
    const json = JSON.stringify(row);
    const previo = snapshot.get(logicalKey);
    if (!previo) inserts.push({ logicalKey, row, json });
    else if (previo.json !== json) updates.push({ logicalKey, row, json });
  }
  db[key] = [...vistos.values()];
  const removals = [];
  for (const [logicalKey, previo] of snapshot) {
    if (!vistos.has(logicalKey) && previo.pk !== undefined && previo.pk !== null) {
      removals.push({ logicalKey, pk: previo.pk });
    }
  }
  return { inserts, updates, removals };
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function loadStore() {
  await ensureDatabaseExists();
  if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  for (const key of Object.keys(collections)) {
    db[key] = await repo(key).find();
    snapshots[key].clear();
    for (const row of db[key]) snapshots[key].set(uniqueKeyFor(key, row), snapshotOf(row));
  }
}

// El snapshot se actualiza recien despues de que cada paso confirma en la base. Si un
// paso falla, lo ya aplicado queda registrado y el resto se reintenta en el proximo
// guardado, sin reinsertar lo que ya entro.
async function saveCollection(key) {
  const { inserts, updates, removals } = diffCollection(key);
  if (!inserts.length && !updates.length && !removals.length) return;
  const repository = repo(key);
  const snapshot = snapshots[key];

  if (removals.length) {
    for (const grupo of chunk(removals, 500)) {
      await repository.delete(grupo.map((item) => item.pk));
      for (const item of grupo) snapshot.delete(item.logicalKey);
    }
  }

  if (inserts.length) {
    for (const grupo of chunk(inserts, 500)) {
      // insert() no consulta si la fila existe, a diferencia de save(). Es seguro
      // porque el snapshot ya garantiza que estas claves no estaban en la base.
      // insert() escribe el id generado sobre el objeto que se le pasa, asi que el
      // snapshot queda con el pk correcto para poder borrar la fila mas adelante.
      await repository.insert(grupo.map((item) => item.row));
      for (const item of grupo) snapshot.set(item.logicalKey, snapshotOf(item.row));
    }
  }

  if (updates.length) {
    for (const grupo of chunk(updates, 500)) {
      await repository.save(grupo.map((item) => item.row));
      for (const item of grupo) snapshot.set(item.logicalKey, snapshotOf(item.row));
    }
  }
}

export async function saveStore() {
  for (const key of Object.keys(collections)) await saveCollection(key);
}

export function state() {
  return db;
}

let pendingWrite = Promise.resolve();

// Las escrituras se serializan en una cola. El guardado calcula un diff contra el
// snapshot y despues hace await por cada paso; si otra mutacion se colara en el medio,
// el snapshot y la base quedarian desincronizados y volveria el duplicate key. Encolar
// garantiza que fn(db) y su guardado corran como una unidad.
export function mutate(fn) {
  const run = pendingWrite.then(async () => {
    const result = fn(db);
    await saveStore();
    return result;
  });
  // La cola sigue viva aunque una mutacion falle: sin esto un error dejaria
  // encadenado un rechazo y toda escritura posterior fallaria tambien.
  pendingWrite = run.then(() => undefined, () => undefined);
  return run;
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${nanoid(14)}`;
}

// `includeFingerprint` solo cuando el destinatario es el propio usuario (o el panel admin).
// El deviceFingerprint es un identificador estable y rastreable del dispositivo: mandarlo
// dentro de `sender`/`other` filtraba la huella de cada uno a sus contactos y grupos.
export function publicUser(user, { includeFingerprint = false } = {}) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
    mustChangePassword: user.mustChangePassword,
    // Lee la columna sembrada en el arranque, no el nombre de usuario.
    isSuperadmin: user.isSuperadmin === true,
    ...(includeFingerprint ? { deviceFingerprint: user.deviceFingerprint } : {})
  };
}

export function conversationIdForUsers(a, b) {
  return [a, b].sort().join(':');
}

export function notExpired(item) {
  return !item.expiresAt || new Date(item.expiresAt).getTime() > Date.now();
}
