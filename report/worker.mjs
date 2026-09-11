import { DurableObject } from 'cloudflare:workers';

// Fleet state service. Bots POST /api/report batches `{bot:{id,...},topics:{[topic]:{at,data}},log:[{topic,at,data}]}`;
// the single SeraphFleet object keeps the latest value per bot/topic plus a bounded log, evicts bots unseen for RETENTION_HOURS,
// and pushes updates to browser WebSockets. Reads (API and the static SPA in dist/, see app/) require VIEW_TOKEN when set;
// writes require REPORT_TOKEN.
const topicRe = /^[a-z][a-z0-9_]{0,63}$/, idRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const maxBody = 131072, maxMapImage = 92160, maxLog = 200, maxTrail = 540, maxAtlas = 65536, sharedAtlas = 12000;
const maxMeta = 128, persistMs = 30000, sweepMs = 900000, mapKinds = new Set(['ground', 'canopy', 'water', 'hazard']);

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const bearer = request => { const value = request.headers.get('authorization') ?? ''; return value.startsWith('Bearer ') ? value.slice(7) : ''; };
const cookie = (request, name) => (request.headers.get('cookie') ?? '').split(';').map(part => part.trim().split('=')).find(([key]) => key === name)?.[1] ?? '';
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
    phase: typeof progress?.phase === 'string' ? progress.phase.slice(0, 64) : null,
  };
  const trail = bot.trail ??= [], last = trail.at(-1);
  const moved = last ? Math.hypot(sample.x - last.x, sample.z - last.z) : Infinity;
  if (last && sample.dimension === last.dimension && sample.goal === last.goal && moved < .5 && sample.at - last.at < 60000) return false;
  trail.push(sample);
  while (trail.length > maxTrail) trail.shift();
  return true;
}

function mapDelta(entry, now) {
  if (!Array.isArray(entry?.data?.columns)) return [];
  const seenAt = number(entry.at, now), rows = [];
  for (const row of entry.data.columns.slice(-1024)) {
    if (!Array.isArray(row) || !Number.isInteger(row[0]) || !Number.isInteger(row[1]) || !Number.isFinite(row[2]) ||
      !mapKinds.has(row[3]) || ![1, 2, 4].includes(row[4])) continue;
    rows.push([row[0], row[1], row[2], row[3], row[4], typeof row[5] === 'string' ? row[5].slice(0, 96) : null,
      seenAt, Number.isInteger(row[7]) && row[7] >= 0 && row[7] <= 0xffffff ? row[7] : null]);
  }
  return rows;
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
    if (request.method !== 'GET') return json(405, { ok: false, error: 'GET only' });
    if (env.VIEW_TOKEN) {
      const token = url.searchParams.get('token') || cookie(request, 'view') || bearer(request);
      if (!equal(token, env.VIEW_TOKEN)) return json(401, { ok: false, error: 'Bad view token' });
      if (url.searchParams.has('token')) {
        url.searchParams.delete('token');
        return new Response(null, { status: 302, headers: { location: url.pathname + url.search,
          'set-cookie': `view=${encodeURIComponent(env.VIEW_TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000` } });
      }
    }
    if (url.pathname === '/api/state' || url.pathname === '/api/ws' || url.pathname === '/api/maps' || url.pathname.startsWith('/api/maps/') ||
      url.pathname.startsWith('/api/map-image/')) return fleet.fetch(request);
    if (url.pathname.startsWith('/api/')) return json(404, { ok: false, error: 'Unknown route' });
    return env.ASSETS.fetch(request);
  },
};

export class SeraphFleet extends DurableObject {
  bots = new Map(); dirty = new Set(); persisted = new Map();
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS atlas (
      bot_id TEXT NOT NULL, x INTEGER NOT NULL, z INTEGER NOT NULL, y REAL NOT NULL, kind TEXT NOT NULL,
      step INTEGER NOT NULL, code TEXT, seen_at INTEGER NOT NULL, color INTEGER,
      PRIMARY KEY (bot_id, x, z)
    )`);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      for (const [key, bot] of await ctx.storage.list({ prefix: 'bot:' })) this.bots.set(key.slice(4), bot);
      await this.schedule();
    });
  }
  retentionMs() { return Math.max(1, Number(this.env.RETENTION_HOURS) || 6) * 3600000; }
  snapshot() { return { now: Date.now(), retentionMs: this.retentionMs(), bots: [...this.bots.values()] }; }
  mapRows(id, limit) {
    return this.sql.exec(`SELECT x,z,y,kind,step,code,seen_at,color FROM atlas WHERE bot_id = ? ORDER BY seen_at DESC LIMIT ?`, id, limit)
      .raw().toArray().reverse();
  }
  maps(ids, limit) { return { maps: ids.map(id => ({ id, columns: this.mapRows(id, limit) })) }; }
  writeMap(id, entry, now) {
    const rows = mapDelta(entry, now);
    if (!rows.length) return rows;
    this.ctx.storage.transactionSync(() => {
      for (let offset = 0; offset < rows.length; offset += 10) {
        const batch = rows.slice(offset, offset + 10), values = batch.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
        this.sql.exec(`INSERT INTO atlas (bot_id,x,z,y,kind,step,code,seen_at,color) VALUES ${values}
          ON CONFLICT(bot_id,x,z) DO UPDATE SET y=excluded.y,kind=excluded.kind,step=excluded.step,
          code=excluded.code,seen_at=excluded.seen_at,color=excluded.color`, ...batch.flatMap(row => [id, ...row]));
      }
      this.sql.exec(`DELETE FROM atlas WHERE rowid IN (
        SELECT rowid FROM atlas WHERE bot_id = ? ORDER BY seen_at DESC, rowid DESC LIMIT -1 OFFSET ?
      )`, id, maxAtlas);
    });
    return rows;
  }
  async schedule() { if (this.bots.size && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + sweepMs); }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/report') return this.report(request);
    if (url.pathname === '/api/map-image') return this.captureMap(request);
    if (url.pathname === '/api/state') return json(200, this.snapshot());
    if (url.pathname === '/api/maps') return json(200, this.maps([...this.bots.keys()], sharedAtlas));
    if (url.pathname.startsWith('/api/maps/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/maps/'.length));
      return idRe.test(id) ? json(200, this.maps([id], maxAtlas)) : json(400, { ok: false, error: 'Bad Seraph id' });
    }
    if (url.pathname.startsWith('/api/map-image/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/map-image/'.length));
      if (!idRe.test(id)) return json(400, { ok: false, error: 'Bad Seraph id' });
      const image = await this.ctx.storage.get(`map-image:${id}`), meta = this.bots.get(id)?.mapImage;
      return image && meta ? new Response(image, { headers: { 'content-type': 'image/webp', 'cache-control': 'private, no-cache', etag: `"${meta.at}"` } })
        : json(404, { ok: false, error: 'No World Map capture' });
    }
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
    const mapped = this.writeMap(id, body.topics?.map, now);
    for (const entry of (Array.isArray(body.log) ? body.log : []).slice(-maxLog)) {
      if (!entry || typeof entry !== 'object' || !topicRe.test(entry.topic)) continue;
      bot.log.push({ topic: entry.topic, at: number(entry.at, now), data: entry.data ?? null });
    }
    while (bot.log.length > maxLog) bot.log.shift();
    this.bots.set(id, bot); this.dirty.add(id);
    this.broadcast({ type: 'bot', bot });
    if (mapped.length) this.broadcast({ type: 'map', id, columns: mapped });
    // Unlike latest topics, a historical sample cannot be refilled by the next report.
    // Persist movement immediately; stationary updates keep the existing write throttle.
    await this.persist(now, trailed);
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
      this.sql.exec('DELETE FROM atlas WHERE bot_id = ?', id);
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
