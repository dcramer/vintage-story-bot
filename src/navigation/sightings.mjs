// Entities, ground items and watched blocks the camera has seen or the ears
// could plausibly hear, streamed by the mod beside terrain deltas. A gone row
// means the mod has not confirmed the sighting for its lifetime; the record
// stays a while as "last seen" and then is forgotten. Absent means unknown.
export class SightingsMemory {
  records = new Map(); session = null; cursor = 0; now = 0; capacity = 8192;
  static lifetime(kind) { return kind === 'block' ? 300000 : 60000; }
  apply(batch) {
    if (!batch) return 0;
    if (batch.reset || batch.session !== this.session) this.records.clear();
    this.session = batch.session; this.cursor = batch.cursor; this.now = batch.clock;
    for (const [key, kind, code, x, y, z, how, at, extra] of batch.sightings ?? []) {
      if (kind === null || kind === undefined) {
        const prior = this.records.get(key);
        if (prior) prior.visible = false;
        continue;
      }
      this.records.set(key, { key, kind, code, point: { x, y, z }, how, at: at ?? this.now, extra: extra ?? null, visible: true });
    }
    for (const [key, record] of this.records)
      if (!record.visible && this.now - record.at > SightingsMemory.lifetime(record.kind)) this.records.delete(key);
    while (this.records.size > this.capacity) this.records.delete(this.records.keys().next().value);
    return batch.sightings?.length ?? 0;
  }
  visible(kind = null) {
    return [...this.records.values()].filter(record => record.visible && (kind === null || record.kind === kind));
  }
  remembered(kind = null) {
    return [...this.records.values()].filter(record => kind === null || record.kind === kind);
  }
}
