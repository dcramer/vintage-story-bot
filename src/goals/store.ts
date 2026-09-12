import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { distance, horizontal } from '../runtime/navigation/terrain.ts';
import { blockTarget } from '../runtime/schemas.ts';
import { parseBlockKey, selectCell } from '../support/blocks.ts';
import { ownedSlots } from '../support/inventory.ts';
import { cleanName, runField } from '../support/task.ts';

const includes = (code, part) => typeof code === 'string' && code.includes(part);
const sum = slots => slots.reduce((n, s) => n + s.quantity, 0);
const id = address => `${address.inventory}:${address.slot}`;

// Own slots that hold ordinary items: hotbar 0-9 and bag contents, never the bag slots themselves.
const ownSide = inventory =>
  ownedSlots(inventory)
    .filter(s => !s.bag)
    .map(s => ({ ...s, address: { inventory: s.inventory, slot: s.slot } }));
const containerSide = container => container.slots.map(s => ({ ...s, address: { inventory: 'container', slot: s.slot } }));

// While a container dialog is open the mod reports controlReady false, which Fieldwork.guard treats as an
// interruption; life, damage and session changes still end the goal.
async function peek(field) {
  const state = await field.send({ action: 'observe' });
  return field.assess(state, { controls: false });
}

// Aim at one observed container block within native reach and open it: the game shows its dialog after
// the server answers the click, so a first refusal is retried once the dialog has had time to appear.
export async function openContainer(field, { target }) {
  const cell = parseBlockKey(target);
  const selected = await selectCell(field, cell);
  if (!selected || selected.key !== target) throw Error('Target not in native reach, changed or obstructed; no action sent');
  field.report('opening', { target });
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = await field.env.send({ action: 'open_container', target });
    if (result.ok) return result;
    last = result.error;
    await field.wait(250);
    await peek(field);
  }
  throw Error(last ?? 'No container dialog opened; the target may not be a container');
}

export async function closeContainer(field) {
  const result = await field.env.send({ action: 'close_container' });
  for (let i = 0; i < 10 && result.ok; i++) {
    const state = await field.env.send({ action: 'observe' });
    if (state.ok && state.controlReady) break;
    await field.wait(100);
  }
  return result;
}

// Move stacks whose code contains `item` between own inventory and the open container, one transfer at a
// time, each guarded by the container's state token and verified by the counts on both sides. Stops at the
// first unverified move; a refused destination is skipped, never retried.
export async function moveItems(field, { container, item, count = Infinity, direction }) {
  const read = async () => ({
    own: await field.send({ action: 'inventory' }),
    container: { ...(await field.send({ action: 'container_slots' })), target: container.target },
  });
  let view = { own: await field.send({ action: 'inventory' }), container };
  const sides = v => (direction === 'store' ? [ownSide(v.own), containerSide(v.container)] : [containerSide(v.container), ownSide(v.own)]);
  const refused = new Set();
  let moved = 0;
  while (moved < count) {
    const [from, to] = sides(view);
    const source = from.find(s => includes(s.code, item) && s.quantity > 0 && !refused.has(id(s.address)));
    if (!source) return { moved, ...(moved === 0 || Number.isFinite(count) ? { reason: 'none_found' } : {}) };
    const destination = to.find(s => s.code === source.code && !refused.has(id(s.address))) ?? to.find(s => !s.code && !refused.has(id(s.address)));
    if (!destination) return { moved, reason: 'no_room' };
    const quantity = Math.min(64, source.quantity, count - moved);
    const before = { from: sum(from.filter(s => s.code === source.code)), to: sum(to.filter(s => s.code === source.code)) };
    field.report(direction === 'store' ? 'storing' : 'taking', { item: source.code, quantity, moved });
    await peek(field);
    const result = await field.env.send({
      action: 'container_move',
      from: source.address,
      to: destination.address,
      quantity,
      expectedState: view.container.state,
    });
    if (!result.ok && !/No items moved/.test(result.error ?? '')) throw Error(result.error);
    let verified = false;
    for (let i = 0; i < 10 && result.moved > 0; i++) {
      await field.wait(200);
      await peek(field);
      const contents = await read();
      const [nowFrom, nowTo] = sides(contents);
      const delta = sum(nowTo.filter(s => s.code === source.code)) - before.to;
      if (delta === result.moved && sum(nowFrom.filter(s => s.code === source.code)) === before.from - delta) {
        view = contents;
        moved += delta;
        verified = true;
        break;
      }
    }
    if (verified) continue;
    if (result.moved > 0) return { moved, reason: 'transfer_unverified' };
    // Nothing moved: the slot cannot take this stack (full, wrong storage type). Try the next destination.
    refused.add(id(destination.address));
    if (!destination.code) refused.add(id(source.address));
    view = await read();
  }
  return { moved };
}

// Walk to a container, open it, move the requested items in or out, close it. Verified by inventory deltas.
export async function exchange(field, survival, { target, items, direction }) {
  const cell = parseBlockKey(target);
  const center = { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
  const results = [];
  const summary = () => ({ target, direction, items: results, moved: +field.moved.toFixed(1), eaten: survival?.eaten ?? 0 });
  const tried = [];
  let container;
  for (let legs = 0; ; legs++) {
    const state = await field.observe(true);
    const eye = { ...state.position, y: state.position.y + state.body.eyeHeight };
    if (distance(eye, center) <= state.pickingRange - 0.25) {
      try {
        container = { ...(await openContainer(field, { target })), target };
        break;
      } catch (error) {
        if (/interruption|cancelled|deadline/i.test(error.message)) throw error;
        if (legs >= 6) return { ok: false, reason: error.message, ...summary() };
        tried.push({ ...state.position });
      }
    } else if (legs >= 8) return { ok: false, reason: 'container_unreachable', ...summary() };
    await survival?.tend();
    const destination =
      field.approach({ kind: 'block', key: target, point: center }, q => tried.some(t => horizontal(t, q) < 0.6)) ??
      (horizontal(state.position, center) > 6 ? field.explore(center) : null);
    if (!destination) return { ok: false, reason: 'no_standing_spot', ...summary() };
    const result = await field.walk(destination, survival?.pauseWhen);
    if (!['arrived', 'paused'].includes(result.state) && legs >= 3) return { ok: false, reason: result.reason ?? 'route_blocked', ...summary() };
  }
  try {
    for (const want of items) {
      const result = await moveItems(field, { container, item: want.item, count: want.count ?? Infinity, direction });
      results.push({ item: want.item, wanted: want.count ?? null, ...result });
      if (result.reason === 'transfer_unverified') break;
    }
  } finally {
    await closeContainer(field).catch(() => {});
  }
  const ok = results.length === items.length && results.every(r => !r.reason);
  return {
    ok,
    goal: direction,
    ...(ok ? {} : { reason: results.find(r => r.reason)?.reason ?? 'incomplete' }),
    ...summary(),
    verification: 'inventory_delta',
  };
}

export const wanted = z
  .array(
    z
      .object({
        item: z.string().min(1).max(160).describe('Item code substring, e.g. cattailroot or game:flint.'),
        count: z.number().int().min(1).max(999).optional().describe('Omit to move every matching item.'),
      })
      .strict(),
  )
  .min(1)
  .max(16);

export default defineGoal({
  name: 'store',
  schema: z
    .object({
      target: blockTarget.describe('Observed key of a chest, vessel or basket block.'),
      items: wanted,
      manageFood: z.boolean().default(false),
      sprint: z.boolean().default(false),
      timeoutMs: z.number().int().min(5000).max(600000).default(180000),
    })
    .strict(),
  destructive: true,
  description:
    'Walk to an observed container block, open it by right-click, move own items in (merging first, then ' +
    'empty slots) and close it. Each move is verified by counts on both sides; stops at the first unverified ' +
    'or refused move (no_room, transfer_unverified). Returns START; poll goal_status.',
  announce: args => `Putting ${args.items.map(i => cleanName(i.item)).join(', ')} away.`,
  run: (env, options) =>
    runField(env, options, ['containers', 'inventory'], (field, survival, o) => exchange(field, survival, { ...o, direction: 'store' })),
});
