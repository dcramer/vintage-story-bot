// Operator-only capture of Vintage Story's native World Map. This opens the map only while the Seraph is idle,
// screenshots the verified game window, compresses it, uploads it to the fleet service, and closes the map again.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { requestBridge } from '../runtime/bridge.mjs';
import { callUi, uiEnv } from './bot-window.mjs';
import { tool } from './display.mjs';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const maxImageBytes = 90 * 1024;

function normalizePoint(point, width, height) {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
    ? [point[0] / width, point[1] / height] : null;
}

export function normalizeMapView(sample, width, height) {
  const world = sample?.world, view = sample?.view;
  if (!sample?.opened || !Number.isFinite(world?.x) || !Number.isFinite(world?.z) || !Number.isInteger(world?.dimension)) return null;
  const here = normalizePoint(view?.here, width, height), east100 = normalizePoint(view?.east100, width, height), south100 = normalizePoint(view?.south100, width, height);
  return here && east100 && south100 ? { world, here, east100, south100 } : null;
}

async function waitForMap(opened) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const view = await requestBridge({ action: 'map_view' });
    if (!view.ok) throw new Error(view.error ?? 'World Map state unavailable.');
    if (view.opened === opened) return view;
    await sleep(100);
  }
  throw new Error(`World Map did not ${opened ? 'open' : 'close'}.`);
}

async function compress(png, env) {
  const convert = tool('convert') ?? tool('convert-im6.q16') ?? tool('magick');
  if (!convert) throw new Error('ImageMagick is missing; run scripts/setup-linux.sh.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'seraph-map-'));
  const input = path.join(directory, 'window.png'), output = path.join(directory, 'map.webp');
  try {
    await writeFile(input, png);
    for (const [size, quality] of [['720x405>', '38'], ['640x360>', '30'], ['560x315>', '24']]) {
      await exec(convert, [input, '-resize', size, '-strip', '-quality', quality, output], { env, timeout: 10000, maxBuffer: 65536 });
      const image = await readFile(output);
      if (image.length <= maxImageBytes) return image;
    }
    throw new Error(`Compressed World Map exceeds ${maxImageBytes} bytes.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function upload(image, capture, { url, token, id }) {
  if (!url || !token || !idPattern.test(id ?? '')) throw new Error('Fleet URL, report token and Seraph id are required for World Map upload.');
  const response = await fetch(new URL('/api/map-image', url), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id, ...capture, image: image.toString('base64') }),
    signal: AbortSignal.timeout(10000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Fleet World Map upload failed with HTTP ${response.status}.`);
}

export async function captureWorldMap({ force = false, uploadImage = true } = {}) {
  const state = await requestBridge({ action: 'observe' });
  if (!state.ok) throw new Error(state.error ?? 'Seraph state unavailable.');
  if (!state.alive || !state.controlReady || state.control?.active) {
    if (!force) return { ok: true, captured: false, reason: 'Seraph is busy or cannot open the World Map.' };
    if (!state.alive) throw new Error('A dead Seraph cannot open the World Map.');
  }
  let opened = false;
  try {
    await callUi('ui_key', { key: 'm' });
    const view = await waitForMap(true); opened = true;
    await sleep(350);
    const screenshot = await callUi('ui_screenshot', {}), geometry = JSON.parse(screenshot.content[0].text);
    const png = Buffer.from(screenshot.content[1].data, 'base64'), ui = await uiEnv();
    const image = await compress(png, ui.env), at = Date.now();
    const capture = { at, width: geometry.width, height: geometry.height,
      view: normalizeMapView(view, geometry.width, geometry.height) };
    if (uploadImage) await upload(image, capture, {
      url: process.env.VINTAGE_STORY_REPORT_URL,
      token: process.env.VINTAGE_STORY_REPORT_TOKEN,
      id: process.env.VINTAGE_STORY_BOT_ID,
    });
    return { ok: true, captured: true, at, bytes: image.length, width: geometry.width, height: geometry.height,
      uploaded: uploadImage, image };
  } finally {
    if (opened) {
      await callUi('ui_key', { key: 'm' }).catch(() => {});
      await waitForMap(false).catch(() => {});
    }
  }
}

export function superviseWorldMap({ intervalMs = Number(process.env.VINTAGE_STORY_MAP_CAPTURE_INTERVAL_MS) || 900000,
  onChange = () => {}, log = () => {} } = {}) {
  intervalMs = Math.max(60000, intervalMs);
  let stopped = false, running = false, lastAt = null, nextAt = Date.now() + 15000, reason = null;
  const status = () => ({ running, lastAt, nextAt, reason });
  const changed = () => onChange(status());
  async function tick() {
    if (stopped || running || Date.now() < nextAt) return;
    running = true; reason = null; changed();
    try {
      const result = await captureWorldMap();
      if (result.captured) { lastAt = result.at; nextAt = Date.now() + intervalMs; log(`captured native World Map (${result.bytes} bytes)`); }
      else { reason = result.reason; nextAt = Date.now() + 60000; }
    } catch (error) {
      reason = error.message; nextAt = Date.now() + 60000; log(reason);
    } finally { running = false; changed(); }
  }
  const timer = setInterval(tick, 5000); changed();
  return { status, capture: () => { nextAt = 0; return tick(); }, stop: () => { stopped = true; clearInterval(timer); } };
}
