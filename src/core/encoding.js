// Utilidades de codificacion sin dependencias. Corren igual en el navegador y en Node.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8(text) {
  return enc.encode(text);
}

export function fromUtf8(bytes) {
  return dec.decode(bytes);
}

// Por bloques: String.fromCharCode(...bytes) revienta el stack con audios de megas.
export function b64url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < view.length; i += 8192) bin += String.fromCharCode(...view.subarray(i, i + 8192));
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromB64url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('base64url invalido');
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// JSON con las claves ordenadas: lo firmado tiene que dar los mismos bytes en todos los nodos.
export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('numero no finito');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item ?? null)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function randomId(prefix, bytes = 16) {
  return `${prefix}_${b64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)))}`;
}
