/**
 * A small cache in this isolate's memory, so hot KV reads (the browser
 * session on every request, the share directory on every interview
 * request) happen at most once per key per `ttlMs`. Other isolates keep
 * their own copies, so a change can take up to `ttlMs` to reach them.
 */
export function ttlCache<V>(ttlMs: number, maxEntries = 1_000) {
  const entries = new Map<string, { value: V; expires: number }>();
  const set = (key: string, value: V) => {
    entries.delete(key);
    entries.set(key, { value, expires: Date.now() + ttlMs });
    // The oldest entry goes first once the cache is full.
    if (entries.size > maxEntries)
      entries.delete(entries.keys().next().value as string);
  };
  return {
    async get(key: string, load: () => Promise<V>): Promise<V> {
      const entry = entries.get(key);
      if (entry && entry.expires > Date.now()) return entry.value;
      const value = await load();
      set(key, value);
      return value;
    },
    set,
    delete: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
  };
}
