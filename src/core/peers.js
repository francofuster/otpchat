// Transporte P2P sobre WebRTC con el relay como respaldo. Por el canal directo viajan los
// mismos sobres sellados que por el relay, asi que la seguridad no depende de WebRTC: si el
// canal no esta o no confirma a tiempo, el sobre sale por el relay.
const CHUNK = 16_000;
const P2P_ACK_TIMEOUT_MS = 6000;
const MAX_PEERS = 12;

export class PeerTransport {
  /**
   * @param {any} relay
   * @param {{ iceServers?: any[], RTCPeerConnectionImpl?: any, deviceId?: () => any }} [options]
   */
  constructor(relay, { iceServers = [], RTCPeerConnectionImpl = globalThis.RTCPeerConnection, deviceId = () => null } = {}) {
    this.relay = relay;
    this.iceServers = iceServers;
    this.RTC = RTCPeerConnectionImpl;
    this.myDeviceId = deviceId;
    this.peers = new Map();
    this.listeners = new Map();
    this.waitingAcks = new Map();
    this.incoming = new Map();
    this.viaPeer = new Map();
    relay.on('envelope', (env) => this.emit('envelope', env));
    relay.on('ready', (info) => this.emit('ready', info));
    relay.on('close', (info) => this.emit('close', info));
    relay.on('replaced', () => this.emit('replaced'));
    relay.on('signal', (msg) => void this.onSignal(msg).catch(() => {}));
  }

  get connected() {
    return this.relay.connected;
  }

  get enabled() {
    return typeof this.RTC === 'function';
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  emit(type, data) {
    for (const fn of this.listeners.get(type) || []) {
      try { fn(data); } catch (err) { console.error(`peers ${type}`, err); }
    }
  }

  connect(creds) { return this.relay.connect(creds); }
  getCards(ids) { return this.relay.getCards(ids); }
  publishCard(card) { return this.relay.publishCard(card); }
  presence(ids) { return this.relay.presence(ids); }
  registerPush(sub) { return this.relay.registerPush(sub); }
  unregisterPush() { return this.relay.unregisterPush(); }
  close() {
    for (const peer of this.peers.values()) peer.pc.close();
    this.peers.clear();
    this.relay.close();
  }

  ack(ids) {
    const byPeer = new Map();
    const relayIds = [];
    for (const id of ids) {
      const peerId = this.viaPeer.get(id);
      this.viaPeer.delete(id);
      if (peerId) {
        if (!byPeer.has(peerId)) byPeer.set(peerId, []);
        byPeer.get(peerId).push(id);
      } else relayIds.push(id);
    }
    for (const [peerId, list] of byPeer) this.frame(peerId, { k: 'a', ids: list });
    this.relay.ack(relayIds);
  }

  openPeers() {
    return [...this.peers.entries()].filter(([, p]) => p.channel?.readyState === 'open').map(([id]) => id);
  }

  // Lo que tiene canal directo abierto va por ahi; si el otro no confirma, cae al relay.
  async send(items) {
    const direct = items.filter((item) => this.peers.get(item.to)?.channel?.readyState === 'open');
    const viaRelay = items.filter((item) => !direct.includes(item));
    const results = await Promise.all(direct.map((item) => this.sendDirect(item).then((ok) => ({ item, ok }))));
    const delivered = results.filter((r) => r.ok).map((r) => r.item.id);
    viaRelay.push(...results.filter((r) => !r.ok).map((r) => r.item));
    if (!viaRelay.length) return { delivered, queued: [], rejected: [] };
    const res = await this.relay.send(viaRelay);
    return { ...res, delivered: [...(res.delivered || []), ...delivered] };
  }

  sendDirect(item) {
    return new Promise((resolve) => {
      const text = JSON.stringify({ id: item.id, data: item.data });
      const total = Math.ceil(text.length / CHUNK) || 1;
      const timer = setTimeout(() => { this.waitingAcks.delete(item.id); resolve(false); }, P2P_ACK_TIMEOUT_MS);
      this.waitingAcks.set(item.id, () => { clearTimeout(timer); resolve(true); });
      try {
        for (let i = 0; i < total; i++) this.frame(item.to, { k: 'c', id: item.id, i, n: total, d: text.slice(i * CHUNK, (i + 1) * CHUNK) });
      } catch {
        clearTimeout(timer);
        this.waitingAcks.delete(item.id);
        resolve(false);
      }
    });
  }

  frame(peerId, frame) {
    const channel = this.peers.get(peerId)?.channel;
    if (channel?.readyState !== 'open') throw new Error('canal cerrado');
    channel.send(JSON.stringify(frame));
  }

  onFrame(peerId, raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    if (frame.k === 'a') {
      for (const id of frame.ids || []) this.waitingAcks.get(id)?.();
      for (const id of frame.ids || []) this.waitingAcks.delete(id);
      return;
    }
    if (frame.k !== 'c' || typeof frame.id !== 'string' || !Number.isInteger(frame.n) || frame.n > 600) return;
    const key = `${peerId}|${frame.id}`;
    const parts = this.incoming.get(key) || [];
    parts[frame.i] = frame.d;
    this.incoming.set(key, parts);
    if (parts.filter((p) => p !== undefined).length < frame.n) return;
    this.incoming.delete(key);
    try {
      const { id, data } = JSON.parse(parts.join(''));
      this.viaPeer.set(id, peerId);
      this.emit('envelope', { id, from: peerId, data, via: 'p2p' });
    } catch {}
  }

  // Abre canales con los dispositivos indicados que esten en linea. Para no chocar ofertas,
  // inicia siempre el de deviceId menor; el otro le pide que lo haga.
  async ensurePeers(deviceIds) {
    if (!this.enabled || !this.relay.connected) return;
    const me = this.myDeviceId();
    const wanted = [...new Set(deviceIds)].filter((id) => id && id !== me && !this.peers.has(id)).slice(0, MAX_PEERS - this.peers.size);
    if (!wanted.length) return;
    let online = [];
    try { online = await this.relay.presence(wanted); } catch { return; }
    for (const id of online) {
      if (me < id) await this.startPeer(id);
      else this.relay.signal(id, { type: 'please' });
    }
  }

  createPeer(peerId) {
    const pc = new this.RTC({ iceServers: this.iceServers });
    const peer = { pc, channel: null };
    this.peers.set(peerId, peer);
    pc.onicecandidate = (event) => { if (event.candidate) this.relay.signal(peerId, { type: 'ice', candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate }); };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.dropPeer(peerId);
    };
    pc.ondatachannel = (event) => this.bindChannel(peerId, event.channel);
    return peer;
  }

  bindChannel(peerId, channel) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.channel = channel;
    channel.onmessage = (event) => this.onFrame(peerId, event.data);
    channel.onopen = () => this.emit('peer', { deviceId: peerId, open: true });
    channel.onclose = () => this.dropPeer(peerId);
  }

  dropPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    try { peer.pc.close(); } catch {}
    this.emit('peer', { deviceId: peerId, open: false });
  }

  async startPeer(peerId) {
    const peer = this.createPeer(peerId);
    this.bindChannel(peerId, peer.pc.createDataChannel('otp', { ordered: true }));
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.relay.signal(peerId, { type: 'offer', sdp: peer.pc.localDescription });
    setTimeout(() => { if (this.peers.get(peerId)?.channel?.readyState !== 'open') this.dropPeer(peerId); }, 20_000);
  }

  async onSignal({ from, data }) {
    if (!this.enabled || typeof from !== 'string' || !data) return;
    if (data.type === 'please') {
      if (!this.peers.has(from) && this.myDeviceId() < from) await this.startPeer(from);
      return;
    }
    if (data.type === 'offer') {
      this.dropPeer(from);
      const peer = this.createPeer(from);
      await peer.pc.setRemoteDescription(data.sdp);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.relay.signal(from, { type: 'answer', sdp: peer.pc.localDescription });
      return;
    }
    const peer = this.peers.get(from);
    if (!peer) return;
    if (data.type === 'answer') await peer.pc.setRemoteDescription(data.sdp);
    if (data.type === 'ice' && data.candidate) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
  }
}
