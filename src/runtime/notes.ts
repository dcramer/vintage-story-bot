import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A brain's notes on disk: the decisions it made about a world (home, chests)
// kept between controller runs, one file per world, player and brain next to
// the knowledge files. Only what the brain hands over is kept; what it saw
// lives in Knowledge and what only matters this session stays in memory.
// Written atomically when the notes change, at most every few seconds, and
// on stop.
export const NOTES_SAVE_MS = 5000;

export class Notes {
  dir: string | null;
  brain: string;
  key: string | null = null;
  data: unknown = null;
  private serialized: string | null = null;
  savedAt = 0;
  loaded: Record<string, unknown> | null = null;
  constructor(dir: string | null, brain: string) {
    this.dir = dir;
    this.brain = brain;
  }
  file(key: string) {
    return join(this.dir ?? '', 'notes', `${key}.${this.brain}.json`);
  }
  // Called with every observed world and player: loads that pair's notes the
  // first time it is seen and saves the previous pair's when it changes.
  // True when notes were (re)loaded and the brain's memory must start afresh from them.
  enter(world?: string | null, player?: string | null) {
    if (!world) return false;
    const key = `${encodeURIComponent(world)}.${encodeURIComponent(player ?? 'player')}`;
    if (key === this.key) return false;
    if (this.key) this.save(true);
    this.key = key;
    this.data = null;
    this.serialized = null;
    this.loaded = null;
    if (this.dir) {
      try {
        if (existsSync(this.file(key))) {
          const file = JSON.parse(readFileSync(this.file(key), 'utf8'));
          this.data = file.notes ?? null;
          this.serialized = JSON.stringify(this.data);
          this.loaded = { savedAt: file.savedAt };
        }
      } catch (error) {
        this.loaded = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.savedAt = Date.now();
    return true;
  }
  // The brain's notes as of now; they reach disk on the next save if they changed.
  set(data: unknown) {
    this.data = data;
  }
  save(force = false, now = Date.now()) {
    if (!this.dir || !this.key) return false;
    const serialized = JSON.stringify(this.data ?? null);
    if (serialized === this.serialized) return false;
    if (!force && now - this.savedAt < NOTES_SAVE_MS) return false;
    const target = this.file(this.key),
      temporary = `${target}.${process.pid}.tmp`;
    mkdirSync(join(this.dir, 'notes'), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ version: 1, brain: this.brain, savedAt: now, notes: this.data ?? null }));
    renameSync(temporary, target);
    this.serialized = serialized;
    this.savedAt = now;
    return true;
  }
  status() {
    return {
      file: this.key && this.dir ? this.file(this.key) : null,
      savedAt: this.savedAt,
      loaded: this.loaded,
      pending: !!this.key && !!this.dir && JSON.stringify(this.data ?? null) !== this.serialized,
    };
  }
}
