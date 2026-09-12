// Besieged: something has prowled outside the sealed burrow for a while by day. The
// mouth opens onto it; a player cuts stairs out the far side instead, and the burrow is
// left behind once they reach daylight. Rock needs a pickaxe the bot does not have, so
// a tunnel that fails is set aside and the ladder opens the mouth and runs instead.
import { fleeTarget } from '../../../support/threats.ts';
import type { Concern } from '../concern.ts';

// How long a threat outside a sealed burrow is waited out by day before tunnelling away from it.
export const SIEGE_MS = 3 * 60 * 1000;
export const TUNNEL_DISTANCE = 12;
// Bearings tried before the tunnel is given up: away from the threat, then a quarter turn either side.
export const TUNNEL_TRIES = 3;
const turned = (position: { x: number; z: number }, away: { x: number; z: number }, quarter: number) => {
  const dx = away.x - position.x,
    dz = away.z - position.z;
  return quarter === 0 ? away : quarter === 1 ? { x: position.x - dz, z: position.z + dx } : { x: position.x + dz, z: position.z - dx };
};

export const tunnel: Concern = {
  id: 'tunnel',
  uncuttable: true,
  run: ({ state, memory, danger }) => {
    const off = danger ? fleeTarget(state.position, danger, TUNNEL_DISTANCE) : { x: state.position.x + TUNNEL_DISTANCE, z: state.position.z };
    const away = turned(state.position, off, memory.tunnelTries % TUNNEL_TRIES);
    memory.pit = { x: away.x, y: state.position.y, z: away.z };
    return {
      start: 'dig_out',
      args: { x: away.x, z: away.z },
      why: `${danger?.code ?? 'something'} prowling outside for too long; tunnelling out, bearing ${(memory.tunnelTries % TUNNEL_TRIES) + 1} of ${TUNNEL_TRIES}`,
    };
  },
  // Rock on one bearing is not rock on every bearing: set aside only once each has been tried.
  setAside: (_last, memory) => ++memory.tunnelTries >= TUNNEL_TRIES,
  ended: (last, memory) => {
    memory.pit = null;
    if (!last.ok) return;
    memory.burrow = null;
    memory.besiegedAt = null;
    memory.tunnelTries = 0;
  },
};
