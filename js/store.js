// Customer records and booking requests, kept in this browser only
// (IndexedDB). They never enter the shared state; export is a JSON download.

const DB_NAME = 'browcanvas';
const DB_VER = 1;
const STORES = ['customers', 'leads'];

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const put = (store, rec) => tx(store, 'readwrite', (s) => s.put(rec));
export const remove = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));
export async function list(store) {
  const all = (await tx(store, 'readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
}
