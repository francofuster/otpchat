import { mkdir, writeFile } from 'node:fs/promises';

// config.js se genera en cada build: la web, la app Android y la de escritorio lo cargan antes
// que Angular. En las apps nativas el API tiene que ser absoluto (su origen es local).
const config = {
  OTPCHAT_API_BASE: process.env.OTPCHAT_API_BASE || '',
  ...(process.env.OTPCHAT_SITE_URL ? { OTPCHAT_SITE_URL: process.env.OTPCHAT_SITE_URL } : {}),
  ...(process.env.OTPCHAT_ANDROID_URL ? { OTPCHAT_ANDROID_URL: process.env.OTPCHAT_ANDROID_URL } : {}),
  ...(process.env.OTPCHAT_ICE ? { OTPCHAT_ICE: JSON.parse(process.env.OTPCHAT_ICE) } : {})
};

await mkdir('public', { recursive: true });
await writeFile('public/config.js', Object.entries(config).map(([key, value]) => `window.${key}=${JSON.stringify(value)};`).join('\n') + '\n');
