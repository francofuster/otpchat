import { CommonModule, DatePipe } from '@angular/common';
import { Component, ElementRef, OnInit, ViewChild, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { SecretService } from './secret.service';
import { ChatMessage, Contact, Group, GroupMember } from './types';

const timers = [0, 30, 60, 300, 1800, 3600, 21600, 43200, 86400, 604800];

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.css'
})
export class ShellComponent implements OnInit {
  @ViewChild('scrollbox') scrollbox?: ElementRef<HTMLElement>;
  username = '';
  password = '';
  repeatPassword = '';
  newPassword = '';
  showPassword = false;
  showRepeatPassword = false;
  showNewPassword = false;
  darkMode = signal(localStorage.getItem('otpchat_theme') === 'dark');
  authMode: 'login' | 'register' = 'login';
  authError = signal('');
  contacts = signal<Contact[]>([]);
  groups = signal<Group[]>([]);
  messages = signal<ChatMessage[]>([]);
  selected = signal<{ scope: 'contact' | 'group'; id: string; title: string; secret: string; keyVersion: number; timerSeconds: number; role?: string; founderId?: string } | null>(null);
  draft = '';
  panel: 'list' | 'chat' = 'list';
  sheet = signal<'contact' | 'group' | 'members' | 'admin' | null>(null);
  invite = signal<any>(null);
  groupName = '';
  badge = signal<Record<string, number>>({});
  adminStats = signal<any>(null);
  adminUsers = signal<any[]>([]);
  groupMembers = signal<GroupMember[]>([]);
  selectedMembers = signal<Set<string>>(new Set());
  selectedUsers = signal<Set<string>>(new Set());
  tempPassword = signal('');
  timers = timers;
  isAdminRoute = computed(() => location.hash.includes('/admin'));

  constructor(
    public auth: AuthService,
    public crypto: CryptoService,
    public api: ApiService,
    private secrets: SecretService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  async ngOnInit() {
    this.applyTheme();
    const boot = setInterval(async () => {
      if (!this.auth.ready()) return;
      clearInterval(boot);
      if (this.auth.user()) {
        const pendingInvite = this.pendingInvite();
        if (pendingInvite) {
          await this.router.navigate(['/invite', pendingInvite.code], pendingInvite.key ? { queryParams: { key: pendingInvite.key } } : undefined);
          return;
        }
        await this.load();
      }
    }, 100);
    setInterval(() => this.pruneExpired(), 1000);
    window.visualViewport?.addEventListener('resize', () => document.documentElement.style.setProperty('--vvh', `${window.visualViewport?.height || window.innerHeight}px`));
  }

  async login() {
    this.authError.set('');
    if (this.authMode === 'register') {
      const errors = this.passwordErrors(this.password);
      if (errors.length) {
        this.authError.set(`La contraseña debe tener ${errors.join(', ')}.`);
        return;
      }
      if (this.password !== this.repeatPassword) {
        this.authError.set('Las contraseñas no coinciden.');
        return;
      }
    }
    try {
      this.authMode === 'login' ? await this.auth.login(this.username, this.password) : await this.auth.register(this.username, this.password);
      const pendingInvite = this.pendingInvite();
      if (pendingInvite) {
        await this.router.navigate(['/invite', pendingInvite.code], pendingInvite.key ? { queryParams: { key: pendingInvite.key } } : undefined);
        return;
      }
      await this.load();
    } catch (err: any) {
      const blocked = err.error?.blockedUntil ? ` Disponible ${this.countdown(err.error.blockedUntil)}` : '';
      this.authError.set((err.error?.error || err.message || 'No se pudo entrar') + blocked);
    }
  }

  async changePassword() {
    const errors = this.passwordErrors(this.newPassword);
    if (errors.length) {
      this.api.toast(`La contraseña debe tener ${errors.join(', ')}.`);
      return;
    }
    await this.auth.changePassword(this.newPassword);
    this.newPassword = '';
  }

  async load() {
    const data = await this.api.bootstrap();
    this.contacts.set(data.contacts);
    this.groups.set(data.groups);
    this.api.connect((event) => void this.onSocket(event));
    const open = this.route.snapshot.queryParamMap.get('open');
    const contact = data.contacts.find((c) => c.conversationId === open);
    const group = data.groups.find((g) => g.id === open);
    if (contact) await this.openContact(contact);
    if (group) await this.openGroup(group);
    if (this.isAdminRoute() && this.auth.user()?.isSuperadmin) await this.openAdmin();
  }

  async openContact(contact: Contact) {
    const secret = this.secrets.get('contact', contact.conversationId);
    this.selected.set({ scope: 'contact', id: contact.conversationId, title: contact.other.username, secret: secret?.secret || '', keyVersion: secret?.version || 1, timerSeconds: contact.timerSeconds });
    await this.loadMessages();
    this.panel = 'chat';
  }

  async openGroup(group: Group) {
    const secret = this.secrets.get('group', group.id);
    this.selected.set({ scope: 'group', id: group.id, title: group.name, secret: secret?.secret || '', keyVersion: secret?.version || 1, timerSeconds: group.timerSeconds, role: group.role, founderId: group.founderId });
    await this.loadMessages();
    this.panel = 'chat';
  }

  async loadMessages() {
    const chat = this.selected();
    if (!chat) return;
    const res = await this.api.messages(chat.scope, chat.id);
    const decrypted: ChatMessage[] = [];
    for (const m of res.messages) {
      const secret = this.secrets.getVersion(chat.scope, chat.id, m.encrypted.keyVersion || 1) || chat.secret;
      const text = secret ? await this.crypto.decrypt(m.encrypted, secret) : '[Falta la llave local para descifrar]';
      decrypted.push({ ...m, text: this.applyKeyRotation(chat.scope, chat.id, text) });
    }
    this.messages.set(decrypted);
    this.badge.update((b) => ({ ...b, [chat.id]: 0 }));
    setTimeout(() => this.scrollBottom(), 40);
  }

  async send() {
    const chat = this.selected();
    if (!chat || !this.draft.trim()) return;
    if (!chat.secret) {
      this.api.toast('Falta la llave local de este chat. Necesitas una nueva invitacion segura.');
      return;
    }
    const text = this.draft.trim();
    this.draft = '';
    const encrypted = await this.crypto.encrypt(text, chat.secret, chat.keyVersion);
    const { message } = await this.api.sendMessage(chat.scope, chat.id, encrypted);
    const optimistic = { ...message, encrypted, sender: this.auth.user() || undefined, text };
    this.messages.update((items) => items.some((item) => item.id === message.id) ? items : [...items, optimistic]);
    setTimeout(() => this.scrollBottom(), 40);
  }

  keydown(event: KeyboardEvent) {
    const mobile = matchMedia('(max-width: 760px)').matches;
    if (event.key === 'Enter' && !event.shiftKey && !mobile) {
      event.preventDefault();
      void this.send();
    }
  }

  async createInvite() {
    const secret = this.secrets.generate();
    const invitation = (await this.api.createContactInvite()).invitation;
    invitation.link = this.secrets.attachToInviteLink(invitation.link, secret);
    invitation.qr = await this.secrets.qrFor(invitation.link);
    this.secrets.savePendingInvite(invitation.code, secret);
    this.invite.set(invitation);
    this.sheet.set('contact');
  }

  openGroupSheet() {
    this.invite.set(null);
    this.sheet.set('group');
  }

  async createGroup() {
    const secret = this.secrets.generate();
    const { group } = await this.api.createGroup(this.groupName || 'Grupo OTP');
    this.secrets.save('group', group.id, secret);
    this.groupName = '';
    await this.load();
    await this.openGroup({ ...group, role: 'admin' });
    this.sheet.set(null);
  }

  async groupInvite() {
    const chat = this.selected();
    if (chat?.scope !== 'group' || !this.canModerate(chat.role)) return;
    if (!chat.secret) {
      this.api.toast('Falta la llave local del grupo en este dispositivo.');
      return;
    }
    const invitation = (await this.api.createGroupInvite(chat.id)).invitation;
    invitation.link = this.secrets.attachToInviteLink(invitation.link, chat.secret);
    invitation.qr = await this.secrets.qrFor(invitation.link);
    this.invite.set(invitation);
    this.sheet.set('group');
  }

  async setTimer(seconds: string) {
    const chat = this.selected();
    if (!chat) return;
    const timerSeconds = Number(seconds);
    chat.timerSeconds = timerSeconds;
    this.selected.set({ ...chat });
    chat.scope === 'group' ? await this.api.updateGroupTimer(chat.id, timerSeconds) : await this.api.updateContactTimer(chat.id, timerSeconds);
  }

  async rotateSecret() {
    const chat = this.selected();
    if (!chat?.secret) {
      this.api.toast('Falta la llave actual para renovar este chat.');
      return;
    }
    const nextVersion = chat.keyVersion + 1;
    const nextSecret = this.secrets.generate();
    const control = JSON.stringify({ otpchatControl: 'key-rotation', version: nextVersion, secret: nextSecret });
    const encrypted = await this.crypto.encrypt(control, chat.secret, chat.keyVersion);
    const { message } = await this.api.sendMessage(chat.scope, chat.id, encrypted);
    this.secrets.save(chat.scope, chat.id, nextSecret, nextVersion);
    this.selected.set({ ...chat, secret: nextSecret, keyVersion: nextVersion });
    const optimistic = { ...message, encrypted, sender: this.auth.user() || undefined, text: 'Clave del chat renovada' };
    this.messages.update((items) => items.some((item) => item.id === message.id) ? items : [...items, optimistic]);
    this.api.toast('Clave renovada para futuros mensajes');
    setTimeout(() => this.scrollBottom(), 40);
  }

  async deleteCurrentChat() {
    const chat = this.selected();
    if (!chat) return;
    if (chat.scope === 'contact') {
      await this.api.deleteContact(chat.id);
      this.api.toast('Chat eliminado');
    } else if (chat.role === 'admin') {
      await this.api.deleteGroup(chat.id);
      this.api.toast('Grupo eliminado');
    }
    this.selected.set(null);
    this.messages.set([]);
    this.panel = 'list';
    await this.load();
  }

  async leaveCurrentGroup() {
    const chat = this.selected();
    if (chat?.scope !== 'group') return;
    await this.api.leaveGroup(chat.id);
    this.api.toast('Saliste del grupo');
    this.selected.set(null);
    this.messages.set([]);
    this.panel = 'list';
    await this.load();
  }

  async openMembers() {
    const chat = this.selected();
    if (chat?.scope !== 'group' || !this.canModerate(chat.role)) return;
    const res = await this.api.groupMembers(chat.id);
    this.groupMembers.set(res.members);
    this.selectedMembers.set(new Set());
    this.sheet.set('members');
  }

  toggleMember(id: string) {
    const next = new Set(this.selectedMembers());
    next.has(id) ? next.delete(id) : next.add(id);
    this.selectedMembers.set(next);
  }

  async removeSelectedMembers() {
    const chat = this.selected();
    const ids = [...this.selectedMembers()];
    if (chat?.scope !== 'group' || !ids.length) return;
    await this.api.removeGroupMembers(chat.id, ids);
    this.api.toast('Miembros eliminados');
    await this.openMembers();
  }

  async setSelectedMembersRole(role: 'subadmin' | 'member') {
    const chat = this.selected();
    const ids = [...this.selectedMembers()];
    if (chat?.scope !== 'group' || chat.role !== 'admin' || !ids.length) return;
    await this.api.updateGroupMemberRoles(chat.id, ids, role);
    this.api.toast(role === 'subadmin' ? 'Subadmin asignado' : 'Rol actualizado');
    await this.openMembers();
  }

  async copyInviteLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      this.api.toast('Link copiado');
    } catch {
      const input = document.createElement('textarea');
      input.value = link;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      this.api.toast('Link copiado');
    }
  }

  async openAdmin() {
    this.sheet.set('admin');
    this.adminStats.set(await this.api.adminStats());
    this.adminUsers.set((await this.api.adminUsers()).users);
  }

  toggleUser(id: string) {
    const next = new Set(this.selectedUsers());
    next.has(id) ? next.delete(id) : next.add(id);
    this.selectedUsers.set(next);
  }

  async resetPassword(id: string) {
    this.tempPassword.set((await this.api.resetPassword(id)).temporaryPassword);
  }

  async deleteSelected() {
    await this.api.deleteUsers([...this.selectedUsers()]);
    this.selectedUsers.set(new Set());
    await this.openAdmin();
  }

  timerLabel(seconds: number) {
    if (!seconds) return 'Desactivado';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${seconds / 60}min`;
    if (seconds < 86400) return `${seconds / 3600}h`;
    return seconds === 604800 ? '7 días' : '1 día';
  }

  countdown(to?: string | null) {
    if (!to) return '';
    const ms = new Date(to).getTime() - Date.now();
    if (ms <= 0) return '0s';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
  }

  isMine(message: ChatMessage) {
    return message.senderId === this.auth.user()?.id;
  }

  back() { this.panel = 'list'; }

  switchAuthMode(mode: 'login' | 'register') {
    this.authMode = mode;
    this.authError.set('');
    this.password = '';
    this.repeatPassword = '';
  }

  toggleTheme() {
    this.darkMode.update((enabled) => !enabled);
    localStorage.setItem('otpchat_theme', this.darkMode() ? 'dark' : 'light');
    this.applyTheme();
  }

  passwordErrors(password: string) {
    const errors: string[] = [];
    if (password.length <= 6) errors.push('mas de 6 caracteres');
    if (!/[A-Z]/.test(password)) errors.push('1 mayuscula');
    if (!/[a-z]/.test(password)) errors.push('1 minuscula');
    if (!/[0-9]/.test(password)) errors.push('1 numero');
    if (!/[^A-Za-z0-9]/.test(password)) errors.push('1 simbolo');
    return errors;
  }

  private applyTheme() {
    document.documentElement.dataset['theme'] = this.darkMode() ? 'dark' : 'light';
  }

  private async onSocket(event: any) {
    if (event.type === 'session:invalidated') {
      this.api.toast('Tu sesión fue invalidada por reset de contraseña');
      this.auth.clear();
    }
    if (event.type === 'contact:accepted') {
      await this.load();
      const contact = this.contacts().find((item) => item.conversationId === event.conversationId);
      if (contact) {
        const secret = this.secrets.consumePendingInvite(event.code);
        if (secret) this.secrets.save('contact', event.conversationId, secret);
        this.sheet.set(null);
        this.invite.set(null);
        await this.openContact(contact);
        this.api.toast('Invitación aceptada');
      }
    }
    if (['group:removed', 'group:left', 'group:deleted'].includes(event.type)) {
      if (this.selected()?.id === event.groupId) {
        this.selected.set(null);
        this.messages.set([]);
        this.panel = 'list';
        this.sheet.set(null);
      }
      await this.load();
    }
    if (event.type === 'contact:deleted') {
      if (this.selected()?.id === event.conversationId) {
        this.selected.set(null);
        this.messages.set([]);
        this.panel = 'list';
      }
      await this.load();
    }
    if (event.type?.startsWith('group:')) await this.load();
    if (event.type === 'timer:changed') this.api.toast(`${event.by} cambió los mensajes temporales`);
    if (event.type === 'message:new') {
      const chat = this.selected();
      if (chat && chat.id === event.message.targetId) {
        const secret = this.secrets.getVersion(chat.scope, chat.id, event.message.encrypted.keyVersion || 1) || chat.secret;
        const text = secret ? await this.crypto.decrypt(event.message.encrypted, secret) : '[Falta la llave local para descifrar]';
        event.message.text = this.applyKeyRotation(chat.scope, chat.id, text);
        this.messages.update((items) => items.some((item) => item.id === event.message.id) ? items : [...items, event.message]);
        setTimeout(() => this.scrollBottom(), 40);
      } else {
        this.badge.update((b) => ({ ...b, [event.message.targetId]: (b[event.message.targetId] || 0) + 1 }));
        this.api.toast('Mensaje nuevo');
      }
    }
    if (event.type === 'messages:expired') this.pruneExpired();
  }

  private pruneExpired() {
    const before = this.messages().length;
    this.messages.update((items) => items.filter((m) => !m.expiresAt || new Date(m.expiresAt).getTime() > Date.now()));
    if (before !== this.messages().length) this.api.toast('Un mensaje temporal expiró');
  }

  private scrollBottom() {
    const box = this.scrollbox?.nativeElement;
    if (box) box.scrollTop = box.scrollHeight;
  }

  private applyKeyRotation(scope: 'contact' | 'group', id: string, text: string): string {
    try {
      const control = JSON.parse(text);
      if (control?.otpchatControl !== 'key-rotation' || !control.secret || !control.version) return text;
      this.secrets.save(scope, id, control.secret, Number(control.version));
      const chat = this.selected();
      if (chat?.scope === scope && chat.id === id && Number(control.version) > chat.keyVersion) {
        this.selected.set({ ...chat, secret: control.secret, keyVersion: Number(control.version) });
      }
      return 'Clave del chat renovada';
    } catch {
      return text;
    }
  }

  private pendingInvite(): { code: string; key?: string } | null {
    const raw = localStorage.getItem('otpchat_pending_invite');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed?.code ? parsed : { code: raw };
    } catch {
      return { code: raw };
    }
  }

  canModerate(role?: string) {
    return role === 'admin' || role === 'subadmin';
  }

  roleLabel(role?: string) {
    return role === 'admin' ? 'Admin principal' : role === 'subadmin' ? 'Subadmin' : 'Miembro';
  }
}
