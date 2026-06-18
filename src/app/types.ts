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
  other: User;
}

export interface Group {
  id: string;
  name: string;
  secret: string;
  founderId: string;
  timerSeconds: number;
  role: 'admin' | 'member';
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
}
