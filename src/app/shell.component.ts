import { CommonModule, DatePipe } from '@angular/common';
import { Component, ElementRef, OnInit, ViewChild, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NodeService } from './node.service';
import { UiService } from './ui.service';
import { PrivacyService } from './privacy.service';
import { androidDownloadUrl } from './runtime-config';
import { closeLegacySession, hasLegacySession, importLegacyChats, LegacyChat } from './legacy-import';
import { TIMER_OPTIONS } from '../core/node.js';
import { b64url, fromB64url } from '../core/encoding.js';

const maxRecordingMs = 120_000;
const minRecordingMs = 700;
// Cada cuanto se regenera el QR de invitacion mientras esta a la vista. El anterior deja de
// servir en el acto: un codigo filtrado vale como mucho unos segundos.
const inviteRefreshMs = 30_000;
export const pendingInviteKey = 'otpchat_pending_invite_v2';

type Sheet = 'contact' | 'group' | 'actions' | 'members' | 'settings' | 'link' | 'safety' | 'paste' | null;

interface ViewMessage {
  id: string; mine: boolean; senderName: string; ts: number; kind: string; text: string;
  audio?: string | null; mime?: string | null; durationMs?: number | null; expiresAt?: number | null; system?: boolean;
}

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.css'
})
export class ShellComponent implements OnInit {
  @ViewChild('scrollbox') scrollbox?: ElementRef<HTMLElement>;
  timers = TIMER_OPTIONS;
  onboardingMode: 'new' | 'restore' | 'link' = 'new';
  nameInput = '';
  restorePassphrase = '';
  restoreFile: any = null;
  pasteLink = '';
  backupPassphrase = '';
  accountName = '';
  groupName = '';
  draft = '';
  panel: 'list' | 'chat' = 'list';
  busy = signal(false);
  onboardingError = signal('');
  sheet = signal<Sheet>(null);
  selectedId = signal<string | null>(null);
  legacyOpen = signal<LegacyChat | null>(null);
  invite = signal<{ link: string; qr: string; expiresAt: number; kind: 'contact' | 'group' | 'link' } | null>(null);
  safety = signal<string[] | null>(null);
  members = signal<any[]>([]);
  selectedMembers = signal<Set<string>>(new Set());
  showJumpToLatest = signal(false);
  recording = signal(false);
  recordingMs = signal(0);
  sendingAudio = signal(false);
  playingId = signal<string | null>(null);
  playbackPosition = signal(0);
  legacyAvailable = signal(hasLegacySession());
  legacyProgress = signal('');
  notificationsEnabled = signal(this.readPref('otpchat_notifications') === 'on');
  deferredInstallPrompt = signal<any>(null);
  standaloneMode = signal(matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true);
  disclaimerAccepted = signal(this.readPref('otpchat_disclaimer_accepted') === '1');
  darkMode = signal(this.readPref('otpchat_theme') !== 'light');
  androidUrl = androidDownloadUrl();

  selected = computed(() => {
    const id = this.selectedId();
    return id ? this.node.chats().find((c) => c.id === id) || null : null;
  });
  messages = computed<ViewMessage[]>(() => {
    this.node.revision();
    const id = this.selectedId();
    return id ? (this.node.node.messages(id) as ViewMessage[]) : [];
  });
  contacts = computed(() => this.node.chats().filter((c) => c.kind === 'contact'));
  groups = computed(() => this.node.chats().filter((c) => c.kind === 'group'));
  devices = computed(() => {
    this.node.revision();
    return this.node.node?.ownDevices?.() || [];
  });

  private audioUrls = new Map<string, string>();
  private player?: HTMLAudioElement;
  private recorder?: MediaRecorder;
  private recorderStream?: MediaStream;
  private recorderChunks: Blob[] = [];
  private recordingTimer?: ReturnType<typeof setInterval>;
  private recordingStartedAt = 0;
  private recordedMs = 0;
  private recordingCancelled = false;
  private recordingChat?: string;
  private inviteRefreshTimer?: ReturnType<typeof setInterval>;
  private inviteToken = '';
  private lastSeenRevision = new Map<string, number>();

  constructor(public node: NodeService, public ui: UiService, public privacy: PrivacyService, private router: Router) {
    effect(() => {
      const mostrando = (this.sheet() === 'contact' || this.sheet() === 'group' || this.sheet() === 'link') && !!this.invite();
      if (mostrando && !this.inviteRefreshTimer) this.inviteRefreshTimer = setInterval(() => void this.refreshInvite(), inviteRefreshMs);
      else if (!mostrando && this.inviteRefreshTimer) this.stopInviteRotation();
    });
    // Mensajes nuevos: badge, aviso y lectura si el chat esta a la vista.
    effect(() => {
      const chats = this.node.chats();
      const visible = this.selectedId();
      for (const chat of chats) {
        const previous = this.lastSeenRevision.get(chat.id) ?? chat.unread;
        if (chat.unread > previous && !this.chatVisible(chat.id)) {
          this.ui.toast('Mensaje nuevo');
          void this.notifyNewMessage();
        }
        this.lastSeenRevision.set(chat.id, chat.unread);
        if (chat.id === visible && chat.unread && this.chatVisible(chat.id)) void this.node.node.markRead(chat.id).then(() => this.node.refresh());
      }
      if (visible && !chats.some((c) => c.id === visible)) {
        this.selectedId.set(null);
        this.panel = 'list';
        if (this.sheet() !== 'settings') this.sheet.set(null);
      }
    });
    effect(() => {
      this.messages();
      this.syncAudio();
    });
    // Alguien acepto el QR que esta en pantalla: se cierra y se abre el chat nuevo.
    this.node.on('contact:accepted', ({ chatId }) => {
      if (this.sheet() === 'contact') this.sheet.set(null);
      this.node.refresh();
      this.openChat(chatId);
      this.ui.toast('Invitación aceptada');
    });
    this.node.on('group:joined', ({ name }) => this.ui.toast(`${name} se unió al grupo`));
    this.privacy.onScreenshotDetected(() => {
      const id = this.selectedId();
      if (id) void this.node.node.reportScreenshot(id).catch(() => {});
      this.ui.toast('Se detectó una captura de pantalla');
    });
  }

  async ngOnInit() {
    this.applyTheme();
    await this.node.start();
    if (this.node.status() === 'ready') this.resumePendingInvite();
    const open = history.state?.open;
    if (open) {
      history.replaceState({ ...history.state, open: null }, '', location.href);
      this.openChat(open);
    }
    if (location.hash.includes('pushList=1')) {
      history.replaceState(null, '', '/#/');
      this.panel = 'list';
    }
    window.visualViewport?.addEventListener('resize', () => document.documentElement.style.setProperty('--vvh', `${window.visualViewport?.height || window.innerHeight}px`));
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.deferredInstallPrompt.set(event);
    });
    window.addEventListener('appinstalled', () => {
      this.deferredInstallPrompt.set(null);
      this.standaloneMode.set(true);
      this.ui.toast('Acceso directo creado');
    });
  }

  private readPref(key: string) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  private writePref(key: string, value: string) {
    try { localStorage.setItem(key, value); } catch {}
  }

  private resumePendingInvite() {
    const pending = this.readPref(pendingInviteKey);
    if (!pending) return;
    localStorage.removeItem(pendingInviteKey);
    void this.router.navigate(['/i', pending], { replaceUrl: true });
  }

  // ── Alta ──────────────────────────────────────────────────────────────────

  async createIdentity() {
    if (this.busy()) return;
    this.onboardingError.set('');
    this.busy.set(true);
    try {
      await this.node.createIdentity(this.nameInput);
      this.resumePendingInvite();
    } catch (err: any) {
      this.onboardingError.set(err.message || 'No se pudo crear la cuenta');
    } finally {
      this.busy.set(false);
    }
  }

  async pickBackup(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      this.restoreFile = JSON.parse(await file.text());
    } catch {
      this.onboardingError.set('El archivo no es un respaldo de OTPChat');
    }
  }

  async restoreBackup() {
    if (this.busy() || !this.restoreFile) return;
    this.onboardingError.set('');
    this.busy.set(true);
    try {
      await this.node.node.importBackup(this.restoreFile, this.restorePassphrase);
      this.restorePassphrase = '';
      this.node.refresh();
      this.node.status.set('ready');
      this.ui.toast('Cuenta restaurada');
    } catch (err: any) {
      this.onboardingError.set(err.message || 'No se pudo restaurar');
    } finally {
      this.busy.set(false);
    }
  }

  async linkFromPaste() {
    const payload = this.extractInvite(this.pasteLink);
    if (!payload) {
      this.onboardingError.set('Pegá el link que muestra el otro dispositivo');
      return;
    }
    this.pasteLink = '';
    await this.router.navigate(['/i', payload]);
  }

  extractInvite(text: string) {
    const match = String(text || '').match(/#\/i\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : /^[A-Za-z0-9_-]{40,}$/.test(text.trim()) ? text.trim() : null;
  }

  async openPastedInvite() {
    const payload = this.extractInvite(this.pasteLink);
    if (!payload) {
      this.ui.toast('Ese texto no es un link de invitación de OTPChat');
      return;
    }
    this.pasteLink = '';
    this.sheet.set(null);
    await this.router.navigate(['/i', payload]);
  }

  // ── Chats ─────────────────────────────────────────────────────────────────

  openChat(id: string) {
    if (!this.node.chats().some((c) => c.id === id)) return;
    this.legacyOpen.set(null);
    this.selectedId.set(id);
    this.panel = 'chat';
    void this.node.node.markRead(id).then(() => this.node.refresh());
    this.node.ensurePeers(id);
    setTimeout(() => this.scrollBottom(), 40);
  }

  openLegacy(chat: LegacyChat) {
    this.selectedId.set(null);
    this.legacyOpen.set(chat);
    this.panel = 'chat';
    this.syncAudio();
  }

  badgeLabel(count: number) {
    return count > 99 ? '+99' : String(count);
  }

  private chatVisible(id: string) {
    return this.selectedId() === id && document.visibilityState === 'visible' && (this.panel === 'chat' || !matchMedia('(max-width: 760px)').matches);
  }

  canWriteCurrentChat() {
    const chat = this.selected();
    if (!chat) return false;
    if (chat.kind !== 'group' || chat.membersCanWrite) return true;
    return this.canModerate(chat.role);
  }

  async send() {
    const chat = this.selected();
    const text = this.draft.trim();
    if (!chat || !text) return;
    if (!this.canWriteCurrentChat()) {
      this.ui.toast('Solo administradores pueden enviar mensajes');
      return;
    }
    this.draft = '';
    try {
      await this.node.node.sendText(chat.id, text);
      setTimeout(() => this.scrollBottom(), 40);
    } catch (err: any) {
      this.draft = text;
      this.ui.toast(err.message || 'No se pudo enviar');
    }
  }

  async toggleGroupWrite(allow: boolean) {
    const chat = this.selected();
    if (chat?.kind !== 'group' || !this.isGroupOwner(chat)) return;
    try {
      await this.node.node.setGroupSettings(chat.id, { membersCanWrite: allow });
      this.ui.toast(allow ? 'Todos pueden escribir en el grupo' : 'Solo administradores pueden escribir');
    } catch (err: any) {
      this.ui.toast(err.message || 'No se pudo cambiar el permiso');
    }
  }

  async setTimer(seconds: string | number) {
    const chat = this.selected();
    if (!chat) return;
    await this.node.node.setTimer(chat.id, Number(seconds));
    this.node.refresh();
  }

  async deleteCurrentChat() {
    const chat = this.selected();
    if (!chat) return;
    try {
      await this.node.node.deleteChat(chat.id);
      this.ui.toast(chat.kind === 'group' ? 'Grupo eliminado' : 'Chat eliminado');
    } catch (err: any) {
      this.ui.toast(err.message);
    }
  }

  async leaveCurrentGroup() {
    const chat = this.selected();
    if (chat?.kind !== 'group') return;
    await this.node.node.leaveGroup(chat.id);
    this.ui.toast('Saliste del grupo');
  }

  async createGroup() {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const id = await this.node.node.createGroup(this.groupName || 'Grupo OTP');
      this.groupName = '';
      this.sheet.set(null);
      this.openChat(id);
    } catch (err: any) {
      this.ui.toast(err.message || 'No se pudo crear el grupo');
    } finally {
      this.busy.set(false);
    }
  }

  async openMembers() {
    const chat = this.selected();
    if (chat?.kind !== 'group' || !this.canModerateChat(chat)) return;
    this.members.set(this.node.node.members(chat.id));
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
    if (chat?.kind !== 'group' || !ids.length) return;
    try {
      await this.node.node.removeMembers(chat.id, ids);
      this.ui.toast('Miembros eliminados');
    } catch (err: any) {
      this.ui.toast(err.message);
    }
    await this.openMembers();
  }

  async setSelectedMembersRole(role: 'subadmin' | 'member') {
    const chat = this.selected();
    const ids = [...this.selectedMembers()];
    if (chat?.kind !== 'group' || !ids.length) return;
    try {
      await this.node.node.setRole(chat.id, ids, role);
      this.ui.toast(role === 'subadmin' ? 'Subadmin asignado' : 'Rol actualizado');
    } catch (err: any) {
      this.ui.toast(err.message);
    }
    await this.openMembers();
  }

  async openSafety() {
    const chat = this.selected();
    if (chat?.kind !== 'contact') return;
    this.safety.set(await this.node.node.safetyCode(chat.id));
    this.sheet.set('safety');
  }

  // ── Invitaciones ──────────────────────────────────────────────────────────

  async createInvite() {
    this.sheet.set('contact');
    this.invite.set(null);
    await this.refreshInvite('contact');
  }

  openGroupSheet() {
    this.invite.set(null);
    this.sheet.set('group');
  }

  async groupInvite() {
    const chat = this.selected();
    if (chat?.kind !== 'group' || !this.canModerateChat(chat)) return;
    this.sheet.set('group');
    this.invite.set(null);
    await this.refreshInvite('group');
  }

  async linkDevice() {
    this.sheet.set('link');
    this.invite.set(null);
    await this.refreshInvite('link');
  }

  // Genera un codigo nuevo y anula el anterior. Lo llama la apertura de la hoja y despues el
  // timer cada 30s mientras el QR siga a la vista.
  private async refreshInvite(kind = this.invite()?.kind) {
    if (!kind) return;
    try {
      const created = kind === 'link'
        ? await this.node.node.createLinkInvite()
        : await this.node.node.createInvite(kind, kind === 'group' ? this.selectedId() : undefined);
      const QRCode = (await import('qrcode')) as any;
      const qr = await (QRCode.toDataURL || QRCode.default?.toDataURL)(created.link, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
      if (this.inviteToken) this.node.node.cancelInvite(this.inviteToken);
      this.inviteToken = created.token;
      this.invite.set({ link: created.link, qr, expiresAt: created.expiresAt, kind });
    } catch (err: any) {
      this.ui.toast(err.message || 'No se pudo generar el QR');
    }
  }

  private stopInviteRotation() {
    clearInterval(this.inviteRefreshTimer);
    this.inviteRefreshTimer = undefined;
    if (this.inviteToken) this.node.node.cancelInvite(this.inviteToken);
    this.inviteToken = '';
    this.invite.set(null);
  }

  async copyInviteLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const input = document.createElement('textarea');
      input.value = link;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    this.ui.toast('Link copiado');
  }

  // ── Audio ─────────────────────────────────────────────────────────────────

  async startRecording() {
    const chat = this.selected();
    if (!chat || this.recording() || this.sendingAudio()) return;
    if (!this.canWriteCurrentChat()) {
      this.ui.toast('Solo administradores pueden enviar mensajes');
      return;
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.ui.toast('Grabar audio requiere HTTPS y un navegador compatible.');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.ui.toast('Sin permiso para usar el micrófono.');
      return;
    }
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
    this.recorderStream = stream;
    this.recorderChunks = [];
    this.recordingCancelled = false;
    this.recordingChat = chat.id;
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
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
  }

  cancelRecording() {
    if (!this.recording()) return;
    this.recordingCancelled = true;
    this.stopRecording();
  }

  recordingLabel() { return this.clock(this.recordingMs()); }
  recordingProgress() { return Math.min(100, (this.recordingMs() / maxRecordingMs) * 100); }

  private async finishRecording() {
    const chunks = this.recorderChunks;
    const durationMs = this.recordedMs;
    const mimeType = this.recorder?.mimeType || 'audio/webm';
    const cancelled = this.recordingCancelled;
    const chatId = this.recordingChat;
    for (const track of this.recorderStream?.getTracks() || []) track.stop();
    this.recorderStream = undefined;
    this.recorder = undefined;
    this.recorderChunks = [];
    this.recordingChat = undefined;
    if (cancelled || !chunks.length || !chatId) return;
    if (durationMs < minRecordingMs) {
      this.ui.toast('Grabación demasiado corta.');
      return;
    }
    this.sendingAudio.set(true);
    try {
      const bytes = new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer());
      if (bytes.length > 3 * 1024 * 1024) throw new Error('El audio es demasiado largo');
      await this.node.node.sendAudio(chatId, b64url(bytes), mimeType, durationMs);
      setTimeout(() => this.scrollBottom(), 40);
    } catch (err: any) {
      this.ui.toast(err.message || 'No se pudo enviar el audio');
    } finally {
      this.sendingAudio.set(false);
    }
  }

  // Los audios se descifran al llegar y solo viven como blob URL mientras estan en pantalla.
  private syncAudio() {
    const legacy = this.legacyOpen();
    const items: any[] = legacy ? legacy.messages : this.messages();
    const keep = new Set<string>();
    for (const m of items) {
      if (m.kind !== 'audio' || !m.audio) continue;
      keep.add(m.id);
      if (this.audioUrls.has(m.id)) continue;
      try {
        this.audioUrls.set(m.id, URL.createObjectURL(new Blob([fromB64url(m.audio)], { type: m.mime || 'audio/webm' })));
      } catch {}
    }
    for (const [id, url] of [...this.audioUrls]) {
      if (keep.has(id)) continue;
      if (this.playingId() === id) this.stopPlayback();
      URL.revokeObjectURL(url);
      this.audioUrls.delete(id);
    }
  }

  hasAudio(m: { id: string }) { return this.audioUrls.has(m.id); }

  async toggleAudio(m: { id: string }) {
    const url = this.audioUrls.get(m.id);
    if (!url) return;
    const player = this.ensurePlayer();
    if (this.playingId() === m.id) {
      player.pause();
      return;
    }
    if (player.src !== url) {
      player.src = url;
      player.currentTime = 0;
    }
    this.playingId.set(m.id);
    try {
      await player.play();
    } catch {
      this.playingId.set(null);
      this.ui.toast('No se pudo reproducir el audio.');
    }
  }

  audioProgress(m: { id: string; durationMs?: number | null }) {
    if (this.playingId() !== m.id || !m.durationMs) return 0;
    return Math.min(100, (this.playbackPosition() / m.durationMs) * 100);
  }

  audioTimeLabel(m: { id: string; durationMs?: number | null }) {
    const total = m.durationMs || 0;
    return this.clock(this.playingId() === m.id ? Math.min(this.playbackPosition(), total) : total);
  }

  clock(ms: number) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  private ensurePlayer() {
    if (this.player) return this.player;
    const player = new Audio();
    player.addEventListener('timeupdate', () => this.playbackPosition.set(player.currentTime * 1000));
    player.addEventListener('ended', () => { this.playingId.set(null); this.playbackPosition.set(0); });
    player.addEventListener('pause', () => { if (!player.ended) this.playingId.set(null); });
    this.player = player;
    return player;
  }

  private stopPlayback() {
    this.player?.pause();
    if (this.player) this.player.src = '';
    this.playingId.set(null);
    this.playbackPosition.set(0);
  }

  // ── Configuracion ─────────────────────────────────────────────────────────

  openSettings() {
    this.invite.set(null);
    this.accountName = this.node.me()?.name || '';
    this.backupPassphrase = '';
    this.sheet.set('settings');
  }

  openActions() {
    if (!this.selected()) return;
    this.invite.set(null);
    this.sheet.set('actions');
  }

  async saveName() {
    try {
      await this.node.node.rename(this.accountName);
      this.node.refresh();
      this.ui.toast('Nombre actualizado');
    } catch (err: any) {
      this.ui.toast(err.message);
    }
  }

  async exportBackup() {
    try {
      const file = await this.node.node.exportBackup(this.backupPassphrase);
      const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `otpchat-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      this.backupPassphrase = '';
      this.ui.toast('Respaldo descargado. Guardalo junto con la frase.');
    } catch (err: any) {
      this.ui.toast(err.message);
    }
  }

  async unlinkDevice(deviceId: string) {
    try {
      await this.node.node.unlinkDevice(deviceId);
      this.node.refresh();
      this.ui.toast('Dispositivo desvinculado');
    } catch (err: any) {
      this.ui.toast(err.message);
    }
  }

  async importLegacy() {
    this.legacyProgress.set('Conectando con la versión anterior…');
    try {
      const chats = await importLegacyChats((text) => this.legacyProgress.set(text));
      await this.node.saveLegacy(chats);
      await closeLegacySession();
      this.legacyAvailable.set(false);
      this.ui.toast(`Importaste ${chats.length} chats anteriores`);
    } catch (err: any) {
      this.ui.toast(err.message || 'No se pudo importar');
    } finally {
      this.legacyProgress.set('');
    }
  }

  async discardLegacy() {
    await this.node.saveLegacy([]);
    this.legacyOpen.set(null);
    this.panel = 'list';
  }

  async logoutDevice() {
    if (!confirm('Se borran la cuenta y los chats de este dispositivo. Si no tenés un respaldo u otro dispositivo vinculado, no se pueden recuperar. ¿Seguir?')) return;
    await this.node.wipe();
  }

  setPrivacy(value: boolean) {
    this.privacy.setEnabled(value);
  }

  async toggleNotifications() {
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext) {
      this.ui.toast('Las notificaciones push requieren HTTPS y un navegador compatible.');
      return;
    }
    try {
      if (this.notificationsEnabled()) {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        await this.node.unregisterPush().catch(() => {});
        await subscription?.unsubscribe();
        this.writePref('otpchat_notifications', 'off');
        this.notificationsEnabled.set(false);
        this.ui.toast('Notificaciones desactivadas');
        return;
      }
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (permission !== 'granted') {
        this.ui.toast('Permiso de notificaciones denegado');
        return;
      }
      const key = this.node.vapidPublicKey();
      if (!key) throw new Error('Push no configurado en el servidor');
      const registration = await navigator.serviceWorker.ready;
      const subscription = (await registration.pushManager.getSubscription()) || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(key) as unknown as BufferSource });
      await this.node.registerPush(subscription.toJSON());
      this.writePref('otpchat_notifications', 'on');
      this.notificationsEnabled.set(true);
      this.ui.toast('Notificaciones activadas');
    } catch (err: any) {
      this.ui.toast(err.message || 'No se pudo cambiar las notificaciones');
    }
  }

  private async notifyNewMessage() {
    if (!this.notificationsEnabled() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    try {
      const registration = await navigator.serviceWorker?.ready;
      await registration?.showNotification('Mensajes nuevos', { tag: 'otpchat-messages', icon: '/icons/icon.svg', badge: '/icons/icon.svg' });
    } catch {}
  }

  async installApp() {
    const prompt = this.deferredInstallPrompt();
    if (!prompt) {
      this.ui.toast(this.standaloneMode() ? 'Ya está instalado como app.' : 'Usá el menú del navegador para agregar a la pantalla de inicio.');
      return;
    }
    await prompt.prompt();
    await prompt.userChoice.catch(() => null);
    this.deferredInstallPrompt.set(null);
  }

  // ── Varios ────────────────────────────────────────────────────────────────

  timerLabel(seconds: number) {
    if (!seconds) return 'Desactivado';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${seconds / 60}min`;
    if (seconds < 86400) return `${seconds / 3600}h`;
    return seconds === 604800 ? '7 días' : '1 día';
  }

  countdown(to?: number | null) {
    if (!to) return '';
    const ms = to - Date.now();
    if (ms <= 0) return '0s';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
  }

  canModerate(role?: string | null) {
    return role === 'admin' || role === 'subadmin';
  }

  isGroupOwner(chat?: { kind: string | null; founderId?: string | null } | null) {
    return chat?.kind === 'group' && chat.founderId === this.node.me()?.userId;
  }

  canModerateChat(chat?: { kind: string | null; role?: string | null; founderId?: string | null } | null) {
    return !!chat && chat.kind === 'group' && (this.isGroupOwner(chat) || this.canModerate(chat.role));
  }

  roleLabel(role?: string) {
    return role === 'admin' ? 'Admin principal' : role === 'subadmin' ? 'Subadmin' : 'Miembro';
  }

  memberSelectable(member: { userId: string; role: string }) {
    const chat = this.selected();
    if (!chat || member.userId === this.node.me()?.userId || member.userId === chat.founderId) return false;
    return !(chat.role === 'subadmin' && member.role !== 'member');
  }

  keydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !matchMedia('(max-width: 760px)').matches) {
      event.preventDefault();
      void this.send();
    }
  }

  onMessagesScroll() {
    const box = this.scrollbox?.nativeElement;
    if (box) this.showJumpToLatest.set(box.scrollHeight - box.scrollTop - box.clientHeight > 180);
  }

  scrollBottom() {
    const box = this.scrollbox?.nativeElement;
    if (box) {
      box.scrollTop = box.scrollHeight;
      this.showJumpToLatest.set(false);
    }
  }

  back() {
    this.panel = 'list';
  }

  acceptDisclaimer() {
    this.writePref('otpchat_disclaimer_accepted', '1');
    this.disclaimerAccepted.set(true);
  }

  toggleTheme() {
    this.darkMode.update((enabled) => !enabled);
    this.writePref('otpchat_theme', this.darkMode() ? 'dark' : 'light');
    this.applyTheme();
  }

  private applyTheme() {
    document.documentElement.dataset['theme'] = this.darkMode() ? 'dark' : 'light';
  }

  reload() {
    location.reload();
  }

  shortId(id?: string | null) {
    return id ? id.slice(2, 10) : '';
  }
}
