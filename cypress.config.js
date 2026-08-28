import { defineConfig } from 'cypress';

const apiBase = process.env.E2E_API_BASE || 'http://localhost:4900';
const password = 'Test-1234';

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

const nombreUnico = (prefijo) => `${prefijo}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const registrar = (username) =>
  api('/api/auth/register', { method: 'POST', body: { username, password, fingerprint: `fp-${username}` } });

export default defineConfig({
  e2e: {
    baseUrl: process.env.E2E_BASE_URL || 'http://localhost:5900',
    supportFile: 'cypress/support/e2e.js',
    specPattern: 'cypress/e2e/**/*.cy.js',
    video: false,
    screenshotOnRunFailure: false,
    defaultCommandTimeout: 10000,
    setupNodeEvents(on) {
      on('task', {
        // Arma un chat entre dos usuarios nuevos y le manda "mensajes" no leidos al
        // primero. Corre en Node, no en el browser: sembrar por HTTP es mucho mas rapido
        // que hacer clicks, y cada escenario usa usuarios unicos para no pisarse.
        async crearChat({ mensajes = 0 } = {}) {
          const nombreA = nombreUnico('e2e_a');
          const nombreB = nombreUnico('e2e_b');
          const a = await registrar(nombreA);
          const b = await registrar(nombreB);

          const { invitation } = await api('/api/invitations/contact', { method: 'POST', token: a.token });
          const { conversationId } = await api(`/api/invitations/${invitation.code}/accept`, { method: 'POST', token: b.token });

          for (let i = 0; i < mensajes; i++) {
            await api('/api/messages', {
              method: 'POST',
              token: b.token,
              // El contenido real no importa: sin la llave local el cliente muestra el
              // aviso de "falta la llave", pero el CONTEO de no leidos es del servidor.
              body: { scope: 'contact', targetId: conversationId, encrypted: { iv: 'aaaa', salt: 'bbbb', ciphertext: btoa(`e2e ${i}`) } }
            });
          }
          return { usuarioA: nombreA, usuarioB: nombreB, password, conversationId };
        },

        // Manda mensajes adicionales a un chat ya creado, como si llegaran de la otra persona.
        async enviarComo({ username, conversationId, mensajes = 1 }) {
          const sesion = await api('/api/auth/login', { method: 'POST', body: { username, password, fingerprint: `fp-${username}` } });
          for (let i = 0; i < mensajes; i++) {
            await api('/api/messages', {
              method: 'POST',
              token: sesion.token,
              body: { scope: 'contact', targetId: conversationId, encrypted: { iv: 'aaaa', salt: 'bbbb', ciphertext: btoa(`extra ${i}`) } }
            });
          }
          return null;
        },

        async noLeidosSegunServidor({ username, conversationId }) {
          const sesion = await api('/api/auth/login', { method: 'POST', body: { username, password, fingerprint: `fp-${username}` } });
          const { contacts } = await api('/api/bootstrap', { token: sesion.token });
          return contacts.find((c) => c.conversationId === conversationId)?.unreadCount ?? null;
        }
      });
    }
  }
});
