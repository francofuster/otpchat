import { Injectable, signal } from '@angular/core';
import { EncryptedPayload } from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtleCrypto = () => globalThis.crypto?.subtle;

@Injectable({ providedIn: 'root' })
export class CryptoService {
  readonly otp = signal('000000');
  readonly secondsLeft = signal(30);

  constructor() {
    setInterval(() => this.tickOtp(), 1000);
    this.tickOtp();
  }

  async fingerprint(): Promise<string> {
    const cached = localStorage.getItem('otpchat_fingerprint');
    if (cached) return cached;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = '16px Arial';
      ctx.fillText('OTPChat fingerprint', 2, 2);
    }
    const gl = canvas.getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const gpu = debug && gl ? `${gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)} ${gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)}` : 'no-webgl';
    const audio = await this.audioSignature();
    const fonts = ['monospace', 'serif', 'sans-serif'].map((font) => this.measureFont(font)).join('|');
    const system = [navigator.userAgent, navigator.language, screen.width, screen.height, devicePixelRatio, Intl.DateTimeFormat().resolvedOptions().timeZone].join('|');
    const source = [canvas.toDataURL(), gpu, audio, fonts, system].join('::');
    const subtle = subtleCrypto();
    const hash = subtle ? this.hex(await subtle.digest('SHA-256', enc.encode(source))) : this.fallbackHash(source);
    const fp = hash.padEnd(64, '0').slice(0, 64);
    localStorage.setItem('otpchat_fingerprint', fp);
    return fp;
  }

  async encrypt(text: string, secret: string, keyVersion = 1): Promise<EncryptedPayload> {
    const subtle = subtleCrypto();
    if (!subtle) throw new Error('Web Crypto requiere HTTPS o localhost');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyStep = this.currentStep();
    const key = await this.deriveKey(await this.sharedSecret(secret, keyStep), salt);
    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
    return { iv: this.b64(iv), salt: this.b64(salt), ciphertext: this.b64(new Uint8Array(ciphertext)), keyStep, keyVersion };
  }

  async decrypt(payload: EncryptedPayload, secret: string): Promise<string> {
    const clear = await this.decryptBytes(payload, secret);
    return clear ? dec.decode(clear) : '[No se pudo descifrar]';
  }

  // Los audios se cifran con la misma clave y el mismo paso OTP que el texto: lo unico
  // que cambia es que entran y salen como bytes, sin pasar por UTF-8.
  async encryptBytes(bytes: Uint8Array, secret: string, keyVersion = 1): Promise<EncryptedPayload> {
    const subtle = subtleCrypto();
    if (!subtle) throw new Error('Web Crypto requiere HTTPS o localhost');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyStep = this.currentStep();
    const key = await this.deriveKey(await this.sharedSecret(secret, keyStep), salt);
    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return { iv: this.b64(iv), salt: this.b64(salt), ciphertext: this.b64(new Uint8Array(ciphertext)), keyStep, keyVersion };
  }

  async decryptBytes(payload: EncryptedPayload, secret: string): Promise<Uint8Array | null> {
    try {
      const subtle = subtleCrypto();
      if (!subtle) throw new Error('Web Crypto requiere HTTPS o localhost');
      const iv = this.fromB64(payload.iv);
      const salt = this.fromB64(payload.salt);
      const key = await this.deriveKey(await this.sharedSecret(secret, payload.keyStep), salt);
      const clear = await subtle.decrypt({ name: 'AES-GCM', iv }, key, this.fromB64(payload.ciphertext));
      return new Uint8Array(clear);
    } catch {
      return null;
    }
  }

  async sharedSecret(baseSecret: string, keyStep = this.currentStep()): Promise<string> {
    return `${await this.totpForStep(keyStep)}:${baseSecret}`;
  }

  private async deriveKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
    const subtle = subtleCrypto();
    if (!subtle) throw new Error('Web Crypto requiere HTTPS o localhost');
    const base = await subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  private async tickOtp() {
    try {
      const step = this.currentStep();
      const left = 30 - (Math.floor(Date.now() / 1000) % 30);
      const subtle = subtleCrypto();
      if (!subtle) {
        this.otp.set('------');
        this.secondsLeft.set(left);
        return;
      }
      this.otp.set(await this.totpForStep(step));
      this.secondsLeft.set(left);
    } catch {
      this.otp.set('------');
    }
  }

  private async audioSignature(): Promise<string> {
    try {
      const Ctx = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
      const audio = new Ctx(1, 256, 44100);
      const osc = audio.createOscillator();
      const comp = audio.createDynamicsCompressor();
      osc.connect(comp);
      comp.connect(audio.destination);
      osc.start(0);
      const rendered = await audio.startRendering();
      return Array.from(rendered.getChannelData(0).slice(0, 16)).join(',');
    } catch {
      return 'no-audio';
    }
  }

  private measureFont(font: string): string {
    const span = document.createElement('span');
    span.style.cssText = `position:absolute;visibility:hidden;font:16px ${font}`;
    span.textContent = 'mmmmmmmmmmlli';
    document.body.appendChild(span);
    const result = `${font}:${span.offsetWidth}:${span.offsetHeight}`;
    span.remove();
    return result;
  }

  // Por bloques y no con spread: un audio cifrado son cientos de miles de bytes y
  // String.fromCharCode(...bytes) se lleva puesto el call stack a ese tamano.
  private b64(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      out += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(out);
  }

  private fromB64(value: string): Uint8Array {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  }

  private hex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  private currentStep(): number {
    return Math.floor(Date.now() / 1000 / 30);
  }

  private async totpForStep(step: number): Promise<string> {
    const subtle = subtleCrypto();
    if (!subtle) return '------';
    const key = await subtle.importKey('raw', enc.encode('OTPChat-browser-TOTP'), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(4, step);
    const hmac = new Uint8Array(await subtle.sign('HMAC', key, buf));
    const offset = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
    return String(code % 1_000_000).padStart(6, '0');
  }

  private fallbackHash(value: string): string {
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let i = 0; i < value.length; i++) {
      a ^= value.charCodeAt(i);
      a = Math.imul(a, 0x01000193);
      b ^= value.charCodeAt(value.length - 1 - i);
      b = Math.imul(b, 0x811c9dc5);
    }
    return Array.from({ length: 8 }, (_, i) => ((i % 2 ? b : a) + i * 0x9e3779b9 >>> 0).toString(16).padStart(8, '0')).join('');
  }
}
