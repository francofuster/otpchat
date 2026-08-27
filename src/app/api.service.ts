import { HttpClient } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ChatMessage, Contact, Group, GroupMember } from './types';
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

  createGroupInvite(id: string) {
    return firstValueFrom(this.http.post<{ invitation: any }>(apiUrl(`/api/groups/${id}/invite`), {}));
  }

  updateGroupKeyVersion(id: string, keyVersion: number) {
    return firstValueFrom(this.http.patch(apiUrl(`/api/groups/${id}/key-version`), { keyVersion }));
  }

  groupMembers(id: string) {
    return firstValueFrom(this.http.get<{ group: Group; members: GroupMember[] }>(apiUrl(`/api/groups/${id}/members`)));
  }

  updateGroupMemberRoles(id: string, ids: string[], role: 'subadmin' | 'member') {
    return firstValueFrom(this.http.patch(apiUrl(`/api/groups/${id}/members/roles`), { ids, role }));
  }

  removeGroupMembers(id: string, ids: string[]) {
    return firstValueFrom(this.http.delete<{ removed: string[] }>(apiUrl(`/api/groups/${id}/members`), { body: { ids } }));
  }

  leaveGroup(id: string) {
    return firstValueFrom(this.http.delete<{ left: boolean; deleted: boolean; ownerId?: string }>(apiUrl(`/api/groups/${id}/leave`)));
  }

  deleteGroup(id: string) {
    return firstValueFrom(this.http.delete<{ deleted: boolean }>(apiUrl(`/api/groups/${id}`)));
  }

  deleteContact(id: string) {
    return firstValueFrom(this.http.delete<{ deleted: boolean }>(apiUrl(`/api/conversations/${id}`)));
  }

  updateContactTimer(id: string, timerSeconds: number) {
    return firstValueFrom(this.http.patch(apiUrl(`/api/conversations/${id}/timer`), { timerSeconds }));
  }

  updateGroup(id: string, body: Partial<Group>) {
    return firstValueFrom(this.http.patch(apiUrl(`/api/groups/${id}`), body));
  }

  updateGroupTimer(id: string, timerSeconds: number) {
    return firstValueFrom(this.http.patch(apiUrl(`/api/groups/${id}/timer`), { timerSeconds }));
  }

  messages(scope: 'contact' | 'group', id: string) {
    return firstValueFrom(this.http.get<{ messages: ChatMessage[] }>(apiUrl(`/api/messages/${scope}/${id}`)));
  }

  markRead(scope: 'contact' | 'group', id: string) {
    return firstValueFrom(this.http.post(apiUrl(`/api/messages/${scope}/${id}/read`), {}));
  }

  sendMessage(scope: 'contact' | 'group', targetId: string, encrypted: any) {
    return firstValueFrom(this.http.post<{ message: ChatMessage }>(apiUrl('/api/messages'), { scope, targetId, encrypted }));
  }

  pushPublicKey() {
    return firstValueFrom(this.http.get<{ publicKey: string }>(apiUrl('/api/push/public-key')));
  }

  subscribePush(subscription: PushSubscriptionJSON) {
    return firstValueFrom(this.http.post(apiUrl('/api/push/subscribe'), { subscription }));
  }

  unsubscribePush(endpoint?: string) {
    return firstValueFrom(this.http.post(apiUrl('/api/push/unsubscribe'), { endpoint }));
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
