const idRe = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const itemRe = /^.{1,160}$/;
const categories = ['gained', 'gathered', 'crafted', 'recovered', 'other'];
const maxRecentRuns = 20;
const maxSegments = 32;
const maxItems = 64;

const number = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const count = value => Math.max(0, Math.min(1e9, Math.floor(number(value))));
const point = value =>
  value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z) && Number.isInteger(value.dimension)
    ? { x: value.x, y: value.y, z: value.z, dimension: value.dimension }
    : null;
const horizontal = (a, b) => (a.dimension === b.dimension ? Math.hypot(a.x - b.x, a.z - b.z) : 0);
const rounded = value => Math.round(value * 10) / 10;

function items(value) {
  const rows = {};
  for (const item of (Array.isArray(value?.byCode) ? value.byCode : []).slice(0, maxItems)) {
    if (!itemRe.test(item?.code ?? '')) continue;
    const row = { code: item.code };
    for (const category of categories) row[category] = count(item[category]);
    rows[item.code] = row;
  }
  return rows;
}

function publicItems(segments) {
  const byCode = new Map();
  for (const segment of Object.values(segments))
    for (const row of Object.values(segment.items)) {
      const sum = byCode.get(row.code) ?? { code: row.code, gained: 0, gathered: 0, crafted: 0, recovered: 0, other: 0 };
      for (const category of categories) sum[category] += row[category];
      byCode.set(row.code, sum);
    }
  const rows = [...byCode.values()].sort((a, b) => b.gained - a.gained || a.code.localeCompare(b.code)).slice(0, maxItems);
  const totals = { gained: 0, gathered: 0, crafted: 0, recovered: 0, other: 0 };
  for (const row of byCode.values()) for (const category of categories) totals[category] += row[category];
  return { ...totals, byCode: rows };
}

function archive(runs) {
  if (!runs.current) return;
  runs.recent.push(runs.current);
  while (runs.recent.length > maxRecentRuns) runs.recent.shift();
}

// Join cumulative controller-segment measurements into one durable game life.
// Replaying the same report replaces a segment snapshot rather than adding it
// twice. The internal segment map is stored server-side but omitted from API
// and WebSocket bot records by publicBot().
export function mergeRunMetric(bot, value) {
  const lifeId = value?.lifeId,
    segmentId = value?.segmentId,
    origin = point(value?.origin),
    position = point(value?.position),
    observedAt = number(value?.observedAt, NaN),
    segmentStartedAt = number(value?.segmentStartedAt, NaN);
  if (!idRe.test(lifeId ?? '') || !idRe.test(segmentId ?? '') || !origin || !position || !Number.isFinite(observedAt) || !Number.isFinite(segmentStartedAt))
    return { changed: false, transition: false };
  const runs = (bot.runs ??= { current: null, recent: [] });
  let transition = false;
  if (runs.current?.lifeId !== lifeId) {
    // Reporter requests are serialized, but a retried stale batch must never
    // roll the durable record back to a life that has already ended.
    if (runs.current && observedAt < runs.current.observedAt) return { changed: false, transition: false };
    archive(runs);
    runs.current = {
      lifeId,
      startedAt: segmentStartedAt,
      observedAt,
      endedAt: value.alive === false ? number(value.endedAt, observedAt) : null,
      alive: value.alive !== false,
      spawn: origin,
      position,
      durationMs: 0,
      distance: 0,
      movementSamples: 0,
      estimatedSteps: 0,
      maxFromSpawn: horizontal(origin, position),
      discontinuities: 0,
      controllerSegments: 0,
      items: { gained: 0, gathered: 0, crafted: 0, recovered: 0, other: 0, byCode: [] },
    };
    bot.runSegments = {};
    transition = true;
  }
  const prior = bot.runSegments?.[segmentId];
  if (prior && prior.observedAt > observedAt) return { changed: false, transition: false };
  const wasAlive = runs.current.alive;
  bot.runSegments[segmentId] = {
    observedAt,
    startedAt: segmentStartedAt,
    distance: Math.max(0, number(value.distance)),
    movementSamples: count(value.movementSamples),
    discontinuities: count(value.discontinuities),
    items: items(value.items),
  };
  const segmentEntries = Object.entries(bot.runSegments);
  if (segmentEntries.length > maxSegments) {
    segmentEntries.sort((a, b) => a[1].observedAt - b[1].observedAt);
    for (const [id] of segmentEntries.slice(0, segmentEntries.length - maxSegments)) delete bot.runSegments[id];
  }
  const current = runs.current,
    segments = Object.values(bot.runSegments);
  current.startedAt = Math.min(current.startedAt, ...segments.map(segment => segment.startedAt));
  current.distance = rounded(segments.reduce((sum, segment) => sum + segment.distance, 0));
  current.movementSamples = segments.reduce((sum, segment) => sum + segment.movementSamples, 0);
  current.estimatedSteps = Math.round(current.distance / 0.75);
  current.discontinuities = segments.reduce((sum, segment) => sum + segment.discontinuities, 0);
  current.controllerSegments = segments.length;
  current.items = publicItems(bot.runSegments);
  if (observedAt >= current.observedAt) {
    current.observedAt = observedAt;
    current.position = position;
    current.alive = value.alive !== false;
    if (!current.alive) current.endedAt ??= number(value.endedAt, observedAt);
  }
  current.maxFromSpawn = rounded(Math.max(current.maxFromSpawn, horizontal(current.spawn, position)));
  if (horizontal(current.spawn, origin) < 0.01) current.maxFromSpawn = rounded(Math.max(current.maxFromSpawn, number(value.maxFromOrigin)));
  current.durationMs = Math.max(0, (current.endedAt ?? current.observedAt) - current.startedAt);
  transition ||= value.alive === false && wasAlive;
  return { changed: true, transition };
}

export function ingestRunMetrics(bot, topics, log) {
  const entries = [];
  for (const entry of Array.isArray(log) ? log : []) if (entry?.topic === 'run') entries.push(entry);
  if (topics?.run) entries.push(topics.run);
  entries.sort((a, b) => number(a?.data?.observedAt, a?.at) - number(b?.data?.observedAt, b?.at));
  const seen = new Set();
  let changed = false,
    transition = false;
  for (const entry of entries) {
    const key = `${entry?.data?.segmentId}:${entry?.data?.observedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const merged = mergeRunMetric(bot, entry?.data);
    changed ||= merged.changed;
    transition ||= merged.transition;
  }
  return { changed, transition };
}

export function publicBot(bot) {
  const { runSegments: _, ...record } = bot;
  return record;
}
