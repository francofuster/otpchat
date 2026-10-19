import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import webpush from 'web-push';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import { createRelay } from './relay.js';
import { verifyCard } from '../src/core/protocol.js';
import {
  conversationIdForUsers,
  loadStore,
  makeId,
  mutate,
  notExpired,
  nowIso,
  publicUser,
  state
} from './store.js';

const app = express();
// Detras del proxy de Render: sin esto el rate limit ve una sola IP (la del proxy) para todos.
if (process.env.TRUST_PROXY !== '0') app.set('trust proxy', 1);
const server = createServer(app);
// v1 (/ws, con base de datos) y v2 (/relay, sin base) comparten el puerto. Con dos
// WebSocketServer atados al mismo server cada uno rechaza el path del otro, asi que los
// upgrades se enrutan a mano.
const wss = new WebSocketServer({ noServer: true });
const port = Number(process.env.PORT || 4900);
// En produccion no hay secreto por defecto: con uno conocido cualquiera fabrica tokens
// validos para cualquier cuenta, admin incluido. Preferimos que el proceso no arranque.
if (process.env.NODE_ENV === 'production' && String(process.env.JWT_SECRET || '').length < 32) {
  console.error('JWT_SECRET falta o tiene menos de 32 caracteres. El servidor no arranca en produccion sin un secreto fuerte.');
  process.exit(1);
}
const jwtSecret = process.env.JWT_SECRET || 'dev-otpchat-secret';
// Corto a proposito: el refresh token rotativo cubre el auto-login, y un JWT robado deja
// de servir rapido aunque nadie lo revoque.
const jwtTtl = process.env.JWT_TTL || '1h';
// CLIENT_ORIGIN admite varios origenes separados por coma; el primero es el sitio principal.
// Las apps nativas cargan la web desde su propio origen y se suman siempre.
const clientOrigins = String(process.env.CLIENT_ORIGIN || 'http://localhost:5900').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
const nativeOrigins = ['https://localhost', 'capacitor://localhost', 'app://otpchat'];
const allowedOrigins = [...new Set([...clientOrigins, ...nativeOrigins])];
const clientOrigin = clientOrigins[0];
// La API v1 necesita la base. Sin DATABASE_URL (ni LEGACY_API=1 para la base local) el
// servidor arranca solo como relay v2, sin ninguna base de datos.
const legacyEnabled = process.env.LEGACY_API !== '0' && (!!process.env.DATABASE_URL || process.env.LEGACY_API === '1');
// Config de confianza: quien tiene admin. Sin esta variable el nombre por defecto queda
// reservado pero sin nadie que lo tenga, asi que el sistema arranca sin superadmin (fail
// closed). Para habilitar admin, registra una cuenta normal y apunta esta env a ella.
const superadminName = process.env.SUPERADMIN_USERNAME || 'sup3r4drm1n_3533';
const online = new Map();
const registerCooldownEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.REGISTER_COOLDOWN_ENABLED || '').toLowerCase());
const deviceAccountLimitEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.DEVICE_ACCOUNT_LIMIT_ENABLED || '').toLowerCase());
// Viene habilitado siempre salvo que se apague a proposito. Solo los tests E2E lo apagan:
// con 3 registros por hora no se puede automatizar ningun flujo de alta.
const rateLimitEnabled = !['0', 'false', 'no', 'off'].includes(String(process.env.RATE_LIMIT_ENABLED || '').toLowerCase());
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
const vapidSubject = process.env.VAPID_SUBJECT || `mailto:admin@${new URL(clientOrigin).hostname}`;
// Sin temporizador propio, un audio vive un dia y despues lo barre cleanupExpiredMessages.
const audioMaxTtlSeconds = 24 * 60 * 60;
const maxAudioBytes = Number(process.env.MAX_AUDIO_BYTES || 3 * 1024 * 1024);
// Las invitaciones (contacto y grupo) viven poco: el cliente muestra el QR y lo regenera
// cada 30s, cancelando el anterior. Este TTL es el respaldo por si el cliente se cierra sin
// cancelar, para que un link/QR filtrado no siga sirviendo horas. Un poco mayor que los 30s
// de refresco para dar margen a que el invitado alcance a aceptar el codigo que ve.
const invitationTtlMs = Number(process.env.INVITATION_TTL_MS || 60_000);
// Tope del ciphertext de un mensaje de texto. Antes solo los audios tenian limite y un texto
// podia ocupar los ~6mb del parser de /api/messages, con todo el estado viviendo en RAM.
const maxTextBytes = Number(process.env.MAX_TEXT_BYTES || 64 * 1024);
const maxPasswordLength = 128;
const maxGroupNameLength = 64;
const maxAudioDurationMs = 60 * 60_000;
// Mismos valores que ofrece el selector del cliente. Cualquier otro numero (fraccionario,
// NaN, Infinity, fuera de rango de integer) lo rechazaba Postgres despues de haber tocado la
// memoria, y desde ahi fallaba el guardado de todos.
const timerOptions = new Set([0, 30, 60, 300, 1800, 3600, 21600, 43200, 86400, 604800]);
const maxInt32 = 2_147_483_647;

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

function inviteLink(code) {
  return `${clientOrigin.replace(/\/$/, '')}/#/invite/${code}`;
}

// La API solo devuelve JSON: no tiene por que cargar nada ni dejarse embeber.
app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
app.use(cors({ origin: allowedOrigins, credentials: true }));
// Los audios cifrados viajan como base64 dentro del JSON, asi que /api/messages necesita
// mas margen que el resto. Va primero a proposito: marca el body como parseado y el
// parser global de 1mb lo saltea, de modo que ninguna otra ruta hereda el limite grande.
app.use('/api/messages', express.json({ limit: `${Math.max(maxAudioBytes, maxTextBytes) * 2}b` }));
app.use(express.json({ limit: '1mb' }));
const sinLimite = (req, res, next) => next();
const limiter = (options) => (rateLimitEnabled ? rateLimit(options) : sinLimite);

app.use(limiter({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const relay = createRelay({
  allowedOrigins,
  push: vapidPublicKey && vapidPrivateKey ? { publicKey: vapidPublicKey, send: (subscription, payload) => webpush.sendNotification(subscription, payload) } : null
});

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/relay') return relay.handleUpgrade(req, socket, head);
  if (path === '/ws' && legacyEnabled) return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

app.get('/api/relay/info', (req, res) => res.json({ v: 2, vapidPublicKey, legacy: legacyEnabled }));

// Volcado del buzon para los e2e. Nunca en produccion, aunque alguien deje la variable puesta.
if (process.env.RELAY_DEBUG === '1' && process.env.NODE_ENV !== 'production') {
  app.get('/api/relay/debug/dump', (req, res) => res.json({ stats: relay.stats(), mailboxes: relay.dump() }));
}

// Sin base de datos la API v1 queda retirada: solo responde la salud y el relay.
if (!legacyEnabled) {
  app.use('/api', (req, res, next) => (req.path === '/health' || req.path.startsWith('/relay') ? next() : res.status(410).json({ error: 'La versión anterior de OTPChat fue retirada' })));
}

const loginLimiter = limiter({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
const registerLimiter = limiter({ windowMs: 60 * 60_000, limit: 3, standardHeaders: true, legacyHeaders: false });

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// `tv` ata el token a la version vigente del usuario: subir tokenVersion (cambio o reset de
// clave) invalida en el acto todos los JWT emitidos antes, sin esperar a que venzan.
function sign(user) {
  return jwt.sign({ sub: user.id, username: user.username, tv: user.tokenVersion || 0 }, jwtSecret, { expiresIn: jwtTtl });
}

function verifyToken(token) {
  const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  const user = state().users.find((u) => u.id === payload.sub);
  if (!user || (payload.tv ?? 0) !== (user.tokenVersion || 0)) return null;
  return user;
}

// Entero dentro de [min, max] o null. Todo numero que llega del cliente pasa por aca antes
// de tocar el estado en memoria.
function intEnRango(value, min, max) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function timerValido(value) {
  const n = intEnRango(value ?? 0, 0, maxInt32);
  return n !== null && timerOptions.has(n) ? n : null;
}

// Misma regla para registro y renombre. El registro antes aceptaba cualquier valor JSON: un
// username numerico rompia el .toLowerCase() de todos los registros posteriores.
function usernameError(username) {
  if (typeof username !== 'string') return 'Usuario invalido';
  const value = username.trim();
  if (value.length < 3) return 'El usuario debe tener al menos 3 caracteres';
  if (value.length > 32) return 'El usuario no puede superar 32 caracteres';
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) return 'Usa solo letras, numeros, punto, guion o guion bajo';
  return null;
}

function sameName(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function groupNameValido(name) {
  if (typeof name !== 'string') return null;
  const value = name.trim();
  return value.length >= 1 && value.length <= maxGroupNameLength ? value : null;
}

const base64 = /^[A-Za-z0-9+/=_-]*$/;

// Reconstruye el payload cifrado con solo los campos esperados. Antes se guardaba el objeto
// tal cual llegaba, con cualquier forma y tamano.
function encryptedValido(encrypted, maxBytes) {
  if (!encrypted || typeof encrypted !== 'object') return null;
  const { iv, salt, ciphertext } = encrypted;
  if (![iv, salt, ciphertext].every((v) => typeof v === 'string' && base64.test(v))) return null;
  if (!ciphertext || iv.length > 64 || salt.length > 64 || ciphertext.length > maxBytes) return null;
  const keyStep = intEnRango(encrypted.keyStep, 0, maxInt32);
  const keyVersion = intEnRango(encrypted.keyVersion ?? 1, 1, maxInt32);
  if (keyStep === null || keyVersion === null) return null;
  return { iv, salt, ciphertext, keyStep, keyVersion };
}

function closeUserSockets(userId, code = 4401) {
  for (const ws of online.get(userId) || []) ws.close(code, 'session');
  online.delete(userId);
}

function passwordErrors(password) {
  const errors = [];
  if (typeof password !== 'string' || password.length > maxPasswordLength) return [`entre 7 y ${maxPasswordLength} caracteres`];
  if (!password || password.length <= 6) errors.push('mas de 6 caracteres');
  if (!/[A-Z]/.test(password || '')) errors.push('1 mayuscula');
  if (!/[a-z]/.test(password || '')) errors.push('1 minuscula');
  if (!/[0-9]/.test(password || '')) errors.push('1 numero');
  if (!/[^A-Za-z0-9]/.test(password || '')) errors.push('1 simbolo');
  return errors;
}

function issueSession(user, deviceFingerprint) {
  const plain = randomBytes(32).toString('hex');
  const session = {
    id: makeId('ses'),
    userId: user.id,
    tokenHash: hashToken(plain),
    deviceFingerprint,
    createdAt: nowIso(),
    lastUsedAt: nowIso(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString()
  };
  state().sessions.push(session);
  return plain;
}

// Lo unico que puede hacer una cuenta con la clave reseteada (o la del admin sembrada desde
// env) hasta definir una propia. Antes el flag solo lo miraba el front.
const allowedWhileMustChange = new Set(['/api/auth/change-password', '/api/auth/logout', '/api/me']);

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  let user;
  try {
    user = verifyToken(token);
  } catch {
    user = null;
  }
  if (!user) return res.status(401).json({ error: 'Sesión inválida' });
  // Migrar a v2 tambien se permite: solo lee lo propio y es la salida de la version vieja.
  if (user.mustChangePassword && !allowedWhileMustChange.has(req.path) && !req.path.startsWith('/api/migration/')) {
    return res.status(403).json({ error: 'Tenés que cambiar la contraseña', mustChangePassword: true });
  }
  req.user = user;
  user.lastSeenAt = nowIso();
  next();
}

function requireAdmin(req, res, next) {
  // Lee el flag sembrado, nunca el nombre de usuario.
  if (req.user?.isSuperadmin !== true) return res.status(403).json({ error: 'Solo superadmin' });
  next();
}

// El nombre del superadmin esta reservado: nadie puede registrarlo ni renombrarse a el.
// Es lo que cierra la escalada (antes cualquiera se renombraba al nombre magico y ganaba
// admin). El propio admin ya lo tiene desde el arranque, asi que no necesita reclamarlo.
function isReservedName(username) {
  return String(username).toLowerCase() === superadminName.toLowerCase();
}

// Re-deriva isSuperadmin desde SUPERADMIN_USERNAME en cada arranque. Al ser idempotente y
// basarse solo en config de confianza, corrige cualquier fila que quedara con el flag mal
// puesto (por datos viejos o por un intento de escalada previo).
async function seedSuperadmin() {
  const existe = state().users.some((u) => sameName(u.username, superadminName));
  const bootstrapPassword = process.env.SUPERADMIN_PASSWORD || '';

  // El nombre del admin esta reservado, asi que no se puede dar de alta por el registro
  // normal (es lo que impide la escalada). La unica via de alta es esta: si la cuenta no
  // existe y hay una password de bootstrap en env (config de confianza), la crea el propio
  // servidor. Se fuerza el cambio de clave en el primer login, porque una password puesta
  // por env puede quedar registrada en los logs o el dashboard del hosting.
  if (!existe && bootstrapPassword) {
    state().users.push({
      id: makeId('usr'),
      username: superadminName,
      passwordHash: await bcrypt.hash(bootstrapPassword, 12),
      deviceFingerprint: 'server-seed',
      mustChangePassword: true,
      tokenVersion: 0,
      isSuperadmin: false,
      createdAt: nowIso(),
      lastSeenAt: nowIso()
    });
    console.log(`Superadmin "${superadminName}" creado desde SUPERADMIN_PASSWORD. Cambia la clave en el primer login.`);
  }

  // Re-asienta el flag: solo la cuenta designada queda como superadmin, el resto en false.
  let cambios = false;
  for (const user of state().users) {
    const deberia = sameName(user.username, superadminName);
    if (user.isSuperadmin !== deberia) {
      user.isSuperadmin = deberia;
      cambios = true;
    }
  }
  if (cambios) await mutate(() => {});
}

function sendToUser(userId, event) {
  const sockets = online.get(userId) || new Set();
  for (const ws of sockets) ws.send(JSON.stringify(event));
}

function sendToConversation(conversationId, event) {
  const [a, b] = conversationId.split(':');
  sendToUser(a, event);
  sendToUser(b, event);
}

function sendToGroup(groupId, event) {
  const members = state().groupMembers.filter((m) => m.groupId === groupId);
  for (const member of members) sendToUser(member.userId, event);
}

async function sendPushToUsers(userIds, context = {}) {
  if (!vapidPublicKey || !vapidPrivateKey || !userIds.length) return;
  const ids = new Set(userIds);
  const subscriptions = state().pushSubscriptions.filter((item) => ids.has(item.userId));
  const staleEndpoints = [];
  const payload = JSON.stringify({
    title: 'Mensajes nuevos',
    scope: context.scope,
    targetId: context.targetId
  });
  await Promise.all(subscriptions.map(async (item) => {
    try {
      await webpush.sendNotification(item.subscription, payload);
    } catch (err) {
      if ([404, 410].includes(err?.statusCode)) staleEndpoints.push(item.endpoint);
    }
  }));
  if (staleEndpoints.length) {
    await mutate((db) => {
      db.pushSubscriptions = db.pushSubscriptions.filter((item) => !staleEndpoints.includes(item.endpoint));
    });
  }
}

function groupMember(groupId, userId) {
  return state().groupMembers.find((m) => m.groupId === groupId && m.userId === userId);
}

function canModerate(role) {
  return role === 'admin' || role === 'subadmin';
}

function groupRole(group, userId) {
  if (!group) return null;
  if (group.founderId === userId) return 'admin';
  return groupMember(group.id, userId)?.role || null;
}

function groupPayload(group, userId) {
  if (!group) return null;
  const member = groupMember(group.id, userId);
  return { ...group, keyVersion: group.keyVersion || 1, membersCanWrite: membersCanWrite(group), joinedAt: member?.joinedAt, timerSeconds: timerPreference(userId, 'group', group.id), role: groupRole(group, userId) };
}

// Las filas creadas antes de la columna llegan con null: solo false restringe el grupo.
function membersCanWrite(group) {
  return group?.membersCanWrite !== false;
}

function publicGroupMember(member) {
  const user = publicUser(state().users.find((u) => u.id === member.userId));
  return user ? { ...member, user } : null;
}

async function cleanupExpiredMessages() {
  const before = state().messages.length;
  await mutate((db) => {
    db.messages = db.messages.filter((m) => !m.expiresAt || new Date(m.expiresAt).getTime() > Date.now());
  });
  if (state().messages.length !== before) {
    for (const wsSet of online.values()) for (const ws of wsSet) ws.send(JSON.stringify({ type: 'messages:expired' }));
  }
}

function registerBlocked(ip, fingerprint) {
  const events = state().securityEvents.filter((e) => e.type === 'register' && (e.ip === ip || e.fingerprint === fingerprint));
  const recent = events.find((e) => Date.now() - new Date(e.createdAt).getTime() < 24 * 60 * 60_000);
  if (!recent) return null;
  return new Date(new Date(recent.createdAt).getTime() + 24 * 60 * 60_000).toISOString();
}

function timerPreference(userId, scope, targetId) {
  return state().messageTimerPreferences.find((pref) => pref.userId === userId && pref.scope === scope && pref.targetId === targetId)?.timerSeconds || 0;
}

function setTimerPreference(userId, scope, targetId, timerSeconds) {
  let preference = state().messageTimerPreferences.find((pref) => pref.userId === userId && pref.scope === scope && pref.targetId === targetId);
  if (!preference) {
    preference = { userId, scope, targetId, timerSeconds: 0, updatedAt: nowIso() };
    state().messageTimerPreferences.push(preference);
  }
  preference.timerSeconds = timerSeconds;
  preference.updatedAt = nowIso();
  return preference;
}

function markAsRead(userId, scope, targetId) {
  let readState = state().messageReadStates.find((item) => item.userId === userId && item.scope === scope && item.targetId === targetId);
  if (!readState) {
    readState = { userId, scope, targetId, lastReadAt: nowIso() };
    state().messageReadStates.push(readState);
    return readState;
  }
  readState.lastReadAt = nowIso();
  return readState;
}

// Un solo recorrido sobre messages para contar los no leidos de cada chat del usuario.
function unreadCounts(userId) {
  const lastRead = new Map();
  for (const item of state().messageReadStates) {
    if (item.userId === userId) lastRead.set(`${item.scope}:${item.targetId}`, new Date(item.lastReadAt).getTime());
  }
  const joinedAt = new Map();
  for (const member of state().groupMembers) {
    if (member.userId === userId) joinedAt.set(member.groupId, new Date(member.joinedAt || 0).getTime());
  }
  const counts = new Map();
  for (const contact of state().contacts) {
    if (contact.userIds.includes(userId)) counts.set(`contact:${contact.conversationId}`, 0);
  }
  for (const groupId of joinedAt.keys()) counts.set(`group:${groupId}`, 0);
  const now = Date.now();
  for (const message of state().messages) {
    const key = `${message.scope}:${message.targetId}`;
    if (message.senderId === userId || !counts.has(key)) continue;
    if (message.expiresAt && new Date(message.expiresAt).getTime() <= now) continue;
    const createdAt = new Date(message.createdAt).getTime();
    if (message.scope === 'group' && createdAt < (joinedAt.get(message.targetId) || 0)) continue;
    if (createdAt <= (lastRead.get(key) || 0)) continue;
    counts.set(key, counts.get(key) + 1);
  }
  return counts;
}

// Sin auth a proposito: lo usan el arranque de los tests E2E y el health check de Render.
app.get('/api/health', (req, res) => res.json({ ok: true }));

function fingerprintValido(fingerprint) {
  return typeof fingerprint === 'string' && fingerprint.length >= 1 && fingerprint.length <= 128;
}

// Se compara contra este hash cuando el usuario no existe, para que el tiempo de respuesta
// no revele que nombres estan registrados.
const dummyPasswordHash = bcrypt.hashSync(randomBytes(16).toString('hex'), 12);

app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const { password, fingerprint } = req.body || {};
  if (!req.body?.username || !password || !fingerprint) return res.status(400).json({ error: 'Faltan datos' });
  const nameError = usernameError(req.body.username);
  if (nameError) return res.status(400).json({ error: nameError });
  if (!fingerprintValido(fingerprint)) return res.status(400).json({ error: 'Faltan datos' });
  const username = req.body.username.trim();
  const passErrors = passwordErrors(password);
  if (passErrors.length) return res.status(400).json({ error: `La contraseña debe tener ${passErrors.join(', ')}` });
  const blockedUntil = registerCooldownEnabled ? registerBlocked(req.ip, fingerprint) : null;
  if (blockedUntil) return res.status(429).json({ error: 'Registro en cooldown', blockedUntil });
  if (isReservedName(username) || state().users.some((u) => sameName(u.username, username))) {
    return res.status(409).json({ error: 'Usuario no disponible' });
  }
  if (deviceAccountLimitEnabled && state().users.some((u) => u.deviceFingerprint === fingerprint)) {
    return res.status(409).json({ error: 'Este dispositivo ya tiene una cuenta' });
  }
  const user = {
    id: makeId('usr'),
    username,
    passwordHash: await bcrypt.hash(password, 12),
    deviceFingerprint: fingerprint,
    mustChangePassword: false,
    tokenVersion: 0,
    isSuperadmin: false,
    createdAt: nowIso(),
    lastSeenAt: nowIso()
  };
  const refreshToken = issueSession(user, fingerprint);
  await mutate((db) => {
    db.users.push(user);
    db.securityEvents.push({ id: makeId('sec'), type: 'register', ip: req.ip, fingerprint, createdAt: nowIso() });
  });
  res.json({ user: publicUser(user, { includeFingerprint: true }), token: sign(user), refreshToken });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password, fingerprint } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > maxPasswordLength) {
    return res.status(401).json({ error: 'Usuario o contraseña inválidos' });
  }
  if (fingerprint !== undefined && !fingerprintValido(fingerprint)) return res.status(400).json({ error: 'Faltan datos' });
  const user = state().users.find((u) => sameName(u.username, username.trim()));
  const passwordOk = await bcrypt.compare(password, user?.passwordHash || dummyPasswordHash);
  if (!user || !passwordOk) {
    return res.status(401).json({ error: 'Usuario o contraseña inválidos' });
  }
  // Con el limite por dispositivo activo, omitir el fingerprint ya no lo saltea.
  if (deviceAccountLimitEnabled && user.deviceFingerprint !== fingerprint && user.username !== superadminName) {
    return res.status(403).json({ error: 'Cuenta vinculada a otro dispositivo' });
  }
  const refreshToken = issueSession(user, fingerprint || user.deviceFingerprint);
  await mutate(() => {});
  res.json({ user: publicUser(user, { includeFingerprint: true }), token: sign(user), refreshToken });
});

app.post('/api/auth/refresh', async (req, res) => {
  const { refreshToken, fingerprint } = req.body || {};
  const session = state().sessions.find((s) => s.tokenHash === hashToken(refreshToken || '') && notExpired(s));
  if (!session || session.deviceFingerprint !== fingerprint) return res.status(401).json({ error: 'Auto-login vencido' });
  const user = state().users.find((u) => u.id === session.userId);
  if (!user) return res.status(401).json({ error: 'Auto-login vencido' });
  const nextRefresh = randomBytes(32).toString('hex');
  await mutate(() => {
    session.tokenHash = hashToken(nextRefresh);
    session.lastUsedAt = nowIso();
    session.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  });
  res.json({ user: publicUser(user, { includeFingerprint: true }), token: sign(user), refreshToken: nextRefresh });
});

app.post('/api/auth/logout', auth, async (req, res) => {
  const { refreshToken } = req.body || {};
  await mutate((db) => {
    db.sessions = db.sessions.filter((s) => s.tokenHash !== hashToken(refreshToken || ''));
  });
  res.json({ ok: true });
});

// Pide la clave actual (salvo en el cambio forzado tras un reset): con solo un JWT robado ya
// no se puede tomar la cuenta. Al cambiarla se cortan todas las sesiones, la propia incluida,
// y se emite una nueva para este dispositivo.
app.post('/api/auth/change-password', auth, async (req, res) => {
  const { password, currentPassword, fingerprint } = req.body || {};
  if (!req.user.mustChangePassword) {
    const ok = typeof currentPassword === 'string' && currentPassword.length <= maxPasswordLength && await bcrypt.compare(currentPassword, req.user.passwordHash);
    if (!ok) return res.status(403).json({ error: 'La contraseña actual no es correcta' });
  }
  const passErrors = passwordErrors(password);
  if (passErrors.length) return res.status(400).json({ error: `La contraseña debe tener ${passErrors.join(', ')}` });
  const passwordHash = await bcrypt.hash(password, 12);
  const user = req.user;
  let refreshToken;
  await mutate((db) => {
    user.passwordHash = passwordHash;
    user.mustChangePassword = false;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    db.sessions = db.sessions.filter((s) => s.userId !== user.id);
    refreshToken = issueSession(user, fingerprintValido(fingerprint) ? fingerprint : user.deviceFingerprint);
  });
  closeUserSockets(user.id);
  res.json({ user: publicUser(user, { includeFingerprint: true }), token: sign(user), refreshToken });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user, { includeFingerprint: true }) }));

app.get('/api/push/public-key', auth, (req, res) => {
  res.json({ publicKey: vapidPublicKey });
});

app.post('/api/push/subscribe', auth, async (req, res) => {
  const subscription = req.body?.subscription;
  if (!vapidPublicKey || !vapidPrivateKey) return res.status(503).json({ error: 'Push no configurado' });
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({ error: 'Suscripcion invalida' });
  await mutate((db) => {
    const existing = db.pushSubscriptions.find((item) => item.endpoint === subscription.endpoint);
    if (existing) {
      existing.userId = req.user.id;
      existing.subscription = subscription;
      existing.updatedAt = nowIso();
      return;
    }
    db.pushSubscriptions.push({
      id: makeId('push'),
      userId: req.user.id,
      endpoint: subscription.endpoint,
      subscription,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });
  });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', auth, async (req, res) => {
  const endpoint = req.body?.endpoint;
  await mutate((db) => {
    db.pushSubscriptions = db.pushSubscriptions.filter((item) => item.userId !== req.user.id || (endpoint && item.endpoint !== endpoint));
  });
  res.json({ ok: true });
});

app.patch('/api/auth/username', auth, async (req, res) => {
  const nameError = usernameError(req.body?.username);
  if (nameError) return res.status(400).json({ error: nameError });
  const username = req.body.username.trim();
  // Reservado salvo que ya sea el nombre del propio usuario (para no bloquear un no-op).
  const claimingReserved = isReservedName(username) && !sameName(req.user.username, username);
  const taken = claimingReserved || state().users.some((u) => u.id !== req.user.id && sameName(u.username, username));
  if (taken) return res.status(409).json({ error: 'Ese usuario ya existe' });
  await mutate(() => {
    req.user.username = username;
  });
  res.json({ user: publicUser(req.user, { includeFingerprint: true }) });
});

app.get('/api/bootstrap', auth, (req, res) => {
  const unread = unreadCounts(req.user.id);
  const contacts = state().contacts
    .filter((c) => c.userIds.includes(req.user.id))
    .map((c) => {
      const otherId = c.userIds.find((id) => id !== req.user.id);
      return {
        ...c,
        timerSeconds: timerPreference(req.user.id, 'contact', c.conversationId),
        unreadCount: unread.get(`contact:${c.conversationId}`) || 0,
        other: publicUser(state().users.find((u) => u.id === otherId))
      };
    });
  const groups = state().groupMembers
    .filter((m) => m.userId === req.user.id)
    .map((m) => {
      const group = state().groups.find((g) => g.id === m.groupId);
      const payload = groupPayload(group, req.user.id);
      return payload && { ...payload, unreadCount: unread.get(`group:${group.id}`) || 0 };
    })
    .filter(Boolean);
  res.json({ contacts, groups });
});

app.post('/api/invitations/contact', auth, async (req, res) => {
  const code = nanoid(24);
  const link = inviteLink(code);
  const invitation = {
    id: makeId('inv'),
    type: 'contact',
    code,
    inviterId: req.user.id,
    status: 'pending',
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + invitationTtlMs).toISOString(),
    link
  };
  await mutate((db) => db.invitations.push(invitation));
  res.json({ invitation });
});

app.get('/api/invitations/:code', auth, (req, res) => {
  const invitation = state().invitations.find((i) => i.code === req.params.code);
  if (!invitation || !notExpired(invitation) || invitation.status !== 'pending') {
    return res.status(404).json({ error: 'Invitación no disponible' });
  }
  const inviter = publicUser(state().users.find((u) => u.id === invitation.inviterId));
  const group = invitation.groupId ? state().groups.find((g) => g.id === invitation.groupId) : null;
  res.json({ invitation, inviter, group });
});

app.post('/api/invitations/:code/cancel', auth, async (req, res) => {
  const invitation = state().invitations.find((i) => i.code === req.params.code && i.inviterId === req.user.id);
  if (!invitation) return res.status(404).json({ error: 'No encontrada' });
  await mutate(() => (invitation.status = 'cancelled'));
  sendToUser(invitation.inviterId, { type: 'invitation:cancelled', invitation });
  res.json({ invitation });
});

app.post('/api/invitations/:code/accept', auth, async (req, res) => {
  const invitation = state().invitations.find((i) => i.code === req.params.code && i.status === 'pending' && notExpired(i));
  if (!invitation) return res.status(404).json({ error: 'Invitación no disponible' });
  if (invitation.type === 'group') {
    const exists = state().groupMembers.some((m) => m.groupId === invitation.groupId && m.userId === req.user.id);
    if (!exists) state().groupMembers.push({ groupId: invitation.groupId, userId: req.user.id, role: 'member', joinedAt: nowIso() });
    await mutate(() => {});
    sendToGroup(invitation.groupId, { type: 'group:member_joined', groupId: invitation.groupId, user: publicUser(req.user) });
    return res.json({ groupId: invitation.groupId, keyVersion: invitation.keyVersion || 1 });
  }
  if (invitation.inviterId === req.user.id) return res.status(400).json({ error: 'No puedes aceptarte a ti mismo' });
  const conversationId = conversationIdForUsers(invitation.inviterId, req.user.id);
  let contact = state().contacts.find((c) => c.conversationId === conversationId);
  if (!contact) {
    contact = { id: makeId('con'), userIds: [invitation.inviterId, req.user.id], conversationId, timerSeconds: 0, createdAt: nowIso() };
    state().contacts.push(contact);
  }
  invitation.status = 'accepted';
  await mutate(() => {});
  sendToConversation(conversationId, { type: 'contact:accepted', conversationId, code: invitation.code, contact });
  res.json({ conversationId, contact });
});

app.post('/api/invitations/:code/reject', auth, async (req, res) => {
  const invitation = state().invitations.find((i) => i.code === req.params.code);
  if (!invitation) return res.status(404).json({ error: 'No encontrada' });
  // Solo una invitacion de contacto vigente y ajena se puede rechazar. Antes cualquiera con
  // el codigo pisaba el estado (incluso de una ya aceptada) y le mandaba avisos al invitador.
  if (invitation.type === 'group' || invitation.status !== 'pending' || !notExpired(invitation) || invitation.inviterId === req.user.id) {
    return res.json({ ok: true });
  }
  await mutate(() => (invitation.status = 'rejected'));
  sendToUser(invitation.inviterId, { type: 'invitation:rejected', invitation });
  res.json({ ok: true });
});

app.post('/api/groups', auth, async (req, res) => {
  const rawName = req.body?.name;
  const name = rawName === undefined || rawName === null || rawName === '' ? 'Grupo OTP' : groupNameValido(rawName);
  if (!name) return res.status(400).json({ error: `El nombre del grupo debe tener entre 1 y ${maxGroupNameLength} caracteres` });
  const group = { id: makeId('grp'), name, founderId: req.user.id, keyVersion: 1, timerSeconds: 0, membersCanWrite: true, createdAt: nowIso() };
  await mutate((db) => {
    db.groups.push(group);
    db.groupMembers.push({ groupId: group.id, userId: req.user.id, role: 'admin', joinedAt: nowIso() });
  });
  res.json({ group });
});

app.post('/api/groups/join', auth, async (req, res) => {
  return res.status(410).json({ error: 'Unite con un link o QR de invitacion' });
});

app.post('/api/groups/:id/invite', auth, async (req, res) => {
  const member = state().groupMembers.find((m) => m.groupId === req.params.id && m.userId === req.user.id);
  if (!member) return res.status(403).json({ error: 'No perteneces al grupo' });
  const group = state().groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
  if (!canModerate(groupRole(group, req.user.id))) return res.status(403).json({ error: 'Requiere admin o subadmin' });
  const code = nanoid(24);
  const link = inviteLink(code);
  const invitation = { id: makeId('inv'), type: 'group', code, inviterId: req.user.id, groupId: req.params.id, keyVersion: group.keyVersion || 1, status: 'pending', createdAt: nowIso(), expiresAt: new Date(Date.now() + invitationTtlMs).toISOString(), link };
  await mutate((db) => db.invitations.push(invitation));
  res.json({ invitation });
});

app.patch('/api/groups/:id/key-version', auth, async (req, res) => {
  const member = groupMember(req.params.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'No perteneces al grupo' });
  const group = state().groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
  if (groupRole(group, req.user.id) !== 'admin') return res.status(403).json({ error: 'Solo admin principal' });
  const keyVersion = intEnRango(req.body?.keyVersion, 1, maxInt32);
  if (keyVersion === null || keyVersion <= (group.keyVersion || 1)) return res.status(400).json({ error: 'Version invalida' });
  await mutate(() => {
    group.keyVersion = keyVersion;
    for (const invitation of state().invitations.filter((i) => i.type === 'group' && i.groupId === group.id && i.status === 'pending')) {
      invitation.status = 'rotated';
    }
  });
  sendToGroup(group.id, { type: 'group:key_rotated', groupId: group.id, keyVersion });
  res.json({ group: groupPayload(group, req.user.id) });
});

app.patch('/api/conversations/:id/timer', auth, async (req, res) => {
  const timerSeconds = timerValido(req.body?.timerSeconds);
  if (timerSeconds === null) return res.status(400).json({ error: 'Temporizador invalido' });
  const contact = state().contacts.find((c) => c.conversationId === req.params.id && c.userIds.includes(req.user.id));
  if (!contact) return res.status(404).json({ error: 'Chat no encontrado' });
  await mutate(() => setTimerPreference(req.user.id, 'contact', contact.conversationId, timerSeconds));
  res.json({ contact: { ...contact, timerSeconds } });
});

app.patch('/api/groups/:id/timer', auth, async (req, res) => {
  const timerSeconds = timerValido(req.body?.timerSeconds);
  if (timerSeconds === null) return res.status(400).json({ error: 'Temporizador invalido' });
  const member = state().groupMembers.find((m) => m.groupId === req.params.id && m.userId === req.user.id);
  if (!member) return res.status(403).json({ error: 'No perteneces al grupo' });
  const group = state().groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
  await mutate(() => setTimerPreference(req.user.id, 'group', group.id, timerSeconds));
  res.json({ group: { ...group, timerSeconds, role: member.role } });
});

app.patch('/api/groups/:id', auth, async (req, res) => {
  const member = state().groupMembers.find((m) => m.groupId === req.params.id && m.userId === req.user.id);
  if (!member || member.role !== 'admin') return res.status(403).json({ error: 'Requiere admin' });
  const group = state().groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
  // Se valida todo antes de tocar el grupo en memoria.
  const name = req.body?.name ? groupNameValido(req.body.name) : undefined;
  if (name === null) return res.status(400).json({ error: `El nombre del grupo debe tener entre 1 y ${maxGroupNameLength} caracteres` });
  const timerSeconds = req.body?.timerSeconds !== undefined ? timerValido(req.body.timerSeconds) : undefined;
  if (timerSeconds === null) return res.status(400).json({ error: 'Temporizador invalido' });
  await mutate(() => {
    if (name) group.name = name;
    if (timerSeconds !== undefined) group.timerSeconds = timerSeconds;
    // Solo el admin principal llega hasta aca, asi que el candado del grupo se abre y
    // cierra desde el mismo lugar que el nombre y el temporizador.
    if (req.body?.membersCanWrite !== undefined) group.membersCanWrite = req.body.membersCanWrite !== false;
  });
  sendToGroup(group.id, { type: 'group:updated', group });
  res.json({ group });
});

app.get('/api/groups/:id/members', auth, (req, res) => {
  const member = groupMember(req.params.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'No perteneces al grupo' });
  const group = state().groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
  if (!canModerate(groupRole(group, req.user.id))) return res.status(403).json({ error: 'Requiere admin o subadmin' });
  const members = state().groupMembers
    .filter((m) => m.groupId === group.id)
    .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime())
    .map(publicGroupMember)
    .filter(Boolean);
  res.json({ group, members });
});

app.patch('/api/groups/:id/members/roles', auth, async (req, res) => {
  const actor = groupMember(req.params.id, req.user.id);
  if (!actor) return res.status(403).json({ error: 'No perteneces al grupo' });
  const group = state().groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
  if (groupRole(group, req.user.id) !== 'admin') return res.status(403).json({ error: 'Solo admin principal' });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const role = req.body?.role === 'subadmin' ? 'subadmin' : 'member';
  await mutate(() => {
    for (const id of ids) {
      if (id === group.founderId) continue;
      const member = groupMember(group.id, id);
      if (member) member.role = role;
    }
  });
  sendToGroup(group.id, { type: 'group:members_updated', groupId: group.id });
  res.json({ ok: true });
});

app.delete('/api/groups/:id/members', auth, async (req, res) => {
  const actor = groupMember(req.params.id, req.user.id);
  if (!actor) return res.status(403).json({ error: 'No perteneces al grupo' });
  const group = state().groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
  const actorRole = groupRole(group, req.user.id);
  if (!canModerate(actorRole)) return res.status(403).json({ error: 'Requiere admin o subadmin' });
  const ids = new Set(Array.isArray(req.body?.ids) ? req.body.ids : []);
  ids.delete(req.user.id);
  ids.delete(group.founderId);
  if (actorRole === 'subadmin') {
    for (const member of state().groupMembers.filter((m) => ids.has(m.userId))) {
      if (member.role === 'admin' || member.role === 'subadmin') ids.delete(member.userId);
    }
  }
  await mutate((db) => {
    db.groupMembers = db.groupMembers.filter((m) => !(m.groupId === group.id && ids.has(m.userId)));
    // Al expulsar se revocan las invitaciones pendientes del grupo. El link de invitacion
    // lleva el secreto del grupo en el fragmento y no se marcaba como usado al aceptar, asi
    // que un expulsado volvia a entrar con el mismo link que ya tenia. Revocarlas corta esa
    // reentrada; el admin genera una nueva si sigue queriendo sumar gente.
    for (const invitation of db.invitations.filter((i) => i.groupId === group.id && i.status === 'pending')) {
      invitation.status = 'revoked';
    }
  });
  for (const id of ids) sendToUser(id, { type: 'group:removed', groupId: group.id });
  sendToGroup(group.id, { type: 'group:members_updated', groupId: group.id });
  res.json({ removed: [...ids] });
});

app.delete('/api/groups/:id/leave', auth, async (req, res) => {
  const group = state().groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
  const member = groupMember(group.id, req.user.id);
  if (!member) return res.status(404).json({ error: 'No perteneces al grupo' });
  let deleted = false;
  let newOwner = null;
  await mutate((db) => {
    db.groupMembers = db.groupMembers.filter((m) => !(m.groupId === group.id && m.userId === req.user.id));
    db.messageReadStates = db.messageReadStates.filter((p) => !(p.scope === 'group' && p.targetId === group.id && p.userId === req.user.id));
    const remaining = db.groupMembers
      .filter((m) => m.groupId === group.id)
      .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime());
    if (!remaining.length) {
      deleted = true;
      db.groups = db.groups.filter((g) => g.id !== group.id);
      db.messages = db.messages.filter((m) => !(m.scope === 'group' && m.targetId === group.id));
      db.invitations = db.invitations.filter((i) => i.groupId !== group.id);
      db.messageTimerPreferences = db.messageTimerPreferences.filter((p) => !(p.scope === 'group' && p.targetId === group.id));
      db.messageReadStates = db.messageReadStates.filter((p) => !(p.scope === 'group' && p.targetId === group.id));
      return;
    }
    if (group.founderId === req.user.id) {
      newOwner = remaining[0];
      group.founderId = newOwner.userId;
      newOwner.role = 'admin';
    }
  });
  sendToUser(req.user.id, { type: 'group:left', groupId: group.id });
  if (!deleted) sendToGroup(group.id, { type: 'group:members_updated', groupId: group.id, ownerId: newOwner?.userId });
  res.json({ left: true, deleted, ownerId: newOwner?.userId });
});

app.delete('/api/groups/:id', auth, async (req, res) => {
  const group = state().groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
  const member = groupMember(group.id, req.user.id);
  if (!member || groupRole(group, req.user.id) !== 'admin' || group.founderId !== req.user.id) {
    return res.status(403).json({ error: 'Solo admin principal' });
  }
  const memberIds = state().groupMembers.filter((m) => m.groupId === group.id).map((m) => m.userId);
  await mutate((db) => {
    db.groups = db.groups.filter((g) => g.id !== group.id);
    db.groupMembers = db.groupMembers.filter((m) => m.groupId !== group.id);
    db.messages = db.messages.filter((m) => !(m.scope === 'group' && m.targetId === group.id));
    db.invitations = db.invitations.filter((i) => i.groupId !== group.id);
    db.messageTimerPreferences = db.messageTimerPreferences.filter((p) => !(p.scope === 'group' && p.targetId === group.id));
    db.messageReadStates = db.messageReadStates.filter((p) => !(p.scope === 'group' && p.targetId === group.id));
  });
  for (const id of memberIds) sendToUser(id, { type: 'group:deleted', groupId: group.id });
  res.json({ deleted: true });
});

app.delete('/api/conversations/:id', auth, async (req, res) => {
  const contact = state().contacts.find((c) => c.conversationId === req.params.id && c.userIds.includes(req.user.id));
  if (!contact) return res.status(404).json({ error: 'Chat no encontrado' });
  await mutate((db) => {
    db.contacts = db.contacts.filter((c) => c.id !== contact.id);
    db.messages = db.messages.filter((m) => !(m.scope === 'contact' && m.targetId === contact.conversationId));
    db.messageTimerPreferences = db.messageTimerPreferences.filter((p) => !(p.scope === 'contact' && p.targetId === contact.conversationId));
    db.messageReadStates = db.messageReadStates.filter((p) => !(p.scope === 'contact' && p.targetId === contact.conversationId));
  });
  sendToConversation(contact.conversationId, { type: 'contact:deleted', conversationId: contact.conversationId });
  res.json({ deleted: true });
});

function canAccessChat(userId, scope, targetId) {
  if (scope === 'contact') return state().contacts.some((c) => c.conversationId === targetId && c.userIds.includes(userId));
  if (scope === 'group') return state().groupMembers.some((m) => m.groupId === targetId && m.userId === userId);
  return false;
}

// El front esconde el campo de texto, pero el permiso se decide aca: es lo unico que un
// miembro silenciado no puede saltear armando el POST a mano.
function canWriteChat(userId, scope, targetId) {
  if (scope !== 'group') return true;
  const group = state().groups.find((g) => g.id === targetId);
  if (!group) return false;
  if (membersCanWrite(group)) return true;
  return canModerate(groupRole(group, userId));
}

// ── Migracion a v2 ──────────────────────────────────────────────────────────
// Cada persona que migra vincula su cuenta v1 con su identidad v2 (una tarjeta firmada). Con
// esos vinculos los clientes recrean en la red nueva los contactos y grupos que ya tenian.
// El contenido de los mensajes nunca pasa por aca en claro: sigue cifrado con las llaves de
// sala, y el historial se comparte entre los propios participantes por la red nueva.

function linkedCard(userId) {
  return state().v2Links.find((l) => l.id === userId)?.card || null;
}

// Quien recrea un grupo v1 en v2: el fundador si ya migro; si no, el moderador migrado mas
// antiguo; si no, el miembro migrado mas antiguo. Es deterministico para todos los clientes.
function groupHost(group) {
  const members = state().groupMembers.filter((m) => m.groupId === group.id && linkedCard(m.userId));
  if (!members.length) return null;
  if (members.some((m) => m.userId === group.founderId)) return group.founderId;
  const byAge = (a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
  const mods = members.filter((m) => canModerate(groupRole(group, m.userId))).sort(byAge);
  return (mods[0] || members.sort(byAge)[0]).userId;
}

app.post('/api/migration/link', auth, async (req, res) => {
  const card = req.body?.card;
  if (!(await verifyCard(card))) return res.status(400).json({ error: 'Tarjeta inválida' });
  await mutate((db) => {
    const existing = db.v2Links.find((l) => l.id === req.user.id);
    if (existing) {
      existing.card = card;
      existing.linkedAt = nowIso();
    } else {
      db.v2Links.push({ id: req.user.id, card, linkedAt: nowIso() });
    }
  });
  res.json({ ok: true });
});

app.get('/api/migration/state', auth, (req, res) => {
  const me = req.user.id;
  const contacts = state().contacts
    .filter((c) => c.userIds.includes(me))
    .map((c) => {
      const otherId = c.userIds.find((id) => id !== me);
      const other = state().users.find((u) => u.id === otherId);
      return { conversationId: c.conversationId, v1UserId: otherId, username: other?.username || '', card: linkedCard(otherId) };
    });
  const groups = state().groupMembers
    .filter((m) => m.userId === me)
    .map((mine) => {
      const group = state().groups.find((g) => g.id === mine.groupId);
      if (!group) return null;
      const link = state().v2GroupLinks.find((l) => l.id === group.id);
      const members = state().groupMembers.filter((m) => m.groupId === group.id).map((m) => ({
        v1UserId: m.userId,
        username: state().users.find((u) => u.id === m.userId)?.username || '',
        role: groupRole(group, m.userId),
        joinedAt: m.joinedAt,
        card: linkedCard(m.userId)
      }));
      return {
        groupId: group.id,
        name: group.name,
        membersCanWrite: membersCanWrite(group),
        founderId: group.founderId,
        joinedAt: mine.joinedAt,
        hostUserId: link?.hostUserId || groupHost(group),
        chatId: link?.chatId || null,
        members
      };
    })
    .filter(Boolean);
  res.json({ me: { v1UserId: me, username: req.user.username }, contacts, groups });
});

// El anfitrion registra el grupo v2 que creo. Si otro ya lo registro, se devuelve ese y el
// cliente abandona el suyo: un solo grupo v2 por grupo v1.
app.post('/api/migration/groups/:id/chat', auth, async (req, res) => {
  const group = state().groups.find((g) => g.id === req.params.id);
  if (!group || !groupMember(group.id, req.user.id)) return res.status(404).json({ error: 'Grupo no encontrado' });
  const chatId = req.body?.chatId;
  if (typeof chatId !== 'string' || !/^g_[A-Za-z0-9_-]{8,64}$/.test(chatId)) return res.status(400).json({ error: 'Grupo v2 inválido' });
  const existing = state().v2GroupLinks.find((l) => l.id === group.id);
  if (existing) return res.json({ chatId: existing.chatId, hostUserId: existing.hostUserId });
  if (groupHost(group) !== req.user.id) return res.status(403).json({ error: 'Otra persona recrea este grupo' });
  await mutate((db) => db.v2GroupLinks.push({ id: group.id, chatId, hostUserId: req.user.id, createdAt: nowIso() }));
  res.json({ chatId, hostUserId: req.user.id });
});

// Mismo historial que /api/messages, bajo /api/migration para que tambien lo pueda bajar una
// cuenta con la clave reseteada.
app.get('/api/migration/messages/:scope/:id', auth, (req, res) => {
  const { scope, id } = req.params;
  if (!canAccessChat(req.user.id, scope, id)) return res.status(403).json({ error: 'Sin acceso' });
  const member = scope === 'group' ? groupMember(id, req.user.id) : null;
  const messages = state().messages
    .filter((m) => m.scope === scope && m.targetId === id && !(m.expiresAt && new Date(m.expiresAt).getTime() <= Date.now()))
    .filter((m) => !member?.joinedAt || new Date(m.createdAt).getTime() >= new Date(member.joinedAt).getTime())
    .slice(-2000)
    .map((m) => ({ ...m, sender: publicUser(state().users.find((u) => u.id === m.senderId)) }));
  res.json({ messages });
});

app.get('/api/messages/:scope/:id', auth, (req, res) => {
  const { scope, id } = req.params;
  if (!canAccessChat(req.user.id, scope, id)) return res.status(403).json({ error: 'Sin acceso' });
  const messages = state().messages
    .filter((m) => {
      if (m.scope !== scope || m.targetId !== id || (m.expiresAt && new Date(m.expiresAt).getTime() <= Date.now())) return false;
      if (scope !== 'group') return true;
      const member = groupMember(id, req.user.id);
      return !member?.joinedAt || new Date(m.createdAt).getTime() >= new Date(member.joinedAt).getTime();
    })
    .slice(-300)
    .map((m) => ({ ...m, sender: publicUser(state().users.find((u) => u.id === m.senderId)) }));
  res.json({ messages });
});

app.post('/api/messages/:scope/:id/read', auth, async (req, res) => {
  const { scope, id } = req.params;
  if (!canAccessChat(req.user.id, scope, id)) return res.status(403).json({ error: 'Sin acceso' });
  await mutate(() => markAsRead(req.user.id, scope, id));
  res.json({ ok: true });
});

app.post('/api/messages', auth, async (req, res) => {
  const { scope, targetId, durationMs, mimeType } = req.body || {};
  const encrypted = encryptedValido(req.body?.encrypted, Infinity);
  if (!canAccessChat(req.user.id, scope, targetId) || !encrypted) return res.status(400).json({ error: 'Mensaje inválido' });
  if (!canWriteChat(req.user.id, scope, targetId)) return res.status(403).json({ error: 'Solo administradores pueden enviar mensajes' });
  const kind = req.body?.kind === 'audio' ? 'audio' : 'text';
  if (kind === 'audio' && encrypted.ciphertext.length > maxAudioBytes) {
    return res.status(413).json({ error: 'El audio es demasiado largo' });
  }
  if (kind === 'text' && encrypted.ciphertext.length > maxTextBytes) {
    return res.status(413).json({ error: 'El mensaje es demasiado largo' });
  }
  // Acotado: un durationMs enorme desbordaba la columna integer y frenaba todo guardado.
  const duration = Number.isFinite(Number(durationMs)) ? Math.min(maxAudioDurationMs, Math.max(0, Math.round(Number(durationMs)))) : 0;
  const timerSeconds = timerPreference(req.user.id, scope, targetId);
  // Los audios nunca quedan para siempre: sin temporizador duran un dia, y con
  // temporizador puesto mandan los segundos que eligio quien los graba.
  const ttlSeconds = kind === 'audio' ? timerSeconds || audioMaxTtlSeconds : timerSeconds;
  const message = {
    id: makeId('msg'),
    scope,
    targetId,
    senderId: req.user.id,
    encrypted,
    kind,
    durationMs: kind === 'audio' ? duration : null,
    mimeType: kind === 'audio' ? String(mimeType || 'audio/webm').slice(0, 64) : null,
    createdAt: nowIso(),
    expiresAt: ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null
  };
  await mutate((db) => db.messages.push(message));
  const event = { type: 'message:new', message: { ...message, sender: publicUser(req.user) } };
  const recipientIds = scope === 'group'
    ? state().groupMembers.filter((m) => m.groupId === targetId && m.userId !== req.user.id).map((m) => m.userId)
    : targetId.split(':').filter((id) => id !== req.user.id);
  if (scope === 'group') sendToGroup(targetId, event);
  else sendToConversation(targetId, event);
  void sendPushToUsers(recipientIds, { scope, targetId }).catch((err) => console.error('sendPushToUsers:', err));
  res.json({ message });
});

app.get('/api/admin/stats', auth, requireAdmin, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.json({
    users: state().users.length,
    messages: state().messages.length,
    groups: state().groups.length,
    activeToday: state().users.filter((u) => (u.lastSeenAt || '').startsWith(today)).length
  });
});

app.get('/api/admin/users', auth, requireAdmin, (req, res) => {
  const users = state().users.map((u) => ({
    ...publicUser(u, { includeFingerprint: true }),
    messages: state().messages.filter((m) => m.senderId === u.id).length,
    groups: state().groupMembers.filter((m) => m.userId === u.id).length
  }));
  res.json({ users });
});

app.post('/api/admin/users/:id/reset-password', auth, requireAdmin, async (req, res) => {
  const user = state().users.find((u) => u.id === req.params.id);
  if (!user || user.username === superadminName) return res.status(403).json({ error: 'No permitido' });
  const temp = `Tmp-${nanoid(8).toUpperCase()}`;
  await mutate((db) => {
    user.passwordHash = bcrypt.hashSync(temp, 12);
    user.mustChangePassword = true;
    // Corta tambien los JWT ya emitidos: antes seguian sirviendo hasta 7 dias.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    db.sessions = db.sessions.filter((s) => s.userId !== user.id);
  });
  sendToUser(user.id, { type: 'session:invalidated' });
  closeUserSockets(user.id);
  res.json({ temporaryPassword: temp });
});

app.delete('/api/admin/users', auth, requireAdmin, async (req, res) => {
  const ids = (req.body?.ids || []).filter((id) => state().users.find((u) => u.id === id)?.username !== superadminName);
  await mutate((db) => {
    db.users = db.users.filter((u) => !ids.includes(u.id));
    db.sessions = db.sessions.filter((s) => !ids.includes(s.userId));
    db.contacts = db.contacts.filter((c) => !c.userIds.some((id) => ids.includes(id)));
    db.messages = db.messages.filter((m) => !ids.includes(m.senderId));
    db.groupMembers = db.groupMembers.filter((m) => !ids.includes(m.userId));
    db.messageReadStates = db.messageReadStates.filter((p) => !ids.includes(p.userId));
  });
  res.json({ deleted: ids });
});

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
  try {
    const user = verifyToken(token);
    // 4401: token vencido o revocado, el cliente renueva y reintenta. 4403: tiene que
    // cambiar la clave antes de recibir nada.
    if (!user) return ws.close(4401, 'session');
    if (user.mustChangePassword) return ws.close(4403, 'must-change-password');
    if (!online.has(user.id)) online.set(user.id, new Set());
    online.get(user.id).add(ws);
    ws.send(JSON.stringify({ type: 'socket:ready' }));
    ws.on('close', () => online.get(user.id)?.delete(ws));
  } catch {
    ws.close(4401, 'session');
  }
});

let cleanupTimer;
if (legacyEnabled) {
  await loadStore();
  // Re-asienta quien es superadmin desde la config antes de aceptar cualquier request.
  await seedSuperadmin();
  // Sin catch, un fallo de escritura aca queda como rechazo sin manejar y Node baja
  // el proceso entero. Preferimos loguear y seguir con el proximo tick.
  cleanupTimer = setInterval(() => void cleanupExpiredMessages().catch((err) => console.error('cleanupExpiredMessages:', err)), 30_000);
}
server.listen(port, () => console.log(`OTPChat on http://localhost:${port} (relay v2${legacyEnabled ? ' + API v1 con base de datos' : ', sin base de datos'})`));

// Exportados para que los tests puedan cerrar el proceso: el listen y los intervals dejan
// el event loop vivo y sin esto "node --test" nunca termina.
export { server, wss, cleanupTimer, seedSuperadmin, relay };
