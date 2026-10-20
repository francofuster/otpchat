// Tests del protocolo v2: cifrado, reglas del log y el sistema distribuido completo (nodos
// reales hablando a traves de un relay real, sin base de datos).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { decryptWithPassphrase, encryptWithPassphrase, generateIdentity, generatePrekey, open, safetyCode, seal, sign, verify } from '../src/core/crypto.js';
import { buildState, createEntry } from '../src/core/log.js';
import { createCard, decodeInvite, verifyCard } from '../src/core/protocol.js';
import { utf8, fromUtf8 } from '../src/core/encoding.js';
import { createMemoryStore } from '../src/core/memory-store.js';
import { INVITE_GRACE_MS, INVITE_REFRESH_MS, INVITE_TTL_MS, LINK_TTL_MS, PREKEY_ROTATE_MS } from '../src/core/node.js';
import { closeAll, contactPair, groupWith, makeNode, sleep, startRelay, until } from './helpers/nodes.mjs';

let relay;
const opened = [];
const track = (...nodes) => { opened.push(...nodes); return nodes; };

before(async () => { relay = await startRelay(); });
after(async () => {
  closeAll(opened);
  await relay.close();
});

// ── Cifrado ─────────────────────────────────────────────────────────────────

test('un sobre sellado solo se abre con la prekey correcta y no tolera cambios', async () => {
  const prekey = await generatePrekey();
  const otra = await generatePrekey();
  const sealed = await seal(prekey.pub, utf8('hola'));
  assert.equal(fromUtf8(await open(prekey, sealed)), 'hola');
  await assert.rejects(open(otra, sealed));
  const roto = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith('A') ? 'BB' : 'AA') };
  await assert.rejects(open(prekey, roto));
});

test('dos sobres para el mismo destino no comparten clave efimera', async () => {
  const prekey = await generatePrekey();
  const a = await seal(prekey.pub, utf8('x'));
  const b = await seal(prekey.pub, utf8('x'));
  assert.notEqual(a.epk, b.epk);
  assert.notEqual(a.ct, b.ct);
});

test('firma y verificacion sobre JSON canonico', async () => {
  const id = await generateIdentity();
  const sig = await sign(id, { b: 1, a: [2, 3] });
  assert.ok(await verify(id.signPub, { a: [2, 3], b: 1 }, sig), 'el orden de las claves no cambia la firma');
  assert.equal(await verify(id.signPub, { a: [2, 3], b: 2 }, sig), false);
});

test('el codigo de seguridad es el mismo en los dos lados', async () => {
  const a = await generateIdentity();
  const b = await generateIdentity();
  assert.deepEqual(await safetyCode(a.signPub, b.signPub), await safetyCode(b.signPub, a.signPub));
  assert.equal((await safetyCode(a.signPub, b.signPub)).length, 12);
});

test('el respaldo se abre solo con la frase correcta', async () => {
  const file = await encryptWithPassphrase('una frase larga', { x: 1 });
  assert.deepEqual(await decryptWithPassphrase('una frase larga', file), { x: 1 });
  await assert.rejects(decryptWithPassphrase('otra frase', file), /Frase incorrecta/);
});

test('una tarjeta alterada no verifica', async () => {
  const id = await generateIdentity();
  const card = await createCard(id, { name: 'Ana', devices: [{ deviceId: 'd_abc', prekey: 'xyz', prekeyAt: 1 }] });
  assert.ok(await verifyCard(card));
  assert.equal(await verifyCard({ ...card, name: 'Otra' }), false);
  assert.equal(await verifyCard({ ...card, userId: 'u_falso' }), false);
});

// ── Reglas del log ──────────────────────────────────────────────────────────

async function grupoLocal() {
  const [admin, sub, miembro, ajeno] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity(), generateIdentity()]);
  const m = (id, name) => ({ userId: id.userId, signPub: id.signPub, name });
  let ts = 1000;
  const e = (id, type, body) => createEntry(id, { chat: 'g_test', type, body, ts: ts++ });
  const entries = [
    await e(admin, 'chat.create', { kind: 'group', name: 'G', members: [m(admin, 'Admin')] }),
    await e(admin, 'member.add', { member: m(sub, 'Sub') }),
    await e(admin, 'member.add', { member: m(miembro, 'Miembro') }),
    await e(admin, 'role.set', { userId: sub.userId, role: 'subadmin' })
  ];
  return { admin, sub, miembro, ajeno, entries, e };
}

test('un no miembro no puede escribir ni agregarse', async () => {
  const { ajeno, entries, e } = await grupoLocal();
  const intruso = await e(ajeno, 'msg', { kind: 'text', text: 'hola' });
  const { state, rejected } = await buildState('g_test', [...entries, intruso]);
  assert.equal(state.messages.length, 0);
  assert.ok(rejected.some((r) => r.id === intruso.id));
});

test('con el candado puesto solo admin y subadmin escriben', async () => {
  const { admin, sub, miembro, entries, e } = await grupoLocal();
  const lock = await e(admin, 'chat.settings', { membersCanWrite: false });
  const deMiembro = await e(miembro, 'msg', { kind: 'text', text: 'no' });
  const deSub = await e(sub, 'msg', { kind: 'text', text: 'si' });
  const { state } = await buildState('g_test', [...entries, lock, deMiembro, deSub]);
  assert.deepEqual(state.messages.map((m) => m.body.text), ['si']);
});

test('solo el admin principal mueve el candado o cambia roles', async () => {
  const { sub, miembro, entries, e } = await grupoLocal();
  const lockSub = await e(sub, 'chat.settings', { membersCanWrite: false });
  const rolMiembro = await e(miembro, 'role.set', { userId: miembro.userId, role: 'subadmin' });
  const { state } = await buildState('g_test', [...entries, lockSub, rolMiembro]);
  assert.equal(state.membersCanWrite, true);
  assert.equal(state.members.get(miembro.userId).role, 'member');
});

test('un subadmin no puede expulsar a otro subadmin ni al admin', async () => {
  const { admin, sub, entries, e } = await grupoLocal();
  const otroSub = await generateIdentity();
  const extra = [
    await e(admin, 'member.add', { member: { userId: otroSub.userId, signPub: otroSub.signPub, name: 'Sub2' } }),
    await e(admin, 'role.set', { userId: otroSub.userId, role: 'subadmin' })
  ];
  const contraSub = await e(sub, 'member.remove', { userId: otroSub.userId });
  const contraAdmin = await e(sub, 'member.remove', { userId: admin.userId });
  const { state } = await buildState('g_test', [...entries, ...extra, contraSub, contraAdmin]);
  assert.ok(state.members.has(otroSub.userId));
  assert.ok(state.members.has(admin.userId));
});

test('una entrada con la firma alterada se descarta', async () => {
  const { miembro, entries, e } = await grupoLocal();
  const msg = await e(miembro, 'msg', { kind: 'text', text: 'original' });
  const forjada = { ...msg, body: { kind: 'text', text: 'cambiado' } };
  const { state } = await buildState('g_test', [...entries, forjada]);
  assert.equal(state.messages.length, 0);
});

test('si se va el fundador el grupo pasa al miembro mas antiguo', async () => {
  const { admin, sub, entries, e } = await grupoLocal();
  const leave = await e(admin, 'member.leave', {});
  const { state } = await buildState('g_test', [...entries, leave]);
  assert.equal(state.founderId, sub.userId);
});

test('el link de invitacion se decodifica y rechaza basura', () => {
  assert.equal(decodeInvite('no-es-un-link'), null);
  assert.equal(decodeInvite(''), null);
});

// ── Sistema distribuido (nodos + relay) ─────────────────────────────────────

test('dos nodos se agregan por QR y chatean de punta a punta', async () => {
  const { na, nb, chatId } = await contactPair(relay.url);
  track(na, nb);
  await nb.sendText(chatId, 'hola Ana');
  await until(() => na.messages(chatId).some((m) => m.text === 'hola Ana'));
  await na.sendText(chatId, 'hola Beto');
  await until(() => nb.messages(chatId).some((m) => m.text === 'hola Beto'));
  assert.equal(na.listChats()[0].title, 'Beto');
  assert.equal(nb.listChats()[0].title, 'Ana');
  assert.deepEqual(await na.safetyCode(chatId), await nb.safetyCode(chatId));
});

test('un mensaje para un nodo desconectado espera en el buzon y se borra al entregarse', async () => {
  const { na, nb, chatId } = await contactPair(relay.url);
  track(na, nb);
  const pendiente = () => relay.relay.pendingFor(nb.device.deviceId);
  await until(() => pendiente().inflight === 0 && pendiente().queued === 0);
  nb.transport.close();
  await until(() => relay.relay.stats().online >= 0 && !nb.transport.connected);
  await sleep(100);
  await na.sendText(chatId, 'mientras no estabas');
  await until(() => pendiente().queued === 1);
  nb.transport.closed = false;
  nb.transport.open();
  await until(() => nb.messages(chatId).some((m) => m.text === 'mientras no estabas'));
  // Entregado y confirmado: no queda nada en el servidor.
  await until(() => pendiente().queued === 0 && pendiente().inflight === 0);
});

test('si el relay pierde el buzon, la sincronizacion entre nodos recupera el mensaje', async () => {
  const otro = await startRelay();
  const { na, nb, chatId } = await contactPair(otro.url);
  track(na, nb);
  nb.transport.close();
  await sleep(150);
  await na.sendText(chatId, 'se pierde en el relay');
  // El relay se reinicia: todo lo que tenia en memoria desaparece.
  await otro.close();
  const nuevo = await startRelay();
  na.transport.close();
  na.transport.url = nuevo.url;
  nb.transport.url = nuevo.url;
  na.transport.closed = false;
  na.transport.open();
  await until(() => na.transport.connected);
  nb.transport.closed = false;
  nb.transport.open();
  await until(() => nb.messages(chatId).some((m) => m.text === 'se pierde en el relay'), { timeout: 8000 });
  na.transport.close();
  nb.transport.close();
  await nuevo.close();
});

test('una rafaga de mensajes simultaneos no pierde ninguno en memoria ni en el almacen', async () => {
  const { na, nb, chatId } = await contactPair(relay.url);
  track(na, nb);
  const total = 150;
  await Promise.all(Array.from({ length: total }, (_, i) => nb.sendText(chatId, `r${i}`)));
  await until(() => na.messages(chatId).length === total, { timeout: 15000 });
  const guardados = (await na.store.entries.list(chatId)).filter((e) => e.type === 'msg');
  assert.equal(guardados.length, total, 'todos quedan guardados');
  assert.equal(new Set(na.messages(chatId).map((m) => m.text)).size, total, 'ninguno repetido ni perdido');
  assert.equal(nb.messages(chatId).length, total, 'el emisor tambien los conserva todos');
  const orden = Array.from({ length: total }, (_, i) => `r${i}`);
  assert.deepEqual(na.messages(chatId).map((m) => m.text), orden, 'conservan el orden en que se enviaron');
});

test('si el relay frena por limite de tasa, el nodo reintenta y no se pierde nada', async () => {
  const lento = await startRelay({ rateBurst: 8, ratePerSec: 20 });
  const { na, nb, chatId } = await contactPair(lento.url);
  for (let i = 0; i < 30; i++) await nb.sendText(chatId, `r${i}`);
  await until(() => na.messages(chatId).length === 30, { timeout: 15000 });
  na.transport.close();
  nb.transport.close();
  await lento.close();
});

test('todos los QR se renuevan cada minuto y tienen la misma vigencia', async () => {
  assert.equal(INVITE_REFRESH_MS, 60_000);
  assert.equal(INVITE_TTL_MS, INVITE_REFRESH_MS + INVITE_GRACE_MS);
  assert.equal(LINK_TTL_MS, INVITE_TTL_MS, 'la vinculacion no vive mas que un contacto');
  const { owner, groupId } = await groupWith(relay.url, 0);
  track(owner);
  for (const crear of [() => owner.createInvite('contact'), () => owner.createInvite('group', groupId), () => owner.createLinkInvite()]) {
    const { expiresAt } = await crear();
    const restante = expiresAt - Date.now();
    assert.ok(restante > INVITE_REFRESH_MS && restante <= INVITE_TTL_MS, `vigencia fuera de rango: ${restante}ms`);
  }
});

test('al renovar, el codigo viejo sirve solo unos segundos; al cerrar la hoja, ninguno', async () => {
  const na = await makeNode(relay.url, 'Ana');
  const nb = await makeNode(relay.url, 'Beto', { waitMs: 1500 });
  const nc = await makeNode(relay.url, 'Caro', { waitMs: 1500 });
  track(na, nb, nc);
  // Renovacion: el viejo queda con gracia y el nuevo reemplaza al anterior.
  const viejo = await na.createInvite('contact');
  na.cancelInvite(viejo.token, INVITE_GRACE_MS);
  assert.ok(na.pendingInvites.get(viejo.token).expiresAt <= Date.now() + INVITE_GRACE_MS, 'la gracia acota el vencimiento');
  await nb.acceptInvite(viejo.link.split('#/i/')[1]);
  // Cierre de la hoja: sin gracia, deja de servir en el acto.
  const cerrado = await na.createInvite('contact');
  na.cancelInvite(cerrado.token);
  assert.equal(na.pendingInvites.has(cerrado.token), false);
  await assert.rejects(nc.acceptInvite(cerrado.link.split('#/i/')[1]), /no respondió/);
});

test('los codigos vencidos no se acumulan en memoria', async () => {
  const na = await makeNode(relay.url, 'Ana');
  track(na);
  const { token } = await na.createInvite('contact');
  na.pendingInvites.get(token).expiresAt = Date.now() - 1;
  await na.createInvite('contact');
  assert.equal(na.pendingInvites.has(token), false);
});

test('el relay rechaza una autenticacion con firma ajena y reemplaza la conexion duplicada', async () => {
  const na = await makeNode(relay.url, 'Ana');
  track(na);
  const intruso = new WebSocket(relay.url);
  const cerrado = new Promise((resolve) => { intruso.onclose = (e) => resolve(e.code); });
  intruso.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.t === 'challenge') intruso.send(JSON.stringify({ t: 'auth', deviceId: na.device.deviceId, pub: na.device.pub, sig: 'AAAA' }));
  };
  assert.equal(await cerrado, 4401, 'sin la clave del dispositivo no se adueña del buzón');

  let reemplazado = false;
  na.transport.on('replaced', () => { reemplazado = true; });
  const segunda = await makeNode(relay.url, null, { store: na.store });
  track(segunda);
  await until(() => reemplazado);
});

test('el codigo de contacto es de un solo uso', async () => {
  const na = await makeNode(relay.url, 'Ana');
  const nb = await makeNode(relay.url, 'Beto');
  const nc = await makeNode(relay.url, 'Caro', { waitMs: 1500 });
  track(na, nb, nc);
  const { link } = await na.createInvite('contact');
  const payload = link.split('#/i/')[1];
  await nb.acceptInvite(payload);
  await assert.rejects(nc.acceptInvite(payload), /no respondió/);
});

test('un grupo con invitados por QR, expulsion efectiva al instante', async () => {
  const { owner, members, groupId } = await groupWith(relay.url, 2);
  track(owner, members);
  const [b, c] = members;
  await b.sendText(groupId, 'hola grupo');
  await until(() => owner.messages(groupId).some((m) => m.text === 'hola grupo') && c.messages(groupId).some((m) => m.text === 'hola grupo'));

  await owner.removeMembers(groupId, [c.identity.userId]);
  await until(() => !c.chats.has(groupId));
  await owner.sendText(groupId, 'despues de la expulsion');
  await until(() => b.messages(groupId).some((m) => m.text === 'despues de la expulsion'));
  await sleep(300);
  assert.equal(c.chats.has(groupId), false, 'el expulsado no vuelve a tener el grupo');
});

test('con el candado puesto un miembro no puede escribir ni forzando la entrada', async () => {
  const { owner, members, groupId } = await groupWith(relay.url, 1);
  track(owner, members);
  const [b] = members;
  await owner.setGroupSettings(groupId, { membersCanWrite: false });
  await until(() => b.chatInfo(groupId)?.membersCanWrite === false);
  await assert.rejects(b.sendText(groupId, 'no deberia'), /permiso/);
  // Forzando: arma la entrada a mano y se la manda al duenio salteando la validacion local.
  const forjada = await createEntry(b.identity, { chat: groupId, type: 'msg', body: { kind: 'text', text: 'forzada' } });
  await b.sendTo([owner.identity.userId], 'entry', { entry: forjada });
  await sleep(400);
  assert.equal(owner.messages(groupId).some((m) => m.text === 'forzada'), false);
});

test('un miembro nuevo no recibe los mensajes anteriores a su ingreso', async () => {
  const { owner, members, groupId } = await groupWith(relay.url, 1);
  track(owner, members);
  await owner.sendText(groupId, 'antes de que llegues');
  await until(() => members[0].messages(groupId).length >= 1);
  const tarde = await makeNode(relay.url, 'Tarde');
  track(tarde);
  const { link } = await owner.createInvite('group', groupId);
  await tarde.acceptInvite(link.split('#/i/')[1]);
  await tarde.requestSync(groupId);
  await sleep(500);
  assert.equal(tarde.messages(groupId).some((m) => m.text === 'antes de que llegues'), false);
  await owner.sendText(groupId, 'ya estas');
  await until(() => tarde.messages(groupId).some((m) => m.text === 'ya estas'));
});

test('un mensaje temporal se borra al vencer y la sincronizacion no lo resucita', async () => {
  const { na, nb, chatId } = await contactPair(relay.url);
  track(na, nb);
  await na.append(chatId, 'msg', { kind: 'text', text: 'efimero', expiresAt: Date.now() + 600 });
  await until(() => nb.messages(chatId).some((m) => m.text === 'efimero'));
  await sleep(700);
  assert.equal(nb.messages(chatId).some((m) => m.text === 'efimero'), false, 'ya no se muestra');
  await na.sweepExpired();
  await nb.sweepExpired();
  const guardadas = await nb.store.entries.list(chatId);
  assert.ok(guardadas.some((e) => e.tombstone), 'queda una lapida sin contenido');
  assert.equal(guardadas.some((e) => e.body?.text === 'efimero'), false, 'el texto ya no esta guardado');
  await nb.requestSync(chatId);
  await sleep(400);
  assert.equal(nb.messages(chatId).some((m) => m.text === 'efimero'), false);
});

test('el temporizador del chat pone vencimiento a los mensajes propios', async () => {
  const { na, nb, chatId } = await contactPair(relay.url);
  track(na, nb);
  await na.setTimer(chatId, 30);
  const entry = await na.sendText(chatId, 'con timer');
  assert.ok(entry.body.expiresAt > Date.now() + 25_000 && entry.body.expiresAt <= Date.now() + 30_000);
  const audio = await nb.sendAudio(chatId, 'AAAA', 'audio/webm', 1200);
  assert.ok(audio.body.expiresAt > Date.now() + 23 * 3600_000, 'sin timer el audio dura un dia');
  await assert.rejects(na.setTimer(chatId, 45), /inválido/);
});

test('un dispositivo vinculado recibe los chats y los mensajes nuevos', async () => {
  const { na, nb, chatId } = await contactPair(relay.url);
  track(na, nb);
  await nb.sendText(chatId, 'antes del vinculo');
  await until(() => na.messages(chatId).length === 1);
  const na2 = await makeNode(relay.url, null);
  track(na2);
  const { link } = await na.createLinkInvite();
  await na2.acceptLinkInvite(link.split('#/i/')[1]);
  assert.equal(na2.identity.userId, na.identity.userId);
  assert.ok(na2.messages(chatId).some((m) => m.text === 'antes del vinculo'));
  await until(() => nb.cards.get(na.identity.userId)?.devices.length === 2);
  await nb.sendText(chatId, 'para los dos');
  await until(() => na.messages(chatId).some((m) => m.text === 'para los dos') && na2.messages(chatId).some((m) => m.text === 'para los dos'));
  await na2.sendText(chatId, 'desde el segundo');
  await until(() => nb.messages(chatId).some((m) => m.text === 'desde el segundo') && na.messages(chatId).some((m) => m.text === 'desde el segundo' && m.mine));
});

test('restaurar un respaldo en otro dispositivo recupera la cuenta y los chats', async () => {
  const { na, nb, chatId } = await contactPair(relay.url);
  track(na, nb);
  await nb.sendText(chatId, 'guardame');
  await until(() => na.messages(chatId).length === 1);
  const file = await na.exportBackup('frase de respaldo');
  const restored = await makeNode(relay.url, null);
  track(restored);
  await restored.importBackup(file, 'frase de respaldo');
  assert.equal(restored.identity.userId, na.identity.userId);
  assert.ok(restored.messages(chatId).some((m) => m.text === 'guardame'));
});

test('cambiar el nombre se propaga a los contactos', async () => {
  const { na, nb, chatId } = await contactPair(relay.url);
  track(na, nb);
  await na.rename('Ana María');
  await until(() => nb.chatInfo(chatId)?.title === 'Ana María');
});

test('al rotar la prekey los contactos sellan con la nueva y lo viejo se sigue abriendo', async () => {
  const { na, nb, chatId } = await contactPair(relay.url);
  track(na, nb);
  const vieja = na.prekeys[0].pub;
  na.prekeys[0].createdAt -= PREKEY_ROTATE_MS + 1000;
  assert.ok(await na.rotatePrekeyIfNeeded());
  assert.notEqual(na.prekeys[0].pub, vieja);
  await until(() => nb.cards.get(na.identity.userId)?.devices[0].prekey === na.prekeys[0].pub);
  await nb.sendText(chatId, 'con la prekey nueva');
  await until(() => na.messages(chatId).some((m) => m.text === 'con la prekey nueva'));
});

test('borrar un chat de contacto lo borra en los dos lados', async () => {
  const { na, nb, chatId } = await contactPair(relay.url);
  track(na, nb);
  await na.deleteChat(chatId);
  await until(() => !nb.chats.has(chatId));
  assert.equal(na.chats.has(chatId), false);
});

test('el estado persiste: un nodo reiniciado con el mismo almacen sigue igual', async () => {
  const store = createMemoryStore();
  const na = await makeNode(relay.url, 'Ana', { store });
  const nb = await makeNode(relay.url, 'Beto');
  track(nb);
  const { link } = await na.createInvite('contact');
  const chatId = await nb.acceptInvite(link.split('#/i/')[1]);
  await nb.sendText(chatId, 'persistente');
  await until(() => na.messages(chatId).length === 1);
  na.transport.close();
  const reinicio = await makeNode(relay.url, null, { store });
  track(reinicio);
  assert.equal(reinicio.identity.userId, na.identity.userId);
  assert.ok(reinicio.messages(chatId).some((m) => m.text === 'persistente'));
});
