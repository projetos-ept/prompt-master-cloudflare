const DB_NAME = 'prompt-master-v1';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('prompts')) db.createObjectStore('prompts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(store, mode, work) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const target = tx.objectStore(store);
    let result;
    try { result = work(target); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
  });
}

export const localDB = {
  all: (store) => transaction(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => transaction(store, 'readonly', (s) => s.get(key)),
  put: (store, value) => transaction(store, 'readwrite', (s) => s.put(value)),
  delete: (store, key) => transaction(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => transaction(store, 'readwrite', (s) => s.clear()),
};
