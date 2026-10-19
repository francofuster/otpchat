import { defineConfig } from 'cypress';
import WebSocket from 'ws';
import { OtpNode } from './src/core/node.js';
import { RelayClient } from './src/core/relay-client.js';
import { createMemoryStore } from './src/core/memory-store.js';

// La "otra persona" de cada test es un nodo bot que corre aca, en Node, con el mismo nucleo
// que la app y contra el mismo relay. Asi cada escenario prueba dos dispositivos reales
// hablando por la red, sin servidor con base de datos en el medio.
const relayHttp = process.env.E2E_API_BASE || 'http://localhost:4900';
const relayUrl = `${relayHttp.replace(/^http/, 'ws')}/relay`;
const siteOrigin = process.env.E2E_BASE_URL || 'http://localhost:5900';
const bots = new Map();
let nextBot = 0;

function bot(id) {
  const node = bots.get(id);
  if (!node) throw new Error(`bot ${id} no existe`);
  return node;
}

const payloadOf = (link) => String(link).split('#/i/')[1];

async function waitFor(check, timeout = 8000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('timeout esperando al bot');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export default defineConfig({
  e2e: {
    baseUrl: siteOrigin,
    supportFile: 'cypress/support/e2e.js',
    specPattern: 'cypress/e2e/**/*.cy.js',
    video: false,
    screenshotOnRunFailure: false,
    defaultCommandTimeout: 10000,
    setupNodeEvents(on) {
      on('task', {
        async 'bot:create'({ name }) {
          const node = new OtpNode({ store: createMemoryStore(), transport: new RelayClient({ url: relayUrl, WebSocketImpl: WebSocket }), origin: siteOrigin, waitMs: 8000 });
          await node.init();
          await node.createIdentity(name);
          await node.connect();
          const id = `bot${++nextBot}`;
          bots.set(id, node);
          return id;
        },
        async 'bot:invite'({ id, kind = 'contact', chatId }) {
          const { link } = await bot(id).createInvite(kind, chatId);
          return link.replace(/^https?:\/\/[^/]+/, siteOrigin);
        },
        async 'bot:accept'({ id, link }) {
          return bot(id).acceptInvite(payloadOf(link));
        },
        async 'bot:tryAccept'({ id, link }) {
          try {
            await bot(id).acceptInvite(payloadOf(link));
            return 'aceptada';
          } catch (err) {
            return err.message;
          }
        },
        async 'bot:createGroup'({ id, name }) {
          return bot(id).createGroup(name);
        },
        async 'bot:send'({ id, chatId, text }) {
          const node = bot(id);
          const target = chatId || node.listChats()[0]?.id;
          await node.sendText(target, text);
          return target;
        },
        async 'bot:trySend'({ id, chatId, text }) {
          try {
            await bot(id).sendText(chatId, text);
            return 'ok';
          } catch (err) {
            return err.message;
          }
        },
        async 'bot:messages'({ id, chatId }) {
          const node = bot(id);
          const target = chatId || node.listChats()[0]?.id;
          return target ? node.messages(target).map((m) => ({ text: m.text, mine: m.mine, expiresAt: m.expiresAt, system: !!m.system })) : [];
        },
        async 'bot:waitMessage'({ id, text, chatId }) {
          const node = bot(id);
          return waitFor(() => {
            const chats = chatId ? [chatId] : node.listChats().map((c) => c.id);
            return chats.some((c) => node.messages(c).some((m) => m.text === text));
          });
        },
        async 'bot:chats'({ id }) {
          return bot(id).listChats();
        },
        async 'bot:waitChat'({ id, kind }) {
          const node = bot(id);
          return waitFor(() => node.listChats().find((c) => !kind || c.kind === kind) || null);
        },
        async 'bot:setRole'({ id, chatId, memberName, role }) {
          const node = bot(id);
          const member = node.members(chatId).find((m) => m.name === memberName);
          await node.setRole(chatId, [member.userId], role);
          return null;
        },
        async 'bot:remove'({ id, chatId, memberName }) {
          const node = bot(id);
          const member = await waitFor(() => node.members(chatId).find((m) => m.name === memberName));
          await node.removeMembers(chatId, [member.userId]);
          return null;
        },
        async 'bot:settings'({ id, chatId, settings }) {
          await bot(id).setGroupSettings(chatId, settings);
          return null;
        },
        async 'bot:offline'({ id }) {
          bot(id).transport.close();
          await new Promise((r) => setTimeout(r, 200));
          return null;
        },
        async 'bot:online'({ id }) {
          const node = bot(id);
          node.transport.closed = false;
          node.transport.open();
          await waitFor(() => node.transport.connected);
          return null;
        },
        async 'bot:device'({ id }) {
          return bot(id).device.deviceId;
        },
        async 'relay:dump'() {
          const res = await fetch(`${relayHttp}/api/relay/debug/dump`);
          return res.json();
        },
        async 'bots:stop'() {
          for (const node of bots.values()) node.transport.close();
          bots.clear();
          return null;
        }
      });
    }
  }
});
