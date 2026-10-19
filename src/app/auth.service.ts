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

  private refreshing: Promise<boolean> | null = null;

  constructor(private http: HttpClient, private crypto: CryptoService) {}

  async boot() {
    if (localStorage.getItem('otpchat_refresh')) await this.refresh();
    this.ready.set(true);
  }

  // El JWT dura poco, asi que se renueva cuando el servidor lo rechaza. Los pedidos que
  // fallen a la vez comparten una sola renovacion: el refresh token rota en cada uso y un
  // segundo intento con el viejo cerraria la sesion.
  refresh(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const refreshToken = localStorage.getItem('otpchat_refresh');
    if (!refreshToken) return false;
    try {
      const fingerprint = await this.crypto.fingerprint();
      const res = await firstValueFrom(this.http.post<{ user: User; token: string; refreshToken: string }>(apiUrl('/api/auth/refresh'), { refreshToken, fingerprint }));
      this.store(res);
      return true;
    } catch {
      this.clear();
      return false;
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

  // El servidor corta todas las sesiones al cambiar la clave y devuelve una nueva para este
  // dispositivo. currentPassword no hace falta en el cambio forzado tras un reset.
  async changePassword(password: string, currentPassword?: string) {
    const fingerprint = await this.crypto.fingerprint();
    const res = await firstValueFrom(this.http.post<{ user: User; token: string; refreshToken: string }>(apiUrl('/api/auth/change-password'), { password, currentPassword, fingerprint }));
    this.store(res);
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
