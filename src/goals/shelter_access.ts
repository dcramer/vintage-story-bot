import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { selectCell } from '../support/blocks.ts';
import { shelterDoorCells, shelterGate, shelterGateState } from '../support/shelter-door.ts';
import { runField } from '../support/task.ts';
import { digArea } from './build.ts';
import { travel } from './travel.ts';
import { useOnBlock } from './use_block.ts';

const cell = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict();

export async function shelterAccess(field, survival, { door, home, direction }) {
  const cells = shelterDoorCells(door);
  const outside = { x: door.x + 0.5, y: door.y, z: door.z + 1.5 };
  const failure = (reason, extra = {}) => ({ ok: false, goal: 'shelter_access', direction, reason, ...extra });
  const operate = async (cell, state: 'opened' | 'closed') => {
    await field.observe(true);
    const selected = await selectCell(field, cell);
    if (!shelterGate(selected?.code)) {
      const remembered = field.env.map.get(cell.x, cell.y, cell.z);
      if (direction !== 'leave' || state !== 'opened')
        return failure('gate_missing', { cell, state, code: selected?.code ?? remembered?.code ?? null });
      if (!remembered?.code || remembered.code === 'game:air') return null;
      const cleared = await digArea(field, survival, { cells: [cell], tool: undefined });
      return cleared.ok ? null : failure(cleared.reason ?? 'doorway_obstructed', { cell, state });
    }
    if (shelterGateState(selected.code, state)) return null;
    const used = await useOnBlock(field, {
      target: selected.key,
      item: null,
      holdMs: 150,
      expectAfter: `-${state}-`,
    });
    return used.ok ? null : failure(used.reason ?? `gate_not_${state}`, { cell, state });
  };
  const pass = async target => {
    const moved = await travel(field, survival, { ...target, arrivalRadius: 0.35 });
    return moved.ok ? null : failure(('reason' in moved ? moved.reason : null) ?? 'threshold_unreachable', { phase: direction, target });
  };

  if (direction === 'enter') {
    const approached = await pass(outside);
    if (approached) return approached;
  }
  // Open the lower gate first so it cannot hide the upper gate's selection
  // box. Close in the opposite order for the same reason.
  for (const gate of cells) {
    const failed = await operate(gate, 'opened');
    if (failed) return failed;
  }
  const crossed = await pass(direction === 'enter' ? home : outside);
  if (crossed) return crossed;
  for (const gate of [...cells].reverse()) {
    const code = field.env.map.get(gate.x, gate.y, gate.z)?.code;
    const failed = shelterGate(code) ? await operate(gate, 'closed') : null;
    if (failed) return failed;
  }
  await field.observe(true);
  const closed = cells.every(gate => {
    const code = field.env.map.get(gate.x, gate.y, gate.z)?.code;
    return direction === 'leave' && !shelterGate(code) ? true : shelterGateState(code, 'closed');
  });
  return closed ? { ok: true, goal: 'shelter_access', direction, home, verification: 'client_observed' } : failure('gate_close_not_observed');
}

export default defineGoal({
  name: 'shelter_access',
  schema: z
    .object({
      door: cell,
      home: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict(),
      direction: z.enum(['enter', 'leave']),
      timeoutMs: z.number().int().min(1000).max(3600000).default(600000),
    })
    .strict(),
  destructive: true,
  description:
    'Open both stacked wattle gates of an owned permanent house, cross the threshold, close both gates and verify their state. ' +
    'Unlike a crude door, wattle gates do not randomly fall apart when operated. Returns START; poll goal_status.',
  title: args => (args.direction === 'enter' ? 'Enter and close the shelter' : 'Leave and close the shelter'),
  announce: args => (args.direction === 'enter' ? 'Going inside and closing the door.' : 'Opening the door and stepping outside.'),
  run: (env, { door, home, direction, ...options }) =>
    runField(env, options, ['block_actions'], (field, survival) => shelterAccess(field, survival, { door, home, direction })),
});
