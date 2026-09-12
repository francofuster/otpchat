// Tests de los endpoints que deciden quien puede escribir en un grupo y cuanto vive un
// audio. Corren contra una base Postgres descartable (ver "npm run test:api"), nunca
// contra la base real: el script fuerza DATABASE_URL vacio antes de que cargue dotenv.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AppDataSource, loadStore, mutate, state } from '../server/store.js';

const base = `http://localhost:${process.env.PORT || 4955}`;
const unDia = 24 * 60 * 60 * 1000;
let backend;

before(async () => {
  backend = await import('../server/index.js');
  for (let intento = 0; intento < 50; intento++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('el backend de test no respondio /api/health');
});

// El listen, el WebSocketServer y el interval de limpieza dejan el event loop vivo.
after(async () => {
  clearInterval(backend.cleanupTimer);
  backend.wss.close();
  await new Promise((resolve) => backend.server.close(resolve));
  await AppDataSource.destroy();
});

beforeEach(async () => {
  const tablas = AppDataSource.entityMetadatas.map((m) => `"${m.tableName}"`).join(', ');
  await AppDataSource.query(`truncate table ${tablas} restart identity cascade`);
  await loadStore();
});

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const texto = await res.text();
  return { status: res.status, body: texto ? JSON.parse(texto) : null };
}

let sufijo = 0;
async function registrar(nombre) {
  const username = `${nombre}${sufijo++}`;
  const { status, body } = await api('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'Abcdef1!', fingerprint: `fp-${username}` }
  });
  assert.equal(status, 200, `no se pudo registrar ${username}: ${JSON.stringify(body)}`);
  return body;
}

const cifrado = (ciphertext = 'c') => ({ iv: 'i', salt: 's', ciphertext, keyStep: 1, keyVersion: 1 });

// Arma un grupo con su dueno y los miembros pedidos ya adentro.
async function grupoCon(cantidadMiembros) {
  const dueno = await registrar('dueno');
  const { body: creado } = await api('/api/groups', { method: 'POST', token: dueno.token, body: { name: 'Equipo' } });
  const miembros = [];
  for (let i = 0; i < cantidadMiembros; i++) {
    const miembro = await registrar('miembro');
    const { body: invitacion } = await api(`/api/groups/${creado.group.id}/invite`, { method: 'POST', token: dueno.token });
    await api(`/api/invitations/${invitacion.invitation.code}/accept`, { method: 'POST', token: miembro.token });
    miembros.push(miembro);
  }
  return { dueno, grupo: creado.group, miembros };
}

function enviar(token, grupoId, extra = {}) {
  return api('/api/messages', { method: 'POST', token, body: { scope: 'group', targetId: grupoId, encrypted: cifrado(), ...extra } });
}

test('un grupo nuevo deja escribir a todos los miembros', async () => {
  const { grupo, miembros } = await grupoCon(1);
  assert.equal(grupo.membersCanWrite, true);
  assert.equal((await enviar(miembros[0].token, grupo.id)).status, 200);
});

test('con el candado puesto el miembro recibe 403 aunque arme el POST a mano', async () => {
  const { dueno, grupo, miembros } = await grupoCon(1);
  await api(`/api/groups/${grupo.id}`, { method: 'PATCH', token: dueno.token, body: { membersCanWrite: false } });

  const rechazado = await enviar(miembros[0].token, grupo.id);
  assert.equal(rechazado.status, 403);
  assert.equal(rechazado.body.error, 'Solo administradores pueden enviar mensajes');
});

test('con el candado puesto admin y subadmin siguen escribiendo', async () => {
  const { dueno, grupo, miembros } = await grupoCon(2);
  const [subadmin, miembro] = miembros;
  await api(`/api/groups/${grupo.id}/members/roles`, { method: 'PATCH', token: dueno.token, body: { ids: [subadmin.user.id], role: 'subadmin' } });
  await api(`/api/groups/${grupo.id}`, { method: 'PATCH', token: dueno.token, body: { membersCanWrite: false } });

  assert.equal((await enviar(dueno.token, grupo.id)).status, 200);
  assert.equal((await enviar(subadmin.token, grupo.id)).status, 200);
  assert.equal((await enviar(miembro.token, grupo.id)).status, 403);
});

test('solo el admin principal puede mover el candado', async () => {
  const { dueno, grupo, miembros } = await grupoCon(2);
  const [subadmin, miembro] = miembros;
  await api(`/api/groups/${grupo.id}/members/roles`, { method: 'PATCH', token: dueno.token, body: { ids: [subadmin.user.id], role: 'subadmin' } });

  assert.equal((await api(`/api/groups/${grupo.id}`, { method: 'PATCH', token: subadmin.token, body: { membersCanWrite: false } })).status, 403);
  assert.equal((await api(`/api/groups/${grupo.id}`, { method: 'PATCH', token: miembro.token, body: { membersCanWrite: false } })).status, 403);
  assert.equal((await api(`/api/groups/${grupo.id}`, { method: 'PATCH', token: dueno.token, body: { membersCanWrite: false } })).status, 200);
});

test('volver a abrir el grupo devuelve la escritura a los miembros', async () => {
  const { dueno, grupo, miembros } = await grupoCon(1);
  await api(`/api/groups/${grupo.id}`, { method: 'PATCH', token: dueno.token, body: { membersCanWrite: false } });
  await api(`/api/groups/${grupo.id}`, { method: 'PATCH', token: dueno.token, body: { membersCanWrite: true } });
  assert.equal((await enviar(miembros[0].token, grupo.id)).status, 200);
});

test('un audio sin temporizador vence en un dia', async () => {
  const { dueno, grupo } = await grupoCon(0);
  const { status, body } = await enviar(dueno.token, grupo.id, { kind: 'audio', durationMs: 4200, mimeType: 'audio/webm' });

  assert.equal(status, 200);
  assert.equal(body.message.kind, 'audio');
  assert.equal(body.message.durationMs, 4200);
  const restante = new Date(body.message.expiresAt).getTime() - Date.now();
  assert.ok(Math.abs(restante - unDia) < 10_000, `esperaba ~24h y vence en ${restante}ms`);
});

test('con mensajes temporales activos el audio dura lo que se seteo', async () => {
  const { dueno, grupo } = await grupoCon(0);
  await api(`/api/groups/${grupo.id}/timer`, { method: 'PATCH', token: dueno.token, body: { timerSeconds: 30 } });

  const { body } = await enviar(dueno.token, grupo.id, { kind: 'audio', durationMs: 1000, mimeType: 'audio/webm' });
  const restante = new Date(body.message.expiresAt).getTime() - Date.now();
  assert.ok(Math.abs(restante - 30_000) < 5_000, `esperaba ~30s y vence en ${restante}ms`);
});

test('el temporizador tambien puede estirar un audio mas alla del dia', async () => {
  const { dueno, grupo } = await grupoCon(0);
  await api(`/api/groups/${grupo.id}/timer`, { method: 'PATCH', token: dueno.token, body: { timerSeconds: 604800 } });

  const { body } = await enviar(dueno.token, grupo.id, { kind: 'audio', durationMs: 1000, mimeType: 'audio/webm' });
  const restante = new Date(body.message.expiresAt).getTime() - Date.now();
  assert.ok(restante > 6 * unDia, `esperaba ~7d y vence en ${restante}ms`);
});

test('el texto sin temporizador sigue sin vencimiento', async () => {
  const { dueno, grupo } = await grupoCon(0);
  const { body } = await enviar(dueno.token, grupo.id);

  assert.equal(body.message.kind, 'text');
  assert.equal(body.message.expiresAt, null);
  assert.equal(body.message.durationMs, null);
});

test('un audio mas grande que el tope se rechaza con 413', async () => {
  const { dueno, grupo } = await grupoCon(0);
  const gigante = 'x'.repeat(Number(process.env.MAX_AUDIO_BYTES || 4096) + 100);
  const { status, body } = await api('/api/messages', {
    method: 'POST',
    token: dueno.token,
    body: { scope: 'group', targetId: grupo.id, encrypted: cifrado(gigante), kind: 'audio', durationMs: 9999, mimeType: 'audio/webm' }
  });

  assert.equal(status, 413);
  assert.equal(body.error, 'El audio es demasiado largo');
});

test('el audio viaja cifrado: el server guarda el ciphertext tal cual y nunca el audio plano', async () => {
  const { dueno, grupo } = await grupoCon(0);
  const ciphertext = 'Y2lmcmFkby1vcGFjby1wYXJhLWVsLXNlcnZlcg==';
  await enviar(dueno.token, grupo.id, { kind: 'audio', durationMs: 2000, mimeType: 'audio/webm', encrypted: cifrado(ciphertext) });

  const fila = await AppDataSource.getRepository('Message').findOneBy({ targetId: grupo.id });
  assert.equal(fila.encrypted.ciphertext, ciphertext);
  // El server no guarda ninguna copia legible: solo iv, salt y el ciphertext opaco.
  assert.deepEqual(Object.keys(fila.encrypted).sort(), ['ciphertext', 'iv', 'keyStep', 'keyVersion', 'salt']);
});

// ── Reentrada tras expulsion (la invitacion de grupo debe revocarse) ────────────

test('expulsar a un miembro revoca las invitaciones pendientes del grupo', async () => {
  const dueno = await registrar('dueno');
  const { body: creado } = await api('/api/groups', { method: 'POST', token: dueno.token, body: { name: 'Equipo' } });
  const grupoId = creado.group.id;
  const { body: inv } = await api(`/api/groups/${grupoId}/invite`, { method: 'POST', token: dueno.token });
  const code = inv.invitation.code;

  const intruso = await registrar('intruso');
  await api(`/api/invitations/${code}/accept`, { method: 'POST', token: intruso.token });

  // El dueno lo expulsa.
  const expulsion = await api(`/api/groups/${grupoId}/members`, { method: 'DELETE', token: dueno.token, body: { ids: [intruso.user.id] } });
  assert.equal(expulsion.status, 200);

  // La invitacion vieja ya no sirve: no se puede consultar ni volver a aceptar.
  assert.equal((await api(`/api/invitations/${code}`, { token: intruso.token })).status, 404);
  assert.equal((await api(`/api/invitations/${code}/accept`, { method: 'POST', token: intruso.token })).status, 404);

  // Y sigue afuera: no puede leer los mensajes del grupo.
  assert.equal((await api(`/api/messages/group/${grupoId}`, { token: intruso.token })).status, 403);
});

// ── Reserva del nombre de superadmin y flag isSuperadmin ────────────────────────

const superadminName = process.env.SUPERADMIN_USERNAME || 'sup3r4drm1n_3533';

test('el nombre de superadmin no se puede registrar', async () => {
  const { status, body } = await api('/api/auth/register', {
    method: 'POST',
    body: { username: superadminName, password: 'Abcdef1!', fingerprint: 'fp-escalada' }
  });
  assert.equal(status, 409);
  assert.equal(body.error, 'Usuario no disponible');
});

test('nadie puede renombrarse al nombre de superadmin', async () => {
  const user = await registrar('random');
  const { status } = await api('/api/auth/username', { method: 'PATCH', token: user.token, body: { username: superadminName } });
  assert.equal(status, 409);
});

test('un usuario comun no tiene isSuperadmin y no entra al panel admin', async () => {
  const user = await registrar('comun');
  assert.equal(user.user.isSuperadmin, false);
  assert.equal((await api('/api/admin/stats', { token: user.token })).status, 403);
  assert.equal((await api('/api/admin/users', { token: user.token })).status, 403);
});

test('el admin se decide por el flag sembrado, no por el nombre de usuario', async () => {
  const user = await registrar('designado');
  // Simula lo que hace seedSuperadmin() en el arranque: marcar el flag en la fila.
  await mutate(() => { state().users.find((u) => u.id === user.user.id).isSuperadmin = true; });
  assert.equal((await api('/api/admin/stats', { token: user.token })).status, 200);
});

// ── El deviceFingerprint no se filtra a otros usuarios (Vuln 4) ──────────────────

test('/api/me devuelve el fingerprint propio pero no se lo pasa a terceros', async () => {
  const { dueno, grupo, miembros } = await grupoCon(1);
  const miembro = miembros[0];

  // Propio: si.
  const yo = await api('/api/me', { token: dueno.token });
  assert.ok(yo.body.user.deviceFingerprint, 'el usuario deberia ver su propio fingerprint');

  // El sender que ve el otro en los mensajes: sin fingerprint.
  await enviar(dueno.token, grupo.id);
  const vistos = await api(`/api/messages/group/${grupo.id}`, { token: miembro.token });
  const sender = vistos.body.messages.at(-1).sender;
  assert.equal(sender.deviceFingerprint, undefined, 'el fingerprint del emisor no debe viajar a otros');

  // La lista de miembros que ve el admin del grupo: tampoco.
  const lista = await api(`/api/groups/${grupo.id}/members`, { token: dueno.token });
  for (const m of lista.body.members) {
    assert.equal(m.user.deviceFingerprint, undefined, 'ningun miembro debe exponer su fingerprint');
  }
});

test('el other de un contacto tampoco expone el fingerprint', async () => {
  const a = await registrar('contactoA');
  const b = await registrar('contactoB');
  const { body: inv } = await api('/api/invitations/contact', { method: 'POST', token: a.token });
  await api(`/api/invitations/${inv.invitation.code}/accept`, { method: 'POST', token: b.token });

  const boot = await api('/api/bootstrap', { token: a.token });
  assert.equal(boot.body.contacts[0].other.deviceFingerprint, undefined);
});
