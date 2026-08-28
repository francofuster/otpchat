// Tests de la capa de persistencia. Corren contra una base Postgres descartable
// (ver "npm run test:store"), nunca contra la base real: el script fuerza
// DATABASE_URL vacio para que store.js use la rama local PGHOST/PGDATABASE.
import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AppDataSource, loadStore, mutate, state, makeId, nowIso } from '../server/store.js';

let consultas = 0;
const contarConsultas = (fn) => { const desde = consultas; return fn().then((r) => ({ resultado: r, consultas: consultas - desde })); };

before(async () => {
  await loadStore();
  // Cuenta cada query que TypeORM manda a Postgres, para poder medir el costo real.
  AppDataSource.logger = {
    logQuery: () => { consultas++; },
    logQueryError: () => {}, logQuerySlow: () => {}, logSchemaBuild: () => {},
    logMigration: () => {}, log: () => {}
  };
});

beforeEach(async () => {
  const tablas = AppDataSource.entityMetadatas.map((m) => `"${m.tableName}"`).join(', ');
  await AppDataSource.query(`truncate table ${tablas} restart identity cascade`);
  await loadStore();
});

const usuario = (nombre) => ({
  id: makeId('usr'), username: nombre, passwordHash: 'hash', deviceFingerprint: 'fp',
  mustChangePassword: false, createdAt: nowIso(), lastSeenAt: nowIso()
});

const mensaje = (targetId) => ({
  id: makeId('msg'), scope: 'contact', targetId, senderId: 'usr_x',
  encrypted: { iv: 'i', salt: 's', ciphertext: 'c', keyStep: 1 }, createdAt: nowIso(), expiresAt: null
});

test('inserta, actualiza y borra filas persistiendo en Postgres', async () => {
  const u = usuario('ana');
  await mutate((db) => db.users.push(u));
  assert.equal(await AppDataSource.getRepository('User').count(), 1);

  await mutate(() => { u.username = 'ana2'; });
  assert.equal((await AppDataSource.getRepository('User').findOneBy({ id: u.id })).username, 'ana2');

  await mutate((db) => { db.users = db.users.filter((x) => x.id !== u.id); });
  assert.equal(await AppDataSource.getRepository('User').count(), 0);
});

test('una mutacion sin cambios reales no manda ninguna consulta', async () => {
  await mutate((db) => db.users.push(usuario('quieto')));
  const { consultas: n } = await contarConsultas(() => mutate(() => {}));
  assert.equal(n, 0, 'un mutate que no toca nada deberia ser gratis');
});

test('el costo de escribir no crece con el tamano de la coleccion', async () => {
  for (let i = 0; i < 200; i++) await mutate((db) => db.messages.push(mensaje('chat:a')));
  assert.equal(state().messages.length, 200);

  // Con reescritura de coleccion entera esto escalaba con las 200 filas ya guardadas.
  const { consultas: n } = await contarConsultas(() => mutate((db) => db.messages.push(mensaje('chat:a'))));
  assert.ok(n <= 3, `agregar 1 mensaje sobre 200 deberia costar pocas consultas, costo ${n}`);
  assert.equal(await AppDataSource.getRepository('Message').count(), 201);
});

test('preserva columnas jsonb y simple-array', async () => {
  const m = mensaje('chat:tipos');
  const contacto = { id: makeId('con'), userIds: ['usr_1', 'usr_2'], conversationId: 'usr_1:usr_2', timerSeconds: 0, createdAt: nowIso() };
  await mutate((db) => { db.messages.push(m); db.contacts.push(contacto); });

  const guardado = await AppDataSource.getRepository('Message').findOneBy({ id: m.id });
  assert.deepEqual(guardado.encrypted, m.encrypted, 'jsonb debe volver igual');
  const c = await AppDataSource.getRepository('Contact').findOneBy({ id: contacto.id });
  assert.deepEqual(c.userIds, ['usr_1', 'usr_2'], 'simple-array debe volver igual');
});

test('completa el id generado de las entidades que lo autogeneran', async () => {
  const lectura = { userId: 'usr_1', scope: 'contact', targetId: 'chat:a', lastReadAt: nowIso() };
  await mutate((db) => db.messageReadStates.push(lectura));
  assert.ok(Number.isInteger(lectura.id), `el id generado deberia volver al objeto, quedo ${lectura.id}`);

  // Sin id de vuelta, un borrado posterior no encontraria la fila.
  await mutate((db) => { db.messageReadStates = []; });
  assert.equal(await AppDataSource.getRepository('MessageReadState').count(), 0);
});

test('deduplica por clave logica antes de escribir', async () => {
  const base = { groupId: 'grp_1', userId: 'usr_1', role: 'member', joinedAt: nowIso() };
  await mutate((db) => { db.groupMembers.push({ ...base }); db.groupMembers.push({ ...base }); });
  assert.equal(state().groupMembers.length, 1, 'el duplicado se descarta en memoria');
  assert.equal(await AppDataSource.getRepository('GroupMember').count(), 1);
});

test('mutaciones concurrentes no rompen el primary key', async () => {
  const tareas = [];
  let esperados = 0;
  for (let i = 0; i < 120; i++) {
    if (i % 5 === 4) {
      // Imita cleanupExpiredMessages, que reemplaza el array entero.
      tareas.push(mutate((db) => { db.messages = db.messages.filter((m) => !m.expiresAt || new Date(m.expiresAt).getTime() > Date.now()); }));
    } else {
      esperados++;
      const m = mensaje('chat:carrera');
      tareas.push(mutate((db) => db.messages.push(m)));
    }
  }
  const res = await Promise.allSettled(tareas);
  const rechazadas = res.filter((r) => r.status === 'rejected');
  assert.equal(rechazadas.length, 0, `hubo rechazos: ${rechazadas[0]?.reason}`);
  assert.equal(await AppDataSource.getRepository('Message').count(), esperados);
});

test('un fallo no traba la cola ni pierde las escrituras siguientes', async () => {
  await assert.rejects(mutate(() => { throw new Error('boom'); }));
  const u = usuario('despues-del-fallo');
  await mutate((db) => db.users.push(u));
  assert.equal(await AppDataSource.getRepository('User').count(), 1);
});

test('las mutaciones se aplican en orden de llegada', async () => {
  const orden = [];
  await Promise.all([1, 2, 3, 4, 5].map((n) => mutate(() => orden.push(n))));
  assert.deepEqual(orden, [1, 2, 3, 4, 5]);
});

test('loadStore reconstruye el estado desde la base', async () => {
  const u = usuario('persistida');
  await mutate((db) => db.users.push(u));
  state().users = [];
  await loadStore();
  assert.equal(state().users.length, 1);
  assert.equal(state().users[0].username, 'persistida');
});

test.after(async () => { await AppDataSource.destroy(); });
