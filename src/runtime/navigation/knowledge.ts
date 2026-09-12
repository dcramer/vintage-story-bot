import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The bot's knowledge on disk: what it has seen of a world, kept between
// controller runs and keyed by the game's own save identifier. Terrain,
// far-field surface and remembered blocks are stored; entities and items
// are transient and are not. Written atomically, at most once a minute
// while anything changed, and on shutdown.
export class Knowledge {
  dir: any;
  memories: any;
  identifier = null;
  dirty = false;
  savedAt = 0;
  loaded = null;
  constructor(dir, memories) {
    this.dir = dir;
    this.memories = memories;
  }
  file(identifier) {
    return join(this.dir, `${encodeURIComponent(identifier)}.json`);
  }
  // Called with every observed world identifier; loads that world's memory
  // the first time it is seen and saves the previous one when it changes.
  enter(identifier) {
    if (!identifier || identifier === this.identifier) return false;
    if (this.identifier) this.save(true);
    this.identifier = identifier;
    const { map, surface, sightings } = this.memories;
    map.restore([]);
    surface.restore([]);
    sightings.restore([]);
    this.loaded = null;
    try {
      if (existsSync(this.file(identifier))) {
        const data = JSON.parse(readFileSync(this.file(identifier), 'utf8'));
        map.restore(data.terrain ?? []);
        surface.restore(data.surface ?? []);
        sightings.restore(data.sightings ?? []);
        this.loaded = { cells: map.cells.size, columns: surface.columns.size, sightings: sightings.records.size, savedAt: data.savedAt };
      }
    } catch (error) {
      this.loaded = { error: error.message };
    }
    this.dirty = false;
    this.savedAt = Date.now();
    return true;
  }
  touch() {
    this.dirty = true;
  }
  save(force = false, now = Date.now()) {
    if (!this.identifier || (!this.dirty && !force) || (!force && now - this.savedAt < 60000)) return false;
    const { map, surface, sightings } = this.memories;
    const data = {
      version: 1,
      identifier: this.identifier,
      savedAt: now,
      terrain: map.export(),
      surface: surface.export(),
      sightings: sightings.export(),
    };
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(this.identifier),
      temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data));
    renameSync(temporary, target);
    this.dirty = false;
    this.savedAt = now;
    return true;
  }
  status() {
    return {
      identifier: this.identifier,
      dirty: this.dirty,
      savedAt: this.savedAt,
      loaded: this.loaded,
      cells: this.memories.map.cells.size,
      columns: this.memories.surface.columns.size,
      sightings: this.memories.sightings.records.size,
    };
  }
}
