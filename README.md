# OTPChat

**[otpchat.vercel.app](https://otpchat.vercel.app/)** — Chat cifrado de punta a punta donde **cada dispositivo es un nodo**. Los chats viven solo en los dispositivos de quienes participan y se replican entre ellos: no hay una base de datos central con usuarios, contactos ni mensajes.

Apps: **web (PWA)**, **Android** y **Windows** — [descargas en Releases](https://github.com/francofuster/otpchat/releases/latest).

---

## Cómo funciona

```
Dispositivo A (nodo)        Servidor liviano, SIN base        Dispositivo B (nodo)
──────────────────────      ─────────────────────────        ──────────────────────
IndexedDB: sus chats   ←→   · Señalización WebRTC       ←→   IndexedDB: sus chats
Log firmado por chat        · Buzón en memoria (TTL,          Log firmado por chat
Claves en el dispositivo      se borra al entregar)           Claves en el dispositivo
        ↕                   · Aviso push sin contenido                ↕
        └──────────── WebRTC directo (P2P) ──────────────────────────┘
```

- **Identidad sin cuenta en un servidor.** Al empezar se genera una clave ECDSA P-256 en el dispositivo. No hay usuario ni contraseña. Se puede respaldar en un archivo cifrado con frase o vincular a otro dispositivo por QR.
- **Sobres sellados.** Cada mensaje viaja sellado para cada dispositivo destino (ECDH P-256 efímero + HKDF + AES-256-GCM) y firmado por su autor. El servidor solo ve `{to, data opaco}`.
- **Log firmado por chat.** Mensajes, altas, expulsiones, roles y ajustes son entradas firmadas. Cada nodo las valida y descarta lo que no cumple las reglas: los permisos de grupo los hacen cumplir los dispositivos, no un servidor.
- **P2P primero, relay de respaldo.** Si los dos dispositivos están en línea, los sobres van por WebRTC directo. Si no, esperan en un buzón en memoria que **se borra apenas el destino confirma la entrega**.
- **Sincronización entre nodos.** Al conectarse, cada nodo pide a los otros miembros lo que le falta. Si el relay se reinicia y pierde el buzón, los nodos se recuperan entre sí.

Detalle técnico: [docs/PROTOCOLO-V2.md](docs/PROTOCOLO-V2.md) · Plan y decisiones: [docs/PLAN-DESCENTRALIZACION.md](docs/PLAN-DESCENTRALIZACION.md)

### Características

- **Chat 1 a 1 y grupal** con invitación por QR. **Todos los QR y sus links (contacto, grupo y vinculación de dispositivos) se renuevan cada minuto**: el anterior deja de servir tras 15 s de gracia, y al cerrar la hoja deja de servir al instante. El de contacto es de un solo uso
- **Mensajes de audio** cifrados igual que el texto (duran 1 día sin temporizador)
- **Mensajes temporales** de 30 s a 7 días: cada nodo los borra al vencer y deja una lápida para que no vuelvan por sincronización
- **Roles de grupo**: admin principal, subadmins y candado "solo administradores escriben"
- **Expulsión efectiva al instante**: lo siguiente ya no se sella para el expulsado
- **Código de seguridad** de 60 dígitos para verificar un contacto en persona
- **Multi-dispositivo** por QR y **respaldo cifrado** con frase (PBKDF2 600k)
- **Protección de pantalla**: Android bloquea capturas y grabaciones (`FLAG_SECURE`) y avisa al chat si detecta una; Windows excluye la ventana de las capturas; la web tapa la vista al perder el foco
- **Notificaciones push** que solo dicen "Mensajes nuevos": el servidor no sabe de quién ni de qué chat
- **Badges de no leídos** calculados en el dispositivo, con tope "+99"
- **Migración desde v1**: importa los chats anteriores al dispositivo como historial de solo lectura

---

## Requisitos

- **Node.js** 22 o superior (WebSocket global)
- Solo para la API v1 durante la migración: **PostgreSQL** 14+

## Desarrollo local

```bash
npm install
npm run dev
```

| Servicio | URL |
|---|---|
| Web | http://localhost:5900 |
| Relay | http://localhost:4900 (`/relay` por WebSocket) |

`npm run dev` levanta el relay **sin base de datos** (`scripts/dev-relay.mjs` neutraliza el `DATABASE_URL` del `.env`). Para probar con dos personas en la misma máquina, abrí el sitio en dos orígenes distintos (por ejemplo, `ng serve --port 5901` en otra terminal): cada origen tiene su propio IndexedDB y es un nodo distinto.

## Tests

```bash
npm test              # store y API v1 (Postgres descartable) + protocolo v2 (nodos reales contra un relay real)
npm run test:core     # solo el protocolo v2, sin base de datos
npm run e2e           # end-to-end con Cypress: el navegador contra nodos "bot" que corren en Node
```

Los e2e no necesitan base de datos: la otra persona de cada escenario es un nodo con el mismo núcleo (`src/core`) conectado al mismo relay.

## Apps nativas

| App | Código | Cómo se compila |
|---|---|---|
| Android | `android/` (Capacitor) | `npm run android:sync` y Android Studio, o el workflow de release |
| Windows | `desktop/` (Electron) | `cd desktop && npm install && npm run dist` con la web compilada en `desktop/app` |

El workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) compila las dos al subir un tag `v*` y publica el release. El APK se firma con la clave guardada en los secretos del repo (`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`).

## Deploy

Guía: [DEPLOYMENT.md](DEPLOYMENT.md). Resumen: Vercel sirve la web, Render corre el relay. Mientras `DATABASE_URL` esté configurada, Render también sirve la API v1 para que la gente importe sus chats anteriores; al quitarla, el servidor queda solo como relay y la base se puede borrar.

## Licencia

MIT
