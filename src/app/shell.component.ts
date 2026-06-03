import { CommonModule, DatePipe } from '@angular/common';
import { Component, ElementRef, OnInit, ViewChild, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { ChatMessage, Contact, Group } from './types';

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
  selected = signal<{ scope: 'contact' | 'group'; id: string; title: string; secret: string; timerSeconds: number; role?: string } | null>(null);
  draft = '';
  panel: 'list' | 'chat' = 'list';
  sheet = signal<'contact' | 'group' | 'admin' | null>(null);
  invite = signal<any>(null);
  groupName = '';
  groupSecret = '';
  badge = signal<Record<string, number>>({});
  adminStats = signal<any>(null);
  adminUsers = signal<any[]>([]);
  selectedUsers = signal<Set<string>>(new Set());
  tempPassword = signal('');
  timers = timers;
  isAdminRoute = computed(() => location.hash.includes('/admin'));

  constructor(
    public auth: AuthService,
    public crypto: CryptoService,
    public api: ApiService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  async ngOnInit() {
    this.applyTheme();
    const boot = setInterval(async () => {
      if (!this.auth.ready()) return;
      clearInterval(boot);
      if (this.auth.user()) await this.load();
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
    this.selected.set({ scope: 'contact', id: contact.conversationId, title: contact.other.username, secret: contact.conversationId, timerSeconds: contact.timerSeconds });
    await this.loadMessages();
    this.panel = 'chat';
  }

  async openGroup(group: Group) {
    this.selected.set({ scope: 'group', id: group.id, title: group.name, secret: group.secret, timerSeconds: group.timerSeconds, role: group.role });
    await this.loadMessages();
    this.panel = 'chat';
  }

  async loadMessages() {
    const chat = this.selected();
    if (!chat) return;
    const res = await this.api.messages(chat.scope, chat.id);
    const secret = await this.crypto.sharedSecret(chat.secret);
    const decrypted = await Promise.all(res.messages.map(async (m) => ({ ...m, text: await this.crypto.decrypt(m.encrypted, secret) })));
    this.messages.set(decrypted);
    this.badge.update((b) => ({ ...b, [chat.id]: 0 }));
    setTimeout(() => this.scrollBottom(), 40);
  }

  async send() {
    const chat = this.selected();
    if (!chat || !this.draft.trim()) return;
    const text = this.draft.trim();
    this.draft = '';
    const secret = await this.crypto.sharedSecret(chat.secret);
    await this.api.sendMessage(chat.scope, chat.id, await this.crypto.encrypt(text, secret));
  }

  keydown(event: KeyboardEvent) {
    const mobile = matchMedia('(max-width: 760px)').matches;
    if (event.key === 'Enter' && !event.shiftKey && !mobile) {
      event.preventDefault();
      void this.send();
    }
  }

  async createInvite() {
    this.invite.set((await this.api.createContactInvite()).invitation);
    this.sheet.set('contact');
  }

  openGroupSheet() {
    this.invite.set(null);
    this.sheet.set('group');
  }

  async createGroup() {
    const { group } = await this.api.createGroup(this.groupName || 'Grupo OTP');
    this.groupName = '';
    await this.load();
    await this.openGroup({ ...group, role: 'admin' });
    this.sheet.set(null);
  }

  async joinGroup() {
    await this.api.joinGroup(this.groupSecret);
    this.groupSecret = '';
    await this.load();
    this.sheet.set(null);
  }

  async groupInvite() {
    const chat = this.selected();
    if (chat?.scope !== 'group') return;
    this.invite.set((await this.api.createGroupInvite(chat.id)).invitation);
    this.sheet.set('group');
  }

  async setTimer(seconds: string) {
    const chat = this.selected();
    if (!chat) return;
    const timerSeconds = Number(seconds);
    chat.timerSeconds = timerSeconds;
    this.selected.set({ ...chat });
    chat.scope === 'group' ? await this.api.updateGroup(chat.id, { timerSeconds } as any) : await this.api.updateContactTimer(chat.id, timerSeconds);
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
    if (event.type === 'contact:accepted' || event.type?.startsWith('group:')) await this.load();
    if (event.type === 'timer:changed') this.api.toast(`${event.by} cambió los mensajes temporales`);
    if (event.type === 'message:new') {
      const chat = this.selected();
      if (chat && chat.id === event.message.targetId) {
        const secret = await this.crypto.sharedSecret(chat.secret);
        event.message.text = await this.crypto.decrypt(event.message.encrypted, secret);
        this.messages.update((items) => [...items, event.message]);
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
}
