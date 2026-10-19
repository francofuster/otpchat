// OTPChat de escritorio. Sirve la web compilada desde app:// (un origen propio y seguro, para
// que IndexedDB y Web Crypto funcionen igual que en el sitio) y protege la ventana:
//  - setContentProtection: queda excluida de capturas y grabaciones de pantalla.
//  - Sin navegacion a otros sitios: los links externos se abren en el navegador del sistema.
const { app, BrowserWindow, protocol, net, shell, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, 'app');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https: wss:; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

if (!app.requestSingleInstanceLock()) app.quit();

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 360,
    minHeight: 520,
    backgroundColor: '#120d0b',
    title: 'OTPChat',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.setContentProtection(true);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://otpchat/')) {
      event.preventDefault();
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  void win.loadURL('app://otpchat/index.html');
  return win;
}

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const target = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
    if (!target.startsWith(ROOT)) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(target).toString()).catch(() => null);
    if (!response || !response.ok) return net.fetch(pathToFileURL(path.join(ROOT, 'index.html')).toString());
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(response.body, { status: response.status, headers });
  });
  // Solo el microfono (mensajes de voz) y las notificaciones; todo lo demas se niega.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'notifications', 'clipboard-sanitized-write'].includes(permission));
  });
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
