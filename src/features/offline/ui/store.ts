/**
 * The installed app's kept snapshots, in IndexedDB: one record per snapshot, written as it changes
 * and read when the app first asks for it.
 */

const DATABASE = 'trail-mix';
const STORE = 'snapshots';

let opened: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (!opened) {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    opened = settled(request);
  }
  return opened;
}

async function inStore<T>(
  mode: IDBTransactionMode,
  act: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return settled(act((await database()).transaction(STORE, mode).objectStore(STORE)));
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
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
  // Keys and values read in one transaction, which lists both in the keys' order.
  entries: async (): Promise<[string, unknown][]> => {
    const store = (await database()).transaction(STORE).objectStore(STORE);
    const [keys, values] = await Promise.all([
      settled(store.getAllKeys()),
      settled(store.getAll()),
    ]);
    return keys.map((key, at) => [key as string, values[at]]);
  },
  clear: async () => {
    await inStore('readwrite', (store) => store.clear());
  },
};
