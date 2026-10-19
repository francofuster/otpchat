// Almacen en memoria con la misma interfaz que el de IndexedDB. Lo usan los tests de Node y
// los nodos "bot" de los e2e.
export function createMemoryStore() {
  const kv = new Map();
  const entries = new Map();
  return {
    kv: {
      async get(key) { return kv.get(key); },
      async set(key, value) { kv.set(key, value); },
      async del(key) { kv.delete(key); },
      async keys(prefix = '') { return [...kv.keys()].filter((k) => k.startsWith(prefix)); }
    },
    entries: {
      async put(entry) { entries.set(entry.id, entry); },
      async list(chatId) { return [...entries.values()].filter((e) => e.chat === chatId); },
      async remove(id) { entries.delete(id); },
      async removeChat(chatId) { for (const [id, e] of entries) if (e.chat === chatId) entries.delete(id); }
    },
    async clear() { kv.clear(); entries.clear(); }
  };
}
