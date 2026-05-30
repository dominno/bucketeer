// Cross-reload persistence for download-to-disk tasks. The write target is a
// FileSystemFileHandle, which is structured-cloneable into IndexedDB (localStorage
// is string-only and can't hold it), so an interrupted download survives an app
// close/crash/reload and can be resumed. Everything is best-effort: any IndexedDB
// failure (private mode, quota, unsupported) degrades to "no persistence", never
// breaks a transfer.
const DB_NAME = 'bkt-transfers';
const STORE = 'downloads';

function openDb() {
  return new Promise((resolve) => {
    try {
      if (!self.indexedDB) return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
    return undefined;
  });
}

export async function putTransfer(record) {
  const db = await openDb();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(record);
      t.oncomplete = resolve;
      t.onerror = resolve;
      t.onabort = resolve;
    } catch {
      resolve();
    }
  });
}

export async function deleteTransfer(id) {
  const db = await openDb();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).delete(id);
      t.oncomplete = resolve;
      t.onerror = resolve;
      t.onabort = resolve;
    } catch {
      resolve();
    }
  });
}

export async function allTransfers() {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}
