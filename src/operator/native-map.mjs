// Operator sync for the exact terrain chunks Vintage Story has already written to this character's World Map DB.
// This never asks the server for unseen terrain: it exports only the persistent client map a human can open in-game.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { requestBridge } from '../runtime/bridge.mjs';
import { root } from './display.mjs';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const chunkMask = (1n << 27n) - 1n, chunkSign = 1n << 26n, chunkRange = 1n << 27n;
const maxChunksPerUpload = 18;

function varint(bytes, offset) {
  let value = 0n, shift = 0n;
  for (let count = 0; count < 10 && offset < bytes.length; count++, shift += 7n) {
    const byte = bytes[offset++]; value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value, offset };
  }
  throw new Error('Invalid protobuf varint in native map chunk.');
}

export function decodeChunkIndex(value) {
  const index = BigInt(value);
  let x = index & chunkMask, z = index >> 27n & chunkMask;
  if (x & chunkSign) x -= chunkRange;
  if (z & chunkSign) z -= chunkRange;
  return { x: Number(x), z: Number(z) };
}

export function decodeMapPiece(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input), values = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = varint(bytes, offset); offset = tag.offset;
    const field = Number(tag.value >> 3n), wire = Number(tag.value & 7n);
    if (field !== 1) throw new Error('Unexpected field in native map chunk.');
    if (wire === 0) {
      const item = varint(bytes, offset); offset = item.offset; values.push(Number(item.value & 0xffffffffn));
    } else if (wire === 2) {
      const length = varint(bytes, offset); offset = length.offset;
      const end = offset + Number(length.value);
      if (end > bytes.length) throw new Error('Truncated native map chunk.');
      while (offset < end) { const item = varint(bytes, offset); offset = item.offset; values.push(Number(item.value & 0xffffffffn)); }
      if (offset !== end) throw new Error('Invalid packed native map chunk.');
    } else throw new Error('Unsupported protobuf encoding in native map chunk.');
  }
  if (values.length !== 32 * 32) throw new Error(`Native map chunk has ${values.length} pixels instead of 1024.`);
  const rgba = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index++) rgba.writeUInt32LE(values[index], index * 4);
  return rgba;
}

export function readNativeMap(mapId, { dataRoot = path.join(root, '.runtime/bot-data') } = {}) {
  if (!idPattern.test(mapId ?? '')) throw new Error('Vintage Story returned an invalid map id.');
  const database = path.join(dataRoot, 'Maps', `${mapId}.db`);
  if (!existsSync(database)) throw new Error(`Native World Map database is not ready for ${mapId}.`);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db.prepare('SELECT position,data FROM mappiece ORDER BY position').all().map(row => {
      const pixels = decodeMapPiece(row.data), { x, z } = decodeChunkIndex(row.position);
      return { x, z, pixels, hash: createHash('sha256').update(row.data).digest('base64url').slice(0, 16) };
    });
  } finally { db.close(); }
}

async function upload(body) {
  const url = process.env.VINTAGE_STORY_REPORT_URL, token = process.env.VINTAGE_STORY_REPORT_TOKEN;
  if (!url || !token || !idPattern.test(process.env.VINTAGE_STORY_BOT_ID ?? ''))
    throw new Error('Fleet URL, report token and Seraph id are required for native map sync.');
  const response = await fetch(new URL('/api/native-map', url), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: process.env.VINTAGE_STORY_BOT_ID, ...body }), signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error ?? `Fleet native map sync failed with HTTP ${response.status}.`);
  return result;
}

export async function syncNativeMap({ known = new Map() } = {}) {
  const sample = await requestBridge({ action: 'map_view' });
  if (!sample.ok || !idPattern.test(sample.map?.id ?? '')) throw new Error(sample.error ?? 'Native World Map metadata is unavailable.');
  const world = sample.map.id, chunks = readNativeMap(world), changed = chunks.filter(chunk => known.get(`${world}:${chunk.x}:${chunk.z}`) !== chunk.hash);
  const players = (sample.players ?? []).slice(0, 64).map(player => ({ name: player.name, x: player.x, z: player.z,
    yawDegrees: player.yawDegrees, self: player.self === true }));
  const batches = changed.length ? Array.from({ length: Math.ceil(changed.length / maxChunksPerUpload) }, (_, index) =>
    changed.slice(index * maxChunksPerUpload, (index + 1) * maxChunksPerUpload)) : [[]];
  let result;
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    result = await upload({ world, at: Date.now(), players: index === batches.length - 1 ? players : undefined,
      complete: index === batches.length - 1, chunks: batch.map(chunk => [chunk.x, chunk.z, chunk.pixels.toString('base64')]) });
    for (const chunk of batch) known.set(`${world}:${chunk.x}:${chunk.z}`, chunk.hash);
  }
  return { ok: true, world, changed: changed.length, total: chunks.length, players: players.length, map: result?.map };
}

export function superviseNativeMap({ intervalMs = Number(process.env.VINTAGE_STORY_NATIVE_MAP_INTERVAL_MS) || 30000,
  onChange = () => {}, log = () => {} } = {}) {
  intervalMs = Math.max(10000, intervalMs);
  const known = new Map();
  let stopped = false, running = false, lastAt = null, nextAt = Date.now() + 25000, reason = null;
  const status = () => ({ running, lastAt, nextAt, reason });
  const changed = () => onChange(status());
  async function tick() {
    if (stopped || running || Date.now() < nextAt) return;
    running = true; reason = null; changed();
    try {
      const result = await syncNativeMap({ known });
      lastAt = Date.now(); nextAt = lastAt + intervalMs;
      if (result.changed) log(`synced ${result.changed}/${result.total} native map chunks for ${result.world}`);
    } catch (error) { reason = error.message; nextAt = Date.now() + 30000; log(reason); }
    finally { running = false; changed(); }
  }
  const timer = setInterval(tick, 5000); changed();
  return { status, sync: () => { nextAt = 0; return tick(); }, stop: () => { stopped = true; clearInterval(timer); } };
}
