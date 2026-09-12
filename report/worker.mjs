import { DurableObject } from 'cloudflare:workers';
import { markRespawnBreaks } from './trail.mjs';

// Fleet state service. Bots POST /api/report batches `{bot:{id,...},topics:{[topic]:{at,data}},log:[{topic,at,data}]}`;
// the single SeraphFleet object keeps the latest value per bot/topic plus a bounded log, evicts bots unseen for RETENTION_HOURS,
// and pushes updates to browser WebSockets (`snapshot|bot|nativemap|gone`; a report sends the whole bot record, a native map sync
// only its `nativeMap` summary). Reads (API and the static SPA in dist/, see app/) are open; writes require REPORT_TOKEN.
const topicRe = /^[a-z][a-z0-9_]{0,63}$/, idRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const maxBody = 131072, maxMapImage = 92160, maxNativeBatch = 18, maxNativeChunks = 16384;
const maxLog = 200, maxTrail = 540;
const maxMeta = 128, persistMs = 30000, sweepMs = 900000;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const bearer = request => { const value = request.headers.get('authorization') ?? ''; return value.startsWith('Bearer ') ? value.slice(7) : ''; };
function equal(given, expected) {
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(expected);
  return a.byteLength === b.byteLength && b.byteLength > 0 && crypto.subtle.timingSafeEqual(a, b);
}
const number = (value, fallback) => Number.isFinite(value) ? value : fallback;
const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.z);

// Keep a compact recent path in the fleet record. Reporters still send only
// what the player's client observed; this merely retains successive own
// positions so the dashboard can show movement and goal context over time.
function appendTrail(bot, stateEntry, now) {
  const position = stateEntry?.data?.position;
  if (!finitePoint(position)) return false;
  const goal = bot.topics.goal?.data, progress = goal?.progress;
  const sample = {
    at: number(stateEntry.at, now), x: position.x, y: Number.isFinite(position.y) ? position.y : null,
    z: position.z, dimension: Number.isFinite(position.dimension) ? position.dimension : 0,
    goal: goal?.id ? String(goal.id).slice(0, 64) : null,
    kind: typeof goal?.kind === 'string' ? goal.kind.slice(0, 64) : null,
    intent: typeof goal?.intent === 'string' ? goal.intent.slice(0, 240) : null,
    subgoal: typeof progress?.subgoal?.kind === 'string' ? progress.subgoal.kind.slice(0, 64) : null,
    phase: typeof progress?.phase === 'string' ? progress.phase.slice(0, 64) : null,
  };
  const trail = bot.trail ??= [], last = trail.at(-1);
  const moved = last ? Math.hypot(sample.x - last.x, sample.z - last.z) : Infinity;
  if (last && sample.dimension === last.dimension && sample.goal === last.goal && moved < .5 && sample.at - last.at < 60000) return false;
  trail.push(sample);
  while (trail.length > maxTrail) trail.shift();
  return true;
}

const mapPoint = value => Array.isArray(value) && value.length === 2 && value.every(item => Number.isFinite(item) && item >= -8 && item <= 8)
  ? value : null;
function mapCapture(body, now) {
  if (!body || typeof body !== 'object' || typeof body.id !== 'string' || !idRe.test(body.id) ||
    !Number.isInteger(body.width) || body.width < 320 || body.width > 4096 || !Number.isInteger(body.height) || body.height < 180 || body.height > 2160 ||
    typeof body.image !== 'string' || body.image.length > 123000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.image)) return null;
  let bytes;
  try { bytes = Uint8Array.from(atob(body.image), character => character.charCodeAt(0)); } catch { return null; }
  if (bytes.byteLength > maxMapImage || bytes.byteLength < 16 || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' ||
    String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') return null;
  const view = body.view, here = mapPoint(view?.here), east100 = mapPoint(view?.east100), south100 = mapPoint(view?.south100);
  const world = view?.world;
  return { id: body.id, bytes, meta: { at: now, width: body.width, height: body.height,
    view: here && east100 && south100 && Number.isFinite(world?.x) && Number.isFinite(world?.z) && Number.isInteger(world?.dimension)
      ? { world: { x: world.x, z: world.z, dimension: world.dimension }, here, east100, south100 } : null } };
}

function base64Bytes(value, length) {
  if (typeof value !== 'string' || value.length > Math.ceil(length / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    return bytes.byteLength === length ? bytes : null;
  } catch { return null; }
}

function nativeMapBatch(body, now) {
  if (!body || typeof body !== 'object' || !idRe.test(body.id ?? '') || !idRe.test(body.world ?? '') ||
    !Array.isArray(body.chunks) || body.chunks.length > maxNativeBatch) return null;
  const chunks = [];
  for (const row of body.chunks) {
    const pixels = Array.isArray(row) ? base64Bytes(row[2], 32 * 32 * 4) : null;
    if (!pixels || !Number.isInteger(row[0]) || !Number.isInteger(row[1]) || Math.abs(row[0]) >= 67108864 || Math.abs(row[1]) >= 67108864) return null;
    chunks.push({ x: row[0], z: row[1], pixels });
  }
  const players = [];
  if (body.players != null) {
    if (!Array.isArray(body.players) || body.players.length > 64) return null;
    for (const player of body.players) {
      if (!player || typeof player.name !== 'string' || !player.name.trim() || !Number.isFinite(player.x) || !Number.isFinite(player.z)) return null;
      players.push({ name: player.name.trim().slice(0, 64), x: player.x, z: player.z,
        yawDegrees: number(player.yawDegrees, 0), self: player.self === true });
    }
  }
  return { id: body.id, world: body.world, chunks, players, complete: body.complete === true, at: now };
}

function bytesBase64(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let offset = 0; offset < data.byteLength; offset += 8192)
    binary += String.fromCharCode(...data.slice(offset, offset + 8192));
  return btoa(binary);
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const fleet = env.FLEET.get(env.FLEET.idFromName('fleet'));
    if (url.pathname === '/api/report') {
      if (request.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
      if (!env.REPORT_TOKEN || !equal(bearer(request), env.REPORT_TOKEN)) return json(401, { ok: false, error: 'Bad report token' });
      if (Number(request.headers.get('content-length')) > maxBody) return json(413, { ok: false, error: `Body over ${maxBody} bytes` });
      return fleet.fetch(request);
    }
    if (url.pathname === '/api/map-image') {
      if (request.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
      if (!env.REPORT_TOKEN || !equal(bearer(request), env.REPORT_TOKEN)) return json(401, { ok: false, error: 'Bad report token' });
      if (Number(request.headers.get('content-length')) > maxBody) return json(413, { ok: false, error: `Body over ${maxBody} bytes` });
      return fleet.fetch(request);
    }
    if (url.pathname === '/api/native-map') {
      if (request.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
      if (!env.REPORT_TOKEN || !equal(bearer(request), env.REPORT_TOKEN)) return json(401, { ok: false, error: 'Bad report token' });
      if (Number(request.headers.get('content-length')) > maxBody) return json(413, { ok: false, error: `Body over ${maxBody} bytes` });
      return fleet.fetch(request);
    }
    if (request.method !== 'GET') return json(405, { ok: false, error: 'GET only' });
    if (url.pathname === '/api/state' || url.pathname === '/api/ws' || url.pathname === '/api/maps' || url.pathname.startsWith('/api/maps/') ||
      url.pathname.startsWith('/api/map-image/') || url.pathname.startsWith('/api/native-map/')) return fleet.fetch(request);
    if (url.pathname.startsWith('/api/')) return json(404, { ok: false, error: 'Unknown route' });
    return env.ASSETS.fetch(request);
  },
};

export class SeraphFleet extends DurableObject {
  bots = new Map(); dirty = new Set(); persisted = new Map();
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // The surface-column atlas older reporters filled is gone: nothing read it and it was the largest write per report.
    this.sql.exec('DROP TABLE IF EXISTS atlas');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS native_map_chunk (
      bot_id TEXT NOT NULL, world_id TEXT NOT NULL, x INTEGER NOT NULL, z INTEGER NOT NULL,
      pixels BLOB NOT NULL, seen_at INTEGER NOT NULL,
      PRIMARY KEY (bot_id, world_id, x, z)
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS native_map_world ON native_map_chunk (world_id, x, z, seen_at)');
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      for (const [key, bot] of await ctx.storage.list({ prefix: 'bot:' })) this.bots.set(key.slice(4), bot);
      await this.schedule();
    });
  }
  retentionMs() { return Math.max(1, Number(this.env.RETENTION_HOURS) || 6) * 3600000; }
  snapshot() { return { now: Date.now(), retentionMs: this.retentionMs(), bots: [...this.bots.values()] }; }
  async schedule() { if (this.bots.size && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + sweepMs); }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/report') return this.report(request);
    if (url.pathname === '/api/map-image') return this.captureMap(request);
    if (url.pathname === '/api/native-map') return this.syncNativeMap(request);
    if (url.pathname === '/api/state') return json(200, this.snapshot());
    if (url.pathname.startsWith('/api/map-image/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/map-image/'.length));
      if (!idRe.test(id)) return json(400, { ok: false, error: 'Bad Seraph id' });
      const image = await this.ctx.storage.get(`map-image:${id}`), meta = this.bots.get(id)?.mapImage;
      return image && meta ? new Response(image, { headers: { 'content-type': 'image/webp', 'cache-control': 'private, no-cache', etag: `"${meta.at}"` } })
        : json(404, { ok: false, error: 'No World Map capture' });
    }
    if (url.pathname.startsWith('/api/native-map/')) return this.nativeMap(request, url);
    if (url.pathname === '/api/ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json(426, { ok: false, error: 'WebSocket upgrade required' });
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'snapshot', ...this.snapshot() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return json(404, { ok: false, error: 'Unknown route' });
  }
  async captureMap(request) {
    let body;
    try { body = await request.json(); } catch { return json(400, { ok: false, error: 'JSON body required' }); }
    const capture = mapCapture(body, Date.now());
    if (!capture) return json(400, { ok: false, error: 'Invalid World Map capture' });
    const bot = this.bots.get(capture.id);
    if (!bot) return json(404, { ok: false, error: 'Seraph must report before its World Map' });
    await this.ctx.storage.put(`map-image:${capture.id}`, capture.bytes);
    bot.mapImage = capture.meta; this.dirty.add(capture.id);
    await this.persist(capture.meta.at, true);
    this.broadcast({ type: 'bot', bot });
    return json(200, { ok: true, at: capture.meta.at, bytes: capture.bytes.byteLength });
  }
  nativeManifest(world, botId = null) {
    const rows = (botId
      ? this.sql.exec('SELECT x,z,seen_at FROM native_map_chunk WHERE world_id = ? AND bot_id = ?', world, botId)
      : this.sql.exec('SELECT x,z,MAX(seen_at) FROM native_map_chunk WHERE world_id = ? GROUP BY x,z', world)).raw().toArray();
    const regions = new Map(); let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, revision = 0;
    for (const [x, z, at] of rows) {
      minX = Math.min(minX, x); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z); revision = Math.max(revision, at);
      const rx = Math.floor(x / 8), rz = Math.floor(z / 8), key = `${rx}:${rz}`, region = regions.get(key) ?? [rx, rz, 0, 0];
      region[2] = Math.max(region[2], at); region[3]++; regions.set(key, region);
    }
    return { world, bot: botId, count: rows.length, revision,
      bounds: rows.length ? { x1: minX * 32, z1: minZ * 32, x2: (maxX + 1) * 32, z2: (maxZ + 1) * 32 } : null,
      regions: [...regions.values()] };
  }
  async nativeMap(request, url) {
    let parts;
    try { parts = url.pathname.slice('/api/native-map/'.length).split('/').map(decodeURIComponent); }
    catch { return json(400, { ok: false, error: 'Bad native map path' }); }
    const world = parts[0];
    if (!idRe.test(world ?? '')) return json(400, { ok: false, error: 'Bad world id' });
    const bot = url.searchParams.get('bot');
    if (bot && !idRe.test(bot)) return json(400, { ok: false, error: 'Bad Seraph id' });
    if (parts.length === 1) return json(200, this.nativeManifest(world, bot));
    if (parts.length !== 4 || parts[1] !== 'region' || !/^-?\d+$/.test(parts[2]) || !/^-?\d+$/.test(parts[3]))
      return json(404, { ok: false, error: 'Unknown native map route' });
    const rx = Number(parts[2]), rz = Number(parts[3]);
    if (!Number.isSafeInteger(rx) || !Number.isSafeInteger(rz) || Math.abs(rx) >= 8388608 || Math.abs(rz) >= 8388608)
      return json(400, { ok: false, error: 'Bad map region' });
    const x1 = rx * 8, z1 = rz * 8, x2 = x1 + 8, z2 = z1 + 8;
    const rows = (bot
      ? this.sql.exec(`SELECT x,z,pixels FROM native_map_chunk WHERE world_id = ? AND bot_id = ? AND x >= ? AND x < ? AND z >= ? AND z < ?`, world, bot, x1, x2, z1, z2)
      : this.sql.exec(`SELECT x,z,pixels FROM native_map_chunk WHERE world_id = ? AND x >= ? AND x < ? AND z >= ? AND z < ? ORDER BY seen_at DESC`, world, x1, x2, z1, z2)).raw().toArray();
    const seen = new Set(), chunks = [];
    for (const [x, z, pixels] of rows) {
      const key = `${x}:${z}`; if (seen.has(key)) continue; seen.add(key); chunks.push([x, z, bytesBase64(pixels)]);
    }
    return json(200, { world, bot, region: [rx, rz], chunks });
  }
  async syncNativeMap(request) {
    let body;
    try { body = await request.json(); } catch { return json(400, { ok: false, error: 'JSON body required' }); }
    const batch = nativeMapBatch(body, Date.now());
    if (!batch) return json(400, { ok: false, error: 'Invalid native map batch' });
    const bot = this.bots.get(batch.id);
    if (!bot) return json(404, { ok: false, error: 'Seraph must report before its native map' });
    this.ctx.storage.transactionSync(() => {
      for (const chunk of batch.chunks) this.sql.exec(`INSERT INTO native_map_chunk (bot_id,world_id,x,z,pixels,seen_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(bot_id,world_id,x,z) DO UPDATE SET pixels=excluded.pixels,seen_at=excluded.seen_at`,
      batch.id, batch.world, chunk.x, chunk.z, chunk.pixels, batch.at);
      this.sql.exec(`DELETE FROM native_map_chunk WHERE rowid IN (
        SELECT rowid FROM native_map_chunk WHERE bot_id = ? ORDER BY seen_at DESC, rowid DESC LIMIT -1 OFFSET ?
      )`, batch.id, maxNativeChunks);
    });
    if (!batch.complete) return json(200, { ok: true, chunks: batch.chunks.length });
    // A players-only sync reuses the stored manifest and the normal write throttle; only new chunks rescan and persist at once.
    const previous = bot.nativeMap, rescan = batch.chunks.length > 0 || previous?.world !== batch.world;
    const map = rescan ? this.nativeManifest(batch.world, batch.id) : previous;
    bot.nativeMap = { world: batch.world, at: batch.at, players: batch.players, count: map.count, bounds: map.bounds, revision: map.revision };
    this.dirty.add(batch.id); await this.persist(batch.at, rescan);
    this.broadcast({ type: 'nativemap', id: batch.id, nativeMap: bot.nativeMap });
    return json(200, { ok: true, chunks: batch.chunks.length, map: bot.nativeMap });
  }
  async report(request) {
    let body;
    try { body = await request.json(); } catch { return json(400, { ok: false, error: 'JSON body required' }); }
    const id = body?.bot?.id;
    if (typeof id !== 'string' || !idRe.test(id)) return json(400, { ok: false, error: 'bot.id must match ' + idRe.source });
    const now = Date.now();
    const bot = this.bots.get(id) ?? { id, firstSeenAt: now, topics: {}, log: [] };
    bot.seenAt = now; bot.meta = {};
    for (const [key, value] of Object.entries(body.bot)) if (key !== 'id' && (typeof value === 'string' || typeof value === 'number')) bot.meta[key.slice(0, maxMeta)] = typeof value === 'string' ? value.slice(0, maxMeta) : value;
    for (const [topic, entry] of Object.entries(body.topics ?? {})) {
      if (topic === 'map') continue;
      if (!topicRe.test(topic) || !entry || typeof entry !== 'object') continue;
      bot.topics[topic] = { at: number(entry.at, now), data: entry.data ?? null };
    }
    delete bot.topics.map;
    const trailed = appendTrail(bot, body.topics?.state, now);
    for (const entry of (Array.isArray(body.log) ? body.log : []).slice(-maxLog)) {
      if (!entry || typeof entry !== 'object' || !topicRe.test(entry.topic)) continue;
      bot.log.push({ topic: entry.topic, at: number(entry.at, now), data: entry.data ?? null });
    }
    while (bot.log.length > maxLog) bot.log.shift();
    const segmented = markRespawnBreaks(bot.trail ?? [], bot.log);
    this.bots.set(id, bot); this.dirty.add(id);
    this.broadcast({ type: 'bot', bot });
    // Unlike latest topics, a historical sample cannot be refilled by the next report.
    // Persist movement immediately; stationary updates keep the existing write throttle.
    await this.persist(now, trailed || segmented);
    await this.schedule();
    return json(200, { ok: true, bots: this.bots.size });
  }
  // Storage writes are throttled per bot: a new bot persists at once, then at most every persistMs; an eviction loses at most
  // that window of updates, which the next report refills.
  async persist(now, force = false) {
    const due = [...this.dirty].filter(id => this.bots.has(id) && (force || now - (this.persisted.get(id) ?? 0) >= persistMs));
    if (!due.length) return;
    for (const id of due) { this.dirty.delete(id); this.persisted.set(id, now); }
    await this.ctx.storage.put(Object.fromEntries(due.map(id => ['bot:' + id, this.bots.get(id)])));
  }
  async alarm() {
    const now = Date.now(), cutoff = now - this.retentionMs();
    for (const [id, bot] of this.bots) {
      if (bot.seenAt >= cutoff) continue;
      this.bots.delete(id); this.dirty.delete(id); this.persisted.delete(id);
      await this.ctx.storage.delete('bot:' + id);
      await this.ctx.storage.delete('map-image:' + id);
      this.broadcast({ type: 'gone', id });
    }
    await this.persist(now, true);
    if (this.bots.size) await this.ctx.storage.setAlarm(now + sweepMs);
  }
  broadcast(message) {
    const text = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) { try { socket.send(text); } catch { try { socket.close(1011); } catch {} } }
  }
  webSocketMessage() {}
  webSocketClose(socket) { try { socket.close(1000); } catch {} }
  webSocketError(socket) { try { socket.close(1011); } catch {} }
}
