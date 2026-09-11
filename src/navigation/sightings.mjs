// Entities, ground items and watched blocks the camera has seen or the ears
// could plausibly hear. The mod returns what is in view this instant with
// every sense; this memory marks those visible, keeps what left the view as
// last seen for a while, and forgets the rest. Absent means unknown.
export const rememberMs = { entity: 20000, item: 60000, block: 300000 };

export class SightingsMemory {
  records = new Map(); now = 0; capacity = 8192;
  apply(snapshot) {
    if (!snapshot) return 0;
    this.now = snapshot.clock ?? this.now;
    for (const record of this.records.values()) record.visible = false;
    for (const [key, kind, code, x, y, z, how, at, extra] of snapshot.sightings ?? [])
      this.records.set(key, { key, kind, code, point: { x, y, z }, how, at: at ?? this.now, extra: extra ?? null, visible: true });
    this.prune();
    return snapshot.sightings?.length ?? 0;
  }
  // observe reports entities seen this instant without a snapshot clock;
  // fold them in so memory stays current between sense reads.
  observeEntities(entities = []) {
    for (const record of this.records.values()) if (record.kind === 'entity') record.visible = false;
    for (const entity of entities) {
      const at = entity.seenAt ?? this.now;
      this.now = Math.max(this.now, at);
      this.records.set(entity.key, { key: entity.key, kind: 'entity', code: entity.code, point: entity.point, how: entity.how ?? 'seen', at, extra: null, visible: true });
    }
    this.prune();
  }
  prune() {
    for (const [key, record] of this.records)
      if (!record.visible && this.now - record.at > (rememberMs[record.kind] ?? 60000)) this.records.delete(key);
    while (this.records.size > this.capacity) this.records.delete(this.records.keys().next().value);
  }
  visible(kind = null) {
    return [...this.records.values()].filter(record => record.visible && (kind === null || record.kind === kind));
  }
  remembered(kind = null) {
    return [...this.records.values()].filter(record => kind === null || record.kind === kind);
  }
  // What threat logic sees: entities visible now or seen within the memory window, at their last known point.
  entities(position = null) {
    return this.remembered('entity').map(record => ({ key: record.key, code: record.code, point: record.point, how: record.how,
      seenAt: record.at, visible: record.visible, ageMs: Math.max(0, this.now - record.at),
      distance: position ? +Math.hypot(record.point.x - position.x, record.point.y - position.y, record.point.z - position.z).toFixed(2) : undefined }))
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  }
}
