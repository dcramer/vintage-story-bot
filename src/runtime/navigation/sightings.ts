// Entities, ground items and watched blocks the camera has seen or the ears
// could plausibly hear. The mod returns what is in view this instant with
// every sense; this memory marks those visible, keeps what left the view as
// last seen for a while, and forgets the rest. Absent means unknown. Blocks
// are part of the bot's lasting knowledge; entities and items are not.
import { distance, lookAt } from './terrain.ts';

export const rememberMs = { entity: 20000, item: 60000, block: 7 * 24 * 60 * 60 * 1000 };
// The cell a block sighting names: keys are block:<dimension>:<x>:<y>:<z>:<code>.
export const cellOfKey = key => {
  const m = /^block:\d+:(-?\d+):(-?\d+):(-?\d+):/.exec(key ?? '');
  return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
};

export class SightingsMemory {
  records = new Map();
  now = 0;
  wall = 0;
  capacity = 32768;
  apply(snapshot, wall = Date.now()) {
    if (!snapshot) return [];
    this.now = snapshot.clock ?? this.now;
    this.wall = wall;
    for (const record of this.records.values()) record.visible = false;
    const fresh = [];
    for (const [key, kind, code, x, y, z, how, at, extra] of snapshot.sightings ?? []) {
      const record = { key, kind, code, point: { x, y, z }, how, at: at ?? this.now, seenAt: wall, extra: extra ?? null, visible: true };
      if (!this.records.has(key)) fresh.push(record);
      this.records.set(key, record);
    }
    this.prune();
    return fresh;
  }
  // observe reports entities seen this instant without a snapshot clock;
  // fold them in so memory stays current between sense reads.
  observeEntities(entities = [], wall = Date.now()) {
    for (const record of this.records.values()) if (record.kind === 'entity') record.visible = false;
    this.wall = wall;
    const fresh = [];
    for (const entity of entities) {
      const at = entity.seenAt ?? this.now;
      this.now = Math.max(this.now, at);
      if (!this.records.has(entity.key)) fresh.push(entity);
      this.records.set(entity.key, {
        key: entity.key,
        kind: 'entity',
        code: entity.code,
        point: entity.point,
        how: entity.how ?? 'seen',
        at,
        seenAt: wall,
        extra: null,
        visible: true,
      });
    }
    this.prune();
    return fresh;
  }
  prune() {
    const wall = this.wall || Date.now();
    for (const [key, record] of this.records)
      if (!record.visible && wall - (record.seenAt ?? wall) > (rememberMs[record.kind] ?? 60000)) this.records.delete(key);
    while (this.records.size > this.capacity) this.records.delete(this.records.keys().next().value);
  }
  forget(key) {
    this.records.delete(key);
  }
  visible(kind = null) {
    return [...this.records.values()].filter(record => record.visible && (kind === null || record.kind === kind));
  }
  remembered(kind = null) {
    return [...this.records.values()].filter(record => kind === null || record.kind === kind);
  }
  // What threat logic sees: entities visible now or seen within the memory window, at their last known point.
  entities(position = null) {
    const wall = this.wall || Date.now();
    return this.remembered('entity')
      .map(record => ({
        key: record.key,
        code: record.code,
        point: record.point,
        how: record.how,
        seenAt: record.at,
        visible: record.visible,
        ageMs: Math.max(0, wall - (record.seenAt ?? wall)),
        distance: position
          ? +Math.hypot(record.point.x - position.x, record.point.y - position.y, record.point.z - position.z).toFixed(2)
          : undefined,
      }))
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  }
  // The watched block remembered at a cell, if any.
  blockAt(cell) {
    for (const record of this.records.values()) {
      if (record.kind !== 'block') continue;
      const at = cellOfKey(record.key);
      if (at && at.x === cell.x && at.y === cell.y && at.z === cell.z) return record;
    }
    return null;
  }
  // One sighting as goals and agents read it: where it is from the eye, whether
  // it is in view now or only remembered, and whether it is within reach.
  describe(record, eye, reach = 4.5) {
    const far = distance(eye, record.point),
      wall = this.wall || Date.now();
    return {
      kind: record.kind,
      key: record.key,
      code: record.code,
      point: record.point,
      distance: +far.toFixed(2),
      quantity: record.extra?.quantity ?? null,
      access: record.extra?.access ?? null,
      facts: record.extra?.facts ?? null,
      how: record.how,
      source: far <= 8 ? 'nearby' : 'sight',
      visible: record.visible,
      ageMs: record.visible ? 0 : Math.max(0, wall - (record.seenAt ?? wall)),
      withinPickingRange: far <= reach,
      look: lookAt(eye, record.point),
    };
  }
  // What the eye has confirmed around a point, nearest first: in view now, and
  // (unless visible only) what left the view but is still remembered.
  view(eye, { matches = [], kind = null, radius = 64, remembered = true, reach = 4.5 }: any = {}) {
    const wanted = matches.map(m => m.toLowerCase());
    return (remembered ? this.remembered(kind) : this.visible(kind))
      .filter(record => !wanted.length || wanted.some(m => record.code.toLowerCase().includes(m)))
      .map(record => this.describe(record, eye, reach))
      .filter(object => object.distance <= radius)
      .sort((a, b) => a.distance - b.distance);
  }
  // Persistence: remembered blocks only.
  export() {
    return this.remembered('block').map(r => [r.key, r.code, r.point.x, r.point.y, r.point.z, r.extra, r.seenAt]);
  }
  restore(rows) {
    this.records.clear();
    for (const [key, code, x, y, z, extra, seenAt] of rows)
      this.records.set(key, { key, kind: 'block', code, point: { x, y, z }, how: 'seen', at: 0, seenAt, extra: extra ?? null, visible: false });
  }
}
