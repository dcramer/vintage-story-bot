import { horizontal } from '../../../runtime/navigation/terrain.ts';
import type { Alongside } from '../concern.ts';

export const suppliesMarker: Alongside = {
  id: 'supplies',
  act: ({ memory, markers, state }) => {
    const stash = memory.notes.stash;
    if (!stash || !state.capabilities?.includes('map_waypoint_add')) return null;
    const marker = markers.find(m => m.title === 'Shared supplies');
    if (marker && horizontal(marker.position, stash) < 2) return null;
    return {
      act: [
        ...(marker ? [{ action: 'remove_map_waypoint', guid: marker.guid }] : []),
        { action: 'add_map_waypoint', title: 'Shared supplies', x: stash.x, y: stash.y, z: stash.z, icon: 'chest', color: '#d6a64b' },
      ],
      why: 'marking the supplies for teammates',
    };
  },
};
