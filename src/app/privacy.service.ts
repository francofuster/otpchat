import { Injectable, NgZone, signal } from '@angular/core';
import { isNative } from './runtime-config';

export type Platform = 'android-app' | 'desktop-app' | 'android-web' | 'web';

// Proteccion de pantalla. Lo fuerte lo hace cada plataforma nativa (Android bloquea capturas
// con FLAG_SECURE; Electron excluye la ventana de las capturas). En la web solo se puede
// tapar la vista al perder el foco y ante la tecla Imprimir pantalla: es una mitigacion, no
// un bloqueo, y la interfaz no promete mas que eso.
@Injectable({ providedIn: 'root' })
export class PrivacyService {
  readonly shielded = signal(false);
  readonly enabled = signal(this.read());
  readonly platform: Platform = detectPlatform();
  private screenshotHandlers = new Set<() => void>();

  constructor(private zone: NgZone) {
    const hide = () => this.zone.run(() => { if (this.enabled()) this.shielded.set(true); });
    const show = () => this.zone.run(() => this.shielded.set(false));
    document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? hide() : show()));
    window.addEventListener('blur', hide);
    window.addEventListener('focus', show);
    window.addEventListener('pagehide', hide);
    window.addEventListener('keyup', (event) => {
      if (event.key === 'PrintScreen') this.onScreenshot();
    });
    // Las apps nativas avisan con este evento cuando el sistema detecta una captura.
    window.addEventListener('otpchat:screenshot', () => this.onScreenshot());
  }

  private read() {
    try {
      return localStorage.getItem('otpchat_privacy_shield') !== 'off';
    } catch {
      return true;
    }
  }

  setEnabled(value: boolean) {
    this.enabled.set(value);
    try { localStorage.setItem('otpchat_privacy_shield', value ? 'on' : 'off'); } catch {}
  }

  onScreenshotDetected(fn: () => void) {
    this.screenshotHandlers.add(fn);
    return () => this.screenshotHandlers.delete(fn);
  }

  private onScreenshot() {
    this.zone.run(() => {
      this.shielded.set(true);
      setTimeout(() => this.shielded.set(false), 1500);
      // Pisa lo que haya quedado en el portapapeles por la captura (si el navegador deja).
      void navigator.clipboard?.writeText?.('').catch(() => {});
      for (const fn of this.screenshotHandlers) fn();
    });
  }

  nativeProtection(): string {
    if (this.platform === 'android-app') return 'Las capturas y grabaciones de pantalla están bloqueadas en esta app.';
    if (this.platform === 'desktop-app') return 'La ventana queda excluida de capturas y grabaciones.';
    return 'En el navegador no se pueden bloquear las capturas: la vista se tapa al cambiar de app o pestaña. Para bloquearlas, usá la app.';
  }
}

export function detectPlatform(): Platform {
  if ((window as any).Capacitor?.isNativePlatform?.()) return 'android-app';
  if ((window as any).otpchatNative) return 'desktop-app';
  if (/Android/i.test(navigator.userAgent) && !isNative()) return 'android-web';
  return 'web';
}
