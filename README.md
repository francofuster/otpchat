# OTPChat

Web app de chat cifrado con Angular, Node.js, Express, WebSocket, TypeORM y Postgres.

## Ejecutar en desarrollo

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5900
- Backend: http://localhost:4900
- Base local: Postgres `otpchat`

## Postgres local

El backend crea la base `otpchat` automáticamente si existe un servidor Postgres local y las credenciales tienen permiso `CREATE DATABASE`.

Si preferís crearla manualmente:

```bash
createdb -U postgres otpchat
```

Configurá `.env` desde `.env.example`. Por defecto usa:

```env
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=postgres
PGDATABASE=otpchat
PGMAINTENANCE_DATABASE=postgres
PG_CREATE_DATABASE=true
TYPEORM_SYNCHRONIZE=true
REGISTER_COOLDOWN_ENABLED=false
DEVICE_ACCOUNT_LIMIT_ENABLED=false
```

Con `TYPEORM_SYNCHRONIZE=true`, TypeORM crea y actualiza las tablas automáticamente al iniciar.

## Tests

```bash
npm test        # capa de persistencia (rapido, sin navegador)
npm run e2e     # end-to-end con Cypress
npm run e2e:open # Cypress en modo interactivo
```

Ambos corren contra bases Postgres **descartables** (`otpchat_test` y `otpchat_e2e`), que
se crean solas y se recrean vacias en cada corrida. Ninguna prueba toca la base de la app.

Esto no es automatico: el `.env` apunta a produccion via `DATABASE_URL`, y en `store.js`
esa variable gana sobre `PGDATABASE`. `scripts/test-env.mjs` la deja vacia antes de que se
cargue `dotenv` y ademas rechaza cualquier nombre de base que no sea `otpchat_<algo>`.

Los tests E2E levantan el backend con `RATE_LIMIT_ENABLED=false`, porque con el limite real
de 3 registros por hora no se puede automatizar ningun alta. En produccion el flag no se
setea y los limitadores quedan activos.

## Features implementadas

- Registro/login con bcrypt 12 rondas, JWT 7 días y refresh token rotativo por dispositivo.
- Fingerprint cliente con Canvas, WebGL, audio, fuentes, sistema y hash SHA-256.
- Cooldown de registro por IP/fingerprint y una cuenta por dispositivo.
- Invitaciones por QR para contactos y grupos, con expiración/cancelación.
- Chat 1 a 1 y grupal por WebSocket.
- Cifrado cliente AES-256-GCM, clave derivada con PBKDF2 desde OTP TOTP + secreto del chat.
- TOTP RFC 6238 en Web Crypto, indicador visual y estados naranja/rojo.
- Historial limitado a 300 mensajes, fechas separadoras, auto-scroll y badges/toasts.
- Mensajes temporales por chat/grupo con countdown, desaparición local y limpieza server cada 30s.
- Grupos con secreto OTP, invitación QR y rol admin básico para editar nombre/timer.
- Panel `/admin` exclusivo para `sup3r4drm1n_3533`, stats, selección, borrado y reset de clave temporal.
- Badges de mensajes no leidos por chat, contados en el servidor y con tope "+99".
- PWA con manifest, service worker, icono y layout mobile/desktop.

## Producción

Ver pasos completos en [DEPLOYMENT.md](DEPLOYMENT.md).

Para Neon/Render podés usar:

```env
DATABASE_URL=postgresql://user:password@host:5432/otpchat
PGSSL=true
```

En producción conviene cambiar `TYPEORM_SYNCHRONIZE=false` y pasar a migraciones versionadas.
