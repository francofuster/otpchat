# Deploy OTPChat

## v2: relay sin base de datos

Desde la versión 2 el servidor es un **relay sin base de datos** (`server/relay.js`, WebSocket en `/relay`). Para correrlo alcanza con:

```env
NODE_ENV=production
JWT_SECRET=<32+ caracteres; lo exige el arranque aunque la API v1 esté apagada>
CLIENT_ORIGIN=https://otpchat.vercel.app
VAPID_PUBLIC_KEY=<opcional, para avisos push>
VAPID_PRIVATE_KEY=<opcional>
```

- `CLIENT_ORIGIN` acepta varios orígenes separados por coma. Las apps nativas (`https://localhost` de Capacitor y `app://otpchat` de Electron) se permiten siempre.
- Todo lo del relay vive en memoria: buzones, directorio de tarjetas y suscripciones push. En el plan gratis de Render el servicio se duerme a los 15 minutos sin tráfico y lo pierde; los nodos lo recuperan entre sí al reconectarse (sincronización recíproca), pero un mensaje para alguien desconectado puede tardar hasta que los dos estén en línea a la vez. Un plan que no duerma evita esa demora.

### Migración y retiro de la base

Mientras `DATABASE_URL` esté configurada, el mismo proceso sirve también la **API v1** para que cada persona importe sus chats anteriores desde la app (banner "Tenés chats de la versión anterior"). Cuando termine el período de migración:

1. Quitá `DATABASE_URL` (y `PGSSL`, `SUPERADMIN_*`) de Render y redeployá. El log tiene que decir `relay v2, sin base de datos` y `/api/*` responde `410` salvo `/api/health`.
2. Borrá el proyecto de Neon.

Desde ahí no queda ninguna base de datos central.

---

## Configuración v1 (solo durante la migración)

## 1. Neon Postgres

1. Create a Neon project.
2. In the Neon dashboard, use **Connect** to copy the pooled Postgres connection string.
3. Keep that value for Render as `DATABASE_URL`.

Use the pooled URL when possible. The backend reads `DATABASE_URL` directly and enables SSL when `PGSSL=true`.

Official docs: https://neon.com/docs/get-started-with-neon/connect-neon

## 2. Render Backend

Create a new Web Service from this GitHub repo.

Settings:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Root directory: repository root

Environment variables:

```env
NODE_ENV=production
DATABASE_URL=<neon pooled connection string>
PGSSL=true
JWT_SECRET=<long random secret, 32+ caracteres>
CLIENT_ORIGIN=<your Vercel production URL>
TYPEORM_SYNCHRONIZE=false
SUPERADMIN_USERNAME=<nombre de usuario del admin>
SUPERADMIN_PASSWORD=<clave inicial del admin>
REGISTER_COOLDOWN_ENABLED=false
DEVICE_ACCOUNT_LIMIT_ENABLED=false
```

**Cambios de seguridad que afectan el entorno:**

- **`JWT_SECRET` es obligatorio.** Con `NODE_ENV=production` el servidor no arranca si falta o tiene menos de 32 caracteres.
- **`JWT_TTL`** (opcional, por defecto `1h`) define cuanto dura el JWT. El cliente lo renueva solo con el refresh token.
- **`TYPEORM_SYNCHRONIZE=false` en produccion.** Las columnas nuevas (por ahora `users.tokenVersion`) las agrega `server/store.js` en el arranque. Una base **vacia** necesita un primer arranque con `TYPEORM_SYNCHRONIZE=true` para crear el esquema; despues se vuelve a `false`.
- **El certificado de Postgres se verifica.** Con `PGSSL=true` la conexion rechaza certificados invalidos; Neon tiene certificados publicos validos. `PGSSL_INSECURE=true` desactiva la verificacion y solo deberia usarse para diagnosticar.
- **`MAX_TEXT_BYTES`** (opcional, por defecto `65536`) es el tope del ciphertext de un mensaje de texto.

**Sobre el superadmin.** El panel `/admin` ya no se otorga por tener un nombre magico. El nombre que pongas en `SUPERADMIN_USERNAME` queda **reservado** (nadie puede registrarlo ni renombrarse a el), asi que la cuenta admin **no se crea por el registro normal**: la crea el servidor en el arranque a partir de `SUPERADMIN_PASSWORD`.

Para habilitar el panel:

1. Pone `SUPERADMIN_USERNAME` (el nombre que quieras) y `SUPERADMIN_PASSWORD` (una clave inicial) en el entorno.
2. Redeploya. En el arranque, si esa cuenta no existe, el servidor la crea con esa clave.
3. Entra con ese usuario y clave. En el primer login te va a pedir **cambiar la contrasena** (la de env puede quedar registrada en logs o el dashboard del hosting).
4. Una vez creada, `SUPERADMIN_PASSWORD` ya no hace nada; podes borrarla del entorno.

Si dejas `SUPERADMIN_PASSWORD` sin setear y la cuenta no existe, el sistema arranca **sin ningun superadmin** (fail closed), que es lo mas seguro si no necesitas el panel.

Render provides `PORT` automatically. Do not hardcode it in Render.

Official docs:

- https://render.com/docs/deploy-node-express-app
- https://render.com/docs/environment-variables
- https://render.com/docs/web-services

## 3. Vercel Frontend

Create a new Vercel project from this GitHub repo.

Settings:

- Framework preset: Angular
- Build command: `npm run build`
- Output directory: `dist/otpchat/browser`

Environment variables:

```env
OTPCHAT_API_BASE=<your Render service URL, for example https://otpchat-api.onrender.com>
```

The build script writes `public/config.js`, so the Angular app knows where the Render API and WebSocket live.

`vercel.json` sets a Content-Security-Policy: only scripts served from the site itself run (no inline scripts), and `connect-src` allows any `https:`/`wss:` origin so the Render API works without hardcoding its URL. To narrow it, replace `https: wss:` with your Render URL (`https://...onrender.com wss://...onrender.com`).

Official docs:

- https://vercel.com/docs/environment-variables
- https://vercel.com/docs/builds

## 4. Final wiring

1. Deploy Render first and copy the backend URL.
2. Add that Render URL as `OTPCHAT_API_BASE` in Vercel.
3. Deploy Vercel and copy the frontend URL.
4. Add that Vercel URL as `CLIENT_ORIGIN` in Render.
5. Redeploy both services once after those URLs are set.

## Automatic options

- GitHub push can be automated locally with `gh`.
- Render and Vercel can auto-deploy on every GitHub push after you connect the repo in their dashboards.
- Neon database creation is usually fastest from the Neon dashboard; after that, the connection string is all the backend needs.
