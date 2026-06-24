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
  if (key === 'messageTimerPreferences') return `${item.userId}:${item.scope}:${item.targetId}`;
  if (key === 'pushSubscriptions') return item.endpoint;
  return item.id;
}

function normalizeCollection(key) {
  const seen = new Map();
  for (const item of db[key]) {
    const uniqueKey = uniqueKeyFor(key, item);
    if (!uniqueKey) continue;
    seen.set(uniqueKey, item);
  }
  db[key] = [...seen.values()];
}

export async function loadStore() {
  await ensureDatabaseExists();
  if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  for (const key of Object.keys(collections)) db[key] = await repo(key).find();
}

async function saveCollection(key) {
  normalizeCollection(key);
  const repository = repo(key);
  const primaryColumn = key === 'groupMembers' ? 'id' : 'id';
  const rows = db[key];
  const existing = await repository.find();
  const rowIds = new Set(rows.map((item) => item[primaryColumn]).filter(Boolean));
  const stale = existing.filter((item) => item[primaryColumn] && !rowIds.has(item[primaryColumn]));
  if (stale.length) await repository.remove(stale);
  if (rows.length) await repository.save(rows);
}

export async function saveStore() {
  await saveCollection('users');
  await saveCollection('sessions');
  await saveCollection('contacts');
  await saveCollection('invitations');
  await saveCollection('groups');
  await saveCollection('groupMembers');
  await saveCollection('messages');
  await saveCollection('messageTimerPreferences');
  await saveCollection('securityEvents');
  await saveCollection('pushSubscriptions');
}

export function state() {
  return db;
}

export async function mutate(fn) {
  const result = fn(db);
  await saveStore();
  return result;
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${nanoid(14)}`;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
    deviceFingerprint: user.deviceFingerprint,
    mustChangePassword: user.mustChangePassword,
    isSuperadmin: user.username === 'sup3r4drm1n_3533'
  };
}

export function conversationIdForUsers(a, b) {
  return [a, b].sort().join(':');
}

export function notExpired(item) {
  return !item.expiresAt || new Date(item.expiresAt).getTime() > Date.now();
}
