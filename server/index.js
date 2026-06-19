import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
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
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const port = Number(process.env.PORT || 4900);
const jwtSecret = process.env.JWT_SECRET || 'dev-otpchat-secret';
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5900';
const superadminName = 'sup3r4drm1n_3533';
const online = new Map();
const registerCooldownEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.REGISTER_COOLDOWN_ENABLED || '').toLowerCase());
const deviceAccountLimitEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.DEVICE_ACCOUNT_LIMIT_ENABLED || '').toLowerCase());

function inviteLink(code) {
  return `${clientOrigin.replace(/\/$/, '')}/#/invite/${code}`;
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
const registerLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 3, standardHeaders: true, legacyHeaders: false });

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function sign(user) {
  return jwt.sign({ sub: user.id, username: user.username }, jwtSecret, { expiresIn: '7d' });
}

function passwordErrors(password) {
  const errors = [];
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

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    const payload = jwt.verify(token, jwtSecret);
    const user = state().users.find((u) => u.id === payload.sub);
    if (!user) return res.status(401).json({ error: 'Sesión inválida' });
    req.user = user;
    user.lastSeenAt = nowIso();
    next();
  } catch {
    res.status(401).json({ error: 'Sesión inválida' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.username !== superadminName) return res.status(403).json({ error: 'Solo superadmin' });
  next();
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
  return { ...group, keyVersion: group.keyVersion || 1, joinedAt: member?.joinedAt, timerSeconds: timerPreference(userId, 'group', group.id), role: groupRole(group, userId) };
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

app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const { username, password, fingerprint } = req.body || {};
  if (!username || !password || !fingerprint) return res.status(400).json({ error: 'Faltan datos' });
  const passErrors = passwordErrors(password);
  if (passErrors.length) return res.status(400).json({ error: `La contraseña debe tener ${passErrors.join(', ')}` });
  const blockedUntil = registerCooldownEnabled ? registerBlocked(req.ip, fingerprint) : null;
  if (blockedUntil) return res.status(429).json({ error: 'Registro en cooldown', blockedUntil });
  if (state().users.some((u) => u.username.toLowerCase() === String(username).toLowerCase())) {
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
    createdAt: nowIso(),
    lastSeenAt: nowIso()
  };
  const refreshToken = issueSession(user, fingerprint);
  await mutate((db) => {
    db.users.push(user);
    db.securityEvents.push({ id: makeId('sec'), type: 'register', ip: req.ip, fingerprint, createdAt: nowIso() });
  });
  res.json({ user: publicUser(user), token: sign(user), refreshToken });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password, fingerprint } = req.body || {};
  const user = state().users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
    return res.status(401).json({ error: 'Usuario o contraseña inválidos' });
  }
  if (deviceAccountLimitEnabled && fingerprint && user.deviceFingerprint !== fingerprint && user.username !== superadminName) {
    return res.status(403).json({ error: 'Cuenta vinculada a otro dispositivo' });
  }
  const refreshToken = issueSession(user, fingerprint || user.deviceFingerprint);
  await mutate(() => {});
  res.json({ user: publicUser(user), token: sign(user), refreshToken });
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
  res.json({ user: publicUser(user), token: sign(user), refreshToken: nextRefresh });
});

app.post('/api/auth/logout', auth, async (req, res) => {
  const { refreshToken } = req.body || {};
  await mutate((db) => {
    db.sessions = db.sessions.filter((s) => s.tokenHash !== hashToken(refreshToken || ''));
  });
  res.json({ ok: true });
});

app.post('/api/auth/change-password', auth, async (req, res) => {
  const { password } = req.body || {};
  const passErrors = passwordErrors(password);
  if (passErrors.length) return res.status(400).json({ error: `La contraseña debe tener ${passErrors.join(', ')}` });
  await mutate(() => {
    req.user.passwordHash = bcrypt.hashSync(password, 12);
    req.user.mustChangePassword = false;
  });
  res.json({ user: publicUser(req.user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/auth/username', auth, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  if (username.length < 3) return res.status(400).json({ error: 'El usuario debe tener al menos 3 caracteres' });
  if (username.length > 32) return res.status(400).json({ error: 'El usuario no puede superar 32 caracteres' });
  if (!/^[A-Za-z0-9_.-]+$/.test(username)) return res.status(400).json({ error: 'Usa solo letras, numeros, punto, guion o guion bajo' });
  const taken = state().users.some((u) => u.id !== req.user.id && u.username.toLowerCase() === username.toLowerCase());
  if (taken) return res.status(409).json({ error: 'Ese usuario ya existe' });
  await mutate(() => {
    req.user.username = username;
  });
  res.json({ user: publicUser(req.user) });
});

app.get('/api/bootstrap', auth, (req, res) => {
  const contacts = state().contacts
    .filter((c) => c.userIds.includes(req.user.id))
    .map((c) => {
      const otherId = c.userIds.find((id) => id !== req.user.id);
      return { ...c, timerSeconds: timerPreference(req.user.id, 'contact', c.conversationId), other: publicUser(state().users.find((u) => u.id === otherId)) };
    });
  const groups = state().groupMembers
    .filter((m) => m.userId === req.user.id)
    .map((m) => {
      const group = state().groups.find((g) => g.id === m.groupId);
      return groupPayload(group, req.user.id);
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
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
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
  if (invitation.type === 'group') return res.json({ ok: true });
  await mutate(() => (invitation.status = 'rejected'));
  sendToUser(invitation.inviterId, { type: 'invitation:rejected', invitation });
  res.json({ ok: true });
});

app.post('/api/groups', auth, async (req, res) => {
  const { name } = req.body || {};
  const group = { id: makeId('grp'), name: name || 'Grupo OTP', founderId: req.user.id, keyVersion: 1, timerSeconds: 0, createdAt: nowIso() };
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
  const invitation = { id: makeId('inv'), type: 'group', code, inviterId: req.user.id, groupId: req.params.id, keyVersion: group.keyVersion || 1, status: 'pending', createdAt: nowIso(), expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), link };
  await mutate((db) => db.invitations.push(invitation));
  res.json({ invitation });
});

app.patch('/api/groups/:id/key-version', auth, async (req, res) => {
  const member = groupMember(req.params.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'No perteneces al grupo' });
  const group = state().groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
  if (groupRole(group, req.user.id) !== 'admin') return res.status(403).json({ error: 'Solo admin principal' });
  const keyVersion = Number(req.body?.keyVersion || 0);
  if (keyVersion <= (group.keyVersion || 1)) return res.status(400).json({ error: 'Version invalida' });
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
  const timerSeconds = Number(req.body?.timerSeconds || 0);
  const contact = state().contacts.find((c) => c.conversationId === req.params.id && c.userIds.includes(req.user.id));
  if (!contact) return res.status(404).json({ error: 'Chat no encontrado' });
  await mutate(() => setTimerPreference(req.user.id, 'contact', contact.conversationId, timerSeconds));
  res.json({ contact: { ...contact, timerSeconds } });
});

app.patch('/api/groups/:id/timer', auth, async (req, res) => {
  const timerSeconds = Number(req.body?.timerSeconds || 0);
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
  await mutate(() => {
    if (req.body?.name) group.name = req.body.name;
    if (req.body?.timerSeconds !== undefined) group.timerSeconds = Number(req.body.timerSeconds || 0);
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
    const remaining = db.groupMembers
      .filter((m) => m.groupId === group.id)
      .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime());
    if (!remaining.length) {
      deleted = true;
      db.groups = db.groups.filter((g) => g.id !== group.id);
      db.messages = db.messages.filter((m) => !(m.scope === 'group' && m.targetId === group.id));
      db.invitations = db.invitations.filter((i) => i.groupId !== group.id);
      db.messageTimerPreferences = db.messageTimerPreferences.filter((p) => !(p.scope === 'group' && p.targetId === group.id));
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
  });
  sendToConversation(contact.conversationId, { type: 'contact:deleted', conversationId: contact.conversationId });
  res.json({ deleted: true });
});

app.get('/api/messages/:scope/:id', auth, (req, res) => {
  const { scope, id } = req.params;
  const allowed =
    (scope === 'contact' && state().contacts.some((c) => c.conversationId === id && c.userIds.includes(req.user.id))) ||
    (scope === 'group' && state().groupMembers.some((m) => m.groupId === id && m.userId === req.user.id));
  if (!allowed) return res.status(403).json({ error: 'Sin acceso' });
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

app.post('/api/messages', auth, async (req, res) => {
  const { scope, targetId, encrypted } = req.body || {};
  const allowed =
    (scope === 'contact' && state().contacts.some((c) => c.conversationId === targetId && c.userIds.includes(req.user.id))) ||
    (scope === 'group' && state().groupMembers.some((m) => m.groupId === targetId && m.userId === req.user.id));
  if (!allowed || !encrypted?.ciphertext) return res.status(400).json({ error: 'Mensaje inválido' });
  const timerSeconds = timerPreference(req.user.id, scope, targetId);
  const message = {
    id: makeId('msg'),
    scope,
    targetId,
    senderId: req.user.id,
    encrypted,
    createdAt: nowIso(),
    expiresAt: timerSeconds ? new Date(Date.now() + timerSeconds * 1000).toISOString() : null
  };
  await mutate((db) => db.messages.push(message));
  const event = { type: 'message:new', message: { ...message, sender: publicUser(req.user) } };
  if (scope === 'group') sendToGroup(targetId, event);
  else sendToConversation(targetId, event);
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
    ...publicUser(u),
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
    db.sessions = db.sessions.filter((s) => s.userId !== user.id);
  });
  sendToUser(user.id, { type: 'session:invalidated' });
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
  });
  res.json({ deleted: ids });
});

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
  try {
    const payload = jwt.verify(token, jwtSecret);
    const user = state().users.find((u) => u.id === payload.sub);
    if (!user) throw new Error('missing user');
    if (!online.has(user.id)) online.set(user.id, new Set());
    online.get(user.id).add(ws);
    ws.send(JSON.stringify({ type: 'socket:ready' }));
    ws.on('close', () => online.get(user.id)?.delete(ws));
  } catch {
    ws.close();
  }
});

await loadStore();
setInterval(() => void cleanupExpiredMessages(), 30_000);
server.listen(port, () => console.log(`OTPChat API on http://localhost:${port}`));
