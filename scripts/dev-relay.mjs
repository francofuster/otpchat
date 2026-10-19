// Levanta el servidor solo como relay v2, sin base de datos. El .env local apunta a la base de
// produccion via DATABASE_URL: se neutraliza antes de que cargue dotenv (que no pisa claves
// que ya existen en process.env).
process.env.DATABASE_URL = '';
process.env.LEGACY_API = '0';
process.env.NODE_ENV = process.env.RELAY_NODE_ENV || 'development';
process.env.PORT = process.env.RELAY_PORT || process.env.PORT || '4900';
process.env.CLIENT_ORIGIN = process.env.RELAY_CLIENT_ORIGIN || 'http://localhost:5900,http://localhost:5901,http://127.0.0.1:5900';
await import('../server/index.js');
