// Recrea la base de E2E desde cero. Se corre antes de levantar el backend de pruebas.
import pg from 'pg';
import { usarBaseDescartable, opcionesPgAdmin } from './test-env.mjs';

const database = usarBaseDescartable(process.env.E2E_PGDATABASE || 'otpchat_e2e');
const accion = process.argv[2] === 'drop' ? 'drop' : 'reset';
const client = new pg.Client(opcionesPgAdmin());
await client.connect();
await client.query(`drop database if exists "${database}" with (force)`);
if (accion === 'reset') await client.query(`create database "${database}"`);
await client.end();
console.log(accion === 'drop' ? `base E2E "${database}" eliminada` : `base E2E "${database}" recreada vacia`);
