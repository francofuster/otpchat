// Relay real en un puerto libre y nodos OTPChat con almacen en memoria, para probar el
// sistema distribuido completo dentro de un solo proceso.
import { createServer } from 'node:http';
import { createRelay } from '../../server/relay.js';
import { OtpNode } from '../../src/core/node.js';
import { RelayClient } from '../../src/core/relay-client.js';
import { createMemoryStore } from '../../src/core/memory-store.js';

export async function startRelay(options = {}) {
  const relay = createRelay(options);
  const server = createServer((req, res) => res.end('ok'));
  server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/relay`;
  return {
    relay,
    url,
    async close() {
      relay.close();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

export async function makeNode(url, name, { store = createMemoryStore(), waitMs = 4000 } = {}) {
  const transport = new RelayClient({ url });
  const node = new OtpNode({ store, transport, origin: 'http://localhost:5900', waitMs });
  await node.init();
  if (name && !node.hasIdentity()) await node.createIdentity(name);
  await node.connect();
  return node;
}

export function until(check, { timeout = 5000, every = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch {}
      if (Date.now() - started > timeout) return reject(new Error('timeout esperando la condicion'));
      setTimeout(tick, every);
    };
    tick();
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function contactPair(url, a = 'Ana', b = 'Beto') {
  const na = await makeNode(url, a);
  const nb = await makeNode(url, b);
  const { link } = await na.createInvite('contact');
  const chatId = await nb.acceptInvite(link.split('#/i/')[1]);
  await until(() => na.chats.has(chatId));
  return { na, nb, chatId };
}

export async function groupWith(url, count) {
  const owner = await makeNode(url, 'Dueño');
  const groupId = await owner.createGroup('Equipo');
  const members = [];
  for (let i = 0; i < count; i++) {
    const member = await makeNode(url, `Miembro${i}`);
    const { link } = await owner.createInvite('group', groupId);
    await member.acceptInvite(link.split('#/i/')[1]);
    members.push(member);
  }
  for (const member of members) await until(() => member.members(groupId).length === count + 1);
  return { owner, members, groupId };
}

export function closeAll(...nodes) {
  for (const node of nodes.flat(Infinity)) node?.transport?.close();
}
