import { horizontal, lookAt, normalize } from '../navigation/terrain.mjs';
import { findRoute } from '../navigation/planner.mjs';

const loose = o => o.kind === 'block' && /^game:loosestick-(free|snow)$/.test(o.code);
const dropped = o => o.kind === 'item' && o.code === 'game:stick';
export const stickCount = state => [...state.hotbar, ...state.backpack]
  .filter(slot => slot.code === 'game:stick').reduce((n, slot) => n + slot.quantity, 0);
const area = p => `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`;
const sightRange = 64, travelRange = sightRange * .75;

// Policy only: supplied runtime owns sensing, input leases and cancellation.
export async function gather(env, { count = 10, timeoutMs, signal, wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 64) throw Error('count must be 1–64');
  const started = now(), seen = new Map(), rejected = new Map(), visits = new Map(), trees = new Map();
  let initial, latest, gained = 0, moved = 0, heading = 0, attempts = 0, searched = 0;
  const check = () => {
    if (signal?.aborted) throw Error('Goal cancelled');
    if (timeoutMs !== undefined && now() - started >= timeoutMs) throw Error('Requested deadline reached');
  };
  const send = async request => { check(); const r = await env.send(request); if (!r.ok) throw Error(r.error ?? 'Game action refused'); return r; };
  const observe = async (sync = false) => {
    check(); latest = sync ? await env.sync() : await send({ action: 'observe' });
    if (!latest.alive || !latest.controlReady || latest.life.alerts.some(a => a !== 'low_food') ||
      latest.motion.swimming || latest.motion.feetInLiquid || latest.mounted) throw Error('Gameplay interruption: life, controls or liquid');
    if (initial && (latest.player.uid !== initial.player.uid || latest.life.session !== initial.life.session ||
      latest.life.lastDamageAt !== initial.life.lastDamageAt || latest.position.dimension !== initial.position.dimension)) throw Error('Gameplay interruption: damage or session changed');
    if (initial) gained = stickCount(latest) - stickCount(initial);
    return latest;
  };
  const report = (phase, extra = {}) => env.report?.({ phase, count, gained, moved: +moved.toFixed(1), searched, targets: seen.size, ...extra });
  const aim = async angles => { await observe(); await env.aim(angles); await observe(); };
  const scan = async (radius, match = 'stick') => {
    let cursor;
    const objects = [];
    do {
      await observe();
      const page = await env.send({ action: 'scan', kind: match === 'stick' ? 'all' : 'blocks', match, radius, limit: 32, ...(cursor ? { cursor } : {}) });
      if (page.code === 'scan_expired') break;
      if (!page.ok) throw Error(page.error ?? 'Scan refused');
      objects.push(...page.objects);
      for (const object of page.objects.filter(o => loose(o) || dropped(o))) seen.set(object.key, { ...object, seenAt: now() });
      if (match === 'leaves') for (const object of page.objects) {
        if (!object.code.startsWith('game:leaves-') || (visits.get(area(object.point)) ?? 0) > 0) continue;
        trees.set(area(object.point), { point: object.point, seenAt: now() });
      }
      cursor = page.more ? page.cursor : null;
    } while (cursor);
    searched++;
    return objects;
  };
  const walk = async target => {
    const before = await observe(); report('walking', { target });
    const timeoutMs = Math.min(120000, Math.max(15000, Math.ceil(horizontal(before.position, target) * 2000)));
    const result = await env.navigate({ ...target, dimension: 0, timeoutMs });
    const after = await observe(true);
    moved += horizontal(before.position, after.position);
    visits.set(area(after.position), (visits.get(area(after.position)) ?? 0) + 1);
    if (visits.size > 4096) visits.delete(visits.keys().next().value);
    if (result.state === 'cancelled') throw Error(`Navigation interrupted: ${result.reason}`);
    if (result.state !== 'arrived') report('rerouting', { reason: result.reason });
    return result;
  };
  const approach = object => {
    const p = latest.position, w = latest.body.halfWidth, h = latest.body.height, candidates = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const q = env.map.stand(Math.floor(object.point.x) + .5 + dx, Math.floor(object.point.z) + .5 + dz, object.point.y, w, h);
      if (!q || horizontal(p, q) < .5 || dropped(object) && horizontal(q, object.point) > .8) continue;
      const route = findRoute(env.map, p, q, w, h, { partial: false });
      if (route) candidates.push({ q, score: route.length + horizontal(q, object.point) * 2 });
    }
    return candidates.sort((a, b) => a.score - b.score)[0]?.q;
  };
  const explore = toward => {
    const p = latest.position, direction = toward ? lookAt(p, toward).yawDegrees : heading;
    const distance = toward ? Math.min(travelRange, horizontal(p, toward)) : travelRange;
    const candidates = [0, 45, -45, 90, -90, 180].map(offset => {
      const radians = normalize(direction + offset) * Math.PI / 180;
      const q = { x: Math.floor(p.x + Math.sin(radians) * distance) + .5, y: p.y,
        z: Math.floor(p.z + Math.cos(radians) * distance) + .5, horizontalOnly: true, arrivalRadius: 4 };
      return { q, score: (visits.get(area(q)) ?? 0) * 8 + Math.abs(offset) / 90 };
    });
    // One distant move_to goal owns all local replanning; resource scans resume at the next patch.
    for (const { q } of candidates.sort((a, b) => a.score - b.score))
      if (findRoute(env.map, p, q, latest.body.halfWidth, latest.body.height)) return q;
    return candidates[attempts++ % candidates.length].q;
  };

  try {
    initial = await observe(true); heading = initial.orientation.yawDegrees;
    visits.set(area(initial.position), 1);
    if (!initial.motion.onGround) throw Error('Start grounded');
    if (!initial.capabilities.includes('nearby_awareness')) throw Error('Update mod: nearby_awareness required');
    await aim({ yawDegrees: heading, pitchDegrees: 15 });
    while (true) {
      await observe(true);
      if (gained >= count) return { ok: true, goal: 'gather_sticks', count, gained, moved: +moved.toFixed(1), searched };
      report('searching');
      const objects = await scan(8);
      if (!objects.some(o => loose(o) && o.withinPickingRange)) await scan(sightRange);
      {
        const ready = objects.find(o => loose(o) && o.withinPickingRange && (rejected.get(o.key) ?? 0) <= now());
        if (ready) {
          report('pickup', { target: ready.key });
          await aim(ready.look);
          const aimed = await observe();
          if (aimed.target?.key === ready.key) {
            const before = stickCount(aimed);
            await send({ action: 'interact', expectedTarget: ready.key, durationMs: 150 });
            await wait(500);
            const after = await observe();
            if (stickCount(after) > before) seen.delete(ready.key);
            else rejected.set(ready.key, now() + 30000);
            report('verified', { target: ready.key });
          } else rejected.set(ready.key, now() + 5000);
        }
      }
      await observe(true);
      if (gained >= count) continue;
      for (const [id, object] of seen) if (now() - object.seenAt > 120000) seen.delete(id);
      while (seen.size > 256) seen.delete(seen.keys().next().value);
      const target = [...seen.values()].filter(o => (rejected.get(o.key) ?? 0) <= now())
        .sort((a, b) => horizontal(a.point, latest.position) - horizontal(b.point, latest.position))[0];
      if (target) {
        const destination = approach(target);
        if (destination) {
          const result = await walk(destination);
          if (result.state !== 'arrived') rejected.set(target.key, now() + 15000);
          continue;
        }
        if (horizontal(latest.position, target.point) > 6) {
          await walk(explore(target.point));
          continue;
        }
        rejected.set(target.key, now() + 15000);
      }
      for (const [id, tree] of trees) if (now() - tree.seenAt > 120000 || visits.has(id)) trees.delete(id);
      while (trees.size > 128) trees.delete(trees.keys().next().value);
      if (!trees.size) await scan(sightRange, 'leaves');
      const tree = [...trees.values()].sort((a, b) => horizontal(a.point, latest.position) - horizontal(b.point, latest.position))[0];
      const destination = explore(tree?.point);
      const before = latest.position;
      await walk(destination);
      if (horizontal(before, latest.position) > 1) heading = lookAt(before, latest.position).yawDegrees;
      else { heading = normalize(heading + 90); await wait(250); }
    }
  } finally {
    await env.send({ action: 'stop' });
  }
}
