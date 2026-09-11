import { signal, computed } from '@preact/signals';

// Fleet state mirrored from the Worker: snapshots seed, /api/ws streams `snapshot|bot|map|gone`. Vital history is
// client-side only, accumulated while the page is open.
export const bots = signal({});
export const atlases = signal({});
export const status = signal('connecting');
export const retentionMs = signal(0);
export const now = signal(Date.now());
export const liveMs = 30000;
const history = new Map(), maxHistory = 720;
setInterval(() => { now.value = Date.now(); }, 1000);

export const list = computed(() => Object.values(bots.value).sort((a, b) => b.seenAt - a.seenAt));
export const isLive = bot => now.value - bot.seenAt < liveMs;
export const vitalHistory = id => history.get(id) ?? [];
export const positionHistory = bot => {
  if (bot?.trail?.length) return bot.trail;
  const state = bot?.topics?.state;
  return state?.data?.position ? [{ at: state.at, ...state.data.position }] : [];
};
export const atlasFor = id => atlases.value[id] ?? [];
function mergeAtlas(id, incoming = []) {
  const merged = new Map((atlases.value[id] ?? []).map(row => [`${row[0]},${row[1]}`, row]));
  for (const row of incoming) {
    if (!Array.isArray(row) || !Number.isFinite(row[0]) || !Number.isFinite(row[1])) continue;
    const key = `${row[0]},${row[1]}`, prior = merged.get(key);
    if (!prior || (row[6] ?? 0) >= (prior[6] ?? 0)) merged.set(key, row);
  }
  atlases.value = { ...atlases.value, [id]: [...merged.values()] };
}
function applyMaps(payload) { for (const map of payload?.maps ?? []) mergeAtlas(map.id, map.columns); }
const fullMaps = new Set();
export function loadAtlas(id) {
  if (fullMaps.has(id)) return;
  fullMaps.add(id);
  fetch(`/api/maps/${encodeURIComponent(id)}`).then(response => response.ok ? response.json() : null).then(applyMaps)
    .catch(() => { fullMaps.delete(id); });
}
const pct = v => v?.max ? v.current / v.max : null;
function record(bot) {
  const state = bot.topics.state;
  if (!state) return;
  const rows = history.get(bot.id) ?? [];
  if (rows[rows.length - 1]?.at === state.at) return;
  rows.push({ at: state.at, health: pct(state.data?.vitals?.health), hunger: pct(state.data?.vitals?.hunger) });
  while (rows.length > maxHistory) rows.shift();
  history.set(bot.id, rows);
}
export function apply(message) {
  if (message.type === 'snapshot') {
    retentionMs.value = message.retentionMs;
    for (const bot of message.bots) record(bot);
    bots.value = Object.fromEntries(message.bots.map(bot => [bot.id, bot]));
  } else if (message.type === 'bot') {
    record(message.bot);
    bots.value = { ...bots.value, [message.bot.id]: message.bot };
  } else if (message.type === 'map') {
    mergeAtlas(message.id, message.columns);
  } else if (message.type === 'gone') {
    const { [message.id]: _, ...rest } = bots.value;
    const { [message.id]: _atlas, ...maps } = atlases.value;
    bots.value = rest;
    atlases.value = maps;
  }
}
let socket, retry = 1000;
export function connect() {
  fetch('/api/state').then(r => r.json()).then(s => apply({ type: 'snapshot', ...s })).catch(() => {});
  fetch('/api/maps').then(r => r.ok ? r.json() : null).then(applyMaps).catch(() => {});
  open();
  setInterval(() => { if (socket?.readyState === 1) socket.send('ping'); }, 30000);
}
function open() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
  socket.onopen = () => { retry = 1000; status.value = 'live'; };
  socket.onmessage = e => { if (e.data !== 'pong') apply(JSON.parse(e.data)); };
  socket.onclose = () => { status.value = 'reconnecting'; setTimeout(open, retry); retry = Math.min(retry * 2, 30000); };
  socket.onerror = () => socket.close();
}
