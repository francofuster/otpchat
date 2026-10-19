// Backend para los tests E2E de v2: solo el relay, sin base de datos y con el volcado de
// diagnostico activo (para comprobar que el servidor no guarda nada legible).
process.env.DATABASE_URL = '';
process.env.LEGACY_API = '0';
process.env.NODE_ENV = 'test';
process.env.RELAY_DEBUG = '1';
process.env.PORT = process.env.E2E_PORT || '4900';
process.env.CLIENT_ORIGIN = process.env.E2E_CLIENT_ORIGIN || 'http://localhost:5900';

console.log(`relay E2E en el puerto ${process.env.PORT}, sin base de datos`);
await import('../server/index.js');
