/**
 * The installed app's kept snapshots, in IndexedDB: one record per snapshot, written as it changes
 * and read when the app first asks for it.
 */

const DATABASE = 'trail-mix';
const STORE = 'snapshots';

let opened: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB would not open.'));
  });
  return opened;
}

async function inStore<T>(
  mode: IDBTransactionMode,
  act: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const store = (await database()).transaction(STORE, mode).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const request = act(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed.'));
  });
}

/** The storage TanStack's persister asks for, over IndexedDB. */
export const snapshots = {
  getItem: (key: string) => inStore<unknown>('readonly', (store) => store.get(key)),
  setItem: async (key: string, value: unknown) => {
    await inStore('readwrite', (store) => store.put(value, key));
  },
  removeItem: async (key: string) => {
    await inStore('readwrite', (store) => store.delete(key));
  },
  entries: async (): Promise<[string, unknown][]> => {
    const store = (await database()).transaction(STORE, 'readonly').objectStore(STORE);
    return new Promise((resolve, reject) => {
      const entries: [string, unknown][] = [];
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(entries);
        entries.push([cursor.key as string, cursor.value]);
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB failed.'));
    });
  },
  clear: async () => {
    await inStore('readwrite', (store) => store.clear());
  },
};
