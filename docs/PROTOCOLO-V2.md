# Protocolo OTPChat v2

Implementa las fases 1 a 5 de [PLAN-DESCENTRALIZACION.md](PLAN-DESCENTRALIZACION.md). El código
vive en `src/core/` (JavaScript puro: lo usan el navegador, las apps nativas y los tests de
Node) y el servidor en `server/relay.js`.

## Identidad

- Cada persona tiene una **clave de identidad** ECDSA P-256. Su `userId` es
  `u_` + los primeros 16 bytes del SHA-256 de la clave pública, en base64url.
- Cada dispositivo tiene un `deviceId` aleatorio y una **prekey** ECDH P-256 firmada por la
  identidad. La prekey rota cada 7 días; las privadas viejas se borran a los 30 días. Eso da
  forward secrecy por ventana: robar el dispositivo hoy no abre sobres capturados hace más de
  un mes.
- La **tarjeta** (`card`) de una persona reúne nombre, clave pública y dispositivos con sus
  prekeys, firmada por la identidad. Es lo único que el relay conoce de alguien, y no puede
  falsificarla.
- **Código de seguridad**: 12 grupos de 5 dígitos derivados de las dos claves públicas, igual
  en los dos teléfonos. Compararlo en persona descarta que alguien se haya interpuesto.
- La identidad se puede **respaldar** en un archivo cifrado con frase (PBKDF2 600k + AES-GCM)
  y **vincular** a otro dispositivo por QR. Para eso la clave privada de identidad es
  exportable; las prekeys no.

## Sobres

Todo lo que viaja entre nodos es un **sobre sellado** para un dispositivo:

```
ECDH(efímera, prekey del destino) → HKDF-SHA256 → AES-256-GCM
```

Adentro va un mensaje firmado por la identidad del emisor. El relay solo ve
`{to: deviceId, data: <opaco>}`.

Tipos de mensaje dentro del sobre:

| Tipo | Para qué |
|---|---|
| `entry` | Una entrada del log de un chat |
| `contact.request` / `contact.reject` | Responder un QR de contacto |
| `group.join` | Responder un QR de grupo |
| `welcome` | Estado inicial de un chat para un miembro nuevo |
| `card` | Tarjeta actualizada (nombre, dispositivos, prekey nueva) |
| `sync.req` / `sync.res` | Pedir y mandar entradas faltantes |
| `link.request` / `link.welcome` | Vincular un dispositivo propio |

## Log por chat

Cada chat es un conjunto de **entradas firmadas** por su autor:

```
{ v, chat, author, ts, type, body, deps, sig }   id = SHA-256(contenido firmado)
```

Cada nodo arma el estado aplicando las entradas en orden (`ts`, luego `id`) y **descarta las
que no cumplen las reglas**. El servidor no decide nada.

| Tipo | Quién puede |
|---|---|
| `chat.create` | El fundador (grupo) o cualquiera de los dos (contacto) |
| `member.add` | Admin o subadmin |
| `member.remove` | Admin a cualquiera; subadmin solo a miembros comunes |
| `member.leave` | El propio miembro. Si se va el fundador, pasa al más antiguo |
| `role.set` | Solo el admin principal |
| `chat.settings` | Solo el admin principal (nombre, "los miembros pueden escribir") |
| `chat.delete` | Admin principal (grupo) o cualquiera de los dos (contacto) |
| `msg` | Un miembro, si el grupo permite escribir o si es admin/subadmin |
| `screenshot` | Un miembro: aviso de que se detectó una captura en su dispositivo |

- **Expulsar** a alguien es efectivo en el acto: las entradas siguientes ya no se sellan para
  sus dispositivos, así que no puede leer nada nuevo (no hace falta rotar una clave común,
  porque no la hay).
- **Mensajes temporales**: cada `msg` lleva su `expiresAt`. Cada nodo lo borra al vencer y deja
  una lápida para que una sincronización no lo resucite. Es de mejor esfuerzo: un dispositivo
  modificado podría quedarse con una copia.
- Un miembro nuevo recibe la estructura del grupo, pero no los mensajes anteriores a su
  ingreso (igual que antes).

## Transporte

1. **P2P**: si los dos dispositivos están en línea se abre un canal WebRTC y los sobres van
   directo, en trozos de 16 KB. El relay solo intercambia la señalización.
2. **Relay**: si no hay canal directo, el sobre va al relay. Si el destino está conectado se
   entrega al instante; si no, espera en un **buzón en memoria** (TTL 7 días) y **se borra en
   cuanto el destino confirma la recepción**.
3. **Sincronización**: al conectarse, un nodo pide a los demás miembros las entradas que le
   faltan de cada chat.

El relay no tiene base de datos. Si se reinicia pierde los buzones pendientes y el directorio
de tarjetas; los nodos vuelven a publicar su tarjeta al reconectarse y se recuperan entre sí
con la sincronización.

## Migración desde v1

Si el navegador todavía tiene la sesión de v1, la app ofrece **importar los chats
anteriores**: los baja de la API vieja, los descifra con las llaves locales y los guarda como
historial de solo lectura en el dispositivo. La API vieja (y la base) siguen activas mientras
`DATABASE_URL` esté configurada; al quitarla, el servidor queda solo como relay.

## Desvíos respecto del plan

- **Sobres por destinatario en lugar de MLS.** No hay una implementación de MLS madura para
  navegador que se pueda auditar acá. Sellar cada entrada para cada dispositivo da lo mismo
  que importa en grupos chicos (expulsión efectiva al instante, servidor ciego) con
  criptografía estándar de Web Crypto. El costo es O(miembros) por mensaje.
- **El TOTP desaparece.** No aportaba seguridad (ver la revisión).
- **Push en Android nativo** requiere Firebase Cloud Messaging y un proyecto propio; la app
  Android avisa mientras está abierta o en segundo plano reciente.
