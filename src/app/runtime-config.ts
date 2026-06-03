declare global {
  interface Window {
    OTPCHAT_API_BASE?: string;
  }
}

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

export {};
