// A Map that keeps only its most recently used entries (reading or writing one counts as a use),
// for caches that would otherwise grow for as long as the page is open.
export class RecentMap<K, V> extends Map<K, V> {
  constructor(private limit: number) {
    super()
  }
  override get(key: K) {
    const value = super.get(key)
    if (value !== undefined) {
      super.delete(key)
      super.set(key, value)
    }
    return value
  }
  override set(key: K, value: V) {
    super.delete(key)
    super.set(key, value)
    for (const oldest of this.keys()) {
      if (this.size <= this.limit) break
      super.delete(oldest)
    }
    return this
  }
}
