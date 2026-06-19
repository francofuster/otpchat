import { Injectable } from '@angular/core';

interface StoredSecrets {
  currentVersion: number;
  versions: Record<string, string>;
}

const prefix = 'otpchat_secret';
const invitePrefix = 'otpchat_invite_secret';

@Injectable({ providedIn: 'root' })
export class SecretService {
  generate(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return this.toBase64Url(bytes);
  }

  get(scope: 'contact' | 'group', id: string): { secret: string; version: number } | null {
    const stored = this.read(scope, id);
    if (!stored) return null;
    const secret = stored.versions[String(stored.currentVersion)];
    return secret ? { secret, version: stored.currentVersion } : null;
  }

  getVersion(scope: 'contact' | 'group', id: string, version = 1): string | null {
    return this.read(scope, id)?.versions[String(version)] || null;
  }

  save(scope: 'contact' | 'group', id: string, secret: string, version = 1) {
    const stored = this.read(scope, id) || { currentVersion: version, versions: {} };
    stored.versions[String(version)] = secret;
    stored.currentVersion = Math.max(stored.currentVersion, version);
    localStorage.setItem(this.key(scope, id), JSON.stringify(stored));
  }

  savePendingInvite(code: string, secret: string) {
    localStorage.setItem(`${invitePrefix}:${code}`, secret);
  }

  consumePendingInvite(code: string): string | null {
    const key = `${invitePrefix}:${code}`;
    const secret = localStorage.getItem(key);
    localStorage.removeItem(key);
    return secret;
  }

  attachToInviteLink(link: string, secret: string): string {
    const url = new URL(link, location.origin);
    const [path, query = ''] = url.hash.slice(1).split('?');
    const params = new URLSearchParams(query);
    params.set('key', secret);
    url.hash = `${path}?${params.toString()}`;
    return url.toString();
  }

  async qrFor(link: string): Promise<string> {
    const QRCode = await import('qrcode') as any;
    return (QRCode.toDataURL || QRCode.default?.toDataURL)(link, { margin: 1, width: 320 });
  }

  private read(scope: 'contact' | 'group', id: string): StoredSecrets | null {
    try {
      const raw = localStorage.getItem(this.key(scope, id));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private key(scope: 'contact' | 'group', id: string) {
    return `${prefix}:${scope}:${id}`;
  }

  private toBase64Url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }
}
