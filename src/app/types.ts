export interface User {
  id: string;
  username: string;
  createdAt: string;
  lastSeenAt?: string;
  deviceFingerprint: string;
  mustChangePassword: boolean;
  isSuperadmin: boolean;
}

export interface Contact {
  id: string;
  conversationId: string;
  userIds: string[];
  timerSeconds: number;
  unreadCount: number;
  other: User;
}

export interface Group {
  id: string;
  name: string;
  founderId: string;
  keyVersion: number;
  joinedAt?: string;
  timerSeconds: number;
  unreadCount?: number;
  role: 'admin' | 'subadmin' | 'member';
}

export interface GroupMember {
  id: number;
  groupId: string;
  userId: string;
  role: 'admin' | 'subadmin' | 'member';
  joinedAt: string;
  user: User;
}

export interface ChatMessage {
  id: string;
  scope: 'contact' | 'group';
  targetId: string;
  senderId: string;
  sender?: User;
  encrypted: EncryptedPayload;
  createdAt: string;
  expiresAt?: string | null;
  text?: string;
  expiring?: boolean;
}

export interface EncryptedPayload {
  iv: string;
  salt: string;
  ciphertext: string;
  keyStep?: number;
  keyVersion?: number;
}
