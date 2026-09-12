// Besieged: something has prowled outside the sealed burrow for a while by day. The
// mouth opens onto it; a player cuts stairs out the far side instead, and the burrow is
// left behind once they reach daylight. Rock needs a pickaxe the bot does not have, so
// a tunnel that fails is set aside and the ladder opens the mouth and runs instead.
import { fleeTarget } from '../../../support/threats.ts';
import type { Concern } from '../concern.ts';

// How long a threat outside a sealed burrow is waited out by day before tunnelling away from it.
export const SIEGE_MS = 3 * 60 * 1000;
export const TUNNEL_DISTANCE = 12;

export const tunnel: Concern = {
  id: 'tunnel',
  uncuttable: true,
  run: ({ state, memory, danger }) => {
    const away = danger ? fleeTarget(state.position, danger, TUNNEL_DISTANCE) : { x: state.position.x + TUNNEL_DISTANCE, z: state.position.z };
    memory.pit = { x: away.x, y: state.position.y, z: away.z };
    return {
      start: 'dig_out',
      args: { x: away.x, z: away.z },
      why: `${danger?.code ?? 'something'} prowling outside for too long; tunnelling out the far side`,
    };
  },
  ended: (last, memory) => {
    memory.pit = null;
    if (!last.ok) return;
    memory.burrow = null;
    memory.besiegedAt = null;
  },
};
