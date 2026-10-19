// Migracion de cuentas v1 a la red v2: contactos y grupos recreados, roles y candado
// copiados, e historial compartido entre participantes cuando alguien perdio sus llaves.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { AppDataSource, loadStore } from '../server/store.js';
import { runMigration, legacyEncrypt } from '../src/core/migration.js';
import { closeAll, makeNode, until } from './helpers/nodes.mjs';

const port = process.env.PORT || 4956;
const base = `http://localhost:${port}`;
const relayUrl = `ws://localhost:${port}/relay`;
let backend;
const nodos = [];

before(async () => {
  backend = await import('../server/index.js');
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const tablas = AppDataSource.entityMetadatas.map((m) => `"${m.tableName}"`).join(', ');
  await AppDataSource.query(`truncate table ${tablas} restart identity cascade`);
  await loadStore();
});

after(async () => {
  closeAll(nodos);
  clearInterval(backend.cleanupTimer);
  backend.wss.close();
  backend.relay.close();
  await new Promise((resolve) => backend.server.close(resolve));
  await AppDataSource.destroy();
});

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const PASS = 'Abcdef1!';
async function registrar(username) {
  const { status, body } = await api('/api/auth/register', { method: 'POST', body: { username, password: PASS, fingerprint: `fp-${username}` } });
  assert.equal(status, 200, JSON.stringify(body));
  return body;
}

async function mandarV1(token, scope, targetId, text, secret) {
  const encrypted = await legacyEncrypt(new TextEncoder().encode(text), secret);
  const { status } = await api('/api/messages', { method: 'POST', token, body: { scope, targetId, encrypted } });
  assert.equal(status, 200);
}

// Escenario v1: Ana y Beto son contactos; Ana fundó "Equipo" con Beto de subadmin y Caro de
// miembro (entró después del primer mensaje), con el candado puesto.
const SECRETO_CONTACTO = 'secreto-contacto-v1';
const SECRETO_GRUPO = 'secreto-grupo-v1';
let v1;

test('arma el escenario en la version anterior', async () => {
  const ana = await registrar('ana');
  const beto = await registrar('beto');
  const caro = await registrar('caro');
  const { body: inv } = await api('/api/invitations/contact', { method: 'POST', token: ana.token });
  const { body: acc } = await api(`/api/invitations/${inv.invitation.code}/accept`, { method: 'POST', token: beto.token });
  const { body: g } = await api('/api/groups', { method: 'POST', token: ana.token, body: { name: 'Equipo' } });
  const unir = async (quien) => {
    const { body: gi } = await api(`/api/groups/${g.group.id}/invite`, { method: 'POST', token: ana.token });
    await api(`/api/invitations/${gi.invitation.code}/accept`, { method: 'POST', token: quien.token });
  };
  await unir(beto);
  await api(`/api/groups/${g.group.id}/members/roles`, { method: 'PATCH', token: ana.token, body: { ids: [beto.user.id], role: 'subadmin' } });
  await mandarV1(ana.token, 'contact', acc.conversationId, 'hola Beto (v1)', SECRETO_CONTACTO);
  await mandarV1(beto.token, 'contact', acc.conversationId, 'hola Ana (v1)', SECRETO_CONTACTO);
  await mandarV1(ana.token, 'group', g.group.id, 'antes de Caro', SECRETO_GRUPO);
  await new Promise((r) => setTimeout(r, 20));
  await unir(caro);
  await mandarV1(ana.token, 'group', g.group.id, 'con Caro', SECRETO_GRUPO);
  await api(`/api/groups/${g.group.id}`, { method: 'PATCH', token: ana.token, body: { membersCanWrite: false } });
  v1 = { conversationId: acc.conversationId, groupId: g.group.id };
});

// Solo Ana conserva el navegador con las llaves viejas.
const llavesDeAna = (scope) => (scope === 'contact' ? SECRETO_CONTACTO : SECRETO_GRUPO);
const migrar = (node, username, getSecret = null) =>
  runMigration({ node, apiBase: base, credentials: { username, password: PASS, fingerprint: `fp-${username}` }, getSecret });

let nAna, nBeto, nCaro;

test('Beto migra primero, sin llaves: recrea el grupo porque es el moderador migrado', async () => {
  nBeto = await makeNode(relayUrl, 'Beto');
  nodos.push(nBeto);
  const { summary } = await migrar(nBeto, 'beto');
  assert.equal(summary.contacts, 0, 'Ana todavía no migró');
  assert.equal(summary.groups, 1);
  assert.equal(summary.history, 0, 'sin llaves no descifra nada');
  const grupo = nBeto.listChats().find((c) => c.kind === 'group');
  assert.equal(grupo.title, 'Equipo');
  assert.equal(grupo.membersCanWrite, false, 'el candado se copia');
});

test('Ana migra con sus llaves: recupera el chat con Beto y le comparte el historial', async () => {
  nAna = await makeNode(relayUrl, 'Ana');
  nodos.push(nAna);
  const { summary } = await migrar(nAna, 'ana', llavesDeAna);
  assert.equal(summary.contacts, 1);
  assert.equal(summary.history, 4, 'descifra los 2 del contacto y los 2 del grupo');
  const contacto = nAna.listChats().find((c) => c.kind === 'contact');
  assert.equal(contacto.title, 'Beto');
  await until(() => nBeto.chats.has(contacto.id));
  // Beto, que había perdido sus llaves, recibe el historial desde Ana.
  await until(async () => (await nBeto.legacyChats()).some((c) => c.v2ChatId === contacto.id && c.messages.length === 2));
  const deBeto = (await nBeto.legacyChats()).find((c) => c.v2ChatId === contacto.id);
  assert.equal(deBeto.sharedBy, 'Ana', 'se marca quién lo compartió');
  assert.equal(deBeto.title, 'Ana', 'el título es el contacto, no el nombre propio');
  assert.deepEqual(deBeto.messages.map((m) => [m.text, m.mine]), [['hola Beto (v1)', false], ['hola Ana (v1)', true]]);
});

test('al volver a sincronizar, el anfitrión suma a Ana al grupo con su rol', async () => {
  await migrar(nBeto, 'beto');
  const grupoId = nBeto.listChats().find((c) => c.kind === 'group').id;
  await until(() => nAna.chats.has(grupoId));
  const ana = nBeto.members(grupoId).find((m) => m.name === 'Ana');
  assert.equal(ana.role, 'subadmin', 'la fundadora v1 queda como subadmin: en v2 el admin es quien lo recreó');
});

test('Caro migra tarde y solo recibe lo que veía en la versión anterior', async () => {
  nCaro = await makeNode(relayUrl, 'Caro');
  nodos.push(nCaro);
  await migrar(nCaro, 'caro');
  await migrar(nBeto, 'beto');
  const grupoId = nBeto.listChats().find((c) => c.kind === 'group').id;
  await until(() => nCaro.chats.has(grupoId));
  assert.equal(nCaro.members(grupoId).find((m) => m.name === 'Caro').role, 'member');
  await migrar(nAna, 'ana', llavesDeAna);
  await until(async () => (await nCaro.legacyChats()).some((c) => c.v2ChatId === grupoId));
  const deCaro = (await nCaro.legacyChats()).find((c) => c.v2ChatId === grupoId);
  assert.deepEqual(deCaro.messages.map((m) => m.text), ['con Caro'], 'no recibe lo anterior a su ingreso');
});

test('migrar de nuevo no duplica chats ni grupos', async () => {
  const antes = nAna.listChats().length;
  const { summary } = await migrar(nAna, 'ana', llavesDeAna);
  assert.equal(summary.contacts, 0);
  assert.equal(summary.groups, 0);
  assert.equal(summary.shared, 0, 'no vuelve a mandar lo ya compartido');
  assert.equal(nAna.listChats().length, antes);
  const grupos = await api('/api/migration/state', { token: (await api('/api/auth/login', { method: 'POST', body: { username: 'caro', password: PASS, fingerprint: 'fp-caro' } })).body.token });
  assert.equal(grupos.body.groups[0].chatId, nBeto.listChats().find((c) => c.kind === 'group').id, 'un solo grupo v2 por grupo v1');
});

test('una tarjeta falsificada no se acepta como vínculo', async () => {
  const login = await api('/api/auth/login', { method: 'POST', body: { username: 'ana', password: PASS, fingerprint: 'fp-ana' } });
  const falsa = { ...nAna.card, name: 'Otra' };
  assert.equal((await api('/api/migration/link', { method: 'POST', token: login.body.token, body: { card: falsa } })).status, 400);
});

test('solo el anfitrión puede registrar el grupo v2', async () => {
  const login = await api('/api/auth/login', { method: 'POST', body: { username: 'caro', password: PASS, fingerprint: 'fp-caro' } });
  const otro = await api(`/api/migration/groups/${v1.groupId}/chat`, { method: 'POST', token: login.body.token, body: { chatId: 'g_otroGrupoInventado' } });
  assert.notEqual(otro.body.chatId, 'g_otroGrupoInventado', 'devuelve el ya registrado, no pisa');
});
