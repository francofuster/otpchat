import { CommonModule, DatePipe } from '@angular/common';
import { Component, ElementRef, OnInit, ViewChild, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { SecretService } from './secret.service';
import { ChatMessage, Contact, Group, GroupMember } from './types';

const timers = [0, 30, 60, 300, 1800, 3600, 21600, 43200, 86400, 604800];
// Tope de grabacion. Acota el payload cifrado que viaja en el JSON del POST.
const maxRecordingMs = 120_000;
const minRecordingMs = 700;

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
  accountUsername = '';
  accountPassword = '';
  showPassword = false;
  showRepeatPassword = false;
  showNewPassword = false;
  showAccountPassword = false;
  notificationsEnabled = signal(localStorage.getItem('otpchat_notifications') === 'on');
  notificationPermission = signal(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  pushSubscribed = signal(localStorage.getItem('otpchat_push_subscribed') === 'on');
  deferredInstallPrompt = signal<any>(null);
  standaloneMode = signal(matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true);
  disclaimerAccepted = signal(localStorage.getItem('otpchat_disclaimer_accepted') === '1');
  darkMode = signal(localStorage.getItem('otpchat_theme') !== 'light');
  authMode: 'login' | 'register' = 'login';
  authError = signal('');
  authSubmitting = signal(false);
  contacts = signal<Contact[]>([]);
  groups = signal<Group[]>([]);
  messages = signal<ChatMessage[]>([]);
  showJumpToLatest = signal(false);
  selected = signal<{ scope: 'contact' | 'group'; id: string; title: string; secret: string; keyVersion: number; timerSeconds: number; role?: string; founderId?: string; joinedAt?: string; membersCanWrite?: boolean } | null>(null);
  recording = signal(false);
  recordingMs = signal(0);
  sendingAudio = signal(false);
  playingId = signal<string | null>(null);
  playbackPosition = signal(0);
  draft = '';
  panel: 'list' | 'chat' = 'list';
  sheet = signal<'contact' | 'group' | 'actions' | 'members' | 'admin' | 'settings' | null>(null);
  invite = signal<any>(null);
  groupName = '';
  groupCreating = signal(false);
  badge = signal<Record<string, number>>({});
  adminStats = signal<any>(null);
  adminUsers = signal<any[]>([]);
  groupMembers = signal<GroupMember[]>([]);
  selectedMembers = signal<Set<string>>(new Set());
  selectedUsers = signal<Set<string>>(new Set());
  tempPassword = signal('');
  timers = timers;
  isAdminRoute = computed(() => location.hash.includes('/admin'));
  private audioUrls = new Map<string, string>();
  private player?: HTMLAudioElement;
  private recorder?: MediaRecorder;
  private recorderStream?: MediaStream;
  private recorderChunks: Blob[] = [];
  private recordingTimer?: ReturnType<typeof setInterval>;
  private recordingStartedAt = 0;
  private recordedMs = 0;
  private recordingCancelled = false;
  // El chat al que apuntaba la grabacion cuando arranco. MediaRecorder entrega el blob en
  // onstop, un rato despues del click: sin esto, cambiar de chat en ese intervalo mandaria
  // el audio a la conversacion equivocada.
  private recordingChat?: { scope: 'contact' | 'group'; id: string; secret: string; keyVersion: number };

  constructor(
    public auth: AuthService,
    public crypto: CryptoService,
    public api: ApiService,
    private secrets: SecretService,
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
          await this.router.navigate(['/invite', pendingInvite.code], { ...(pendingInvite.key ? { queryParams: { key: pendingInvite.key, kv: pendingInvite.keyVersion || 1 } } : {}), replaceUrl: true });
          return;
        }
        await this.load();
      }
    }, 100);
    setInterval(() => this.pruneExpired(), 1000);
    window.visualViewport?.addEventListener('resize', () => document.documentElement.style.setProperty('--vvh', `${window.visualViewport?.height || window.innerHeight}px`));
    window.addEventListener('hashchange', () => void this.handlePushNavigationFromUrl());
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.deferredInstallPrompt.set(event);
    });
    window.addEventListener('appinstalled', () => {
      this.deferredInstallPrompt.set(null);
      this.standaloneMode.set(true);
      this.api.toast('Acceso directo creado');
    });
  }

  async login() {
    if (this.authSubmitting()) return;
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
    this.authSubmitting.set(true);
    try {
      this.authMode === 'login' ? await this.auth.login(this.username, this.password) : await this.auth.register(this.username, this.password);
      const pendingInvite = this.pendingInvite();
      if (pendingInvite) {
        await this.router.navigate(['/invite', pendingInvite.code], { ...(pendingInvite.key ? { queryParams: { key: pendingInvite.key, kv: pendingInvite.keyVersion || 1 } } : {}), replaceUrl: true });
        return;
      }
      await this.load();
    } catch (err: any) {
      const blocked = err.error?.blockedUntil ? ` Disponible ${this.countdown(err.error.blockedUntil)}` : '';
      this.authError.set((err.error?.error || err.message || 'No se pudo entrar') + blocked);
    } finally {
      this.authSubmitting.set(false);
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
    this.badge.set(Object.fromEntries([
      ...data.contacts.map((c) => [c.conversationId, c.unreadCount || 0] as const),
      ...data.groups.map((g) => [g.id, g.unreadCount || 0] as const)
    ].map(([id, count]) => [id, this.chatVisible(id) ? 0 : count] as const)));
    this.syncSelectedFromBootstrap(data.contacts, data.groups);
    this.api.connect((event) => void this.onSocket(event));
    const open = history.state?.open;
    const pushOpen = this.consumePushOpen();
    const pushList = this.consumePushList();
    if (open || pushOpen || pushList) history.replaceState({ ...history.state, open: null }, '', '/#/');
    const contact = data.contacts.find((c) => c.conversationId === open);
    const group = data.groups.find((g) => g.id === open);
    if (contact) await this.openContact(contact);
    if (group) await this.openGroup(group);
    if (pushOpen?.scope === 'contact') {
      const pushContact = data.contacts.find((c) => c.conversationId === pushOpen.id);
      if (pushContact) await this.openContact(pushContact);
    }
    if (pushOpen?.scope === 'group') {
      const pushGroup = data.groups.find((g) => g.id === pushOpen.id);
      if (pushGroup) await this.openGroup(pushGroup);
    }
    if (pushList && !pushOpen) this.panel = 'list';
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
    this.selected.set({ scope: 'group', id: group.id, title: group.name, secret: secret?.secret || '', keyVersion: secret?.version || group.keyVersion || 1, timerSeconds: group.timerSeconds, role: group.role, founderId: group.founderId, joinedAt: group.joinedAt, membersCanWrite: group.membersCanWrite !== false });
    await this.loadMessages();
    this.panel = 'chat';
  }

  async loadMessages() {
    const chat = this.selected();
    if (!chat) return;
    const res = await this.api.messages(chat.scope, chat.id);
    const decrypted: ChatMessage[] = [];
    for (const m of res.messages) decrypted.push(await this.decryptMessage(chat, m));
    this.releaseAudio(new Set(decrypted.map((m) => m.id)));
    this.messages.set(decrypted);
    this.badge.update((b) => ({ ...b, [chat.id]: 0 }));
    void this.markRead(chat.scope, chat.id);
    setTimeout(() => this.scrollBottom(), 40);
  }

  // Unico punto donde se descifra un mensaje entrante, venga del historial o del socket.
  // Los audios salen como bytes y quedan cacheados como blob URL para el player.
  private async decryptMessage(chat: { scope: 'contact' | 'group'; id: string; secret: string }, message: ChatMessage): Promise<ChatMessage> {
    const secret = this.secrets.getVersion(chat.scope, chat.id, message.encrypted.keyVersion || 1) || chat.secret;
    if (message.kind === 'audio') {
      const bytes = secret ? await this.crypto.decryptBytes(message.encrypted, secret) : null;
      if (bytes) this.cacheAudio(message, bytes);
      return { ...message, text: bytes ? '' : '[No se pudo descifrar el audio]' };
    }
    const text = secret ? await this.crypto.decrypt(message.encrypted, secret) : '[Falta la llave local para descifrar]';
    return { ...message, text: this.applyKeyRotation(chat.scope, chat.id, text, message.senderId) };
  }

  badgeLabel(count: number) {
    return count > 99 ? '+99' : String(count);
  }

  private async markRead(scope: 'contact' | 'group', id: string) {
    try {
      await this.api.markRead(scope, id);
    } catch {}
  }

  private chatVisible(id: string) {
    return this.selected()?.id === id && (this.panel === 'chat' || !matchMedia('(max-width: 760px)').matches);
  }

  async send() {
    const chat = this.selected();
    if (!chat || !this.draft.trim()) return;
    if (!this.canWriteCurrentChat()) {
      this.api.toast('Solo administradores pueden enviar mensajes');
      return;
    }
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

  // Un miembro silenciado no ve el campo de texto, pero el permiso real lo decide el
  // servidor en cada POST: esto es solo para no mostrarle una caja que va a rebotar.
  canWriteCurrentChat() {
    const chat = this.selected();
    if (!chat) return false;
    if (chat.scope !== 'group') return true;
    if (chat.membersCanWrite !== false) return true;
    return this.canModerateChat(chat);
  }

  async toggleGroupWrite(allow: boolean) {
    const chat = this.selected();
    if (chat?.scope !== 'group' || !this.isGroupOwner(chat)) return;
    try {
      await this.api.updateGroup(chat.id, { membersCanWrite: allow });
      this.selected.set({ ...chat, membersCanWrite: allow });
      this.groups.update((items) => items.map((group) => group.id === chat.id ? { ...group, membersCanWrite: allow } : group));
      this.api.toast(allow ? 'Todos pueden escribir en el grupo' : 'Solo administradores pueden escribir');
    } catch (err: any) {
      this.api.toast(err.error?.error || 'No se pudo cambiar el permiso');
    }
  }

  async startRecording() {
    const chat = this.selected();
    if (!chat || this.recording() || this.sendingAudio()) return;
    if (!this.canWriteCurrentChat()) {
      this.api.toast('Solo administradores pueden enviar mensajes');
      return;
    }
    if (!chat.secret) {
      this.api.toast('Falta la llave local de este chat. Necesitas una nueva invitacion segura.');
      return;
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.api.toast('Grabar audio requiere HTTPS y un navegador compatible.');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.api.toast('Sin permiso para usar el microfono.');
      return;
    }
    const mimeType = this.recorderMimeType();
    this.recorderStream = stream;
    this.recorderChunks = [];
    this.recordingCancelled = false;
    this.recordingChat = { scope: chat.scope, id: chat.id, secret: chat.secret, keyVersion: chat.keyVersion };
    this.recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 24000 });
    this.recorder.ondataavailable = (event) => { if (event.data.size) this.recorderChunks.push(event.data); };
    this.recorder.onstop = () => void this.finishRecording();
    this.recorder.start();
    this.recordingStartedAt = Date.now();
    this.recordedMs = 0;
    this.recordingMs.set(0);
    this.recording.set(true);
    this.recordingTimer = setInterval(() => {
      const elapsed = Date.now() - this.recordingStartedAt;
      this.recordingMs.set(elapsed);
      if (elapsed >= maxRecordingMs) this.stopRecording();
    }, 200);
  }

  stopRecording() {
    if (!this.recording()) return;
    this.recordedMs = Date.now() - this.recordingStartedAt;
    this.recording.set(false);
    clearInterval(this.recordingTimer);
    this.recordingTimer = undefined;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
  }

  cancelRecording() {
    if (!this.recording()) return;
    this.recordingCancelled = true;
    this.stopRecording();
  }

  recordingLabel() {
    return this.clock(this.recordingMs());
  }

  recordingProgress() {
    return Math.min(100, (this.recordingMs() / maxRecordingMs) * 100);
  }

  async toggleAudio(message: ChatMessage) {
    const url = this.audioUrls.get(message.id);
    if (!url) {
      this.api.toast('Este audio no se puede reproducir en este dispositivo.');
      return;
    }
    const player = this.ensurePlayer();
    if (this.playingId() === message.id) {
      player.pause();
      return;
    }
    if (player.src !== url) {
      player.src = url;
      player.currentTime = 0;
    }
    this.playingId.set(message.id);
    this.playbackPosition.set(player.currentTime * 1000);
    try {
      await player.play();
    } catch {
      this.playingId.set(null);
      this.api.toast('No se pudo reproducir el audio.');
    }
  }

  hasAudio(message: ChatMessage) {
    return this.audioUrls.has(message.id);
  }

  audioProgress(message: ChatMessage) {
    if (this.playingId() !== message.id || !message.durationMs) return 0;
    return Math.min(100, (this.playbackPosition() / message.durationMs) * 100);
  }

  audioTimeLabel(message: ChatMessage) {
    const total = message.durationMs || 0;
    if (this.playingId() !== message.id) return this.clock(total);
    return this.clock(Math.min(this.playbackPosition(), total));
  }

  clock(ms: number) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  private recorderMimeType() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
  }

  private async finishRecording() {
    const chunks = this.recorderChunks;
    const durationMs = this.recordedMs;
    const mimeType = this.recorder?.mimeType || 'audio/webm';
    const cancelled = this.recordingCancelled;
    const chat = this.recordingChat;
    this.releaseRecorder();
    if (cancelled || !chunks.length || !chat) return;
    if (durationMs < minRecordingMs) {
      this.api.toast('Grabacion demasiado corta.');
      return;
    }
    await this.sendAudio(chat, new Blob(chunks, { type: mimeType }), durationMs, mimeType);
  }

  private async sendAudio(chat: { scope: 'contact' | 'group'; id: string; secret: string; keyVersion: number }, blob: Blob, durationMs: number, mimeType: string) {
    if (!chat.secret) return;
    this.sendingAudio.set(true);
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const encrypted = await this.crypto.encryptBytes(bytes, chat.secret, chat.keyVersion);
      const { message } = await this.api.sendAudio(chat.scope, chat.id, encrypted, durationMs, mimeType);
      const optimistic: ChatMessage = { ...message, encrypted, sender: this.auth.user() || undefined, text: '' };
      this.cacheAudio(optimistic, bytes);
      // Si mientras tanto se cambio de chat, el audio ya viajo al correcto pero la burbuja
      // optimista no va en pantalla: la trae loadMessages al volver.
      if (this.selected()?.id !== chat.id) return;
      this.messages.update((items) => items.some((item) => item.id === message.id) ? items : [...items, optimistic]);
      setTimeout(() => this.scrollBottom(), 40);
    } catch (err: any) {
      this.api.toast(err.error?.error || 'No se pudo enviar el audio');
    } finally {
      this.sendingAudio.set(false);
    }
  }

  private releaseRecorder() {
    clearInterval(this.recordingTimer);
    this.recordingTimer = undefined;
    for (const track of this.recorderStream?.getTracks() || []) track.stop();
    this.recorderStream = undefined;
    this.recorder = undefined;
    this.recorderChunks = [];
    this.recordingChat = undefined;
    this.recording.set(false);
    this.recordingMs.set(0);
  }

  private ensurePlayer() {
    if (this.player) return this.player;
    const player = new Audio();
    player.addEventListener('timeupdate', () => this.playbackPosition.set(player.currentTime * 1000));
    player.addEventListener('ended', () => {
      this.playingId.set(null);
      this.playbackPosition.set(0);
      player.currentTime = 0;
    });
    player.addEventListener('pause', () => { if (!player.ended) this.playingId.set(null); });
    this.player = player;
    return player;
  }

  private cacheAudio(message: ChatMessage, bytes: Uint8Array) {
    const previous = this.audioUrls.get(message.id);
    if (previous) URL.revokeObjectURL(previous);
    const blob = new Blob([bytes], { type: message.mimeType || 'audio/webm' });
    this.audioUrls.set(message.id, URL.createObjectURL(blob));
  }

  // El audio descifrado solo vive como blob URL en memoria. Cuando el mensaje se va
  // (cambio de chat o venció) hay que revocarlo o el blob queda retenido.
  private releaseAudio(keep?: Set<string>) {
    for (const [id, url] of [...this.audioUrls]) {
      if (keep?.has(id)) continue;
      if (this.playingId() === id) this.stopPlayback();
      URL.revokeObjectURL(url);
      this.audioUrls.delete(id);
    }
  }

  private stopPlayback() {
    this.player?.pause();
    if (this.player) this.player.src = '';
    this.playingId.set(null);
    this.playbackPosition.set(0);
  }

  keydown(event: KeyboardEvent) {
    const mobile = matchMedia('(max-width: 760px)').matches;
    if (event.key === 'Enter' && !event.shiftKey && !mobile) {
      event.preventDefault();
      void this.send();
    }
  }

  onMessagesScroll() {
    const box = this.scrollbox?.nativeElement;
    if (!box) return;
    this.showJumpToLatest.set(box.scrollHeight - box.scrollTop - box.clientHeight > 180);
  }

  async createInvite() {
    const secret = this.secrets.generate();
    const invitation = (await this.api.createContactInvite()).invitation;
    invitation.link = this.secrets.attachToInviteLink(invitation.link, secret, 1);
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
    if (this.groupCreating()) return;
    this.groupCreating.set(true);
    const secret = this.secrets.generate();
    try {
      const { group } = await this.api.createGroup(this.groupName || 'Grupo OTP');
      this.secrets.save('group', group.id, secret);
      this.groupName = '';
      await this.load();
      await this.openGroup({ ...group, role: 'admin' });
      this.sheet.set(null);
    } catch (err: any) {
      this.api.toast(err.error?.error || 'No se pudo crear el grupo');
    } finally {
      this.groupCreating.set(false);
    }
  }

  async groupInvite() {
    const chat = this.selected();
    if (chat?.scope !== 'group' || !this.canModerateChat(chat)) return;
    if (!chat.secret) {
      this.api.toast('Falta la llave local del grupo en este dispositivo.');
      return;
    }
    const invitation = (await this.api.createGroupInvite(chat.id)).invitation;
    invitation.link = this.secrets.attachToInviteLink(invitation.link, chat.secret, chat.keyVersion);
    invitation.qr = await this.secrets.qrFor(invitation.link);
    this.invite.set(invitation);
    this.sheet.set('group');
  }

  openActions() {
    if (!this.selected()) return;
    this.invite.set(null);
    this.sheet.set('actions');
  }

  openSettings() {
    this.invite.set(null);
    this.accountUsername = this.auth.user()?.username || '';
    this.accountPassword = '';
    this.sheet.set('settings');
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
    if (chat.scope === 'group' && !this.isGroupOwner(chat)) {
      this.api.toast('Solo el admin principal puede renovar la clave del grupo.');
      return;
    }
    const nextVersion = chat.keyVersion + 1;
    const nextSecret = this.secrets.generate();
    const control = JSON.stringify({ otpchatControl: 'key-rotation', version: nextVersion, secret: nextSecret });
    const encrypted = await this.crypto.encrypt(control, chat.secret, chat.keyVersion);
    const { message } = await this.api.sendMessage(chat.scope, chat.id, encrypted);
    if (chat.scope === 'group') await this.api.updateGroupKeyVersion(chat.id, nextVersion);
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
    } else if (this.isGroupOwner(chat)) {
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
    if (chat?.scope !== 'group' || !this.canModerateChat(chat)) return;
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
    if (chat?.scope !== 'group' || !this.isGroupOwner(chat) || !ids.length) return;
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

  acceptDisclaimer() {
    localStorage.setItem('otpchat_disclaimer_accepted', '1');
    this.disclaimerAccepted.set(true);
  }

  toggleTheme() {
    this.darkMode.update((enabled) => !enabled);
    localStorage.setItem('otpchat_theme', this.darkMode() ? 'dark' : 'light');
    this.applyTheme();
  }

  async saveUsername() {
    try {
      await this.auth.changeUsername(this.accountUsername);
      this.api.toast('Nombre de usuario actualizado');
    } catch (err: any) {
      this.api.toast(err.error?.error || 'No se pudo cambiar el usuario');
    }
  }

  async saveAccountPassword() {
    const errors = this.passwordErrors(this.accountPassword);
    if (errors.length) {
      this.api.toast(`La contraseÃ±a debe tener ${errors.join(', ')}.`);
      return;
    }
    try {
      await this.auth.changePassword(this.accountPassword);
      this.accountPassword = '';
      this.api.toast('ContraseÃ±a actualizada');
    } catch (err: any) {
      this.api.toast(err.error?.error || 'No se pudo cambiar la contraseÃ±a');
    }
  }

  async toggleNotifications() {
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext) {
      this.api.toast('Las notificaciones push requieren HTTPS y un navegador compatible.');
      return;
    }
    if (this.notificationsEnabled()) {
      await this.disablePushNotifications();
      localStorage.setItem('otpchat_notifications', 'off');
      this.notificationsEnabled.set(false);
      this.pushSubscribed.set(false);
      this.api.toast('Notificaciones desactivadas');
      return;
    }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    this.notificationPermission.set(permission);
    if (permission !== 'granted') {
      this.api.toast('Permiso de notificaciones denegado');
      return;
    }
    try {
      await this.enablePushNotifications();
      localStorage.setItem('otpchat_notifications', 'on');
      localStorage.setItem('otpchat_push_subscribed', 'on');
      this.notificationsEnabled.set(true);
      this.pushSubscribed.set(true);
      this.api.toast('Notificaciones activadas');
    } catch (err: any) {
      this.api.toast(err.error?.error || err.message || 'No se pudo activar push');
    }
  }

  async installApp() {
    const prompt = this.deferredInstallPrompt();
    if (!prompt) {
      this.api.toast(this.standaloneMode() ? 'Ya esta instalado como app.' : 'Usa el menu del navegador para agregar a pantalla de inicio.');
      return;
    }
    await prompt.prompt();
    await prompt.userChoice.catch(() => null);
    this.deferredInstallPrompt.set(null);
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
      const mine = event.message.senderId === this.auth.user()?.id;
      if (!mine && !('PushManager' in window)) void this.notifyNewMessage();
      const chat = this.selected();
      if (chat && chat.id === event.message.targetId) {
        const decrypted = await this.decryptMessage(chat, event.message);
        this.messages.update((items) => items.some((item) => item.id === decrypted.id) ? items : [...items, decrypted]);
        setTimeout(() => this.scrollBottom(), 40);
      }
      if (!mine && this.chatVisible(event.message.targetId)) {
        void this.markRead(event.message.scope, event.message.targetId);
      } else if (!mine) {
        this.badge.update((b) => ({ ...b, [event.message.targetId]: (b[event.message.targetId] || 0) + 1 }));
        this.api.toast('Mensaje nuevo');
      }
    }
    if (event.type === 'messages:expired') this.pruneExpired();
  }

  private pruneExpired() {
    const before = this.messages().length;
    this.messages.update((items) => items.filter((m) => !m.expiresAt || new Date(m.expiresAt).getTime() > Date.now()));
    if (before === this.messages().length) return;
    this.releaseAudio(new Set(this.messages().map((m) => m.id)));
    this.api.toast('Un mensaje temporal expiró');
  }

  scrollBottom() {
    const box = this.scrollbox?.nativeElement;
    if (box) {
      box.scrollTop = box.scrollHeight;
      this.showJumpToLatest.set(false);
    }
  }

  private async notifyNewMessage() {
    if (!this.notificationsEnabled() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    const options = { tag: 'otpchat-messages', renotify: false, icon: '/icons/icon.svg', badge: '/icons/icon.svg' };
    try {
      const registration = await navigator.serviceWorker?.ready;
      if (registration) {
        await registration.showNotification('Mensajes nuevos', options);
        return;
      }
    } catch {}
    new Notification('Mensajes nuevos', options);
  }

  private async enablePushNotifications() {
    const { publicKey } = await this.api.pushPublicKey();
    if (!publicKey) throw new Error('Push no configurado en el servidor');
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: this.urlBase64ToUint8Array(publicKey)
    });
    await this.api.subscribePush(subscription.toJSON());
  }

  private async disablePushNotifications() {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    await this.api.unsubscribePush(subscription?.endpoint);
    if (subscription) await subscription.unsubscribe();
    localStorage.setItem('otpchat_push_subscribed', 'off');
  }

  private urlBase64ToUint8Array(value: string) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
  }

  private applyKeyRotation(scope: 'contact' | 'group', id: string, text: string, senderId?: string): string {
    try {
      const control = JSON.parse(text);
      if (control?.otpchatControl !== 'key-rotation' || !control.secret || !control.version) return text;
      // El emisor tiene que estar autorizado a rotar. En un grupo, solo el fundador: sin
      // esto cualquier miembro cifraba este control con la clave actual y le imponia a todos
      // un secreto elegido por el — que seguia conociendo aunque despues lo expulsaran.
      if (!this.canRotateKey(scope, id, senderId)) return text;
      const version = Number(control.version);
      // Nunca aceptar un downgrade: solo versiones mas nuevas que la que ya tenemos.
      const known = this.secrets.get(scope, id)?.version || 0;
      if (version <= known) return text;
      this.secrets.save(scope, id, control.secret, version);
      const chat = this.selected();
      if (chat?.scope === scope && chat.id === id && version > chat.keyVersion) {
        this.selected.set({ ...chat, secret: control.secret, keyVersion: version });
      }
      return 'Clave del chat renovada';
    } catch {
      return text;
    }
  }

  // Contacto: cualquiera de los dos participantes. Grupo: unicamente el fundador, el mismo
  // que del lado del servidor es el unico que puede subir keyVersion.
  private canRotateKey(scope: 'contact' | 'group', id: string, senderId?: string): boolean {
    if (!senderId) return false;
    if (scope === 'contact') return id.split(':').includes(senderId);
    return this.groups().find((g) => g.id === id)?.founderId === senderId;
  }

  private pendingInvite(): { code: string; key?: string; keyVersion?: number } | null {
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

  private consumePushOpen(): { scope: 'contact' | 'group'; id: string } | null {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const raw = params.get('pushOpen') || '';
    const separator = raw.indexOf(':');
    if (separator <= 0) return null;
    const scope = raw.slice(0, separator);
    const id = raw.slice(separator + 1);
    return (scope === 'contact' || scope === 'group') && id ? { scope, id } : null;
  }

  private consumePushList() {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    return params.get('pushList') === '1';
  }

  private async handlePushNavigationFromUrl() {
    const pushOpen = this.consumePushOpen();
    const pushList = this.consumePushList();
    if (!pushOpen && !pushList) return;
    if (!this.auth.ready() || !this.auth.user() || (!this.contacts().length && !this.groups().length)) return;
    history.replaceState({ ...history.state, open: null }, '', '/#/');
    if (pushList && !pushOpen) {
      this.panel = 'list';
      return;
    }
    if (pushOpen?.scope === 'contact') {
      const contact = this.contacts().find((c) => c.conversationId === pushOpen.id);
      if (contact) await this.openContact(contact);
    }
    if (pushOpen?.scope === 'group') {
      const group = this.groups().find((g) => g.id === pushOpen.id);
      if (group) await this.openGroup(group);
    }
  }

  isGroupOwner(chat?: { scope: 'contact' | 'group'; founderId?: string } | null) {
    return chat?.scope === 'group' && chat.founderId === this.auth.user()?.id;
  }

  canModerateChat(chat?: { scope: 'contact' | 'group'; role?: string; founderId?: string } | null) {
    return !!chat && chat.scope === 'group' && (this.isGroupOwner(chat) || this.canModerate(chat.role));
  }

  roleLabel(role?: string) {
    return role === 'admin' ? 'Admin principal' : role === 'subadmin' ? 'Subadmin' : 'Miembro';
  }

  private syncSelectedFromBootstrap(contacts: Contact[], groups: Group[]) {
    const chat = this.selected();
    if (!chat) return;
    if (chat.scope === 'contact') {
      if (!contacts.some((contact) => contact.conversationId === chat.id)) {
        this.selected.set(null);
        this.messages.set([]);
        this.panel = 'list';
      }
      return;
    }
    const group = groups.find((item) => item.id === chat.id);
    if (!group) {
      this.selected.set(null);
      this.messages.set([]);
      this.panel = 'list';
      return;
    }
    this.selected.set({
      ...chat,
      title: group.name,
      role: group.role,
      founderId: group.founderId,
      joinedAt: group.joinedAt,
      keyVersion: Math.max(chat.keyVersion, group.keyVersion || 1),
      timerSeconds: group.timerSeconds,
      membersCanWrite: group.membersCanWrite !== false
    });
  }
}
