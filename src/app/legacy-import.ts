// Migracion desde v1: baja los chats de la API vieja, los descifra con las llaves que este
// navegador ya tenia y los deja como historial de solo lectura en el dispositivo. Es la
// unica parte de v2 que habla con la base de datos central, y solo mientras exista.
import { apiUrl } from './runtime-config';

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface LegacyMessage { id: string; ts: number; mine: boolean; senderName: string; kind: 'text' | 'audio'; text: string; audio?: string; mime?: string; durationMs?: number }
export interface LegacyChat { id: string; kind: 'contact' | 'group'; title: string; messages: LegacyMessage[]; importedAt: number }

export function hasLegacySession(): boolean {
  try {
    return !!localStorage.getItem('otpchat_refresh');
  } catch {
    return false;
  }
}

function fromB64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function toB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// El esquema de v1, tal cual: TOTP con clave fija + secreto de sala → PBKDF2 → AES-GCM.
async function totpForStep(step: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode('OTPChat-browser-TOTP'), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint32(4, step);
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

async function legacyDecrypt(payload: any, secret: string): Promise<Uint8Array | null> {
  try {
    const base = await crypto.subtle.importKey('raw', enc.encode(`${await totpForStep(payload.keyStep)}:${secret}`), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromB64(payload.salt), iterations: 120000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(payload.iv) }, key, fromB64(payload.ciphertext)));
  } catch {
    return null;
  }
}

function legacySecret(scope: string, id: string, version: number): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem(`otpchat_secret:${scope}:${id}`) || 'null');
    return stored?.versions?.[String(version)] || null;
  } catch {
    return null;
  }
}

async function getJson(path: string, token: string) {
  const res = await fetch(apiUrl(path), { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`v1 ${res.status}`);
  return res.json();
}

export async function importLegacyChats(onProgress?: (text: string) => void): Promise<LegacyChat[]> {
  const refreshToken = localStorage.getItem('otpchat_refresh');
  const fingerprint = localStorage.getItem('otpchat_fingerprint');
  if (!refreshToken || !fingerprint) throw new Error('No hay una sesión de la versión anterior en este navegador');
  const auth = await fetch(apiUrl('/api/auth/refresh'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken, fingerprint }) });
  if (!auth.ok) throw new Error('La sesión anterior venció o la versión anterior ya no está disponible');
  const { token, user, refreshToken: next } = await auth.json();
  localStorage.setItem('otpchat_refresh', next);
  const boot = await getJson('/api/bootstrap', token);
  const chats: LegacyChat[] = [];
  const targets = [
    ...boot.contacts.map((c: any) => ({ scope: 'contact', id: c.conversationId, title: c.other?.username || 'Contacto' })),
    ...boot.groups.map((g: any) => ({ scope: 'group', id: g.id, title: g.name }))
  ];
  for (const target of targets) {
    onProgress?.(`Importando ${target.title}…`);
    const { messages } = await getJson(`/api/messages/${target.scope}/${encodeURIComponent(target.id)}`, token);
    const out: LegacyMessage[] = [];
    for (const m of messages) {
      const secret = legacySecret(target.scope, target.id, m.encrypted?.keyVersion || 1);
      const bytes = secret ? await legacyDecrypt(m.encrypted, secret) : null;
      const base = { id: m.id, ts: new Date(m.createdAt).getTime(), mine: m.senderId === user.id, senderName: m.sender?.username || '' };
      if (m.kind === 'audio') {
        out.push({ ...base, kind: 'audio', text: bytes ? '' : '[Audio sin llave local]', audio: bytes ? toB64url(bytes) : undefined, mime: m.mimeType || 'audio/webm', durationMs: m.durationMs || 0 });
        continue;
      }
      const text = bytes ? dec.decode(bytes) : '[Sin llave local para descifrar]';
      // Los mensajes de control de rotacion llevan un secreto: nunca se guardan en claro.
      if (text.includes('"otpchatControl"')) continue;
      out.push({ ...base, kind: 'text', text });
    }
    chats.push({ id: `legacy_${target.scope}_${target.id}`, kind: target.scope as 'contact' | 'group', title: target.title, messages: out, importedAt: Date.now() });
  }
  return chats;
}

// Cierra la sesion vieja y borra sus llaves: despues de importar ya no hacen falta.
export async function closeLegacySession() {
  const refreshToken = localStorage.getItem('otpchat_refresh');
  try {
    const token = localStorage.getItem('otpchat_token');
    if (token && refreshToken) await fetch(apiUrl('/api/auth/logout'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ refreshToken }) });
  } catch {}
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('otpchat_secret') || key.startsWith('otpchat_invite_secret') || ['otpchat_token', 'otpchat_refresh', 'otpchat_pending_invite'].includes(key)) localStorage.removeItem(key);
  }
}
