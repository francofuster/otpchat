## OTPChat 2.0 — cada dispositivo es un nodo

Tus chats ya no viven en una base de datos central: se guardan solo en los dispositivos de quienes participan y se replican entre ellos, directo por WebRTC cuando se puede. El servidor quedó como relay ciego, sin base de datos.

### Descargas

| Plataforma | Archivo |
|---|---|
| Android 7+ | `otpchat-android.apk` |
| Windows 10/11 | `otpchat-windows.exe` (portable, no requiere instalación) |
| Web | [otpchat.vercel.app](https://otpchat.vercel.app) |

Verificá la descarga contra `SHA256SUMS.txt`.

**Instalar el APK:** abrilo desde el teléfono y permití "instalar apps de origen desconocido" para el navegador o el gestor de archivos. Android pide confirmación una sola vez.

### Novedades

- **Sin cuenta en un servidor**: tu identidad es una clave generada en el dispositivo. Sin usuario ni contraseña.
- **P2P**: los mensajes van directo entre dispositivos cuando están en línea; si no, esperan cifrados en un buzón que se borra al entregarse.
- **Cifrado nuevo**: sobres sellados por destinatario (ECDH P-256 + AES-256-GCM) y entradas firmadas (ECDSA). Expulsar a alguien de un grupo es efectivo al instante.
- **Protección de pantalla**: la app Android bloquea capturas y grabaciones y avisa al chat si detecta una; la de Windows excluye su ventana de las capturas.
- **Multi-dispositivo** por QR, **respaldo cifrado** con frase y **código de seguridad** para verificar contactos.
- **Migración**: si usabas la versión anterior, la app ofrece importar tus chats al dispositivo.

### A tener en cuenta

- Si perdés el dispositivo sin respaldo ni otro dispositivo vinculado, la cuenta no se puede recuperar: no hay un servidor que la guarde.
- Las invitaciones se resuelven entre los dos dispositivos: quien muestra el QR tiene que tenerlo abierto en pantalla.
- La app Android todavía no tiene notificaciones push con la app cerrada (requiere Firebase); avisa mientras está abierta.
