// Migracion de una cuenta v1 a la red v2. Corre en el cliente (web, apps o tests de Node):
//  1. Entra a la API v1 (sesion guardada o usuario y contrasenia).
//  2. Vincula la cuenta v1 con la identidad v2 de este nodo.
//  3. Baja el historial y descifra lo que pueda con las llaves locales de v1.
//  4. Recrea en v2 los contactos que ya migraron y los grupos que le toca recrear.
//  5. Comparte su historial con quienes estan en el chat nuevo y no lo tienen.
// Se puede correr de nuevo cuantas veces haga falta: cada paso es idempotente.
import { b64url } from './encoding.js';
import { contactChatId } from './log.js';
import { verifyCard } from './protocol.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Descifrado v1 (TOTP fijo + secreto de sala → PBKDF2 → AES-GCM) ──────────

function fromB64(value) {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function totpForStep(step) {
  const key = await crypto.subtle.importKey('raw', enc.encode('OTPChat-browser-TOTP'), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint32(4, step);
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export async function legacyDecrypt(payload, secret) {
  try {
    const base = await crypto.subtle.importKey('raw', enc.encode(`${await totpForStep(payload.keyStep)}:${secret}`), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromB64(payload.salt), iterations: 120000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(payload.iv) }, key, fromB64(payload.ciphertext)));
  } catch {
    return null;
  }
}

// Para los tests: cifra como lo hacia el cliente v1.
export async function legacyEncrypt(bytes, secret, keyStep = Math.floor(Date.now() / 30000)) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey('raw', enc.encode(`${await totpForStep(keyStep)}:${secret}`), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const b64 = (u) => btoa(String.fromCharCode(...u));
  return { iv: b64(iv), salt: b64(salt), ciphertext: b64(ct), keyStep, keyVersion: 1 };
}

// ── API v1 ──────────────────────────────────────────────────────────────────

function client(apiBase, fetchImpl) {
  const base = apiBase.replace(/\/$/, '');
  let token = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const err = new Error(data?.error || `La versión anterior respondió ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
  return { call, setToken: (t) => (token = t) };
}

export async function legacyAvailable(apiBase, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${apiBase.replace(/\/$/, '')}/api/relay/info`);
    return res.ok && (await res.json()).legacy === true;
  } catch {
    return false;
  }
}

async function authenticate(api, credentials) {
  if (credentials.refreshToken) {
    return api.call('/api/auth/refresh', { method: 'POST', body: { refreshToken: credentials.refreshToken, fingerprint: credentials.fingerprint } });
  }
  return api.call('/api/auth/login', { method: 'POST', body: { username: credentials.username, password: credentials.password, fingerprint: credentials.fingerprint } });
}

// ── Historial ───────────────────────────────────────────────────────────────

async function buildArchive(api, { scope, id, title }, me, getSecret) {
  const { messages } = await api.call(`/api/migration/messages/${scope}/${encodeURIComponent(id)}`);
  const out = [];
  let decrypted = 0;
  for (const m of messages) {
    const secret = getSecret?.(scope, id, m.encrypted?.keyVersion || 1);
    const bytes = secret ? await legacyDecrypt(m.encrypted, secret) : null;
    if (!bytes) continue;
    const base = { id: m.id, ts: new Date(m.createdAt).getTime(), senderV1Id: m.senderId, mine: m.senderId === me, senderName: m.sender?.username || '' };
    if (m.kind === 'audio') {
      out.push({ ...base, kind: 'audio', text: '', audio: b64url(bytes), mime: m.mimeType || 'audio/webm', durationMs: m.durationMs || 0 });
      decrypted++;
      continue;
    }
    const text = dec.decode(bytes);
    // Los mensajes de control de rotacion llevan un secreto de sala: nunca se guardan.
    if (text.includes('"otpchatControl"')) continue;
    out.push({ ...base, kind: 'text', text });
    decrypted++;
  }
  return { archive: { id: `legacy_${scope}_${id}`, kind: scope, title, messages: out, importedAt: Date.now() }, total: messages.length, decrypted };
}

// Lo que ve otra persona: "mio" pasa a ser lo que mando ella, y en grupos solo lo que ella
// ya podia ver en v1 (desde que entro).
function archiveFor(archive, v1UserId, joinedAt = 0) {
  const since = joinedAt ? new Date(joinedAt).getTime() : 0;
  return {
    ...archive,
    messages: archive.messages.filter((m) => m.ts >= since).map(({ senderV1Id, ...m }) => ({ ...m, mine: senderV1Id === v1UserId }))
  };
}

// ── Recrear contactos y grupos ──────────────────────────────────────────────

async function usableCard(node, card) {
  if (!card || !(await verifyCard(card))) return null;
  await node.acceptCard(card);
  return node.cards.get(card.userId) || card;
}

/**
 * @param {{ node: any, apiBase: string, credentials: any, getSecret?: ((scope: string, id: string, version: number) => string | null) | null,
 *   fetchImpl?: any, onProgress?: (text: string) => void, importHistory?: boolean }} options
 */
export async function runMigration({ node, apiBase, credentials, getSecret = null, fetchImpl = fetch, onProgress = () => {}, importHistory = true }) {
  if (!node.hasIdentity()) throw new Error('Creá tu cuenta nueva antes de migrar');
  const api = client(apiBase, fetchImpl);
  onProgress('Entrando a la versión anterior…');
  const session = await authenticate(api, credentials);
  api.setToken(session.token);
  const me = session.user.id;
  await api.call('/api/migration/link', { method: 'POST', body: { card: node.card } });
  const state = await api.call('/api/migration/state');
  const summary = { contacts: 0, groups: 0, history: 0, undecryptable: 0, shared: 0 };
  const shared = new Set((await node.store.kv.get('legacyShared')) || []);
  const archives = new Map((await node.legacyChats()).map((c) => [c.id, c]));

  if (importHistory) {
    const targets = [
      ...state.contacts.map((c) => ({ scope: 'contact', id: c.conversationId, title: c.username })),
      ...state.groups.map((g) => ({ scope: 'group', id: g.groupId, title: g.name }))
    ];
    for (const target of targets) {
      onProgress(`Bajando el historial de ${target.title}…`);
      const { archive, total, decrypted } = await buildArchive(api, target, me, getSecret);
      summary.history += decrypted;
      summary.undecryptable += total - decrypted;
      if (archive.messages.length) {
        await node.mergeLegacyChat(archive);
        archives.set(archive.id, (await node.legacyChats()).find((c) => c.id === archive.id));
      }
    }
  }

  const attach = async (archiveId, chatId) => {
    const all = await node.legacyChats();
    const found = all.find((c) => c.id === archiveId);
    if (found && found.v2ChatId !== chatId) {
      found.v2ChatId = chatId;
      await node.saveLegacyChats(all);
    }
    return found;
  };

  const share = async (archiveId, chatId, v2UserId, v1UserId, joinedAt) => {
    const key = `${archiveId}|${v1UserId}`;
    const archive = archives.get(archiveId);
    if (shared.has(key) || !archive || archive.sharedBy || !archive.messages.some((m) => m.senderV1Id)) return;
    summary.shared += await node.shareLegacy(chatId, v2UserId, archiveFor(archive, v1UserId, joinedAt));
    shared.add(key);
  };

  // Contactos: el chat v2 tiene id deterministico, asi que si los dos lo crean es el mismo.
  for (const contact of state.contacts) {
    const archiveId = `legacy_contact_${contact.conversationId}`;
    const card = await usableCard(node, contact.card);
    if (!card || card.userId === node.identity.userId) continue;
    onProgress(`Reconectando con ${contact.username}…`);
    const chatId = await contactChatId(node.identity.userId, card.userId);
    if (!node.chats.has(chatId)) {
      await node.append(chatId, 'chat.create', { kind: 'contact', members: [node.myMember(), { userId: card.userId, signPub: card.signPub, name: card.name }] });
      await node.sendWelcome(chatId, [card.userId]);
      summary.contacts++;
    }
    await attach(archiveId, chatId);
    await share(archiveId, chatId, card.userId, contact.v1UserId);
  }

  // Grupos: los recrea una sola cuenta (la que el servidor elige como anfitrion) y suma a los
  // demas a medida que migran. Los roles y el candado se copian de v1.
  for (const group of state.groups) {
    const archiveId = `legacy_group_${group.groupId}`;
    let chatId = group.chatId;
    if (group.hostUserId === me) {
      if (!chatId) {
        onProgress(`Recreando el grupo ${group.name}…`);
        const created = await node.createGroup(group.name);
        const claim = await api.call(`/api/migration/groups/${encodeURIComponent(group.groupId)}/chat`, { method: 'POST', body: { chatId: created } });
        if (claim.chatId !== created) {
          await node.deleteChat(created);
        } else {
          summary.groups++;
          if (!group.membersCanWrite) await node.setGroupSettings(created, { membersCanWrite: false });
        }
        chatId = claim.chatId;
      }
      if (node.chats.has(chatId)) {
        for (const member of group.members) {
          if (member.v1UserId === me) continue;
          const card = await usableCard(node, member.card);
          if (!card) continue;
          const v2 = node.chats.get(chatId);
          if (!v2.state.members.has(card.userId)) {
            await node.append(chatId, 'member.add', { member: { userId: card.userId, signPub: card.signPub, name: card.name } });
            const others = [...node.chats.get(chatId).state.members.keys()].filter((u) => u !== card.userId && u !== node.identity.userId);
            if (others.length) await node.sendTo(others, 'cards', { cards: [card] });
            // El fundador v1 que no es el anfitrion queda como subadmin: en v2 hay un solo admin.
            if (member.role === 'subadmin' || member.role === 'admin') await node.setRole(chatId, [card.userId], 'subadmin');
            await node.sendWelcome(chatId, [card.userId]);
          }
        }
      }
    }
    if (chatId && node.chats.has(chatId)) {
      await attach(archiveId, chatId);
      // Cualquiera que tenga el historial descifrado lo comparte (el anfitrion puede no tener
      // las llaves viejas). Cada destino recibe solo lo que ya veia en v1.
      const members = node.chats.get(chatId).state.members;
      for (const member of group.members) {
        if (member.v1UserId === me || !member.card || !members.has(member.card.userId)) continue;
        await share(archiveId, chatId, member.card.userId, member.v1UserId, member.joinedAt);
      }
    }
  }

  await node.store.kv.set('legacyShared', [...shared]);
  onProgress('');
  return { summary, session: { refreshToken: session.refreshToken, fingerprint: credentials.fingerprint, v1UserId: me, username: session.user.username } };
}
