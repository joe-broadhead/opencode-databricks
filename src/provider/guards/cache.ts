/**
 * The small cache every Unity Catalog look-up behind the read path uses (design §5.4): "Resolution results are cached
 * per account for 5 minutes, and only ever for the read path's decision."
 *
 * - The key names the account and the object, so two accounts sharing a process never see each other's answers.
 * - A miss is cached too (`undefined` is a value), so a name Unity Catalog does not return is asked about once.
 * - Time comes from the call's clock, so a test moves time instead of waiting.
 * - An entry is dropped when its answer was an error other than not-found: a refused or failed call is not a fact.
 */
export const RESOLUTION_TTL_MS = 5 * 60_000

export interface TtlCache<V> {
  get(key: string): { readonly hit: true; readonly value: V } | { readonly hit: false }
  set(key: string, value: V): void
  clear(): void
  readonly size: number
}

export function ttlCache<V>(ttlMs: number, now: () => number): TtlCache<V> {
  const entries = new Map<string, { readonly at: number; readonly value: V }>()
  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return { hit: false }
      if (now() - entry.at > ttlMs) {
        entries.delete(key)
        return { hit: false }
      }
      return { hit: true, value: entry.value }
    },
    set(key, value) {
      entries.set(key, { at: now(), value })
    },
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}
