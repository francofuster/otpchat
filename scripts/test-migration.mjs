// Test de migracion v1 → v2: API v1 contra una base descartable y el relay en el mismo
// proceso, con nodos v2 reales migrando cuentas v1.
import { spawn } from 'node:child_process';
import { usarBaseDescartable } from './test-env.mjs';

const database = usarBaseDescartable('otpchat_mig');
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LEGACY_API = '1';
process.env.PORT = process.env.MIG_TEST_PORT || '4956';
console.log(`test de migracion contra la base local "${database}" (DATABASE_URL neutralizada)`);

const hijo = spawn(process.execPath, ['--test', 'tests/migration.test.mjs'], { stdio: 'inherit', env: process.env });
hijo.on('exit', (code) => process.exit(code ?? 1));
