import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { GameClient } from '../game.ts';

type Section = { name: 'terrain' | 'surface' | 'sightings'; values: any[]; encode: (values: any[]) => unknown[][] };
type Save = { identifier: string; revision: number; at: number; sections: Section[]; done: Promise<boolean> };

// The bot's knowledge on disk: what it has seen of a world, kept between
// controller runs and keyed by the game's own save identifier. Terrain,
// far-field surface and remembered blocks are stored; entities and items
// are transient and are not. Written atomically, at most once a minute
// while anything changed, and on shutdown.
export class Knowledge {
  dir: string;
  memories: Pick<GameClient, 'map' | 'surface' | 'sightings'>;
  identifier: string | null = null;
  dirty = false;
  savedAt = 0;
  loaded: Record<string, unknown> | null = null;
  error: string | null = null;
  private revision = 0;
  private writes = Promise.resolve();
  private pending = new Map<string, Save>();
  private onError: (error: Error) => void;
  constructor(dir: string, memories: Knowledge['memories'], onError: (error: Error) => void = () => {}) {
    this.dir = dir;
    this.memories = memories;
    this.onError = onError;
  }
  file(identifier) {
    return join(this.dir, `${encodeURIComponent(identifier)}.json`);
  }
  // Called with every observed world identifier; loads that world's memory
  // the first time it is seen and saves the previous one when it changes.
  enter(identifier) {
    if (!identifier || identifier === this.identifier) return false;
    if (this.identifier) void this.save(true).catch(() => {});
    this.identifier = identifier;
    this.revision++;
    const { map, surface, sightings } = this.memories;
    map.restore([]);
    surface.restore([]);
    sightings.restore([]);
    this.loaded = null;
    try {
      // Returning to a world before its write finishes must restore the captured
      // memory, not an older file. A save always captures before yielding.
      const pending = this.pending.get(identifier);
      if (pending) {
        const data = Object.fromEntries(pending.sections.map(section => [section.name, section.encode(section.values)]));
        map.restore(data.terrain);
        surface.restore(data.surface);
        sightings.restore(data.sightings);
        this.loaded = { cells: map.cells.size, columns: surface.columns.size, sightings: sightings.records.size, savedAt: pending.at, pending: true };
      } else if (existsSync(this.file(identifier))) {
        const data = JSON.parse(readFileSync(this.file(identifier), 'utf8'));
        map.restore(data.terrain ?? []);
        surface.restore(data.surface ?? []);
        sightings.restore(data.sightings ?? []);
        this.loaded = { cells: map.cells.size, columns: surface.columns.size, sightings: sightings.records.size, savedAt: data.savedAt };
      }
    } catch (error) {
      this.loaded = { error: error.message };
    }
    this.dirty = this.pending.has(identifier);
    this.savedAt = Date.now();
    return true;
  }
  touch() {
    this.dirty = true;
    this.revision++;
  }
  save(force = false, now = Date.now()): Promise<boolean> {
    if (!this.identifier || (!this.dirty && !force) || (!force && now - this.savedAt < 60000)) return Promise.resolve(false);
    const previous = this.pending.get(this.identifier);
    if (previous?.revision === this.revision) return previous.done;
    const { map, surface, sightings } = this.memories;
    // Cells/columns are replaced by observations. Keep their references at this
    // instant; encoding and writing run in small batches, never one giant JSON.
    const job: Save = {
      identifier: this.identifier,
      revision: this.revision,
      at: now,
      sections: [
        { name: 'terrain', values: [...map.cells.values()], encode: rows => map.export(rows) },
        { name: 'surface', values: [...surface.columns.values()], encode: rows => surface.export(rows) },
        { name: 'sightings', values: sightings.remembered('block'), encode: rows => sightings.export(rows) },
      ],
      done: undefined,
    };
    job.done = this.writes.then(async () => {
      // Coalesce snapshots queued for the same world, but never overlap writes.
      if (this.pending.get(job.identifier) !== job) return false;
      try {
        await this.write(job);
        if (this.identifier === job.identifier) {
          if (this.revision === job.revision) this.dirty = false;
          this.savedAt = job.at;
        }
        this.error = null;
        return true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.onError(error instanceof Error ? error : new Error(this.error));
        throw error;
      } finally {
        if (this.pending.get(job.identifier) === job) this.pending.delete(job.identifier);
      }
    });
    this.pending.set(job.identifier, job);
    this.writes = job.done.then(
      () => {},
      () => {},
    );
    return job.done;
  }
  private async write(job: Save) {
    const target = this.file(job.identifier),
      temporary = `${target}.${process.pid}.tmp`;
    await mkdir(this.dir, { recursive: true });
    try {
      const file = await open(temporary, 'w');
      try {
        await file.writeFile(JSON.stringify({ version: 1, identifier: job.identifier, savedAt: job.at }).slice(0, -1));
        for (const section of job.sections) {
          await file.writeFile(`,"${section.name}":[`);
          for (let offset = 0; offset < section.values.length; offset += 256) {
            const rows = section.encode(section.values.slice(offset, offset + 256));
            await file.writeFile((offset ? ',' : '') + JSON.stringify(rows).slice(1, -1));
          }
          await file.writeFile(']');
        }
        await file.writeFile('}');
      } finally {
        await file.close();
      }
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  status() {
    return {
      identifier: this.identifier,
      dirty: this.dirty,
      savedAt: this.savedAt,
      loaded: this.loaded,
      saving: this.pending.size > 0,
      error: this.error,
      cells: this.memories.map.cells.size,
      columns: this.memories.surface.columns.size,
      sightings: this.memories.sightings.records.size,
    };
  }
}
