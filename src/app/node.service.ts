import { Injectable, NgZone, signal } from '@angular/core';
import { OtpNode } from '../core/node.js';
import { RelayClient } from '../core/relay-client.js';
import { PeerTransport } from '../core/peers.js';
import { createIdbStore } from './idb-store';
import { iceServers, publicOrigin, wsUrl } from './runtime-config';
import { UiService } from './ui.service';
import { LegacyChat } from './legacy-import';

export type ChatSummary = ReturnType<OtpNode['listChats']>[number];

// Puente entre el nodo (src/core, sin Angular) y la interfaz: lo arranca con IndexedDB y el
// transporte P2P + relay, y expone su estado como signals.
@Injectable({ providedIn: 'root' })
export class NodeService {
  readonly status = signal<'loading' | 'onboarding' | 'ready' | 'replaced' | 'error'>('loading');
  readonly me = signal<ReturnType<OtpNode['me']>>(null);
  readonly chats = signal<ChatSummary[]>([]);
  readonly connected = signal(false);
  readonly peers = signal(0);
  readonly revision = signal(0);
  readonly legacy = signal<LegacyChat[]>([]);
  readonly vapidPublicKey = signal('');
  node!: OtpNode;
  transport!: PeerTransport;
  private started: Promise<void> | null = null;

  constructor(private zone: NgZone, private ui: UiService) {}

  start() {
    this.started ??= this.boot().catch((err) => {
      console.error(err);
      this.status.set('error');
    });
    return this.started;
  }

  private async boot() {
    const store = await createIdbStore();
    const relay = new RelayClient({ url: wsUrl('/relay') });
    this.transport = new PeerTransport(relay, { iceServers: iceServers(), deviceId: () => this.node?.device?.deviceId });
    this.node = new OtpNode({ store, transport: this.transport, origin: publicOrigin() });
    await this.node.init();
    this.node.on('*', ({ type, data }: { type: string; data: any }) => this.zone.run(() => this.onEvent(type, data)));
    this.transport.on('ready', (info: any) => this.zone.run(() => {
      this.connected.set(true);
      this.vapidPublicKey.set(info?.vapidPublicKey || '');
    }));
    this.transport.on('close', () => this.zone.run(() => this.connected.set(false)));
    this.transport.on('replaced', () => this.zone.run(() => this.status.set('replaced')));
    this.transport.on('peer', () => this.zone.run(() => this.peers.set(this.transport.openPeers().length)));
    this.legacy.set(await this.node.legacyChats());
    this.refresh();
    this.status.set(this.node.hasIdentity() ? 'ready' : 'onboarding');
    await this.node.connect();
    setInterval(() => void this.node.sweepExpired(), 1000);
  }

  private handlers = new Map<string, Set<(data: any) => void>>();

  // Eventos del nodo para la interfaz (ya dentro de la zona de Angular).
  on(type: string, fn: (data: any) => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  private onEvent(type: string, data: any) {
    for (const fn of this.handlers.get(type) || []) fn(data);
    if (type === 'chat' || type === 'chat:removed' || type === 'cards' || type === 'ready') this.refresh();
    if (type === 'identity') {
      this.refresh();
      this.status.set('ready');
    }
    if (type === 'toast') this.ui.toast(String(data));
    if (type === 'invite:rejected') this.ui.toast('Rechazaron la invitación');
    if (type === 'device:linked') this.ui.toast('Dispositivo vinculado');
    if (type === 'device:unlinked') {
      this.ui.toast('Este dispositivo fue desvinculado de la cuenta');
      void this.wipe();
    }
  }

  refresh() {
    this.me.set(this.node.me());
    this.chats.set(this.node.hasIdentity() ? this.node.listChats() : []);
    this.revision.update((n) => n + 1);
  }

  async createIdentity(name: string) {
    await this.node.createIdentity(name);
    await this.node.connect();
    this.transport.publishCard(this.node.card);
    this.refresh();
    this.status.set('ready');
  }

  // Abre canales directos con los dispositivos de los miembros del chat que esten en linea.
  ensurePeers(chatId: string) {
    const chat = this.node.chats.get(chatId);
    if (!chat) return;
    const me = this.node.identity?.userId;
    const devices = [...chat.state.members.keys()].flatMap((userId: string) =>
      (userId === me ? this.node.ownDevices() : this.node.cards.get(userId)?.devices || []).map((d: any) => d.deviceId));
    void this.transport.ensurePeers(devices);
  }

  async saveLegacy(chats: LegacyChat[]) {
    await this.node.saveLegacyChats(chats);
    this.legacy.set(chats);
  }

  async registerPush(subscription: PushSubscriptionJSON) {
    return this.transport.registerPush(subscription);
  }

  async unregisterPush() {
    return this.transport.unregisterPush();
  }

  async wipe() {
    this.transport.close();
    await this.node.wipe();
    location.reload();
  }
}
