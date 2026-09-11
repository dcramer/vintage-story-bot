import { defineGoal } from '../controller/define.mjs';
import { empty as schema } from '../controller/schemas.mjs';

export async function collectStick(send, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const before = await send({ action: 'observe' });
  if (!before.ok || !before.capabilities?.includes('target_guard') || !before.capabilities?.includes('life_events') ||
      !before.alive || before.paused || !(before.controlReady ?? before.mouseGrabbed) || before.life?.alerts?.length) {
    throw new Error('Requires target_guard/life_events and an alive, unpaused bot without vital alerts, with captured mouse.');
  }
  const safe = state => state.ok && state.alive && !state.paused && (state.controlReady ?? state.mouseGrabbed) &&
    state.player.uid === before.player.uid && state.life?.session === before.life?.session &&
    state.life?.lastDamageAt === before.life?.lastDamageAt && !state.life?.alerts?.length;
  const count = state => [...state.hotbar, ...state.backpack]
    .filter(slot => slot.code === 'game:stick').reduce((total, slot) => total + slot.quantity, 0);
  const scene = await send({ action: 'scan', kind: 'blocks', match: 'loosestick', radius: 6, limit: 16 });
  if (!scene.ok) throw new Error(scene.error);
  const target = scene.objects.find(object => object.withinPickingRange && object.code === 'game:loosestick-free');
  if (!target) throw new Error('No reachable loose stick in view. Reorient or approach, then try again.');
  try {
    const look = await send({ action: 'look', ...target.look });
    if (!look.ok) throw new Error(look.error);
    await wait(250);
    const aimed = await send({ action: 'observe' });
    if (!safe(aimed)) throw new Error('Goal interrupted by danger or session change; replan.');
    if (aimed.target?.key !== target.key) throw new Error('Target mismatch; no pickup sent.');
    const result = await send({ action: 'interact', durationMs: 250, expectedTarget: target.key });
    if (!result.ok) throw new Error(result.error);
    await wait(750);
    const after = await send({ action: 'observe' });
    if (!safe(after) ||
        after.target?.key === target.key || count(after) <= count(before)) {
      throw new Error('Pickup not verified. Observe before retrying.');
    }
    return { ok: true, goal: 'collect_stick', gained: count(after) - count(before), target: target.key };
  } finally {
    await send({ action: 'stop' });
  }
}

export default defineGoal({
  name: 'collect_stick',
  schema,
  destructive: true,
  description:
    'Start a shared goal to pick up one already visible/reachable loose stick, verifying ' +
    'inventory gain. Returns START and goal.id; poll observe.goal for result. No ' +
    'movement/exploration. stop cancels globally.',
  announce: () => 'Grabbing a stick.',
  run: env => collectStick(env.send),
});
