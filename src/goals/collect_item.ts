import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { horizontal } from '../runtime/navigation/terrain.ts';
import { carriedCount, itemCount } from '../support/inventory.ts';
import { runField } from '../support/task.ts';

export async function collectItem(field, { target, expectedItem, radius = 8 }) {
  await field.observe();
  const before = await field.send({ action: 'inventory' });
  const initialCount = itemCount(before, expectedItem);
  const sight = () => field.scan(radius, expectedItem.slice(0, 64), 'items');
  const find = objects => objects.find(o => o.key === target && o.code === expectedItem);
  let drop = find(await sight());
  if (!drop || !Number.isInteger(drop.quantity) || drop.quantity < 1)
    throw Error('Dropped item not currently visible or identity changed; scan again');
  const wanted = drop.quantity;
  const success = gained => ({
    ok: true,
    goal: 'collect_item',
    target,
    item: expectedItem,
    wanted,
    gained,
    moved: +field.moved.toFixed(1),
    verification: 'inventory_delta',
  });
  while (true) {
    await field.observe(true);
    let gained = itemCount(await field.send({ action: 'inventory' }), expectedItem) - initialCount;
    if (gained >= wanted) return success(gained);
    field.report('collecting', { target, item: expectedItem, wanted, gained });
    if (!drop || horizontal(field.latest.position, drop.point) < 1.2) {
      // Native pickup/server inventory updates can lag behind arrival or entity removal.
      for (let i = 0; i < 8; i++) {
        await field.wait(200);
        await field.observe();
        gained = itemCount(await field.send({ action: 'inventory' }), expectedItem) - initialCount;
        if (gained >= wanted) return success(gained);
      }
    }
    drop = find(await sight());
    if (!drop) return { ok: false, reason: 'target_lost_without_verified_pickup', target, wanted, gained };
    await field.observe(true);
    let destination = field.approach(drop);
    const p = field.latest.position,
      distance = horizontal(p, drop.point);
    if (distance > 6) {
      // Travel in short legs and reacquire the actual entity, not a remembered vanished drop.
      destination = {
        x: p.x + ((drop.point.x - p.x) * 6) / distance,
        y: p.y,
        z: p.z + ((drop.point.z - p.z) * 6) / distance,
        horizontalOnly: true,
        arrivalRadius: 0.5,
      };
    }
    if (!destination) return { ok: false, reason: 'no_safe_pickup_position', target, wanted, gained };
    const result = await field.walk(destination, state => (carriedCount(state, expectedItem) - initialCount >= wanted ? 'pickup_observed' : null));
    gained = itemCount(await field.send({ action: 'inventory' }), expectedItem) - initialCount;
    if (gained >= wanted) return success(gained);
    if (!['arrived', 'paused'].includes(result.state)) return { ok: false, reason: result.reason ?? 'pickup_route_blocked', target, wanted, gained };
    drop = find(await sight());
  }
}

export default defineGoal({
  name: 'collect_item',
  schema: z
    .object({
      target: z
        .string()
        .max(64)
        .regex(/^entity:\d+$/)
        .describe('Specific dropped-item key from scan, not a loose-item block.'),
      expectedItem: z.string().min(1).max(160),
      radius: z.number().int().min(1).max(64).default(8),
      sprint: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).max(120000).default(60000),
    })
    .strict(),
  destructive: true,
  description:
    'Approach a currently visible dropped stack using safe navigation and native proximity pickup. ' +
    'Reacquires its identity between travel legs; no searching other targets, clicking, digging or ' +
    'swimming. Requires inventory gain covering its initially observed quantity; disappearance alone ' +
    'is not success. Delta does not prove entity causality. Partial pickup, lost targets and blocked ' +
    'routes report failure; damage/deadline/stop interrupt. Returns START; poll goal_status.',
  announce: () => 'Picking something up.',
  run: (env, options) => runField(env, options, ['inventory'], (field, _, o) => collectItem(field, o)),
});
