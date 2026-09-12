// Copper seen in passing: a marker and a word to the others, once per nugget,
// unless one is already marked nearby. Copper lies where its nuggets show; one
// marker per 32 blocks is enough to find the spot again.
import { horizontal } from '../../../runtime/navigation/terrain.ts';
import type { Aside } from '../concern.ts';

export const COPPER = /nativecopper/;
export const COPPER_TITLE = 'Copper';
export const MARKER_RADIUS = 32;

export const copper: Aside = {
  id: 'copper',
  act: ({ events, markers, memory }) => {
    const nugget = events.find(e => e.type === 'sighted' && e.kind === 'block' && COPPER.test(e.code ?? '') && !memory.marked.has(e.key));
    if (!nugget) return null;
    memory.marked.add(nugget.key);
    if (markers.some(m => m.title === COPPER_TITLE && horizontal(m.position, nugget.point) < MARKER_RADIUS)) return null;
    const x = Math.floor(nugget.point.x),
      y = Math.floor(nugget.point.y),
      z = Math.floor(nugget.point.z);
    return {
      act: [
        { action: 'add_map_waypoint', title: COPPER_TITLE, x, y, z, icon: 'rocks', color: '#ff8800' },
        { action: 'chat', message: `Found copper at ${x}, ${z}.` },
      ],
      why: `${nugget.code} sighted`,
    };
  },
};
