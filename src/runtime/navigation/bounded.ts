// A map of remembered things that stays bounded. Setting a key moves it to the end, so the
// least recently seen entry is the first one to go when the map is over capacity; forgetting
// by age is a sweep the owner runs at most once per interval, never on every write. Terrain
// cells, surface columns and sightings all keep their memory this way.
export class Bounded<V> extends Map<string, V> {
  capacity: number;
  sweepMs: number;
  sweptAt = 0;
  constructor(capacity: number, sweepMs = 60000) {
    super();
    this.capacity = capacity;
    this.sweepMs = sweepMs;
  }
  set(id: string, value: V) {
    super.delete(id);
    return super.set(id, value);
  }
  // Drop what has expired, at most once per sweep interval, then trim to capacity oldest
  // first. The owner's forget runs for each entry dropped, so derived indexes stay in step.
  bound(now: number, expired: (value: V) => boolean, forget: (id: string) => void = id => this.delete(id)) {
    if (now - this.sweptAt >= this.sweepMs) {
      this.sweptAt = now;
      for (const [id, value] of this) if (expired(value)) forget(id);
    }
    while (this.size > this.capacity) forget(this.keys().next().value as string);
  }
}
