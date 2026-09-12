// Home on the map, once per home: the operator and the others find it there,
// and a home that moved takes its marker along. The note is the truth; the
// marker mirrors it.
import { horizontal } from '../../../runtime/navigation/terrain.ts';
import type { Aside } from '../concern.ts';

export const HOME_TITLE = 'Home';
// A marker this far from the note is stale.
export const HOME_MARKER_RADIUS = 4;

export const homeMarker: Aside = {
  id: 'home',
  act: ({ home, memory, markers, state }) => {
    if (!home || memory.homeMarked || !state.capabilities?.includes?.('map_waypoint_add')) return null;
    const marker = markers.find(m => m.title === HOME_TITLE);
    memory.homeMarked = true;
    if (marker && horizontal(marker.position, home) <= HOME_MARKER_RADIUS) return null;
    return {
      act: [
        ...(marker ? [{ action: 'remove_map_waypoint', guid: marker.guid }] : []),
        {
          action: 'add_map_waypoint',
          title: HOME_TITLE,
          x: Math.floor(home.x),
          y: Math.floor(home.y),
          z: Math.floor(home.z),
          icon: 'home',
          color: '#22aa22',
        },
      ],
      why: marker ? 'home moved' : 'home built',
    };
  },
};
