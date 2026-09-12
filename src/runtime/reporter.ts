import os from 'node:os';
import { type Log, noLog } from './log.ts';

// Fire-and-forget batches to the fleet report service (report/worker.mjs). Same `publish(topic, data, {coalesce})` contract as
// Telemetry: latest value per topic plus a bounded log, trimmed to fleet-relevant fields, one POST per interval. Never awaited
// by gameplay; a failed POST keeps the latest topics for the next interval and drops that batch's log lines. `frame` and the
// far-view `map` columns stay local: the fleet page draws the game's own World Map chunks (operator native map sync) instead.
// Which lines are log lines is the controller's call (its `coalesce` flag); the reporter only trims.
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Public base of this host's live view; the fleet page frames `<stream>/bot/`. Only web origins, no path, credentials or query.
function streamOrigin(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VINTAGE_STORY_STREAM_URL must be an absolute http(s) URL');
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('VINTAGE_STORY_STREAM_URL must be an origin like https://diggy.stream.example.com');
  return url.origin;
}
const pick = (source, keys) => (source ? Object.fromEntries(keys.filter(k => source[k] !== undefined).map(k => [k, source[k]])) : source);
const reduce = {
  frame: () => undefined,
  map: () => undefined,
  scan: s => ({
    match: s?.match,
    kind: s?.kind,
    radius: s?.radius,
    count: s?.objects?.length ?? 0,
    objects: (s?.objects ?? [])
      .slice()
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 12)
      .map(o => pick(o, ['kind', 'code', 'distance', 'quantity'])),
  }),
  state: s =>
    s && {
      ...pick(s, [
        'observedAt',
        'player',
        'world',
        'position',
        'alive',
        'life',
        'vitals',
        'condition',
        'paused',
        'controlReady',
        'mounted',
        'activeSlot',
        'hotbar',
      ]),
      orientation: pick(s.orientation, ['yawDegrees', 'pitchDegrees']),
      motion: pick(s.motion, ['onGround', 'swimming', 'sprinting', 'climbing']),
      control: s.control ? pick(s.control, ['owner', 'active']) : null,
      target: s.target ? pick(s.target, ['kind', 'code', 'name']) : null,
      nearbyEntities: {
        count: s.nearbyEntities?.length ?? 0,
        nearest: (s.nearbyEntities ?? []).slice(0, 6).map(e => pick(e, ['code', 'distance', 'hostile'])),
      },
    },
  navigation: n => pick(n, ['id', 'state', 'reason', 'target', 'remainingCheckpoints', 'replans', 'cachedCells', 'lastReplan', 'evading', 'threat']),
  waypoints: w =>
    w && {
      observedAt: w.observedAt,
      count: w.count,
      waypoints: (w.waypoints ?? []).slice(0, 200).map(m => pick(m, ['guid', 'title', 'icon', 'color', 'pinned', 'position'])),
    },
  goal: g =>
    g && {
      ...pick(g, ['id', 'kind', 'intent', 'state', 'active', 'startedAt', 'finishedAt', 'reason', 'cleanupError']),
      args: bounded(g.args ?? null, g.kind === 'goal_script' ? 12288 : 4096),
      progress: bounded(g.progress ?? null, 4096),
      result: bounded(g.result ?? null, 4096),
    },
};
function bounded(data, limit) {
  const text = JSON.stringify(data);
  return text === undefined || text.length <= limit ? data : { truncated: true, bytes: text.length };
}
// A death followed by a quick respawn can share one oversized batch with many
// ordinary events. Run entries are boundaries, not debug history: keep them
// when reducing that batch or the latest alive snapshot erases the death.
function compactLog(log, tail = 10, runLimit = 8) {
  const keep = new Set([...log.filter(entry => entry.topic === 'run').slice(-runLimit), ...log.slice(-tail)]);
  return log.filter(entry => keep.has(entry));
}
export class Reporter {
  timer: any;
  latest = new Map();
  log = [];
  inflight = null;
  closed = false;
  failures = 0;
  static fromEnv(env = process.env, log: Log = noLog) {
    if (!env.VINTAGE_STORY_REPORT_URL) return null;
    return new Reporter({
      url: env.VINTAGE_STORY_REPORT_URL,
      token: env.VINTAGE_STORY_REPORT_TOKEN ?? '',
      id: env.VINTAGE_STORY_BOT_ID || os.hostname(),
      intervalMs: Number(env.VINTAGE_STORY_REPORT_INTERVAL_MS) || 10000,
      stream: env.VINTAGE_STORY_STREAM_URL,
      log,
    });
  }
  session: Log;
  url: string;
  token: string;
  id: string;
  stream: string | null;
  intervalMs: number;
  maxLog: number;
  maxBytes: number;
  topicBytes: number;
  timeoutMs: number;
  fetch: typeof globalThis.fetch;
  constructor({
    url,
    token,
    id,
    stream = null,
    intervalMs = 10000,
    maxLog = 100,
    maxBytes = 98304,
    topicBytes = 16384,
    timeoutMs = 8000,
    fetch = globalThis.fetch,
    log = noLog as Log,
  }) {
    if (!idPattern.test(id)) throw new Error('VINTAGE_STORY_BOT_ID must match ' + idPattern.source);
    this.session = log;
    Object.assign(this, {
      url: new URL('/api/report', url).href,
      token,
      id,
      stream: streamOrigin(stream),
      intervalMs,
      maxLog,
      maxBytes,
      topicBytes,
      timeoutMs,
      fetch,
    });
    this.timer = setInterval(() => this.flush(), Math.max(1000, intervalMs)).unref();
  }
  publish(topic, data, { coalesce = false } = {}) {
    if (this.closed || !/^[a-z][a-z0-9_]{0,63}$/.test(topic)) return;
    const reduced = topic in reduce ? reduce[topic](data) : data;
    if (reduced === undefined) return;
    const entry = { at: Date.now(), data: bounded(reduced ?? null, this.topicBytes) };
    this.latest.set(topic, entry);
    if (coalesce) return;
    this.log.push({ topic, ...entry });
    while (this.log.length > this.maxLog) this.log.shift();
  }
  flush() {
    if (this.closed || this.inflight || (!this.latest.size && !this.log.length)) return this.inflight;
    const topics = Object.fromEntries(this.latest),
      log = this.log.splice(0);
    this.latest.clear();
    const body = {
      bot: { id: this.id, host: os.hostname(), pid: process.pid, version: '0.1.0', ...(this.stream ? { stream: this.stream } : {}) },
      at: Date.now(),
      topics,
      log,
    };
    let text = JSON.stringify(body);
    if (text.length > this.maxBytes) {
      body.log = compactLog(log);
      text = JSON.stringify(body);
    }
    if (text.length > this.maxBytes) {
      body.log = log.filter(entry => entry.topic === 'run').slice(-8);
      text = JSON.stringify(body);
    }
    if (text.length > this.maxBytes) {
      body.log = log.filter(entry => entry.topic === 'run').slice(-2);
      text = JSON.stringify(body);
    }
    if (text.length > this.maxBytes) {
      body.log = [];
      text = JSON.stringify(body);
    }
    this.inflight = this.fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: text,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
      .then(async response => {
        await response.body?.cancel();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      })
      .then(
        () => {
          if (this.failures) this.session.info('report', 'recovered', { failures: this.failures });
          this.failures = 0;
        },
        error => {
          if (!this.failures++) this.session.info('report', 'failed', { error: error.message });
          for (const [topic, entry] of Object.entries(topics) as [string, any][]) if (!this.latest.has(topic)) this.latest.set(topic, entry);
        },
      )
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
  }
}
