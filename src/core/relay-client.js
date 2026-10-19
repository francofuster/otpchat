// Cliente del relay. Usa el WebSocket global (navegador, Electron, Capacitor y Node 22+).
// Se reconecta solo con espera creciente y reautentica con la clave del dispositivo.
import { signChallenge } from './protocol.js';

const REQUEST_TIMEOUT_MS = 20_000;

export class RelayClient {
  /** @param {{ url?: string, WebSocketImpl?: any }} [options] */
  constructor({ url, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.connected = false;
    this.listeners = new Map();
    this.pending = new Map();
    this.rid = 0;
    this.creds = null;
    this.retry = 0;
    this.closed = false;
    this.info = {};
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  emit(type, data) {
    for (const fn of this.listeners.get(type) || []) {
      try { fn(data); } catch (err) { console.error(`relay ${type}`, err); }
    }
  }

  connect({ device, card }) {
    this.creds = { device, card };
    this.closed = false;
    if (this.socket && this.socket.readyState <= 1) return Promise.resolve();
    return new Promise((resolve) => {
      const done = this.on('ready', () => { done(); resolve(); });
      this.open();
      // No se bloquea el arranque si el relay no responde: el nodo sigue funcionando local.
      setTimeout(() => { done(); resolve(); }, 8000);
    });
  }

  open() {
    if (this.closed) return;
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch {
      return this.scheduleReconnect();
    }
    this.socket = socket;
    socket.onmessage = (event) => void this.onFrame(event.data);
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      const was = this.connected;
      this.connected = false;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('relay desconectado')); }
      this.pending.clear();
      if (was) this.emit('close', { code: event.code });
      if (event.code === 4409) {
        this.emit('replaced');
        return;
      }
      this.scheduleReconnect();
    };
    socket.onerror = () => {};
  }

  scheduleReconnect() {
    if (this.closed) return;
    const wait = Math.min(30_000, 1000 * 2 ** this.retry++);
    setTimeout(() => this.open(), wait);
  }

  async onFrame(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (msg.t === 'challenge') {
      const { device, card } = this.creds;
      const sig = await signChallenge(device, msg.nonce);
      this.raw({ t: 'auth', deviceId: device.deviceId, pub: device.pub, sig, ...(card ? { card } : {}) });
      return;
    }
    if (msg.t === 'ready') {
      this.connected = true;
      this.retry = 0;
      this.info = msg.info || {};
      this.emit('ready', this.info);
      return;
    }
    if (msg.t === 'env') return this.emit('envelope', { id: msg.id, from: msg.from, data: msg.data, via: 'relay' });
    if (msg.t === 'signal') return this.emit('signal', { from: msg.from, data: msg.data });
    if (msg.t === 'res') {
      const pending = this.pending.get(msg.rid);
      if (!pending) return;
      this.pending.delete(msg.rid);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.data);
    }
  }

  raw(message) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }

  request(t, payload) {
    if (!this.connected) return Promise.reject(new Error('relay desconectado'));
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error('relay sin respuesta')); }, REQUEST_TIMEOUT_MS);
      this.pending.set(rid, { resolve, reject, timer });
      this.raw({ ...payload, t, rid });
    });
  }

  send(items) {
    return this.request('send', { items: items.map(({ id, to, data }) => ({ id, to, data })) });
  }

  ack(ids) {
    if (ids.length) this.raw({ t: 'ack', ids });
  }

  async getCards(userIds) {
    return (await this.request('cards.get', { userIds })) || [];
  }

  publishCard(card) {
    if (this.creds) this.creds.card = card;
    this.raw({ t: 'card', card });
  }

  async presence(deviceIds) {
    if (!deviceIds.length) return [];
    return (await this.request('presence', { deviceIds })) || [];
  }

  signal(to, data) {
    this.raw({ t: 'signal', to, data });
  }

  registerPush(subscription) {
    return this.request('push.register', { subscription });
  }

  unregisterPush() {
    return this.request('push.unregister', {});
  }

  close() {
    this.closed = true;
    this.connected = false;
    this.socket?.close();
  }
}
