import { angle, distance, horizontal, key, lookAt, normalize } from '../navigation/terrain.mjs';
import { findRoute } from '../navigation/planner.mjs';

const loose = o => o.kind === 'block' && /^game:loosestick-(free|snow)$/.test(o.code);
const dropped = o => o.kind === 'item' && o.code === 'game:stick';
export const stickCount = state => [...state.hotbar, ...state.backpack]
  .filter(slot => slot.code === 'game:stick').reduce((n, slot) => n + slot.quantity, 0);
const area = p => `${Math.floor(p.x / 3)},${Math.floor(p.z / 3)}`;

// Policy only: supplied runtime owns sensing, input leases and cancellation.
export async function gather(env, { count = 10, timeoutMs, signal, wait = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 64) throw Error('count must be 1–64');
  const started = now(), seen = new Map(), rejected = new Map(), visits = new Map();
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
  const walk = async target => {
    const before = await observe(); report('walking', { target });
    const result = await env.navigate({ ...target, dimension: 0, timeoutMs: 15000 });
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
  const explore = () => {
    const p = latest.position, w = latest.body.halfWidth, h = latest.body.height, candidates = new Map();
    for (const cell of env.map.cells.values()) for (const box of cell.boxes) {
      const q = { x: cell.x + .5, y: box[4], z: cell.z + .5 }, d = horizontal(p, q);
      if (d < 2 || d > 7 || Math.abs(q.y - p.y) > 6 || !env.map.clear(q, w, h) || env.map.support(q, w) !== 9) continue;
      const turn = Math.abs(angle(lookAt(p, q).yawDegrees, heading));
      candidates.set(key(q), { q, score: (visits.get(area(q)) ?? 0) * 8 + turn / 90 - d * .6 });
    }
    for (const { q } of [...candidates.values()].sort((a, b) => a.score - b.score).slice(0, 16)) {
      if (findRoute(env.map, p, q, w, h, { partial: false })) return q;
    }
    const yaw = normalize(heading + attempts++ * 90), radians = yaw * Math.PI / 180;
    return { x: Math.floor(p.x + Math.sin(radians) * 6) + .5, y: p.y, z: Math.floor(p.z + Math.cos(radians) * 6) + .5 };
  };

  try {
    initial = await observe(true); heading = initial.orientation.yawDegrees;
    if (!initial.motion.onGround) throw Error('Start grounded');
    while (true) {
      await observe(true);
      if (gained >= count) return { ok: true, goal: 'gather_sticks', count, gained, moved: +moved.toFixed(1), searched };
      report('searching');
      const scanHeading = heading;
      for (const offset of [0, 90, 180, 270]) {
        await aim({ yawDegrees: normalize(scanHeading + offset), pitchDegrees: 35 });
        const scene = await send({ action: 'scan', kind: 'all', match: 'stick', radius: 8, limit: 32 });
        for (const object of scene.objects.filter(o => loose(o) || dropped(o))) seen.set(object.key, { ...object, seenAt: now() });
        searched++;
        const ready = scene.objects.find(o => loose(o) && o.withinPickingRange && (rejected.get(o.key) ?? 0) <= now());
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
            if (gained >= count) break;
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
        rejected.set(target.key, now() + 15000);
      }
      const destination = explore();
      const before = latest.position;
      await walk(destination);
      if (horizontal(before, latest.position) > 1) heading = lookAt(before, latest.position).yawDegrees;
      else { heading = normalize(heading + 90); await wait(250); }
    }
  } finally {
    await env.send({ action: 'stop' });
  }
}
