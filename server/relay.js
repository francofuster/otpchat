// Relay de OTPChat v2. No tiene base de datos: todo vive en memoria y nada sobrevive a un
// reinicio. Hace cuatro cosas:
//  - Buzon: guarda sobres sellados para dispositivos desconectados y los BORRA en cuanto el
//    destino confirma la recepcion (o al vencer el TTL).
//  - Directorio de tarjetas firmadas, para encontrar las prekeys de alguien.
//  - Senalizacion WebRTC entre dispositivos conectados.
//  - Aviso push "Mensajes nuevos" (sin contenido) a dispositivos desconectados.
// No ve contenido: los sobres son opacos y las tarjetas estan firmadas por su duenio.
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { verifyCard, verifyChallenge } from '../src/core/protocol.js';

const DEFAULTS = {
  mailboxTtlMs: 7 * 24 * 60 * 60_000,
  maxEnvelopeBytes: 6 * 1024 * 1024,
  maxMailboxBytes: 60 * 1024 * 1024,
  maxMailboxItems: 2000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxCards: 50_000,
  cardTtlMs: 45 * 24 * 60 * 60_000,
  authTimeoutMs: 10_000,
  // Tope por conexion: mensajes por segundo (rafaga) y bytes por minuto.
  rateBurst: 200,
  ratePerSec: 50,
  bytesPerMinute: 60 * 1024 * 1024,
  pushThrottleMs: 60_000
};

const ID = /^[A-Za-z0-9_-]{4,64}$/;

export function createRelay({ allowedOrigins = [], push = null, ...overrides } = {}) {
  const opts = { ...DEFAULTS, ...overrides };
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxEnvelopeBytes * 1.5 + 64 * 1024 });
  const online = new Map();
  const mailboxes = new Map();
  const inflight = new Map();
  const cards = new Map();
  const pushSubs = new Map();
  const lastPush = new Map();
  let totalBytes = 0;

  function originAllowed(origin) {
    if (!origin || !allowedOrigins.length) return true;
    return allowedOrigins.includes(origin);
  }

  function handleUpgrade(req, socket, head) {
    if (!originAllowed(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  }

  function send(ws, message) {
    if (ws.readyState === 1) ws.send(JSON.stringify(message));
  }

  function mailbox(deviceId) {
    if (!mailboxes.has(deviceId)) mailboxes.set(deviceId, { items: [], bytes: 0 });
    return mailboxes.get(deviceId);
  }

  function enqueue(to, item) {
    const box = mailbox(to);
    if (box.items.length >= opts.maxMailboxItems || box.bytes + item.size > opts.maxMailboxBytes || totalBytes + item.size > opts.maxTotalBytes) return false;
    box.items.push(item);
    box.bytes += item.size;
    totalBytes += item.size;
    return true;
  }

  function dropFromMailbox(deviceId, ids) {
    const box = mailboxes.get(deviceId);
    if (!box) return;
    box.items = box.items.filter((item) => {
      if (!ids.has(item.id)) return true;
      box.bytes -= item.size;
      totalBytes -= item.size;
      return false;
    });
    if (!box.items.length) mailboxes.delete(deviceId);
  }

  // Entrega en vivo: el sobre queda "en vuelo" hasta el ack. Si la conexion se corta antes,
  // vuelve al buzon; si llega el ack, desaparece del servidor.
  function deliver(ws, item) {
    inflight.set(item.id, { to: ws.deviceId, item, ws });
    send(ws, { t: 'env', id: item.id, from: item.from, data: item.data });
  }

  function flushMailbox(ws) {
    const box = mailboxes.get(ws.deviceId);
    if (!box) return;
    const now = Date.now();
    const items = box.items.filter((item) => item.expiresAt > now);
    totalBytes -= box.bytes;
    mailboxes.delete(ws.deviceId);
    for (const item of items) deliver(ws, item);
  }

  async function notifyPush(deviceId) {
    if (!push) return;
    const subscription = pushSubs.get(deviceId);
    if (!subscription) return;
    const now = Date.now();
    if (now - (lastPush.get(deviceId) || 0) < opts.pushThrottleMs) return;
    lastPush.set(deviceId, now);
    try {
      await push.send(subscription, JSON.stringify({ title: 'Mensajes nuevos' }));
    } catch (err) {
      if ([404, 410].includes(err?.statusCode)) pushSubs.delete(deviceId);
    }
  }

  function storeCard(card) {
    const current = cards.get(card.userId);
    if (current && current.card.ts >= card.ts) {
      current.seenAt = Date.now();
      return;
    }
    if (!current && cards.size >= opts.maxCards) {
      const oldest = [...cards.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt)[0];
      if (oldest) cards.delete(oldest[0]);
    }
    cards.set(card.userId, { card, seenAt: Date.now() });
  }

  function onConnection(ws) {
    const nonce = randomBytes(24).toString('base64url');
    ws.bucket = opts.rateBurst;
    ws.bucketAt = Date.now();
    ws.bytesWindow = { start: Date.now(), bytes: 0 };
    const authTimer = setTimeout(() => ws.close(4401, 'auth'), opts.authTimeoutMs);
    send(ws, { t: 'challenge', nonce });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return ws.close(4400, 'binary');
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // Al pasarse del limite se contesta el pedido con error (el cliente reintenta enseguida)
      // en vez de descartarlo en silencio y dejarlo esperando el timeout.
      if (!allow(ws, raw.length)) return send(ws, msg?.rid ? { t: 'res', rid: msg.rid, error: 'rate' } : { t: 'error', error: 'rate' });
      void handle(ws, msg, nonce, authTimer).catch((err) => {
        if (msg?.rid) send(ws, { t: 'res', rid: msg.rid, error: 'error interno' });
        console.error('relay', msg?.t, err?.message);
      });
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!ws.deviceId) return;
      if (online.get(ws.deviceId) === ws) online.delete(ws.deviceId);
      // Lo que se le entrego a esta conexion y no confirmo vuelve al buzon, o pasa directo a
      // la conexion que la reemplazo.
      const replacement = online.get(ws.deviceId);
      for (const [id, entry] of inflight) {
        if (entry.ws !== ws) continue;
        inflight.delete(id);
        if (replacement) deliver(replacement, entry.item);
        else enqueue(entry.to, entry.item);
      }
    });
  }

  function allow(ws, bytes) {
    const now = Date.now();
    ws.bucket = Math.min(opts.rateBurst, ws.bucket + ((now - ws.bucketAt) / 1000) * opts.ratePerSec);
    ws.bucketAt = now;
    if (now - ws.bytesWindow.start > 60_000) ws.bytesWindow = { start: now, bytes: 0 };
    ws.bytesWindow.bytes += bytes;
    if (ws.bucket < 1 || ws.bytesWindow.bytes > opts.bytesPerMinute) return false;
    ws.bucket -= 1;
    return true;
  }

  async function handle(ws, msg, nonce, authTimer) {
    const reply = (data) => send(ws, { t: 'res', rid: msg.rid, data });
    const fail = (error) => send(ws, { t: 'res', rid: msg.rid, error });

    if (!ws.deviceId) {
      if (msg.t !== 'auth' || !ID.test(msg.deviceId || '') || typeof msg.pub !== 'string' || typeof msg.sig !== 'string') return ws.close(4401, 'auth');
      if (!(await verifyChallenge(msg.pub, msg.deviceId, nonce, msg.sig))) return ws.close(4401, 'auth');
      clearTimeout(authTimer);
      // Una sola conexion por dispositivo: la nueva reemplaza a la vieja (otra pestania).
      const previous = online.get(msg.deviceId);
      if (previous && previous !== ws) previous.close(4409, 'replaced');
      ws.deviceId = msg.deviceId;
      online.set(ws.deviceId, ws);
      if (msg.card && (await verifyCard(msg.card)) && msg.card.devices.some((d) => d.deviceId === ws.deviceId)) storeCard(msg.card);
      send(ws, { t: 'ready', info: { vapidPublicKey: push?.publicKey || '' } });
      flushMailbox(ws);
      return;
    }

    switch (msg.t) {
      case 'send': {
        const items = Array.isArray(msg.items) ? msg.items.slice(0, 50) : [];
        const delivered = [];
        const queued = [];
        const rejected = [];
        const now = Date.now();
        for (const raw of items) {
          if (!ID.test(raw?.id || '') || !ID.test(raw?.to || '') || !raw.data) { if (raw?.id) rejected.push(raw.id); continue; }
          const data = raw.data;
          const size = JSON.stringify(data).length;
          if (size > opts.maxEnvelopeBytes) { rejected.push(raw.id); continue; }
          const item = { id: raw.id, from: ws.deviceId, data, size, expiresAt: now + opts.mailboxTtlMs };
          const target = online.get(raw.to);
          if (target) {
            deliver(target, item);
            delivered.push(raw.id);
          } else if (enqueue(raw.to, item)) {
            queued.push(raw.id);
            void notifyPush(raw.to);
          } else rejected.push(raw.id);
        }
        return reply({ delivered, queued, rejected });
      }
      case 'ack': {
        const ids = new Set((Array.isArray(msg.ids) ? msg.ids : []).slice(0, 500));
        for (const id of ids) {
          const entry = inflight.get(id);
          if (entry?.to === ws.deviceId) inflight.delete(id);
        }
        dropFromMailbox(ws.deviceId, ids);
        return;
      }
      case 'card':
        if (await verifyCard(msg.card) && msg.card.devices.some((d) => d.deviceId === ws.deviceId)) storeCard(msg.card);
        return;
      case 'cards.get': {
        const ids = (Array.isArray(msg.userIds) ? msg.userIds : []).slice(0, 100);
        return reply(ids.map((id) => cards.get(id)?.card).filter(Boolean));
      }
      case 'presence': {
        const ids = (Array.isArray(msg.deviceIds) ? msg.deviceIds : []).slice(0, 300);
        return reply(ids.filter((id) => online.has(id)));
      }
      case 'signal': {
        if (!ID.test(msg.to || '') || JSON.stringify(msg.data || {}).length > 64 * 1024) return;
        const target = online.get(msg.to);
        if (target) send(target, { t: 'signal', from: ws.deviceId, data: msg.data });
        return;
      }
      case 'push.register': {
        const sub = msg.subscription;
        if (!push) return fail('Push no configurado');
        if (typeof sub?.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !sub.keys?.p256dh || !sub.keys?.auth) return fail('Suscripcion invalida');
        pushSubs.set(ws.deviceId, { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
        return reply({ ok: true });
      }
      case 'push.unregister':
        pushSubs.delete(ws.deviceId);
        return reply({ ok: true });
      default:
        if (msg.rid) fail('tipo desconocido');
    }
  }

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [deviceId, box] of mailboxes) {
      const keep = box.items.filter((item) => item.expiresAt > now);
      if (keep.length === box.items.length) continue;
      const freed = box.items.filter((item) => item.expiresAt <= now).reduce((n, item) => n + item.size, 0);
      box.items = keep;
      box.bytes -= freed;
      totalBytes -= freed;
      if (!keep.length) mailboxes.delete(deviceId);
    }
    for (const [userId, { seenAt }] of cards) if (now - seenAt > opts.cardTtlMs) cards.delete(userId);
  }, 60_000);
  sweepTimer.unref?.();

  return {
    handleUpgrade,
    // Todo lo que el relay tiene guardado, tal cual lo ve. Solo para los e2e (RELAY_DEBUG):
    // sirve para comprobar que en el servidor no hay nada legible.
    dump: () => [...mailboxes.entries()].map(([deviceId, box]) => ({ deviceId, items: box.items.map((i) => ({ id: i.id, from: i.from, data: i.data })) })),
    // Cuanto tiene pendiente un dispositivo (para tests y diagnostico; no expone contenido).
    pendingFor: (deviceId) => ({
      queued: mailboxes.get(deviceId)?.items.length || 0,
      inflight: [...inflight.values()].filter((e) => e.to === deviceId).length
    }),
    stats: () => ({ online: online.size, mailboxes: mailboxes.size, queued: [...mailboxes.values()].reduce((n, b) => n + b.items.length, 0), inflight: inflight.size, bytes: totalBytes, cards: cards.size }),
    close() {
      clearInterval(sweepTimer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    }
  };
}
