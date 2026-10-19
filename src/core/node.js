// Motor de un nodo OTPChat v2. Cada dispositivo es un nodo: guarda sus chats, valida las
// entradas que recibe y las replica solo hacia los dispositivos de los otros miembros. No
// depende del navegador: el almacen y el transporte se inyectan.
import { randomId } from './encoding.js';
import { decryptWithPassphrase, encryptWithPassphrase, exportIdentity, generateIdentity, generatePrekey, importIdentity, safetyCode } from './crypto.js';
import { MAX_CLOCK_SKEW_MS, buildState, canModerate, canWrite, cleanName, contactChatId, createEntry, memberList, roleOf } from './log.js';
import { createCard, decodeInvite, generateDevice, inviteLink, sealFor, unseal, verifyCard, verifyWrapped, wrap } from './protocol.js';

export const PREKEY_ROTATE_MS = 7 * 24 * 60 * 60_000;
export const PREKEY_KEEP_MS = 30 * 24 * 60 * 60_000;
export const INVITE_TTL_MS = 60_000;
export const LINK_TTL_MS = 120_000;
export const AUDIO_DEFAULT_TTL_MS = 24 * 60 * 60_000;
export const TIMER_OPTIONS = [0, 30, 60, 300, 1800, 3600, 21600, 43200, 86400, 604800];
const SYNC_CHUNK_BYTES = 2 * 1024 * 1024;
const WAIT_WELCOME_MS = 25_000;

const STRUCTURAL = new Set(['chat.create', 'member.add', 'member.remove', 'member.leave', 'role.set', 'chat.settings', 'chat.delete']);

export class OtpNode {
  /** @param {{ store: any, transport: any, origin?: string, waitMs?: number }} options */
  constructor({ store, transport, origin = '', waitMs = WAIT_WELCOME_MS }) {
    this.store = store;
    this.transport = transport;
    this.origin = origin;
    this.waitMs = waitMs;
    this.identity = null;
    this.device = null;
    this.prekeys = [];
    this.card = null;
    this.cards = new Map();
    this.chats = new Map();
    this.prefs = { timers: {}, lastRead: {}, removedChats: {} };
    this.pendingInvites = new Map();
    this.waiters = new Map();
    this.orphans = new Map();
    this.seen = new Set();
    this.listeners = new Map();
    this.outbox = [];
    this.flushing = null;
    this.linking = null;
  }

  // ── Eventos ───────────────────────────────────────────────────────────────

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  emit(type, data) {
    for (const fn of this.listeners.get(type) || []) {
      try { fn(data); } catch (err) { console.error(`listener ${type}`, err); }
    }
    for (const fn of this.listeners.get('*') || []) {
      try { fn({ type, data }); } catch {}
    }
  }

  // ── Arranque ──────────────────────────────────────────────────────────────

  async init() {
    const kv = this.store.kv;
    this.device = (await kv.get('device')) || null;
    if (!this.device) {
      this.device = await generateDevice();
      await kv.set('device', this.device);
    }
    this.prekeys = (await kv.get('prekeys')) || [];
    if (!this.prekeys.length) {
      this.prekeys = [await generatePrekey()];
      await kv.set('prekeys', this.prekeys);
    }
    const stored = await kv.get('identity');
    if (stored) this.identity = await importIdentity(stored);
    this.card = (await kv.get('card')) || null;
    for (const card of Object.values((await kv.get('cards')) || {})) this.cards.set(card.userId, card);
    this.prefs = { timers: {}, lastRead: {}, removedChats: {}, ...((await kv.get('prefs')) || {}) };
    this.outbox = (await kv.get('outbox')) || [];
    for (const chatId of (await kv.get('chats')) || []) await this.loadChat(chatId);
    this.transport.on('envelope', (env) => void this.receive(env).catch((err) => console.error('receive', err)));
    this.transport.on('ready', () => void this.onTransportReady().catch((err) => console.error('ready', err)));
    if (this.identity) await this.rotatePrekeyIfNeeded();
    return this;
  }

  hasIdentity() {
    return !!this.identity;
  }

  me() {
    return this.identity ? { userId: this.identity.userId, name: this.card?.name || '', signPub: this.identity.signPub, deviceId: this.device.deviceId } : null;
  }

  async createIdentity(name) {
    const clean = cleanName(name, 32);
    if (!clean) throw new Error('Elegí un nombre de 1 a 32 caracteres');
    this.identity = await generateIdentity();
    await this.store.kv.set('identity', await exportIdentity(this.identity));
    await this.publishCard({ name: clean });
    return this.me();
  }

  async connect() {
    await this.transport.connect({ device: this.device, card: this.card });
  }

  async onTransportReady() {
    if (this.identity) {
      await this.rotatePrekeyIfNeeded();
      await this.transport.publishCard?.(this.card);
    }
    await this.flushOutbox();
    if (this.identity) {
      await this.refreshCards([...this.knownUsers()]);
      await this.requestSync();
    }
    this.emit('ready');
  }

  // ── Tarjetas y prekeys ────────────────────────────────────────────────────

  ownDevices() {
    return this.card?.devices || [];
  }

  async publishCard({ name = this.card?.name, devices } = {}) {
    const own = { deviceId: this.device.deviceId, prekey: this.prekeys[0].pub, prekeyAt: this.prekeys[0].createdAt };
    const others = (devices || this.ownDevices()).filter((d) => d.deviceId !== this.device.deviceId);
    const previousTs = this.card?.ts || 0;
    this.card = await createCard(this.identity, { name, devices: [own, ...others], ts: Math.max(Date.now(), previousTs + 1) });
    await this.store.kv.set('card', this.card);
    this.cards.set(this.card.userId, this.card);
    await this.saveCards();
    await this.transport.publishCard?.(this.card);
    return this.card;
  }

  async rotatePrekeyIfNeeded() {
    const now = Date.now();
    let changed = false;
    if (now - this.prekeys[0].createdAt > PREKEY_ROTATE_MS) {
      this.prekeys.unshift(await generatePrekey());
      changed = true;
    }
    // Forward secrecy por ventana: las privadas viejas se borran y lo sellado para ellas ya
    // no se puede abrir aunque roben el dispositivo.
    const kept = this.prekeys.filter((k, i) => i === 0 || now - k.createdAt < PREKEY_KEEP_MS);
    if (kept.length !== this.prekeys.length) changed = true;
    this.prekeys = kept;
    if (!changed) return false;
    await this.store.kv.set('prekeys', this.prekeys);
    await this.publishCard();
    await this.broadcastCard();
    return true;
  }

  async broadcastCard() {
    const users = [...this.knownUsers()].filter((u) => u !== this.identity.userId);
    await this.sendTo([...users, this.identity.userId], 'cards', { cards: [this.card] });
  }

  async saveCards() {
    await this.store.kv.set('cards', Object.fromEntries(this.cards));
  }

  async acceptCard(card) {
    if (!(await verifyCard(card))) return false;
    if (card.userId === this.identity?.userId) {
      if (card.ts <= (this.card?.ts || 0)) return false;
      // Otro dispositivo propio actualizo la tarjeta (vinculo, desvinculo, nombre).
      const stillHere = card.devices.some((d) => d.deviceId === this.device.deviceId);
      this.card = card;
      await this.store.kv.set('card', card);
      if (!stillHere) {
        this.emit('device:unlinked');
        return true;
      }
    }
    const current = this.cards.get(card.userId);
    if (current && current.ts >= card.ts) return false;
    this.cards.set(card.userId, card);
    await this.saveCards();
    this.emit('cards', { userId: card.userId });
    return true;
  }

  async refreshCards(userIds) {
    if (!userIds.length || !this.transport.getCards) return;
    try {
      for (const card of await this.transport.getCards(userIds)) await this.acceptCard(card);
    } catch {}
  }

  knownUsers() {
    const users = new Set();
    for (const { state } of this.chats.values()) for (const id of state.members.keys()) users.add(id);
    return users;
  }

  nameOf(userId) {
    if (userId === this.identity?.userId) return this.card?.name || 'Yo';
    const card = this.cards.get(userId);
    if (card) return card.name;
    for (const { state } of this.chats.values()) {
      const member = state.members.get(userId);
      if (member) return member.name;
    }
    return 'Desconocido';
  }

  // ── Envio ─────────────────────────────────────────────────────────────────

  // Sella un mensaje para cada dispositivo de cada usuario (los propios incluidos, salvo
  // este). Lo que no se puede entregar ahora queda en el outbox hasta reconectar.
  async sendTo(userIds, t, payload, { devices: extraDevices = [], onlyDevices = null } = {}) {
    const message = await wrap(this.identity, this.device.deviceId, t, payload);
    const missing = [...new Set(userIds)].filter((u) => !this.cards.has(u));
    if (missing.length) await this.refreshCards(missing);
    const targets = new Map();
    for (const userId of new Set(userIds)) {
      for (const device of this.cards.get(userId)?.devices || []) targets.set(device.deviceId, device);
    }
    for (const device of extraDevices) targets.set(device.deviceId, device);
    targets.delete(this.device.deviceId);
    const items = [];
    for (const device of targets.values()) {
      if (onlyDevices && !onlyDevices.has(device.deviceId)) continue;
      items.push({ id: randomId('v', 12), to: device.deviceId, data: await sealFor(device, message) });
    }
    if (items.length) await this.queue(items);
    return items.length;
  }

  async queue(items) {
    this.outbox.push(...items.map((item) => ({ ...item, at: Date.now() })));
    await this.store.kv.set('outbox', this.outbox);
    await this.flushOutbox();
  }

  async flushOutbox() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.outbox.length && this.transport.connected) {
        const batch = this.outbox.slice(0, 20);
        let result;
        try {
          result = await this.transport.send(batch);
        } catch {
          // Relay ocupado o caido: se reintenta solo, sin esperar al proximo envio.
          clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => void this.flushOutbox(), 1500);
          break;
        }
        const done = new Set([...(result.delivered || []), ...(result.queued || []), ...(result.rejected || [])]);
        if (result.rejected?.length) this.emit('toast', 'Un mensaje no se pudo entregar (demasiado grande o buzón lleno)');
        this.outbox = this.outbox.filter((item) => !done.has(item.id));
        await this.store.kv.set('outbox', this.outbox);
        if (!done.size) break;
      }
    })().finally(() => (this.flushing = null));
    return this.flushing;
  }

  pendingCount() {
    return this.outbox.length;
  }

  // ── Recepcion ─────────────────────────────────────────────────────────────

  async receive(env) {
    const ack = () => this.transport.ack?.([env.id]);
    if (this.seen.has(env.id)) return ack();
    this.seen.add(env.id);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
    let message;
    try {
      message = await unseal(this.prekeys, env.data);
    } catch {
      return ack();
    }
    try {
      await this.dispatch(message);
    } catch (err) {
      console.error('dispatch', message?.t, err);
    }
    return ack();
  }

  async senderKey(message) {
    if (message.from === this.identity?.userId) return this.identity.signPub;
    const known = this.cards.get(message.from);
    if (known) return known.signPub;
    const card = message.p?.card;
    if (card && card.userId === message.from && (await verifyCard(card))) return card.signPub;
    if (message.t === 'welcome' || message.t === 'link.welcome') {
      const fromWelcome = (message.p?.cards || []).find((c) => c?.userId === message.from) || message.p?.card;
      if (fromWelcome && fromWelcome.userId === message.from && (await verifyCard(fromWelcome))) return fromWelcome.signPub;
    }
    return null;
  }

  async dispatch(message) {
    if (message.t === 'link.request') return this.onLinkRequest(message);
    if (message.t === 'link.welcome') return this.onLinkWelcome(message);
    if (!this.identity || typeof message.from !== 'string') return;
    const signPub = await this.senderKey(message);
    if (!signPub || !(await verifyWrapped(message, signPub))) return;
    const p = message.p || {};
    switch (message.t) {
      case 'entry':
        return this.ingest([p.entry]);
      case 'cards':
        for (const card of (p.cards || []).slice(0, 64)) await this.acceptCard(card);
        return;
      case 'contact.request':
        return this.onContactRequest(message.from, p);
      case 'contact.reject':
        return this.onContactReject(p);
      case 'group.join':
        return this.onGroupJoin(message.from, p);
      case 'welcome':
        return this.onWelcome(message.from, p);
      case 'sync.req':
        return this.onSyncRequest(message.from, message.fd, p);
      case 'sync.res':
        return this.ingest(p.entries || []);
      case 'legacy.share':
        return this.onLegacyShare(message.from, p);
      default:
    }
  }

  // ── Chats ─────────────────────────────────────────────────────────────────

  async loadChat(chatId) {
    const entries = await this.store.entries.list(chatId);
    const { state, accepted } = await buildState(chatId, entries);
    this.chats.set(chatId, { state, entries: new Map(accepted.map((e) => [e.id, e])) });
  }

  async saveChatIndex() {
    await this.store.kv.set('chats', [...this.chats.keys()]);
  }

  async savePrefs() {
    await this.store.kv.set('prefs', this.prefs);
  }

  // Incorpora entradas recibidas (en vivo o por sincronizacion). Solo se guardan las que el
  // estado acepta; las demas se descartan.
  async ingest(entries) {
    const now = Date.now();
    const byChat = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry.chat !== 'string' || typeof entry.id !== 'string' || !Number.isInteger(entry.ts)) continue;
      if (entry.ts > now + MAX_CLOCK_SKEW_MS) continue;
      const removedAt = this.prefs.removedChats[entry.chat];
      if (removedAt && entry.ts <= removedAt) continue;
      if (!byChat.has(entry.chat)) byChat.set(entry.chat, []);
      byChat.get(entry.chat).push(entry);
    }
    for (const [chatId, list] of byChat) await this.ingestChat(chatId, list);
  }

  async ingestChat(chatId, list) {
    let chat = this.chats.get(chatId);
    const fresh = list.filter((e) => !chat?.entries.has(e.id));
    if (!fresh.length) return;
    if (!chat && !fresh.some((e) => e.type === 'chat.create')) {
      // Llego antes que la bienvenida: se guarda un rato y se reintenta con el estado.
      const parked = this.orphans.get(chatId) || [];
      this.orphans.set(chatId, [...parked, ...fresh].slice(-200));
      return;
    }
    const parked = this.orphans.get(chatId) || [];
    this.orphans.delete(chatId);
    const previous = chat ? [...chat.entries.values()] : [];
    const { state, accepted } = await buildState(chatId, [...previous, ...fresh, ...parked]);
    const known = new Set(previous.map((e) => e.id));
    const added = accepted.filter((e) => !known.has(e.id));
    if (!added.length && chat) return;
    const meId = this.identity.userId;
    if (!state.kind || state.deleted || !state.members.has(meId)) {
      // Solo se marca como quitado un chat que existia aca: un estado ajeno que llega suelto
      // no tiene que bloquear una invitacion futura al mismo chat.
      if (chat) await this.removeChatLocal(chatId, state.deleted ? 'deleted' : 'removed');
      return;
    }
    const now = Date.now();
    for (const entry of added) {
      const stored = entry.type === 'msg' && entry.body?.expiresAt && entry.body.expiresAt <= now ? tombstone(entry) : entry;
      await this.store.entries.put(stored);
    }
    this.chats.set(chatId, { state, entries: new Map(accepted.map((e) => [e.id, e])) });
    if (!chat) await this.saveChatIndex();
    const incoming = added.filter((e) => e.type === 'msg' && e.author !== meId);
    this.emit('chat', { chatId, added: added.map((e) => e.id), incoming: incoming.length, created: !chat });
    this.resolveWaiters(chatId);
  }

  async removeChatLocal(chatId, reason) {
    this.chats.delete(chatId);
    this.prefs.removedChats[chatId] = Date.now();
    delete this.prefs.timers[chatId];
    delete this.prefs.lastRead[chatId];
    await this.store.entries.removeChat(chatId);
    await this.saveChatIndex();
    await this.savePrefs();
    this.emit('chat:removed', { chatId, reason });
  }

  // Crea una entrada propia, la valida contra el estado y la replica. Los destinatarios son
  // los miembros antes y despues del cambio: un expulsado recibe su propia expulsion.
  async append(chatId, type, body) {
    const chat = this.chats.get(chatId);
    if (!chat && type !== 'chat.create') throw new Error('Chat no encontrado');
    const entry = await createEntry(this.identity, { chat: chatId, type, body });
    const previous = chat ? [...chat.entries.values()] : [];
    const { state, accepted } = await buildState(chatId, [...previous, entry]);
    if (!accepted.some((e) => e.id === entry.id)) throw new Error('No tenés permiso para hacer eso');
    const before = chat ? [...chat.state.members.keys()] : [];
    const recipients = [...new Set([...before, ...state.members.keys()])];
    if (!state.kind || state.deleted || !state.members.has(this.identity.userId)) {
      await this.removeChatLocal(chatId, 'left');
    } else {
      await this.store.entries.put(entry);
      this.chats.set(chatId, { state, entries: new Map(accepted.map((e) => [e.id, e])) });
      if (!chat) await this.saveChatIndex();
      this.emit('chat', { chatId, added: [entry.id], incoming: 0, created: !chat });
    }
    await this.sendTo(recipients, 'entry', { entry });
    return entry;
  }

  listChats() {
    const meId = this.identity?.userId;
    return [...this.chats.values()].map(({ state }) => {
      const other = state.kind === 'contact' ? [...state.members.keys()].find((id) => id !== meId) : null;
      const messages = this.visibleMessages(state);
      const last = messages.at(-1);
      return {
        id: state.id,
        kind: state.kind,
        title: state.kind === 'group' ? state.name : this.nameOf(other),
        otherUserId: other,
        role: roleOf(state, meId),
        founderId: state.founderId,
        membersCanWrite: state.membersCanWrite,
        unread: this.unreadCount(state),
        lastTs: last?.ts || state.createdAt,
        timerSeconds: this.prefs.timers[state.id] || 0
      };
    }).sort((a, b) => b.lastTs - a.lastTs);
  }

  chatInfo(chatId) {
    return this.listChats().find((c) => c.id === chatId) || null;
  }

  visibleMessages(state) {
    const now = Date.now();
    const joinedAt = state.members.get(this.identity?.userId)?.joinedAt || 0;
    return state.messages.filter((m) => !(m.body.expiresAt && m.body.expiresAt <= now) && m.ts >= joinedAt);
  }

  messages(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat) return [];
    const meId = this.identity.userId;
    const items = this.visibleMessages(chat.state).map((m) => ({
      id: m.id,
      chatId,
      senderId: m.author,
      senderName: this.nameOf(m.author),
      mine: m.author === meId,
      ts: m.ts,
      kind: m.body.kind,
      text: m.body.kind === 'text' ? m.body.text : '',
      audio: m.body.kind === 'audio' ? m.body.audio : null,
      mime: m.body.mime || null,
      durationMs: m.body.durationMs || null,
      expiresAt: m.body.expiresAt || null
    }));
    const joinedAt = chat.state.members.get(meId)?.joinedAt || 0;
    const events = chat.state.events.filter((e) => e.ts >= joinedAt).map((e) => ({
      id: e.id, chatId, system: true, ts: e.ts, kind: 'event', text: this.eventText(e), mine: false, senderId: e.userId, senderName: this.nameOf(e.userId)
    }));
    return [...items, ...events].sort((a, b) => a.ts - b.ts);
  }

  eventText(event) {
    const name = this.nameOf(event.userId);
    if (event.type === 'joined') return `${name} se unió al grupo`;
    if (event.type === 'left') return `${name} salió del grupo`;
    if (event.type === 'removed') return `${name} fue quitado del grupo`;
    if (event.type === 'screenshot') return `${name} sacó una captura de pantalla`;
    return '';
  }

  members(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat) return [];
    return memberList(chat.state).map((m) => ({ ...m, name: this.nameOf(m.userId) })).sort((a, b) => a.joinedAt - b.joinedAt);
  }

  unreadCount(state) {
    const meId = this.identity?.userId;
    const lastRead = this.prefs.lastRead[state.id] || 0;
    return this.visibleMessages(state).filter((m) => m.author !== meId && m.ts > lastRead).length;
  }

  async markRead(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    const last = chat.state.messages.at(-1)?.ts || 0;
    this.prefs.lastRead[chatId] = Math.max(Date.now(), last);
    await this.savePrefs();
  }

  // ── Mensajes ──────────────────────────────────────────────────────────────

  async setTimer(chatId, seconds) {
    const value = Number(seconds);
    if (!TIMER_OPTIONS.includes(value)) throw new Error('Temporizador inválido');
    if (value) this.prefs.timers[chatId] = value;
    else delete this.prefs.timers[chatId];
    await this.savePrefs();
  }

  expiryFor(chatId, kind) {
    const seconds = this.prefs.timers[chatId] || 0;
    if (seconds) return Date.now() + seconds * 1000;
    // Los audios nunca quedan para siempre: sin temporizador duran un dia.
    return kind === 'audio' ? Date.now() + AUDIO_DEFAULT_TTL_MS : undefined;
  }

  async sendText(chatId, text) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    return this.append(chatId, 'msg', { kind: 'text', text: clean, expiresAt: this.expiryFor(chatId, 'text') });
  }

  async sendAudio(chatId, audioB64, mime, durationMs) {
    return this.append(chatId, 'msg', { kind: 'audio', audio: audioB64, mime: String(mime || 'audio/webm').slice(0, 64), durationMs: Math.max(0, Math.round(durationMs)), expiresAt: this.expiryFor(chatId, 'audio') });
  }

  async reportScreenshot(chatId) {
    if (!this.chats.has(chatId)) return null;
    return this.append(chatId, 'screenshot', {});
  }

  // Borra lo vencido del estado y del almacen. Deja una lapida con el mismo id para que una
  // sincronizacion no lo vuelva a traer.
  async sweepExpired() {
    const now = Date.now();
    let removed = 0;
    for (const [chatId, chat] of this.chats) {
      const expired = chat.state.messages.filter((m) => m.body.expiresAt && m.body.expiresAt <= now);
      if (!expired.length) continue;
      for (const entry of expired) {
        const stone = tombstone(entry);
        chat.entries.set(entry.id, stone);
        await this.store.entries.put(stone);
      }
      const ids = new Set(expired.map((e) => e.id));
      chat.state.messages = chat.state.messages.filter((m) => !ids.has(m.id));
      removed += expired.length;
      this.emit('chat', { chatId, added: [], incoming: 0, expired: expired.length });
    }
    return removed;
  }

  // ── Grupos ────────────────────────────────────────────────────────────────

  myMember() {
    return { userId: this.identity.userId, signPub: this.identity.signPub, name: this.card.name };
  }

  async createGroup(name) {
    const clean = cleanName(name || 'Grupo OTP');
    if (!clean) throw new Error('El nombre del grupo debe tener entre 1 y 64 caracteres');
    const chatId = randomId('g', 16);
    await this.append(chatId, 'chat.create', { kind: 'group', name: clean, members: [this.myMember()] });
    return chatId;
  }

  async setGroupSettings(chatId, settings) {
    return this.append(chatId, 'chat.settings', settings);
  }

  async removeMembers(chatId, userIds) {
    for (const userId of userIds) await this.append(chatId, 'member.remove', { userId });
  }

  async setRole(chatId, userIds, role) {
    for (const userId of userIds) await this.append(chatId, 'role.set', { userId, role });
  }

  async leaveGroup(chatId) {
    return this.append(chatId, 'member.leave', {});
  }

  async deleteChat(chatId) {
    return this.append(chatId, 'chat.delete', {});
  }

  async safetyCode(chatId) {
    const chat = this.chats.get(chatId);
    if (chat?.state.kind !== 'contact') return null;
    const other = [...chat.state.members.values()].find((m) => m.userId !== this.identity.userId);
    return other ? safetyCode(this.identity.signPub, other.signPub) : null;
  }

  // ── Invitaciones ──────────────────────────────────────────────────────────

  async createInvite(kind, groupId) {
    if (kind === 'group') {
      const chat = this.chats.get(groupId);
      if (!chat || !canModerate(roleOf(chat.state, this.identity.userId))) throw new Error('Requiere admin o subadmin');
    }
    const token = randomId('t', 16);
    const expiresAt = Date.now() + INVITE_TTL_MS;
    this.pendingInvites.set(token, { kind, groupId, expiresAt });
    const invite = { kind: kind === 'group' ? 'g' : 'c', k: this.identity.signPub, u: this.identity.userId, d: this.device.deviceId, t: token, ...(kind === 'group' ? { g: groupId } : {}) };
    return { token, expiresAt, link: inviteLink(this.origin, invite) };
  }

  cancelInvite(token) {
    this.pendingInvites.delete(token);
  }

  takeInvite(token, kind) {
    const invite = this.pendingInvites.get(token);
    if (!invite || invite.kind !== kind || invite.expiresAt <= Date.now()) return null;
    return invite;
  }

  // Lo que ve el invitado antes de aceptar: quien invita y a que.
  async inspectInvite(payload) {
    const invite = typeof payload === 'string' ? decodeInvite(payload) : payload;
    if (!invite) throw new Error('Link de invitación inválido');
    const [card] = await this.transport.getCards([invite.u]);
    if (!card || card.signPub !== invite.k || !(await verifyCard(card))) throw new Error('La invitación venció o quien invita no está conectado');
    await this.acceptCard(card);
    return { invite, inviter: { userId: card.userId, name: card.name }, kind: invite.kind };
  }

  async acceptInvite(payload) {
    const { invite } = await this.inspectInvite(payload);
    if (invite.u === this.identity.userId) throw new Error('No podés aceptar tu propia invitación');
    const expected = invite.kind === 'g' ? invite.g : await contactChatId(invite.u, this.identity.userId);
    const wait = this.waitForChat(expected);
    await this.sendTo([invite.u], invite.kind === 'g' ? 'group.join' : 'contact.request', { token: invite.t, card: this.card }, { onlyDevices: new Set([invite.d]) });
    await wait;
    return expected;
  }

  async rejectInvite(payload) {
    const invite = typeof payload === 'string' ? decodeInvite(payload) : payload;
    if (!invite || invite.kind !== 'c') return;
    await this.sendTo([invite.u], 'contact.reject', { token: invite.t, card: this.card }, { onlyDevices: new Set([invite.d]) });
  }

  waitForChat(chatId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(chatId);
        reject(new Error('Quien invita no respondió. Pedí un QR nuevo.'));
      }, this.waitMs);
      this.waiters.set(chatId, () => { clearTimeout(timer); resolve(chatId); });
    });
  }

  resolveWaiters(chatId) {
    const waiter = this.waiters.get(chatId);
    if (waiter) {
      this.waiters.delete(chatId);
      waiter();
    }
  }

  async onContactRequest(from, p) {
    if (!this.takeInvite(p.token, 'contact')) return;
    this.pendingInvites.delete(p.token);
    if (!(await this.acceptCard(p.card)) && !this.cards.has(from)) return;
    const chatId = await contactChatId(this.identity.userId, from);
    const existing = this.chats.get(chatId);
    const them = p.card;
    if (!existing) {
      await this.append(chatId, 'chat.create', { kind: 'contact', members: [this.myMember(), { userId: them.userId, signPub: them.signPub, name: them.name }] });
    }
    await this.sendWelcome(chatId, [from]);
    this.emit('contact:accepted', { chatId, name: them.name });
  }

  onContactReject(p) {
    if (!this.takeInvite(p.token, 'contact')) return;
    this.pendingInvites.delete(p.token);
    this.emit('invite:rejected', {});
  }

  async onGroupJoin(from, p) {
    const invite = this.takeInvite(p.token, 'group');
    if (!invite) return;
    const chat = this.chats.get(invite.groupId);
    if (!chat || !canModerate(roleOf(chat.state, this.identity.userId))) return;
    if (!(await verifyCard(p.card)) || p.card.userId !== from) return;
    await this.acceptCard(p.card);
    if (!chat.state.members.has(from)) {
      await this.append(invite.groupId, 'member.add', { member: { userId: from, signPub: p.card.signPub, name: p.card.name } });
      const others = [...this.chats.get(invite.groupId).state.members.keys()].filter((u) => u !== from);
      await this.sendTo(others, 'cards', { cards: [p.card] });
    }
    await this.sendWelcome(invite.groupId, [from]);
    this.emit('group:joined', { chatId: invite.groupId, name: p.card.name });
  }

  // Estructura del chat (sin mensajes viejos) mas las tarjetas de todos los miembros, para
  // que el recien llegado pueda validar el estado y escribirle a cada uno.
  async sendWelcome(chatId, userIds) {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    const entries = [...chat.entries.values()].filter((e) => STRUCTURAL.has(e.type));
    const cards = [...chat.state.members.keys()].map((u) => (u === this.identity.userId ? this.card : this.cards.get(u))).filter(Boolean);
    await this.sendTo(userIds, 'welcome', { chat: chatId, entries, cards });
  }

  async onWelcome(from, p) {
    for (const card of (p.cards || []).slice(0, 256)) await this.acceptCard(card);
    await this.ingest(p.entries || []);
    // Volver a agregar un contacto que ya existe no trae entradas nuevas, pero la bienvenida
    // igual confirma la aceptacion.
    if (this.chats.get(p.chat)?.state.members.has(this.identity.userId)) this.resolveWaiters(p.chat);
  }

  // ── Sincronizacion ────────────────────────────────────────────────────────

  async requestSync(chatId) {
    const ids = chatId ? [chatId] : [...this.chats.keys()];
    for (const id of ids) {
      const chat = this.chats.get(id);
      if (!chat) continue;
      const users = [...chat.state.members.keys()];
      const have = [...chat.entries.keys()].slice(-4000);
      await this.sendTo(users, 'sync.req', { chat: id, have }, { onlyDevices: await this.onlineDevices(users) });
    }
  }

  async onlineDevices(users) {
    const devices = users.flatMap((u) => (u === this.identity.userId ? this.ownDevices() : this.cards.get(u)?.devices || []).map((d) => d.deviceId));
    try {
      const online = await this.transport.presence?.(devices);
      return new Set(online || []);
    } catch {
      return new Set();
    }
  }

  async onSyncRequest(from, fromDevice, p) {
    const chat = this.chats.get(p.chat);
    if (!chat) return;
    const own = from === this.identity.userId;
    const member = chat.state.members.get(from);
    if (!own && !member) return;
    const have = new Set(Array.isArray(p.have) ? p.have : []);
    const joinedAt = own ? 0 : member.joinedAt;
    const now = Date.now();
    const missing = [...chat.entries.values()].filter((e) => !have.has(e.id) && !e.tombstone
      && (STRUCTURAL.has(e.type) || e.ts >= joinedAt)
      && !(e.type === 'msg' && e.body?.expiresAt && e.body.expiresAt <= now));
    const device = (own ? this.ownDevices() : this.cards.get(from)?.devices || []).filter((d) => d.deviceId === fromDevice);
    let chunk = [];
    let size = 0;
    const flush = async () => {
      if (!chunk.length) return;
      await this.sendTo([from], 'sync.res', { chat: p.chat, entries: chunk }, { onlyDevices: new Set(device.map((d) => d.deviceId)) });
      chunk = [];
      size = 0;
    };
    for (const entry of missing) {
      const bytes = JSON.stringify(entry).length;
      if (size + bytes > SYNC_CHUNK_BYTES) await flush();
      chunk.push(entry);
      size += bytes;
    }
    await flush();
    // Reciproco: quien pide tambien puede tener lo que a este nodo le falta (por ejemplo, si
    // el relay se reinicio y perdio el buzon). Una sola vuelta, para no entrar en un bucle.
    if (!p.reply) {
      const have = [...chat.entries.keys()].slice(-4000);
      await this.sendTo([from], 'sync.req', { chat: p.chat, have, reply: true }, { onlyDevices: new Set(device.map((d) => d.deviceId)) });
    }
  }

  // ── Perfil y dispositivos ─────────────────────────────────────────────────

  async rename(name) {
    const clean = cleanName(name, 32);
    if (!clean) throw new Error('Elegí un nombre de 1 a 32 caracteres');
    await this.publishCard({ name: clean });
    await this.broadcastCard();
  }

  async unlinkDevice(deviceId) {
    if (deviceId === this.device.deviceId) throw new Error('No podés desvincular este dispositivo desde sí mismo');
    await this.publishCard({ devices: this.ownDevices().filter((d) => d.deviceId !== deviceId) });
    await this.broadcastCard();
  }

  async createLinkInvite() {
    const token = randomId('t', 16);
    const expiresAt = Date.now() + LINK_TTL_MS;
    this.pendingInvites.set(token, { kind: 'link', expiresAt });
    const invite = { kind: 'l', k: this.identity.signPub, u: this.identity.userId, d: this.device.deviceId, t: token };
    return { token, expiresAt, link: inviteLink(this.origin, invite) };
  }

  // Dispositivo nuevo, sin identidad: le pide al que muestra el QR que lo vincule.
  async acceptLinkInvite(payload) {
    if (this.identity) throw new Error('Este dispositivo ya tiene una cuenta');
    const invite = typeof payload === 'string' ? decodeInvite(payload) : payload;
    if (invite?.kind !== 'l') throw new Error('Link de vinculación inválido');
    const [card] = await this.transport.getCards([invite.u]);
    if (!card || card.signPub !== invite.k || !(await verifyCard(card))) throw new Error('El otro dispositivo no está conectado');
    const target = card.devices.find((d) => d.deviceId === invite.d);
    if (!target) throw new Error('El otro dispositivo no está conectado');
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.linking = null; reject(new Error('El otro dispositivo no respondió')); }, 60_000);
      this.linking = { invite, resolve: (v) => { clearTimeout(timer); resolve(v); } };
    });
    const message = await wrap(null, this.device.deviceId, 'link.request', { token: invite.t, deviceId: this.device.deviceId, prekey: this.prekeys[0].pub, prekeyAt: this.prekeys[0].createdAt });
    await this.queue([{ id: randomId('v', 12), to: target.deviceId, data: await sealFor(target, message) }]);
    return done;
  }

  async onLinkRequest(message) {
    if (!this.identity) return;
    const p = message.p || {};
    if (!this.takeInvite(p.token, 'link')) return;
    this.pendingInvites.delete(p.token);
    if (typeof p.deviceId !== 'string' || typeof p.prekey !== 'string' || p.deviceId !== message.fd) return;
    const device = { deviceId: p.deviceId, prekey: p.prekey, prekeyAt: p.prekeyAt };
    await this.publishCard({ devices: [...this.ownDevices(), device] });
    const chats = {};
    for (const [chatId, chat] of this.chats) chats[chatId] = [...chat.entries.values()].filter((e) => !e.tombstone);
    const snapshot = { identity: await exportIdentity(this.identity), card: this.card, cards: [...this.cards.values()], chats, prefs: this.prefs };
    const welcome = await wrap(this.identity, this.device.deviceId, 'link.welcome', snapshot);
    await this.queue([{ id: randomId('v', 12), to: device.deviceId, data: await sealFor(device, welcome) }]);
    await this.broadcastCard();
    this.emit('device:linked', { deviceId: device.deviceId });
  }

  async onLinkWelcome(message) {
    const pending = this.linking;
    if (!pending || this.identity) return;
    const p = message.p || {};
    if (p.identity?.signPub !== pending.invite.k || message.from !== pending.invite.u) return;
    if (!(await verifyWrapped(message, pending.invite.k))) return;
    await this.restoreSnapshot(p);
    this.linking = null;
    pending.resolve(this.me());
  }

  async restoreSnapshot(snapshot) {
    this.identity = await importIdentity(snapshot.identity);
    await this.store.kv.set('identity', snapshot.identity);
    for (const card of snapshot.cards || []) {
      if (await verifyCard(card)) this.cards.set(card.userId, card);
    }
    await this.saveCards();
    if (snapshot.card && (await verifyCard(snapshot.card))) {
      this.card = snapshot.card;
    }
    this.prefs = { timers: {}, lastRead: {}, removedChats: {}, ...(snapshot.prefs || {}) };
    await this.savePrefs();
    for (const [chatId, entries] of Object.entries(snapshot.chats || {})) {
      for (const entry of entries) await this.store.entries.put(entry);
      await this.loadChat(chatId);
      if (!this.chats.get(chatId)?.state.members.has(this.identity.userId)) {
        this.chats.delete(chatId);
        await this.store.entries.removeChat(chatId);
      }
    }
    await this.saveChatIndex();
    // La tarjeta vuelve a firmarse con este dispositivo adentro y su prekey actual.
    await this.publishCard({ name: this.card?.name || 'Sin nombre', devices: this.card?.devices || [] });
    await this.broadcastCard();
    this.emit('identity', this.me());
  }

  async exportBackup(passphrase) {
    if (!passphrase || passphrase.length < 8) throw new Error('La frase debe tener al menos 8 caracteres');
    const chats = {};
    for (const [chatId, chat] of this.chats) chats[chatId] = [...chat.entries.values()].filter((e) => !e.tombstone);
    return encryptWithPassphrase(passphrase, { identity: await exportIdentity(this.identity), card: this.card, cards: [...this.cards.values()], chats, prefs: this.prefs, at: Date.now() });
  }

  async importBackup(file, passphrase) {
    if (this.identity) throw new Error('Este dispositivo ya tiene una cuenta');
    const snapshot = await decryptWithPassphrase(passphrase, file);
    await this.restoreSnapshot(snapshot);
    return this.me();
  }

  // ── Historial de la version anterior ──────────────────────────────────────

  async legacyChats() {
    return (await this.store.kv.get('legacy')) || [];
  }

  async saveLegacyChats(chats) {
    await this.store.kv.set('legacy', chats);
    this.emit('legacy', {});
  }

  // Suma un historial v1 al que ya hay (union por id de mensaje). Lo usan la importacion
  // propia y lo que comparte otro participante.
  async mergeLegacyChat(incoming) {
    const chats = await this.legacyChats();
    const current = chats.find((c) => c.id === incoming.id);
    if (!current) {
      chats.push({ ...incoming, messages: [...incoming.messages].sort((a, b) => a.ts - b.ts) });
    } else {
      const byId = new Map(current.messages.map((m) => [m.id, m]));
      for (const m of incoming.messages) if (!byId.has(m.id)) byId.set(m.id, m);
      current.messages = [...byId.values()].sort((a, b) => a.ts - b.ts);
      current.v2ChatId = current.v2ChatId || incoming.v2ChatId;
      current.title = current.title || incoming.title;
      // Si ahora hay mensajes propios descifrados, deja de ser "solo compartido".
      if (!incoming.sharedBy) delete current.sharedBy;
    }
    await this.saveLegacyChats(chats);
  }

  // Comparte con un participante el historial v1 de un chat que ya existe en v2. Va sellado
  // como todo lo demas, en partes, y solo a miembros del chat nuevo.
  async shareLegacy(chatId, userId, archive) {
    const chat = this.chats.get(chatId);
    if (!chat?.state.members.has(userId) || !archive.messages.length) return 0;
    const meta = { id: archive.id, kind: archive.kind, title: archive.title };
    let part = [];
    let size = 0;
    let sent = 0;
    const flush = async () => {
      if (!part.length) return;
      await this.sendTo([userId], 'legacy.share', { chat: chatId, archive: { ...meta, messages: part } });
      sent += part.length;
      part = [];
      size = 0;
    };
    for (const m of archive.messages) {
      const bytes = JSON.stringify(m).length;
      if (size + bytes > SYNC_CHUNK_BYTES) await flush();
      part.push(m);
      size += bytes;
    }
    await flush();
    return sent;
  }

  async onLegacyShare(from, p) {
    const chat = this.chats.get(p?.chat);
    if (!chat?.state.members.has(from) || from === this.identity.userId) return;
    const archive = p.archive;
    if (typeof archive?.id !== 'string' || !/^legacy_(contact|group)_[A-Za-z0-9_:-]{1,128}$/.test(archive.id) || !Array.isArray(archive.messages)) return;
    const clean = archive.messages.slice(0, 5000).filter((m) => typeof m?.id === 'string' && Number.isInteger(m.ts)).map((m) => ({
      id: m.id.slice(0, 64),
      ts: m.ts,
      mine: m.mine === true,
      senderName: String(m.senderName || '').slice(0, 64),
      kind: m.kind === 'audio' ? 'audio' : 'text',
      text: String(m.text || '').slice(0, 16_000),
      ...(m.kind === 'audio' && typeof m.audio === 'string' ? { audio: m.audio, mime: String(m.mime || 'audio/webm').slice(0, 64), durationMs: Number(m.durationMs) || 0 } : {})
    }));
    const existing = (await this.legacyChats()).find((c) => c.id === archive.id);
    await this.mergeLegacyChat({
      id: archive.id,
      kind: archive.kind === 'group' ? 'group' : 'contact',
      // En un contacto el titulo que manda el otro es su vista (mi nombre): aca va el suyo.
      title: existing?.title || (archive.kind === 'group' ? String(archive.title || '').slice(0, 64) : this.nameOf(from)),
      v2ChatId: chat.state.id,
      importedAt: Date.now(),
      // Nadie puede verificar un historial viejo que manda otro: se marca de donde vino.
      ...(existing && !existing.sharedBy ? {} : { sharedBy: this.nameOf(from) }),
      messages: clean
    });
  }

  async wipe() {
    await this.store.clear();
  }
}

function tombstone(entry) {
  return { id: entry.id, chat: entry.chat, ts: entry.ts, type: entry.type, tombstone: true };
}

export { canWrite, roleOf, canModerate };
