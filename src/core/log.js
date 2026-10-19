// Log firmado por chat. Cada nodo arma el estado del chat aplicando las entradas en orden
// (ts, id) y descarta las que no cumplen las reglas: los permisos los hacen cumplir todos los
// nodos, no un servidor.
import { b64url, canonical, utf8 } from './encoding.js';
import { sha256, sign, verify } from './crypto.js';

export const MAX_TEXT = 16_000;
export const MAX_AUDIO_B64 = Math.ceil((3 * 1024 * 1024 * 4) / 3) + 4;
export const MAX_NAME = 64;
// Una entrada fechada demasiado en el futuro podria fijarse al final del orden para pisar
// cambios posteriores. Se rechaza al recibirla.
export const MAX_CLOCK_SKEW_MS = 10 * 60_000;

const ROLES = new Set(['admin', 'subadmin', 'member']);

function signedPart(entry) {
  return { v: entry.v, chat: entry.chat, author: entry.author, ts: entry.ts, type: entry.type, body: entry.body };
}

async function entryId(entry) {
  return `e_${b64url((await sha256(utf8(canonical({ ...signedPart(entry), sig: entry.sig })))).subarray(0, 18))}`;
}

export async function createEntry(identity, { chat, type, body, ts = Date.now() }) {
  const entry = { v: 2, chat, author: identity.userId, ts, type, body };
  entry.sig = await sign(identity, signedPart(entry));
  entry.id = await entryId(entry);
  return entry;
}

export async function contactChatId(userA, userB) {
  const [a, b] = [userA, userB].sort();
  return `c_${b64url((await sha256(utf8(`${a}|${b}`))).subarray(0, 16))}`;
}

// Caracteres de control e invisibles (incluye los de direccion de texto, usados para
// disfrazar nombres). Con escapes en string para que el fuente quede en ASCII.
const INVISIBLE = new RegExp('[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]', 'g');

export function cleanName(name, max = MAX_NAME) {
  if (typeof name !== 'string') return null;
  const value = name.replace(INVISIBLE, '').trim();
  return value.length >= 1 && value.length <= max ? value : null;
}

function isMember(state, userId) {
  return state.members.has(userId);
}

function roleOf(state, userId) {
  if (state.kind !== 'group') return isMember(state, userId) ? 'member' : null;
  if (state.founderId === userId) return 'admin';
  return state.members.get(userId)?.role || null;
}

function canModerate(role) {
  return role === 'admin' || role === 'subadmin';
}

export function canWrite(state, userId) {
  if (!state || state.deleted || !isMember(state, userId)) return false;
  if (state.kind !== 'group' || state.membersCanWrite) return true;
  return canModerate(roleOf(state, userId));
}

function memberRecord(raw, ts, role) {
  if (!raw || typeof raw.userId !== 'string' || typeof raw.signPub !== 'string') return null;
  return { userId: raw.userId, signPub: raw.signPub, name: cleanName(raw.name, 32) || 'Sin nombre', role, joinedAt: ts };
}

function validMsgBody(body, ts) {
  if (!body || typeof body !== 'object') return false;
  if (body.expiresAt !== undefined && body.expiresAt !== null && (!Number.isInteger(body.expiresAt) || body.expiresAt <= ts)) return false;
  if (body.kind === 'text') return typeof body.text === 'string' && body.text.length >= 1 && body.text.length <= MAX_TEXT;
  if (body.kind === 'audio') {
    return typeof body.audio === 'string' && body.audio.length <= MAX_AUDIO_B64
      && typeof body.mime === 'string' && body.mime.length <= 64
      && Number.isInteger(body.durationMs) && body.durationMs >= 0 && body.durationMs <= 60 * 60_000;
  }
  return false;
}

export function emptyState(chatId) {
  return { id: chatId, kind: null, name: '', founderId: null, createdAt: 0, members: new Map(), membersCanWrite: true, deleted: false, messages: [], events: [] };
}

// Aplica una entrada al estado. Devuelve false si la rechaza (y el estado queda igual).
function apply(state, entry) {
  const { type, body, author, ts } = entry;
  if (type === 'chat.create') {
    if (state.kind && !state.deleted) return false;
    const kind = body?.kind;
    if (kind !== 'group' && kind !== 'contact') return false;
    const members = Array.isArray(body.members) ? body.members : [];
    if (!members.some((m) => m?.userId === author)) return false;
    if (kind === 'contact' && members.length !== 2) return false;
    const name = kind === 'group' ? cleanName(body.name) : '';
    if (kind === 'group' && !name) return false;
    Object.assign(state, emptyState(state.id), { kind, name, founderId: kind === 'group' ? author : null, createdAt: ts, membersCanWrite: true });
    for (const raw of members) {
      const record = memberRecord(raw, ts, kind === 'group' ? (raw.userId === author ? 'admin' : 'member') : 'member');
      if (!record) return false;
      state.members.set(record.userId, record);
    }
    return true;
  }
  if (!state.kind || state.deleted || !isMember(state, author)) return false;
  const role = roleOf(state, author);

  switch (type) {
    case 'msg':
      if (!validMsgBody(body, ts) || !canWrite(state, author)) return false;
      state.messages.push(entry);
      return true;
    case 'screenshot':
      state.events.push({ id: entry.id, ts, type: 'screenshot', userId: author });
      return true;
    case 'member.add': {
      if (state.kind !== 'group' || !canModerate(role)) return false;
      const record = memberRecord(body?.member, ts, 'member');
      if (!record || isMember(state, record.userId)) return false;
      state.members.set(record.userId, record);
      state.events.push({ id: entry.id, ts, type: 'joined', userId: record.userId });
      return true;
    }
    case 'member.remove': {
      if (state.kind !== 'group' || !canModerate(role)) return false;
      const target = body?.userId;
      if (!isMember(state, target) || target === author || target === state.founderId) return false;
      if (role === 'subadmin' && roleOf(state, target) !== 'member') return false;
      state.members.delete(target);
      state.events.push({ id: entry.id, ts, type: 'removed', userId: target, by: author });
      return true;
    }
    case 'member.leave': {
      if (state.kind !== 'group') return false;
      state.members.delete(author);
      state.events.push({ id: entry.id, ts, type: 'left', userId: author });
      if (!state.members.size) {
        state.deleted = true;
        return true;
      }
      // Si se va el fundador, el grupo pasa al miembro mas antiguo (desempate por userId).
      if (state.founderId === author) {
        const next = [...state.members.values()].sort((a, b) => a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId))[0];
        state.founderId = next.userId;
        next.role = 'admin';
      }
      return true;
    }
    case 'role.set': {
      if (state.kind !== 'group' || role !== 'admin') return false;
      const target = state.members.get(body?.userId);
      const next = body?.role;
      if (!target || target.userId === state.founderId || (next !== 'subadmin' && next !== 'member')) return false;
      target.role = next;
      return true;
    }
    case 'chat.settings': {
      if (state.kind !== 'group' || role !== 'admin') return false;
      if (body?.name !== undefined) {
        const name = cleanName(body.name);
        if (!name) return false;
        state.name = name;
      }
      if (body?.membersCanWrite !== undefined) {
        if (typeof body.membersCanWrite !== 'boolean') return false;
        state.membersCanWrite = body.membersCanWrite;
      }
      return true;
    }
    case 'chat.delete':
      if (state.kind === 'group' && role !== 'admin') return false;
      state.deleted = true;
      return true;
    default:
      return false;
  }
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const verified = new Set();

async function authentic(entry, signPub) {
  if (!signPub) return false;
  if (verified.has(entry.id)) return true;
  if ((await entryId(entry)) !== entry.id) return false;
  if (!(await verify(signPub, signedPart(entry), entry.sig))) return false;
  verified.add(entry.id);
  return true;
}

// Estado completo del chat a partir de todas sus entradas. Las lapidas (mensajes vencidos)
// no se aplican: solo existen para que una sincronizacion no los vuelva a traer.
export async function buildState(chatId, entries) {
  const state = emptyState(chatId);
  const accepted = [];
  const rejected = [];
  for (const entry of sortEntries(entries)) {
    if (entry.chat !== chatId || entry.tombstone) {
      if (entry.tombstone) accepted.push(entry);
      continue;
    }
    const signPub = entry.type === 'chat.create'
      ? entry.body?.members?.find?.((m) => m?.userId === entry.author)?.signPub
      : state.members.get(entry.author)?.signPub;
    if (!(await authentic(entry, signPub))) {
      rejected.push(entry);
      continue;
    }
    if (apply(state, entry)) accepted.push(entry);
    else rejected.push(entry);
  }
  return { state, accepted, rejected };
}

export function memberList(state) {
  return [...state.members.values()].map((m) => ({ ...m, role: state.kind === 'group' && m.userId === state.founderId ? 'admin' : m.role }));
}

export { roleOf, canModerate, ROLES };
