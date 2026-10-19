// Puente entre la migracion del nucleo (src/core/migration.js) y el navegador: de aca salen
// la sesion vieja y las llaves de sala que v1 dejo en localStorage, si este navegador las tiene.
import { apiUrl } from './runtime-config';

export interface LegacyMessage { id: string; ts: number; mine: boolean; senderName: string; kind: 'text' | 'audio'; text: string; audio?: string; mime?: string; durationMs?: number }
export interface LegacyChat { id: string; kind: 'contact' | 'group'; title: string; messages: LegacyMessage[]; importedAt: number; v2ChatId?: string; sharedBy?: string }

function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// Sesion de v1 todavia abierta en este navegador.
export function browserLegacySession(): { refreshToken: string; fingerprint: string } | null {
  const refreshToken = read('otpchat_refresh');
  const fingerprint = read('otpchat_fingerprint');
  return refreshToken && fingerprint ? { refreshToken, fingerprint } : null;
}

// Nombre de usuario v1, leido del JWT viejo que quedo en el navegador (solo para mostrarlo).
export function legacyUsernameFromSession(): string {
  try {
    const token = read('otpchat_token') || '';
    const payload = JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')));
    return typeof payload?.username === 'string' ? payload.username.slice(0, 32) : '';
  } catch {
    return '';
  }
}

export function legacyFingerprint(): string {
  return read('otpchat_fingerprint') || `v2-${Math.random().toString(36).slice(2, 12)}`;
}

// Llave de sala v1 guardada en este navegador (null en otro dispositivo o en la app).
export function browserLegacySecret(scope: string, id: string, version: number): string | null {
  try {
    const stored = JSON.parse(read(`otpchat_secret:${scope}:${id}`) || 'null');
    return stored?.versions?.[String(version)] || null;
  } catch {
    return null;
  }
}

export function legacyApiBase(): string {
  return apiUrl('') || location.origin;
}
