import { createWriteStream, mkdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

// The session log: what the bot did and why, for reading back after the fact.
// One NDJSON line per entry, appended to .runtime/logs/<bot>/<start>.ndjson for
// the life of the process, plus a short mirror on stderr. Every line carries
// {at, level, scope, event} and then the fields the caller gave, with whatever
// context the logger was bound to (a goal's id and kind). The file keeps every
// level; the mirror shows info unless SERAPH_LOG says debug or off. Writes are
// never awaited by gameplay; a file that cannot be written is dropped, once noted.
//
// Scopes: controller (process), mod (requests to the game), tool (requests to the
// controller), goal (lifecycle, progress, what a goal noted), nav (routes and
// frames), brain (decisions and faults), event (the event bus), eye (a sample of
// own state once a second), report (the fleet reporter).
export type Level = 'debug' | 'info';
export type Fields = Record<string, unknown>;
export interface Log {
  info(scope: string, event: string, fields?: Fields): void;
  debug(scope: string, event: string, fields?: Fields): void;
  // The same log with fields added to every line.
  bind(context: Fields): Log;
}

const mirrors = ['debug', 'info', 'off'] as const;
type Mirror = (typeof mirrors)[number];

export class SessionLog implements Log {
  path: string | null = null;
  private stream: ReturnType<typeof createWriteStream> | null = null;
  private failed = false;
  private mirror: Mirror;
  private stderr: { write(line: string): unknown } | null;
  constructor({
    dir = null as string | null,
    bot = 'seraph',
    mirror = (process.env.SERAPH_LOG as Mirror) ?? 'info',
    stderr = process.stderr as { write(line: string): unknown } | null,
    startedAt = new Date(),
  } = {}) {
    this.mirror = mirrors.includes(mirror) ? mirror : 'info';
    this.stderr = stderr;
    if (!dir) return;
    const folder = join(dir, bot.replace(/[^A-Za-z0-9._-]/g, '_'));
    this.path = join(folder, `${startedAt.toISOString().replace(/[:.]/g, '-')}.ndjson`);
    try {
      mkdirSync(folder, { recursive: true });
      this.stream = createWriteStream(this.path, { flags: 'a' });
      this.stream.on('error', error => this.fail(error));
    } catch (error) {
      this.fail(error);
    }
  }
  static fromEnv(env = process.env) {
    return new SessionLog({
      dir: env.VINTAGE_STORY_LOG_DIR ?? '.runtime/logs',
      bot: env.VINTAGE_STORY_BOT_ID || os.hostname(),
      mirror: env.SERAPH_LOG as Mirror,
    });
  }
  info(scope: string, event: string, fields: Fields = {}) {
    this.write('info', scope, event, fields);
  }
  debug(scope: string, event: string, fields: Fields = {}) {
    this.write('debug', scope, event, fields);
  }
  bind(context: Fields): Log {
    return new Bound(this, context);
  }
  write(level: Level, scope: string, event: string, fields: Fields) {
    const at = new Date();
    // The header keys are the log's own; a caller's field of the same name never displaces them.
    const head = { at: at.toISOString(), level, scope, event };
    if (this.stream && !this.failed) this.stream.write(JSON.stringify(Object.assign({ ...head }, fields, head)) + '\n');
    if (this.mirror === 'off' || (level === 'debug' && this.mirror !== 'debug')) return;
    const brief = Object.entries(fields)
      .map(([key, value]) => `${key}=${short(value)}`)
      .filter(pair => !pair.endsWith('='))
      .join(' ');
    this.stderr?.write(`${at.toISOString().slice(11, 23)} ${scope} ${event}${brief ? ` ${brief}` : ''}\n`);
  }
  close() {
    this.stream?.end();
    this.stream = null;
  }
  private fail(error: unknown) {
    if (this.failed) return;
    this.failed = true;
    this.stream = null;
    this.stderr?.write(`session log ${this.path} unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

class Bound implements Log {
  private parent: SessionLog;
  private context: Fields;
  constructor(parent: SessionLog, context: Fields) {
    this.parent = parent;
    this.context = context;
  }
  info(scope: string, event: string, fields: Fields = {}) {
    this.parent.write('info', scope, event, { ...this.context, ...fields });
  }
  debug(scope: string, event: string, fields: Fields = {}) {
    this.parent.write('debug', scope, event, { ...this.context, ...fields });
  }
  bind(context: Fields): Log {
    return new Bound(this.parent, { ...this.context, ...context });
  }
}

// A log that keeps nothing: for tests and for pieces built without a session.
export const noLog: Log = {
  info() {},
  debug() {},
  bind() {
    return noLog;
  },
};

// One readable token per value for the stderr mirror: points as x,y,z, arrays by
// length or as a short list, other objects as their scalar fields.
const short = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.length > 4 || value.some(v => typeof v === 'object') ? `[${value.length}]` : value.join(',');
  const point = value as Fields;
  if ('x' in point && 'z' in point) return `${round(point.x)},${point.y == null ? '' : `${round(point.y)},`}${round(point.z)}`;
  return Object.entries(point)
    .filter(([, v]) => v != null && typeof v !== 'object')
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
};
const round = (value: unknown) => (typeof value === 'number' ? Math.round(value * 10) / 10 : String(value));
