import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export default defineAction({
  name: 'goals',
  schema: z.object({ limit: z.number().int().min(1).max(64).default(16) }).strict(),
  readOnly: true,
  idempotent: true,
  description:
    'Recent goals, newest first: id, kind, args, state, reason, who started it and when. The active goal comes first. ' +
    'Last 64 retained until controller restart; goal_status reads one in full. No game I/O.',
  local: async (runtime, { limit }) => {
    const rows = [...runtime.history.values()].reverse();
    if (runtime.active && !rows.some(row => row.id === runtime.active.id)) rows.unshift(runtime.goalView(runtime.active));
    return {
      ok: true,
      active: runtime.active ? runtime.active.id : null,
      goals: rows.slice(0, limit).map(({ id, kind, args, state, reason, by, startedAt, finishedAt, intent }) => ({
        id,
        kind,
        args,
        state,
        reason,
        by,
        startedAt,
        finishedAt,
        intent,
      })),
    };
  },
});
