import http from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { bridgePort } from '../bridge/client.mjs';
import { superviseStream } from './stream.mjs';
import { superviseWorldMap } from './world-map.mjs';
import { superviseNativeMap } from './native-map.mjs';

// Operator dashboard: producers stream NDJSON `{topic,at?,data,log?}` lines to POST /ingest; browsers read
// GET / (page), GET /state (snapshot) and GET /events (SSE). Read-only; no gameplay or controller imports.
// It also owns the live video stream of the headless display for as long as it runs (stream.mjs).
const port = bridgePort(process.env.VINTAGE_STORY_DASHBOARD_PORT ?? '42159');
const pageUrl = new URL('./dashboard.html', import.meta.url);
const startedAt = Date.now(), latest = new Map(), log = [], clients = new Set(), producers = new Set();
const maxLine = 65536, maxLog = 500;
let stream = null, worldMap = null, nativeMap = null;

const snapshot = () => ({ startedAt, producers: producers.size, topics: Object.fromEntries(latest), log,
  stream: stream?.status() ?? null, worldMap: worldMap?.status() ?? null, nativeMap: nativeMap?.status() ?? null });
function broadcast(event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(chunk);
}
function ingest(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== 'object' || typeof message.topic !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(message.topic)) return;
  const entry = { topic: message.topic, at: Number.isFinite(message.at) ? message.at : Date.now(), data: message.data ?? null, log: message.log === true };
  latest.set(entry.topic, entry);
  if (entry.log) { log.push(entry); while (log.length > maxLog) log.shift(); }
  broadcast('update', entry);
}
function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  const { pathname } = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'GET' && pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return response.end(readFileSync(pageUrl));
  }
  if (request.method === 'GET' && pathname === '/state') return json(response, 200, snapshot());
  if (request.method === 'GET' && pathname === '/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  if (request.method === 'POST' && pathname === '/ingest') {
    producers.add(request); broadcast('producers', { count: producers.size });
    let buffer = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { ingest(buffer.slice(0, end).trim()); buffer = buffer.slice(end + 1); }
      if (buffer.length > maxLine) request.destroy();
    });
    request.on('end', () => { if (buffer.trim()) ingest(buffer.trim()); json(response, 200, { ok: true }); });
    request.on('close', () => { if (producers.delete(request)) broadcast('producers', { count: producers.size }); });
    return;
  }
  json(response, 404, { ok: false, error: 'Unknown route' });
});
const heartbeat = setInterval(() => { for (const client of clients) client.write(': ping\n\n'); }, 15000);
server.listen(port, '127.0.0.1');
await once(server, 'listening');
console.error(`Dashboard on http://127.0.0.1:${port} (ingest POST /ingest, stream GET /events)`);
stream = superviseStream({ bind: process.env.VINTAGE_STORY_STREAM_BIND || undefined,
  onChange: status => broadcast('stream', status), log: line => console.error(`[stream] ${line}`) });
if (process.env.VINTAGE_STORY_REPORT_URL && process.env.VINTAGE_STORY_REPORT_TOKEN && process.env.VINTAGE_STORY_BOT_ID) {
  worldMap = superviseWorldMap({ onChange: status => broadcast('worldmap', status), log: line => console.error(`[worldmap] ${line}`) });
  nativeMap = superviseNativeMap({ onChange: status => broadcast('nativemap', status), log: line => console.error(`[nativemap] ${line}`) });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  clearInterval(heartbeat);
  for (const client of clients) client.end();
  for (const producer of producers) producer.destroy();
  worldMap?.stop();
  nativeMap?.stop();
  await stream.stop();
  server.close(() => process.exit(0));
});
