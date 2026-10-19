declare global {
  interface Window {
    OTPCHAT_API_BASE?: string;
    OTPCHAT_ICE?: RTCIceServer[];
    OTPCHAT_ANDROID_URL?: string;
    OTPCHAT_SITE_URL?: string;
  }
}

// Las apps nativas cargan la web desde su propio origen (https://localhost, app://otpchat):
// ahi el API tiene que ser absoluto y viene de config.js, generado en el build.
export function apiUrl(path: string): string {
  const base = (window.OTPCHAT_API_BASE || '').replace(/\/$/, '');
  return `${base}${path}`;
}

export function wsUrl(path: string): string {
  const base = (window.OTPCHAT_API_BASE || '').replace(/\/$/, '');
  if (base) {
    const url = new URL(base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = path;
    url.search = '';
    return url.toString();
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}

export function iceServers(): RTCIceServer[] {
  return Array.isArray(window.OTPCHAT_ICE) ? window.OTPCHAT_ICE : [{ urls: 'stun:stun.l.google.com:19302' }];
}

// Link estable al APK del ultimo release: GitHub redirige "latest/download" al archivo.
export function androidDownloadUrl(): string {
  return window.OTPCHAT_ANDROID_URL || 'https://github.com/francofuster/otpchat/releases/latest/download/otpchat-android.apk';
}

// Origen publico para los links de invitacion. En la web es el propio sitio; en las apps
// nativas (origen local) los links apuntan al sitio publicado para poder compartirlos.
export function publicOrigin(): string {
  if (!isNative()) return location.origin;
  return (window.OTPCHAT_SITE_URL || 'https://otpchat.vercel.app').replace(/\/$/, '');
}

export function isNative(): boolean {
  return !!(window as any).Capacitor?.isNativePlatform?.() || !!(window as any).otpchatNative;
}

export {};
