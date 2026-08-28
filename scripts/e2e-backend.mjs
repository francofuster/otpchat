// Backend para los tests E2E: base descartable y sin rate limiting.
// Los limitadores reales (3 registros/hora) hacen imposible automatizar altas.
import { usarBaseDescartable } from './test-env.mjs';

const database = usarBaseDescartable(process.env.E2E_PGDATABASE || 'otpchat_e2e');
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.PORT = process.env.E2E_PORT || '4900';
process.env.CLIENT_ORIGIN = process.env.E2E_CLIENT_ORIGIN || 'http://localhost:5900';

console.log(`backend E2E en el puerto ${process.env.PORT} contra la base "${database}"`);
await import('../server/index.js');
