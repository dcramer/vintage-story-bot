// Operator-only map UI. The connect bootstrap opens the World Map once while idle, then leaves the minimap active so
// Vintage Story continuously writes its visible native chunks. Explicit capture also screenshots that verified window.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { requestBridge } from '../runtime/bridge.ts';
import { callUi, uiEnv } from './bot-window.ts';
import { tool } from './display.ts';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const maxImageBytes = 90 * 1024;

function normalizePoint(point, width, height) {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) ? [point[0] / width, point[1] / height] : null;
}

export function normalizeMapView(sample, width, height) {
  const world = sample?.world,
    view = sample?.view;
  if (!sample?.opened || !Number.isFinite(world?.x) || !Number.isFinite(world?.z) || !Number.isInteger(world?.dimension)) return null;
  const here = normalizePoint(view?.here, width, height),
    east100 = normalizePoint(view?.east100, width, height),
    south100 = normalizePoint(view?.south100, width, height);
  return here && east100 && south100 ? { world, here, east100, south100 } : null;
}

export function mapMode(sample) {
  return ['closed', 'minimap', 'world'].includes(sample?.mode) ? sample.mode : sample?.opened ? 'world' : 'closed';
}

async function waitForMap(mode) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const view = await requestBridge({ action: 'map_view' });
    if (!view.ok) throw new Error(view.error ?? 'World Map state unavailable.');
    if (mapMode(view) === mode) return view;
    await sleep(100);
  }
  throw new Error(`Map did not enter ${mode} mode.`);
}

async function mapInputReady(force = false) {
  const state = await requestBridge({ action: 'observe' });
  if (!state.ok) throw new Error(state.error ?? 'Seraph state unavailable.');
  if (!state.alive || !state.controlReady || state.control?.active) {
    if (!force) return { state, reason: 'Seraph is busy or cannot change the map UI.' };
    if (!state.alive) throw new Error('A dead Seraph cannot change the map UI.');
  }
  return { state, reason: null };
}

async function openWorldMap(force) {
  const ready = await mapInputReady(force);
  if (ready.reason) return { reason: ready.reason };
  const initial = await requestBridge({ action: 'map_view' });
  if (!initial.ok) throw new Error(initial.error ?? 'Map state unavailable.');
  const priorMode = mapMode(initial);
  if (priorMode === 'world') return { view: initial, priorMode, opened: false };
  await callUi('ui_key', { key: 'm' });
  return { view: await waitForMap('world'), priorMode, opened: true };
}

async function restoreMap(operation) {
  if (!operation.opened) return;
  await callUi('ui_key', { key: 'm' }).catch(() => {});
  await waitForMap(operation.priorMode).catch(() => {});
}

export async function ensureMinimap() {
  const current = await requestBridge({ action: 'map_view' });
  if (!current.ok) throw new Error(current.error ?? 'Map state unavailable.');
  const mode = mapMode(current);
  if (mode === 'minimap') return { ok: true, enabled: true, mode, world: current.map?.id, session: current.session };
  if (mode === 'world') return { ok: true, enabled: false, mode, world: current.map?.id, session: current.session, reason: 'World Map is open.' };
  const ready = await mapInputReady();
  if (ready.reason) return { ok: true, enabled: false, mode, world: current.map?.id, session: current.session, reason: ready.reason };
  await callUi('ui_key', { key: 'F6' });
  const view = await waitForMap('minimap');
  return { ok: true, enabled: true, mode: 'minimap', world: view.map?.id, session: view.session };
}

export async function scanWorldMap({ force = false } = {}) {
  const operation = await openWorldMap(force);
  if (operation.reason) return { ok: true, scanned: false, reason: operation.reason };
  try {
    await sleep(750);
    return { ok: true, scanned: true, world: operation.view.map?.id, session: operation.view.session };
  } finally {
    await restoreMap(operation);
  }
}

async function compress(png, env) {
  const convert = tool('convert') ?? tool('convert-im6.q16') ?? tool('magick');
  if (!convert) throw new Error('ImageMagick is missing; run scripts/setup-linux.sh.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'seraph-map-'));
  const input = path.join(directory, 'window.png'),
    output = path.join(directory, 'map.webp');
  try {
    await writeFile(input, png);
    for (const [size, quality] of [
      ['720x405>', '38'],
      ['640x360>', '30'],
      ['560x315>', '24'],
    ]) {
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
  const operation = await openWorldMap(force);
  if (operation.reason) return { ok: true, captured: false, reason: operation.reason };
  try {
    await sleep(350);
    const screenshot = await callUi('ui_screenshot', {}),
      geometry = JSON.parse(screenshot.content[0].text);
    const png = Buffer.from(screenshot.content[1].data, 'base64'),
      ui = await uiEnv();
    const image = await compress(png, ui.env),
      at = Date.now();
    const capture = { at, width: geometry.width, height: geometry.height, view: normalizeMapView(operation.view, geometry.width, geometry.height) };
    if (uploadImage)
      await upload(image, capture, {
        url: process.env.VINTAGE_STORY_REPORT_URL,
        token: process.env.VINTAGE_STORY_REPORT_TOKEN,
        id: process.env.VINTAGE_STORY_BOT_ID,
      });
    return { ok: true, captured: true, at, bytes: image.length, width: geometry.width, height: geometry.height, uploaded: uploadImage, image };
  } finally {
    await restoreMap(operation);
  }
}
