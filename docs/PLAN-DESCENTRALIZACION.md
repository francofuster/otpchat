# Plan: seguridad y persistencia descentralizada

Estado: aprobado. Fase 0 en curso.

## Decisiones tomadas

- **No hay base de datos única.** Cada chat vive solo en los dispositivos de sus participantes
  y se replica entre ellos. Nadie ajeno al chat guarda nada, ni siquiera cifrado.
- **Queda un servidor liviano y sin base**: señalización WebRTC, relay TURN y un **buzón
  temporal en memoria**. Un mensaje se borra del buzón en cuanto el destinatario confirma la
  entrega (y en todo caso al vencer su TTL).
- **Apps nativas mínimas** de escritorio y mobile, además de la PWA: hacen falta para tener
  nodos que sigan vivos en segundo plano y para proteger la pantalla contra capturas.
- **Los mensajes temporales siguen siendo una función central.** En un modelo distribuido
  son de "mejor esfuerzo": cada nodo honesto los borra al vencer, pero nadie puede garantizar
  que un dispositivo modificado no se quede con una copia. La interfaz lo tiene que decir.

## Arquitectura objetivo

```
Dispositivo A (nodo)        Servidor liviano, SIN base        Dispositivo B (nodo)
──────────────────────      ─────────────────────────        ──────────────────────
Almacenamiento local   ←→   · Señalización WebRTC       ←→   Almacenamiento local
Log firmado por chat        · Relay TURN                      Log firmado por chat
Claves en el dispositivo    · Buzón en memoria (TTL,          Claves en el dispositivo
        ↕                     se borra al entregar)                   ↕
        └──────────── WebRTC directo (P2P) ──────────────────────────┘
```

- **Identidad:** par de claves generado en el dispositivo. Sin usuarios ni contraseñas en el
  servidor.
- **Log por chat:** cada mensaje y cada cambio (alta, expulsión, rol, nombre, temporizador,
  permiso de escritura) es una entrada firmada por su autor y encadenada por hash. Cada nodo
  valida firmas y reglas y descarta lo inválido (por ejemplo, una expulsión que no firmó un
  admin). Los permisos de grupo los hacen cumplir los nodos, no el servidor.
- **Sincronización:** al conectarse, dos nodos comparan qué entradas tiene cada uno y se pasan
  las que faltan. Si el otro no está en línea, la entrada va al buzón temporal.
- **Cifrado:** MLS (RFC 9420) para grupos y para 1 a 1 (grupo de dos). Expulsar a alguien
  cambia la clave para el resto. Reemplaza el esquema actual de "TOTP + secreto de sala".

### Dónde va cada tabla actual

| Tabla actual | Dónde pasa a vivir |
|---|---|
| `users`, `sessions` | Clave de identidad en el dispositivo; no hay sesiones |
| `contacts`, `invitations` | QR con clave pública + código de un solo uso; el contacto queda en cada nodo |
| `groups`, `groupMembers` | Entradas firmadas en el log del grupo |
| `messages` | Log del chat, replicado entre sus miembros |
| `messageReadStates`, `messageTimerPreferences` | Locales (o sincronizados entre los dispositivos del mismo usuario) |
| `securityEvents`, estadísticas admin | Desaparecen |
| `pushSubscriptions` | Push opcional: el servidor solo sabe "hay algo en el buzón X" |

## Fases

### Fase 0: endurecer lo actual

Corrige los hallazgos de la revisión de seguridad que protegen a los usuarios actuales o son
baratos. No se invierte en piezas que van a desaparecer (panel admin, contraseñas, JWT).

- Validar entradas numéricas (`timerSeconds`, `keyVersion`, `durationMs`) y de texto
  (`username`, `password`, nombre de grupo, forma y tamaño de `encrypted`).
- `mutate` deshace el cambio en memoria si la base rechaza el guardado.
- Revocación de JWT con `tokenVersion`, JWT corto, clave actual obligatoria al cambiarla,
  `mustChangePassword` exigido en el servidor.
- El servidor no arranca en producción sin `JWT_SECRET`.
- TLS de Postgres verificado, `TYPEORM_SYNCHRONIZE=false` en producción.
- CSP y headers de seguridad en Vercel; service worker con red primero para la navegación.

### Fase 1: identidad por claves

- Par de claves por dispositivo (Web Crypto), guardado como `CryptoKey` no extraíble.
- Login firmando un desafío; las contraseñas quedan opcionales y después se eliminan.
- Contactos ligados a la clave pública, con código de seguridad para verificar en persona.
- Respaldo cifrado de la clave con frase de recuperación.

### Fase 2: el dispositivo es la fuente de verdad

- Historial y estado en almacenamiento local, con el log firmado por chat.
- El servidor actual pasa a ser solo transporte: retransmite sin guardar.
- Migración: cada usuario descarga su historial a su dispositivo; después se vacían las
  tablas de mensajes, contactos y grupos. **Desde acá no hay base de datos única.**
- Cifrado MLS para chats nuevos; los viejos quedan marcados como "cifrado heredado".

### Fase 3: P2P

- WebRTC entre los miembros de cada chat para sincronizar el log.
- Servidor reducido a señalización + TURN + buzón en memoria (borrado al entregar).
- Spike previo: WebRTC con señalización propia vs. libp2p.

### Fase 4: apps nativas y protección de pantalla

Base común: el mismo frontend Angular envuelto.

- **Mobile:** Capacitor (Android e iOS).
- **Escritorio:** Tauri o Electron. Los dos tienen protección de contenido de ventana
  integrada.
- Las apps nativas pueden quedar como nodo en segundo plano (dentro de los límites de cada
  sistema operativo) para sincronizar y vaciar el buzón.

**Protección contra capturas** — qué se puede y qué no en cada plataforma:

| Plataforma | Mecanismo | Alcance |
|---|---|---|
| Android | `FLAG_SECURE` en la ventana | **Bloquea** capturas y grabación; la vista aparece negra. También oculta la app en el selector de recientes |
| iOS | No se pueden bloquear las capturas. Se detectan después (`userDidTakeScreenshotNotification`) y la grabación o duplicación de pantalla en curso (`UIScreen.isCaptured`) | Al detectar grabación se tapa la vista. Para capturas se puede tapar el contenido sensible con la técnica de la capa de campo seguro, y además avisar al resto del chat |
| Windows | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` (`setContentProtection` en Electron, `set_content_protected` en Tauri) | La ventana sale negra o vacía en capturas y grabaciones |
| macOS | `NSWindow.sharingType = .none` (mismas APIs de Electron/Tauri) | Funciona con las APIs clásicas de captura; las herramientas más nuevas del sistema pueden ignorarlo. Verificar en cada versión |
| Web (PWA) | No hay API para detectar ni bloquear capturas | Solo se puede tapar la vista al perder el foco (`visibilitychange`, `blur`), como mitigación parcial |

Comportamiento propuesto en todas las plataformas: al perder el foco o pasar a segundo plano
se tapa la vista (protege el selector de apps recientes), y si se detecta grabación o captura
se tapa el contenido y se avisa al chat. Ninguna técnica impide sacarle una foto a la
pantalla con otro dispositivo; la interfaz no debe prometer más que esto.

### Fase 5: resiliencia

- Nodo siempre encendido opcional (app de escritorio o nodo propio) con réplicas cifradas de
  los chats del usuario.
- Multi-dispositivo: los dispositivos de un mismo usuario se sincronizan entre sí.
- Varios servidores de encuentro intercambiables y un paquete para levantar uno propio.
- Builds reproducibles y hash publicado del cliente, para que un servidor comprometido no
  pueda servir un frontend modificado.

## Riesgos asumidos

- **Metadatos:** el servidor de encuentro ve IPs y horarios aunque no lea contenido.
  Mitigación parcial: buzones con identificadores rotativos y relleno de tamaño.
- **Entrega diferida:** si ningún participante está en línea y el buzón vence, el mensaje no
  llega. El TTL del buzón tiene que ser generoso (días) y configurable.
- **Pérdida de claves:** sin respaldo, perder el dispositivo es perder la cuenta y el
  historial.
- **Moderación:** sin servidor central no hay panel admin ni borrado de cuentas.
- **Complejidad del cifrado:** MLS y la validación del log son delicados. Usar una librería
  existente y, si el proyecto va en serio, pedir una auditoría externa.
