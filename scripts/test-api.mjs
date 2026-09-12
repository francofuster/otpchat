// Corre los tests de API contra una base descartable y sin rate limiting.
// Los limitadores reales (3 registros/hora) hacen imposible automatizar altas.
import { spawn } from 'node:child_process';
import { usarBaseDescartable } from './test-env.mjs';

const database = usarBaseDescartable('otpchat_api');
process.env.RATE_LIMIT_ENABLED = 'false';
// Admin designado por env: nombre reservado + password de bootstrap para sembrarlo.
process.env.SUPERADMIN_USERNAME = 'admintest';
process.env.SUPERADMIN_PASSWORD = 'AdminBoot1!';
process.env.PORT = process.env.API_TEST_PORT || '4955';
// Chico a proposito: el test de payload grande manda unos pocos KB en vez de megas.
process.env.MAX_AUDIO_BYTES = '4096';
console.log(`tests de API contra la base local "${database}" (DATABASE_URL neutralizada)`);

const hijo = spawn(process.execPath, ['--test', 'tests/api.test.mjs'], { stdio: 'inherit', env: process.env });
hijo.on('exit', (code) => process.exit(code ?? 1));
