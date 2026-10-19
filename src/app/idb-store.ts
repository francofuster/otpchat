// Almacen del nodo en IndexedDB: misma interfaz que src/core/memory-store.js. Guarda las
// entradas de cada chat por separado (un audio no obliga a reescribir el historial entero) y
// acepta CryptoKey no exportables, que IndexedDB clona sin sacarlas del navegador.
const DB_NAME = 'otpchat-node';
const DB_VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('entries')) {
        const entries = db.createObjectStore('entries', { keyPath: 'id' });
        entries.createIndex('chat', 'chat');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function createIdbStore() {
  const db = await openDb();
  const tx = (name: string, mode: IDBTransactionMode = 'readonly') => db.transaction(name, mode).objectStore(name);
  return {
    kv: {
      get: (key: string) => request(tx('kv').get(key)),
      set: async (key: string, value: unknown) => { await request(tx('kv', 'readwrite').put(value, key)); },
      del: async (key: string) => { await request(tx('kv', 'readwrite').delete(key)); },
      keys: async (prefix = '') => ((await request(tx('kv').getAllKeys())) as string[]).filter((k) => String(k).startsWith(prefix))
    },
    entries: {
      put: async (entry: { id: string }) => { await request(tx('entries', 'readwrite').put(entry)); },
      list: (chatId: string) => request(tx('entries').index('chat').getAll(chatId)),
      remove: async (id: string) => { await request(tx('entries', 'readwrite').delete(id)); },
      removeChat: async (chatId: string) => {
        const store = tx('entries', 'readwrite');
        const keys = await request(store.index('chat').getAllKeys(chatId));
        await Promise.all(keys.map((key) => request(store.delete(key))));
      }
    },
    async clear() {
      await request(tx('kv', 'readwrite').clear());
      await request(tx('entries', 'readwrite').clear());
    }
  };
}
