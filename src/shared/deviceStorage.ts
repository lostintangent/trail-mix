/** This device's storage, or one that forgets on reload where storage is blocked. */
export function deviceStorage(): Storage {
  try {
    return localStorage;
  } catch {
    return forgetful;
  }
}

const memory = new Map<string, string>();
const forgetful: Storage = {
  get length() {
    return memory.size;
  },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => [...memory.keys()][index] ?? null,
  removeItem: (key) => memory.delete(key),
  setItem: (key, value) => memory.set(key, value),
};
