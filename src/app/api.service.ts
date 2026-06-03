import { HttpClient } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ChatMessage, Contact, Group } from './types';
import { AuthService } from './auth.service';
import { apiUrl, wsUrl } from './runtime-config';

@Injectable({ providedIn: 'root' })
export class ApiService {
  readonly toasts = signal<string[]>([]);
  private socket?: WebSocket;

  constructor(private http: HttpClient, private auth: AuthService) {}

  bootstrap() {
    return firstValueFrom(this.http.get<{ contacts: Contact[]; groups: Group[] }>(apiUrl('/api/bootstrap')));
  }

  createContactInvite() {
    return firstValueFrom(this.http.post<{ invitation: any }>(apiUrl('/api/invitations/contact'), {}));
  }

  getInvite(code: string) {
    return firstValueFrom(this.http.get<any>(apiUrl(`/api/invitations/${code}`)));
  }

  acceptInvite(code: string) {
    return firstValueFrom(this.http.post<any>(apiUrl(`/api/invitations/${code}/accept`), {}));
  }

  rejectInvite(code: string) {
    return firstValueFrom(this.http.post(apiUrl(`/api/invitations/${code}/reject`), {}));
  }

  cancelInvite(code: string) {
    return firstValueFrom(this.http.post(apiUrl(`/api/invitations/${code}/cancel`), {}));
  }

  createGroup(name: string) {
    return firstValueFrom(this.http.post<{ group: Group }>(apiUrl('/api/groups'), { name }));
  }

  joinGroup(secret: string) {
    return firstValueFrom(this.http.post<{ group: Group }>(apiUrl('/api/groups/join'), { secret }));
  }

  createGroupInvite(id: string) {
    return firstValueFrom(this.http.post<{ invitation: any }>(apiUrl(`/api/groups/${id}/invite`), {}));
  }

  updateContactTimer(id: string, timerSeconds: number) {
    return firstValueFrom(this.http.patch(apiUrl(`/api/conversations/${id}/timer`), { timerSeconds }));
  }

  updateGroup(id: string, body: Partial<Group>) {
    return firstValueFrom(this.http.patch(apiUrl(`/api/groups/${id}`), body));
  }

  messages(scope: 'contact' | 'group', id: string) {
    return firstValueFrom(this.http.get<{ messages: ChatMessage[] }>(apiUrl(`/api/messages/${scope}/${id}`)));
  }

  sendMessage(scope: 'contact' | 'group', targetId: string, encrypted: any) {
    return firstValueFrom(this.http.post<{ message: ChatMessage }>(apiUrl('/api/messages'), { scope, targetId, encrypted }));
  }

  adminStats() {
    return firstValueFrom(this.http.get<any>(apiUrl('/api/admin/stats')));
  }

  adminUsers() {
    return firstValueFrom(this.http.get<any>(apiUrl('/api/admin/users')));
  }

  resetPassword(id: string) {
    return firstValueFrom(this.http.post<any>(apiUrl(`/api/admin/users/${id}/reset-password`), {}));
  }

  deleteUsers(ids: string[]) {
    return firstValueFrom(this.http.delete<any>(apiUrl('/api/admin/users'), { body: { ids } }));
  }

  connect(onEvent: (event: any) => void) {
    const token = this.auth.token();
    if (!token || this.socket?.readyState === WebSocket.OPEN) return;
    this.socket = new WebSocket(`${wsUrl('/ws')}?token=${encodeURIComponent(token)}`);
    this.socket.onmessage = (event) => onEvent(JSON.parse(event.data));
    this.socket.onclose = () => setTimeout(() => this.connect(onEvent), 1500);
  }

  toast(message: string) {
    this.toasts.update((items) => [...items.slice(-2), message]);
    setTimeout(() => this.toasts.update((items) => items.filter((item) => item !== message)), 3500);
  }
}
