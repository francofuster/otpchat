import { EntitySchema } from 'typeorm';

const textDate = { type: 'text', nullable: true };

export const UserEntity = new EntitySchema({
  name: 'User',
  tableName: 'users',
  columns: {
    id: { type: 'varchar', primary: true },
    username: { type: 'varchar', unique: true },
    passwordHash: { type: 'text' },
    deviceFingerprint: { type: 'varchar' },
    mustChangePassword: { type: 'boolean', default: false },
    // Privilegio de superadmin. NO se deriva del nombre de usuario (eso permitia que
    // cualquiera se renombrara al nombre magico y escalara): se siembra en el arranque
    // a partir de SUPERADMIN_USERNAME, que es config de confianza.
    isSuperadmin: { type: 'boolean', default: false },
    createdAt: { type: 'text' },
    lastSeenAt: textDate
  }
});

export const SessionEntity = new EntitySchema({
  name: 'Session',
  tableName: 'sessions',
  columns: {
    id: { type: 'varchar', primary: true },
    userId: { type: 'varchar' },
    tokenHash: { type: 'varchar', unique: true },
    deviceFingerprint: { type: 'varchar' },
    createdAt: { type: 'text' },
    lastUsedAt: { type: 'text' },
    expiresAt: { type: 'text' }
  }
});

export const ContactEntity = new EntitySchema({
  name: 'Contact',
  tableName: 'contacts',
  columns: {
    id: { type: 'varchar', primary: true },
    userIds: { type: 'simple-array' },
    conversationId: { type: 'varchar', unique: true },
    timerSeconds: { type: 'integer', default: 0 },
    createdAt: { type: 'text' }
  }
});

export const InvitationEntity = new EntitySchema({
  name: 'Invitation',
  tableName: 'invitations',
  columns: {
    id: { type: 'varchar', primary: true },
    type: { type: 'varchar' },
    code: { type: 'varchar', unique: true },
    inviterId: { type: 'varchar' },
    groupId: { type: 'varchar', nullable: true },
    keyVersion: { type: 'integer', nullable: true },
    status: { type: 'varchar' },
    createdAt: { type: 'text' },
    expiresAt: { type: 'text' },
    link: { type: 'text' }
  }
});

export const GroupEntity = new EntitySchema({
  name: 'Group',
  tableName: 'chat_groups',
  columns: {
    id: { type: 'varchar', primary: true },
    name: { type: 'varchar' },
    founderId: { type: 'varchar' },
    keyVersion: { type: 'integer', default: 1 },
    timerSeconds: { type: 'integer', default: 0 },
    // En false solo admin y subadmin pueden enviar mensajes al grupo.
    membersCanWrite: { type: 'boolean', default: true },
    createdAt: { type: 'text' }
  }
});

export const GroupMemberEntity = new EntitySchema({
  name: 'GroupMember',
  tableName: 'group_members',
  columns: {
    id: { type: 'integer', primary: true, generated: true },
    groupId: { type: 'varchar' },
    userId: { type: 'varchar' },
    role: { type: 'varchar' },
    joinedAt: { type: 'text' }
  },
  indices: [{ name: 'idx_group_members_unique_user', columns: ['groupId', 'userId'], unique: true }]
});

export const MessageEntity = new EntitySchema({
  name: 'Message',
  tableName: 'messages',
  columns: {
    id: { type: 'varchar', primary: true },
    scope: { type: 'varchar' },
    targetId: { type: 'varchar' },
    senderId: { type: 'varchar' },
    encrypted: { type: 'jsonb' },
    // 'text' o 'audio'. El contenido va cifrado igual en los dos casos; esto solo dice
    // como interpretar los bytes descifrados y que vencimiento aplicarle en el server.
    kind: { type: 'varchar', default: 'text' },
    // Metadata de reproduccion para los audios. No revela nada que el tamano del
    // ciphertext no insinue ya, y permite dibujar el player antes de descifrar.
    durationMs: { type: 'integer', nullable: true },
    mimeType: { type: 'varchar', nullable: true },
    createdAt: { type: 'text' },
    expiresAt: textDate
  },
  indices: [{ name: 'idx_messages_scope_target', columns: ['scope', 'targetId'] }]
});

export const MessageTimerPreferenceEntity = new EntitySchema({
  name: 'MessageTimerPreference',
  tableName: 'message_timer_preferences',
  columns: {
    id: { type: 'integer', primary: true, generated: true },
    userId: { type: 'varchar' },
    scope: { type: 'varchar' },
    targetId: { type: 'varchar' },
    timerSeconds: { type: 'integer', default: 0 },
    updatedAt: { type: 'text' }
  },
  indices: [{ name: 'idx_timer_preferences_unique', columns: ['userId', 'scope', 'targetId'], unique: true }]
});

export const MessageReadStateEntity = new EntitySchema({
  name: 'MessageReadState',
  tableName: 'message_read_states',
  columns: {
    id: { type: 'integer', primary: true, generated: true },
    userId: { type: 'varchar' },
    scope: { type: 'varchar' },
    targetId: { type: 'varchar' },
    lastReadAt: { type: 'text' }
  },
  indices: [{ name: 'idx_read_states_unique', columns: ['userId', 'scope', 'targetId'], unique: true }]
});

export const SecurityEventEntity = new EntitySchema({
  name: 'SecurityEvent',
  tableName: 'security_events',
  columns: {
    id: { type: 'varchar', primary: true },
    type: { type: 'varchar' },
    ip: { type: 'varchar', nullable: true },
    fingerprint: { type: 'varchar', nullable: true },
    createdAt: { type: 'text' }
  }
});

export const PushSubscriptionEntity = new EntitySchema({
  name: 'PushSubscription',
  tableName: 'push_subscriptions',
  columns: {
    id: { type: 'varchar', primary: true },
    userId: { type: 'varchar' },
    endpoint: { type: 'text', unique: true },
    subscription: { type: 'jsonb' },
    createdAt: { type: 'text' },
    updatedAt: { type: 'text' }
  },
  indices: [{ name: 'idx_push_subscriptions_user', columns: ['userId'] }]
});

export const entities = [
  UserEntity,
  SessionEntity,
  ContactEntity,
  InvitationEntity,
  GroupEntity,
  GroupMemberEntity,
  MessageEntity,
  MessageTimerPreferenceEntity,
  MessageReadStateEntity,
  SecurityEventEntity,
  PushSubscriptionEntity
];
