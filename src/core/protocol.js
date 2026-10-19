// Tarjetas, sobres y links de invitacion de OTPChat v2.
import { b64url, canonical, fromB64url, fromUtf8, randomId, utf8 } from './encoding.js';
import { open, seal, sha256, sign, userIdFor, verify } from './crypto.js';
import { cleanName } from './log.js';

const subtle = () => globalThis.crypto.subtle;
const DEVICE_KEY = { name: 'ECDSA', namedCurve: 'P-256' };

// ── Dispositivo ─────────────────────────────────────────────────────────────

// La clave del dispositivo solo sirve para probarle al relay que el buzon es suyo. No es
// exportable: el deviceId (hash de la publica) queda atado a este dispositivo.
export async function generateDevice() {
  const pair = await subtle().generateKey(DEVICE_KEY, false, ['sign', 'verify']);
  const pub = b64url(await subtle().exportKey('raw', pair.publicKey));
  return { deviceId: await deviceIdFor(pub), pub, privateKey: pair.privateKey };
}

export async function deviceIdFor(pub) {
  return `d_${b64url((await sha256(fromB64url(pub))).subarray(0, 16))}`;
}

export async function signChallenge(device, nonce) {
  const sig = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, utf8(`otpchat-relay|${nonce}|${device.deviceId}`));
  return b64url(sig);
}

export async function verifyChallenge(pub, deviceId, nonce, sig) {
  try {
    if ((await deviceIdFor(pub)) !== deviceId) return false;
    const key = await subtle().importKey('raw', fromB64url(pub), DEVICE_KEY, false, ['verify']);
    return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(sig), utf8(`otpchat-relay|${nonce}|${deviceId}`));
  } catch {
    return false;
  }
}

// ── Tarjetas ────────────────────────────────────────────────────────────────

function cardBody(card) {
  return { v: 2, userId: card.userId, signPub: card.signPub, name: card.name, devices: card.devices, ts: card.ts };
}

export async function createCard(identity, { name, devices, ts = Date.now() }) {
  const card = { v: 2, userId: identity.userId, signPub: identity.signPub, name: cleanName(name, 32) || 'Sin nombre', devices, ts };
  card.sig = await sign(identity, cardBody(card));
  return card;
}

export async function verifyCard(card) {
  if (!card || typeof card !== 'object' || typeof card.signPub !== 'string' || !Array.isArray(card.devices)) return false;
  if (card.devices.length > 16 || !Number.isInteger(card.ts)) return false;
  for (const d of card.devices) {
    if (typeof d?.deviceId !== 'string' || typeof d?.prekey !== 'string' || !Number.isInteger(d?.prekeyAt)) return false;
  }
  if (!cleanName(card.name, 32)) return false;
  if ((await userIdFor(card.signPub)) !== card.userId) return false;
  return verify(card.signPub, cardBody(card), card.sig);
}

// ── Sobres ──────────────────────────────────────────────────────────────────

// Mensaje firmado por la identidad del emisor y sellado para un dispositivo. Un dispositivo
// todavia sin identidad (vinculandose) manda el mensaje sin firma; solo sirve para link.*.
export async function wrap(identity, deviceId, t, payload) {
  const body = { t, from: identity?.userId || null, fd: deviceId, ts: Date.now(), n: randomId('n', 8), p: payload };
  return identity ? { ...body, sig: await sign(identity, body) } : body;
}

export async function sealFor(device, message) {
  return seal(device.prekey, utf8(JSON.stringify(message)));
}

export async function unseal(prekeys, sealed) {
  const prekey = prekeys.find((k) => k.pub.slice(0, 16) === sealed?.pk);
  if (!prekey) throw new Error('prekey desconocida');
  return JSON.parse(fromUtf8(await open(prekey, sealed)));
}

export async function verifyWrapped(message, signPub) {
  if (!message?.sig) return false;
  const { sig, ...body } = message;
  return verify(signPub, body, sig);
}

// ── Links de invitacion ─────────────────────────────────────────────────────

// kind: 'c' contacto, 'g' grupo, 'l' vincular un dispositivo propio.
export function encodeInvite(invite) {
  return b64url(utf8(canonical(invite)));
}

export function decodeInvite(text) {
  try {
    const invite = JSON.parse(fromUtf8(fromB64url(text)));
    if (!['c', 'g', 'l'].includes(invite?.kind) || typeof invite.k !== 'string' || typeof invite.u !== 'string' || typeof invite.d !== 'string' || typeof invite.t !== 'string') return null;
    if (invite.kind === 'g' && typeof invite.g !== 'string') return null;
    return invite;
  } catch {
    return null;
  }
}

export function inviteLink(origin, invite) {
  return `${origin.replace(/\/$/, '')}/#/i/${encodeInvite(invite)}`;
}
