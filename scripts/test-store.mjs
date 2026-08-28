// Corre los tests de la capa de persistencia contra una base descartable.
import { spawn } from 'node:child_process';
import { usarBaseDescartable } from './test-env.mjs';

const database = usarBaseDescartable('otpchat_test');
console.log(`tests de store contra la base local "${database}" (DATABASE_URL neutralizada)`);

const hijo = spawn(process.execPath, ['--test', 'tests/store.test.mjs'], { stdio: 'inherit', env: process.env });
hijo.on('exit', (code) => process.exit(code ?? 1));
