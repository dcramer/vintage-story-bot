import { DurableObject } from 'cloudflare:workers';

// Fleet state service. Bots POST /api/report batches `{bot:{id,...},topics:{[topic]:{at,data}},log:[{topic,at,data}]}`;
// the single SeraphFleet object keeps the latest value per bot/topic plus a bounded log, evicts bots unseen for RETENTION_HOURS,
// and pushes updates to browser WebSockets. Reads (API and the static SPA in dist/, see app/) require VIEW_TOKEN when set;
// writes require REPORT_TOKEN.
const topicRe = /^[a-z][a-z0-9_]{0,63}$/, idRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const maxBody = 131072, maxLog = 200, maxMeta = 128, persistMs = 30000, sweepMs = 900000;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const bearer = request => { const value = request.headers.get('authorization') ?? ''; return value.startsWith('Bearer ') ? value.slice(7) : ''; };
const cookie = (request, name) => (request.headers.get('cookie') ?? '').split(';').map(part => part.trim().split('=')).find(([key]) => key === name)?.[1] ?? '';
function equal(given, expected) {
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(expected);
  return a.byteLength === b.byteLength && b.byteLength > 0 && crypto.subtle.timingSafeEqual(a, b);
}
const number = (value, fallback) => Number.isFinite(value) ? value : fallback;

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
    if (url.pathname === '/api/state' || url.pathname === '/api/ws') return fleet.fetch(request);
    if (url.pathname.startsWith('/api/')) return json(404, { ok: false, error: 'Unknown route' });
    return env.ASSETS.fetch(request);
  },
};

export class SeraphFleet extends DurableObject {
  bots = new Map(); dirty = new Set(); persisted = new Map();
  constructor(ctx, env) {
    super(ctx, env);
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
    if (url.pathname === '/api/state') return json(200, this.snapshot());
    if (url.pathname === '/api/ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json(426, { ok: false, error: 'WebSocket upgrade required' });
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'snapshot', ...this.snapshot() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return json(404, { ok: false, error: 'Unknown route' });
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
      if (!topicRe.test(topic) || !entry || typeof entry !== 'object') continue;
      bot.topics[topic] = { at: number(entry.at, now), data: entry.data ?? null };
    }
    for (const entry of (Array.isArray(body.log) ? body.log : []).slice(-maxLog)) {
      if (!entry || typeof entry !== 'object' || !topicRe.test(entry.topic)) continue;
      bot.log.push({ topic: entry.topic, at: number(entry.at, now), data: entry.data ?? null });
    }
    while (bot.log.length > maxLog) bot.log.shift();
    this.bots.set(id, bot); this.dirty.add(id);
    this.broadcast({ type: 'bot', bot });
    await this.persist(now);
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
