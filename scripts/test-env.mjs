// Fuerza a que cualquier proceso de test use una base Postgres local descartable.
//
// Esto se importa ANTES que cualquier cosa que haga `import 'dotenv/config'`. El .env del
// proyecto apunta a la base de produccion en Neon via DATABASE_URL, y en store.js esa
// variable gana sobre PGDATABASE: pasar solo PGDATABASE NO aisla nada. dotenv no pisa
// claves que ya existen en process.env, asi que dejarla vacia aca la neutraliza.
export function usarBaseDescartable(nombre) {
  const database = nombre || process.env.TEST_PGDATABASE || 'otpchat_test';
  if (!/^otpchat_[a-z0-9_]+$/i.test(database) || database === 'otpchat') {
    throw new Error(`Nombre de base de test invalido: "${database}". Debe ser otpchat_<algo> y nunca la base real.`);
  }
  process.env.DATABASE_URL = '';
  process.env.PGSSL = 'false';
  process.env.PGDATABASE = database;
  process.env.PG_CREATE_DATABASE = 'true';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  return database;
}

export function opcionesPgAdmin() {
  return {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGMAINTENANCE_DATABASE || 'postgres'
  };
}
