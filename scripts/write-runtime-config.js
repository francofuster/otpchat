import { mkdir, writeFile } from 'node:fs/promises';

const apiBase = process.env.OTPCHAT_API_BASE || '';
await mkdir('public', { recursive: true });
await writeFile('public/config.js', `window.OTPCHAT_API_BASE=${JSON.stringify(apiBase)};\n`);
