// Primitivas de OTPChat v2, todas sobre Web Crypto (navegador y Node 20+ por igual):
// firmas ECDSA P-256 para la identidad y sobres ECDH P-256 + HKDF + AES-256-GCM.
import { b64url, canonical, concat, fromB64url, fromUtf8, utf8 } from './encoding.js';

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Web Crypto requiere HTTPS o localhost');
  return s;
};

const SIGN = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_HASH = { name: 'ECDSA', hash: 'SHA-256' };
const DH = { name: 'ECDH', namedCurve: 'P-256' };
const SEAL_INFO = utf8('otpchat-v2-seal');

export async function sha256(bytes) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

// ── Identidad ────────────────────────────────────────────────────────────────

// Exportable a proposito: es lo que se respalda y lo que se pasa al vincular otro
// dispositivo. Las prekeys, en cambio, nunca salen del dispositivo que las genero.
export async function generateIdentity() {
  const pair = await subtle().generateKey(SIGN, true, ['sign', 'verify']);
  const signPub = b64url(await subtle().exportKey('raw', pair.publicKey));
  return { signPub, privateKey: pair.privateKey, userId: await userIdFor(signPub) };
}

export async function userIdFor(signPub) {
  const hash = await sha256(fromB64url(signPub));
  return `u_${b64url(hash.subarray(0, 16))}`;
}

export async function exportIdentity(identity) {
  return { signPub: identity.signPub, jwk: await subtle().exportKey('jwk', identity.privateKey) };
}

export async function importIdentity(exported) {
  const privateKey = await subtle().importKey('jwk', exported.jwk, SIGN, true, ['sign']);
  return { signPub: exported.signPub, privateKey, userId: await userIdFor(exported.signPub) };
}

const verifyKeys = new Map();

async function verifyKey(signPub) {
  let key = verifyKeys.get(signPub);
  if (!key) {
    key = await subtle().importKey('raw', fromB64url(signPub), SIGN, false, ['verify']);
    verifyKeys.set(signPub, key);
  }
  return key;
}

export async function sign(identity, value) {
  const sig = await subtle().sign(SIGN_HASH, identity.privateKey, utf8(canonical(value)));
  return b64url(sig);
}

export async function verify(signPub, value, sig) {
  try {
    return await subtle().verify(SIGN_HASH, await verifyKey(signPub), fromB64url(sig), utf8(canonical(value)));
  } catch {
    return false;
  }
}

// ── Prekeys y sobres ─────────────────────────────────────────────────────────

export async function generatePrekey() {
  const pair = await subtle().generateKey(DH, false, ['deriveBits']);
  const pub = b64url(await subtle().exportKey('raw', pair.publicKey));
  return { pub, privateKey: pair.privateKey, createdAt: Date.now() };
}

async function sealKey(privateKey, peerPub, epk, rpk) {
  const peer = await subtle().importKey('raw', fromB64url(peerPub), DH, false, []);
  const shared = await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const base = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const salt = await sha256(concat(fromB64url(epk), fromB64url(rpk)));
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: SEAL_INFO }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Sella bytes para una prekey: clave efimera nueva en cada sobre, asi que dos sobres para
// el mismo destino no comparten clave.
export async function seal(prekeyPub, bytes) {
  const eph = await subtle().generateKey(DH, true, ['deriveBits']);
  const epk = b64url(await subtle().exportKey('raw', eph.publicKey));
  const key = await sealKey(eph.privateKey, prekeyPub, epk, prekeyPub);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: fromB64url(epk) }, key, bytes));
  return { epk, pk: prekeyPub.slice(0, 16), iv: b64url(iv), ct: b64url(ct) };
}

export async function open(prekey, sealed) {
  const key = await sealKey(prekey.privateKey, sealed.epk, sealed.epk, prekey.pub);
  const clear = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64url(sealed.iv), additionalData: fromB64url(sealed.epk) }, key, fromB64url(sealed.ct));
  return new Uint8Array(clear);
}

// ── Respaldo con frase ──────────────────────────────────────────────────────

const BACKUP_ITERATIONS = 600_000;

async function passphraseKey(passphrase, salt, iterations) {
  const base = await subtle().importKey('raw', utf8(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptWithPassphrase(passphrase, value) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await passphraseKey(passphrase, salt, BACKUP_ITERATIONS);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, utf8(JSON.stringify(value)));
  return { format: 'otpchat-backup', v: 2, kdf: 'PBKDF2-SHA256', iterations: BACKUP_ITERATIONS, salt: b64url(salt), iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}

export async function decryptWithPassphrase(passphrase, file) {
  if (file?.format !== 'otpchat-backup') throw new Error('No es un respaldo de OTPChat');
  const key = await passphraseKey(passphrase, fromB64url(file.salt), file.iterations);
  try {
    const clear = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64url(file.iv) }, key, fromB64url(file.ct));
    return JSON.parse(fromUtf8(new Uint8Array(clear)));
  } catch {
    throw new Error('Frase incorrecta o respaldo dañado');
  }
}

// ── Codigo de seguridad ─────────────────────────────────────────────────────

// Mismo resultado en los dos lados: se ordenan las claves antes de mezclarlas.
export async function safetyCode(signPubA, signPubB) {
  const [a, b] = [signPubA, signPubB].sort();
  const hash = new Uint8Array(await subtle().digest('SHA-512', concat(utf8('otpchat-safety'), fromB64url(a), fromB64url(b))));
  const view = new DataView(hash.buffer);
  return Array.from({ length: 12 }, (_, i) => String(view.getUint32(i * 4) % 100000).padStart(5, '0'));
}
