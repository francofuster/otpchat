import { HttpClient } from '@angular/common/http';
import { Injectable, computed, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { User } from './types';
import { CryptoService } from './crypto.service';
import { apiUrl } from './runtime-config';

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly user = signal<User | null>(null);
  readonly token = signal(localStorage.getItem('otpchat_token'));
  readonly ready = signal(false);
  readonly isAuthed = computed(() => !!this.user());

  constructor(private http: HttpClient, private crypto: CryptoService) {}

  async boot() {
    const refreshToken = localStorage.getItem('otpchat_refresh');
    if (!refreshToken) {
      this.ready.set(true);
      return;
    }
    try {
      const fingerprint = await this.crypto.fingerprint();
      const res = await firstValueFrom(this.http.post<{ user: User; token: string; refreshToken: string }>(apiUrl('/api/auth/refresh'), { refreshToken, fingerprint }));
      this.store(res);
    } catch {
      this.clear();
    } finally {
      this.ready.set(true);
    }
  }

  async register(username: string, password: string) {
    const fingerprint = await this.crypto.fingerprint();
    const res = await firstValueFrom(this.http.post<{ user: User; token: string; refreshToken: string }>(apiUrl('/api/auth/register'), { username, password, fingerprint }));
    this.store(res);
  }

  async login(username: string, password: string) {
    const fingerprint = await this.crypto.fingerprint();
    const res = await firstValueFrom(this.http.post<{ user: User; token: string; refreshToken: string }>(apiUrl('/api/auth/login'), { username, password, fingerprint }));
    this.store(res);
  }

  async changePassword(password: string) {
    const res = await firstValueFrom(this.http.post<{ user: User }>(apiUrl('/api/auth/change-password'), { password }));
    this.user.set(res.user);
  }

  async changeUsername(username: string) {
    const res = await firstValueFrom(this.http.patch<{ user: User }>(apiUrl('/api/auth/username'), { username }));
    this.user.set(res.user);
  }

  async logout() {
    const refreshToken = localStorage.getItem('otpchat_refresh');
    try {
      await firstValueFrom(this.http.post(apiUrl('/api/auth/logout'), { refreshToken }));
    } finally {
      this.clear();
    }
  }

  private store(res: { user: User; token: string; refreshToken: string }) {
    localStorage.setItem('otpchat_token', res.token);
    localStorage.setItem('otpchat_refresh', res.refreshToken);
    this.token.set(res.token);
    this.user.set(res.user);
  }

  clear() {
    localStorage.removeItem('otpchat_token');
    localStorage.removeItem('otpchat_refresh');
    this.token.set(null);
    this.user.set(null);
  }
}
