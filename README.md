# OTPChat

**[otpchat.vercel.app](https://otpchat.vercel.app/)** — Chat cifrado de punta a punta para dos o más participantes. Cada mensaje se encripta **en el navegador** con AES-256-GCM antes de viajar al servidor, usando una clave derivada de un código TOTP (RFC 6238) y un secreto de sala: el backend nunca ve texto en claro.

---

## Cómo funciona

```
Navegador A                  Servidor (Node/Express)          Navegador B
─────────────────────        ──────────────────────           ─────────────────────
TOTP + secreto de sala  →    Solo ve texto cifrado   →        TOTP + secreto de sala
AES-256-GCM encripta         WebSocket retransmite            AES-256-GCM desencripta
                             PostgreSQL persiste               Texto legible en UI
```

### Stack

| Capa | Tecnología |
|---|---|
| Frontend | Angular 20, PWA |
| Backend | Node.js, Express 5, WebSocket (`ws`) |
| Base de datos | PostgreSQL 14+ vía TypeORM |
| Autenticación | JWT 7 días + refresh token rotativo por dispositivo |
| Cifrado | AES-256-GCM, PBKDF2, TOTP RFC 6238 en Web Crypto API |

### Características

- **Chat 1 a 1 y grupal** por WebSocket con historial limitado a 300 mensajes
- **TOTP visual** con indicador naranja/rojo cuando el código está por vencer
- **Mensajes temporales** con countdown y limpieza automática server-side cada 30 s
- **Invitaciones por QR** para contactos y grupos, con expiración y cancelación
- **Fingerprint de dispositivo** con Canvas, WebGL, audio y fuentes + hash SHA-256
- **Badges de no leídos** por chat, contados en el servidor, con tope "+99"
- **Panel `/admin`** con stats, selección y borrado de cuentas (acceso por nombre reservado)
- **PWA** con manifest, service worker e ícono — instalable en mobile y desktop

---

## Requisitos

- **Node.js** 20 o superior
- **PostgreSQL** 14 o superior (local o en la nube)

---

## Desarrollo local

```bash
git clone https://github.com/tu-usuario/otp-chat.git
cd otp-chat
npm install
```

Copiá el archivo de variables de entorno y editá según tu entorno:

```bash
cp .env.example .env
```

Variables mínimas para desarrollo:

```env
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=postgres
PGDATABASE=otpchat
PGMAINTENANCE_DATABASE=postgres
PG_CREATE_DATABASE=true
TYPEORM_SYNCHRONIZE=true
JWT_SECRET=cambia_esto_en_produccion
REGISTER_COOLDOWN_ENABLED=false
DEVICE_ACCOUNT_LIMIT_ENABLED=false
```

Con `PG_CREATE_DATABASE=true` el backend crea la base `otpchat` automáticamente si el usuario de Postgres tiene permiso `CREATE DATABASE`. Si preferís crearla a mano:

```bash
createdb -U postgres otpchat
```

Levantá frontend y backend en paralelo:

```bash
npm run dev
```

| Servicio | URL |
|---|---|
| Frontend | http://localhost:5900 |
| Backend / API | http://localhost:4900 |

---

## Build propio

El build genera el frontend estático en `dist/otpchat/browser` y deja el backend listo para servir con `npm start`.

### 1. Configurá las variables de entorno de build

El script de build escribe `public/config.js` con la URL del API. Sin esta variable el frontend apunta a `localhost` en producción.

```env
OTPCHAT_API_BASE=https://tu-backend.example.com
```

### 2. Compilá

```bash
npm run build
```

Esto ejecuta en orden:
1. `node scripts/write-runtime-config.js` — genera `public/config.js` con la URL del API
2. `ng build` — compila y optimiza el frontend Angular en `dist/otpchat/browser`

### 3. Servís el backend

El servidor Express sirve el frontend compilado automáticamente en producción:

```bash
npm start
```

O con variables de entorno explícitas:

```bash
NODE_ENV=production DATABASE_URL=postgresql://user:pass@host/otpchat node server/index.js
```

### Estructura de salida

```
dist/otpchat/browser/   ← archivos estáticos del frontend (servidos por Express)
server/                 ← backend Node.js (no se compila, corre directo)
public/config.js        ← URL del API, generada en build time
```

---

## Tests

```bash
npm test              # capa de persistencia — rápido, sin navegador
npm run e2e           # end-to-end con Cypress (headless)
npm run e2e:open      # Cypress en modo interactivo
```

Los tests E2E corren contra bases descartables (`otpchat_test` y `otpchat_e2e`) que se crean y recrean vacías en cada corrida. No tocan la base de la app ni la de producción.

> **Nota:** `temporales.cy.js` tarda ~1 minuto. El temporizador mínimo de la app es de 30 s y hay un test que espera a que el mensaje desaparezca en tiempo real.

---

## Deploy en la nube

Guía completa paso a paso: [DEPLOYMENT.md](DEPLOYMENT.md)

Resumen del stack recomendado:

| Servicio | Rol |
|---|---|
| [Neon](https://neon.com) | PostgreSQL serverless |
| [Render](https://render.com) | Backend Node.js |
| [Vercel](https://vercel.com) | Frontend Angular (static) |

Variables clave en producción:

```env
DATABASE_URL=postgresql://user:password@host:5432/otpchat
PGSSL=true
JWT_SECRET=<secreto largo y aleatorio>
CLIENT_ORIGIN=<URL de Vercel>
TYPEORM_SYNCHRONIZE=false
NODE_ENV=production
```

En producción conviene cambiar `TYPEORM_SYNCHRONIZE=false` y gestionar el esquema con migraciones versionadas.

---

## Licencia

MIT
