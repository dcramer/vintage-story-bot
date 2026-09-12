import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { horizontal } from '../runtime/navigation/terrain.ts';
import { itemCount, ownedSlots } from '../support/inventory.ts';
import { runField } from '../support/task.ts';
import { travel } from './travel.ts';

export const isDeathMarker = w => w.icon === 'gravestone' || /you died here/i.test(w.title ?? '');
// The map lists markers in creation order, so the last gravestone is the latest death.
export const latestDeathMarker = waypoints => waypoints.filter(isDeathMarker).at(-1);
export const hasEmptySlot = inventory => ownedSlots(inventory).some(s => !s.code);

const readMarkers = async field => {
  const map = await field.send({ action: 'map_waypoints' });
  if (!map.ok) throw Error(map.error ?? 'Map unavailable');
  return map.waypoints;
};

// Walk back to the latest death marker, pick up what fits, then clear the marker.
// TODO: smarter pickup policy (merge into partial stacks, prefer tools over junk,
// drop low-value stacks to make room, fall back to the died event position when
// the map is disabled). Today anything that does not fit is skipped and reported.
export async function retrieveBody(field, survival, { guid, radius = 12, arrivalRadius = 3 }) {
  const markers = await readMarkers(field);
  const marker = guid ? markers.find(w => w.guid === guid) : latestDeathMarker(markers);
  if (!marker) throw Error(guid ? 'No such marker on the map' : 'No death marker on the map');
  const body = marker.position;
  field.report('travelling_to_body', { marker: marker.guid, body });
  const trip = await travel(field, survival, { x: body.x, z: body.z, arrivalRadius });
  if (!trip.ok)
    return {
      ok: false,
      goal: 'retrieve_body',
      reason: (trip as any).reason ?? 'trip_failed',
      marker: marker.guid,
      body,
      moved: +field.moved.toFixed(1),
      legs: trip.legs,
    };
  const collected = [],
    skipped = [];
  const done = new Set();
  while (true) {
    await field.observe(true);
    const drops = (await field.scan(radius, undefined, 'items')).filter(d => !done.has(d.key) && horizontal(d.point, body) <= radius);
    const drop = drops[0];
    if (!drop) break;
    done.add(drop.key);
    const skip = reason => {
      skipped.push({ key: drop.key, item: drop.code, quantity: drop.quantity, reason });
    };
    const inventory = await field.send({ action: 'inventory' });
    if (!hasEmptySlot(inventory)) {
      skip('bag_full');
      continue;
    }
    const before = itemCount(inventory, drop.code);
    field.report('collecting', { item: drop.code, quantity: drop.quantity, collected: collected.length, skipped: skipped.length });
    const destination = field.approach(drop);
    if (!destination) {
      skip('no_safe_pickup_position');
      continue;
    }
    const gainedNow = async () => itemCount(await field.send({ action: 'inventory' }), drop.code) - before;
    const result = await field.walk(destination, _state => null);
    let gained = await gainedNow();
    // Native proximity pickup and the server's inventory update trail arrival.
    for (let i = 0; i < 8 && gained <= 0; i++) {
      await field.wait(200);
      await field.observe();
      gained = await gainedNow();
    }
    if (gained > 0) collected.push({ item: drop.code, quantity: gained });
    else skip(['arrived', 'paused'].includes(result.state) ? 'pickup_failed' : (result.reason ?? 'route_blocked'));
  }
  field.report('clearing_marker', { marker: marker.guid });
  const removal = await field.send({ action: 'map_waypoint_remove', guid: marker.guid });
  let markerRemoved = false;
  for (let i = 0; i < 15 && removal.ok && !markerRemoved; i++) {
    await field.wait(200);
    markerRemoved = !(await readMarkers(field)).some(w => w.guid === marker.guid);
  }
  // A marker still on the map means the body is not recovered as far as anyone can see.
  return {
    ok: markerRemoved,
    goal: 'retrieve_body',
    ...(markerRemoved ? {} : { reason: 'marker_persists' }),
    marker: marker.guid,
    body,
    moved: +field.moved.toFixed(1),
    legs: trip.legs,
    collected,
    skipped,
    markerRemoved,
    verification: 'inventory_delta,map_waypoints',
  };
}

export default defineGoal({
  name: 'retrieve_body',
  schema: z
    .object({
      guid: z.string().min(1).max(80).optional().describe('Death marker guid from map_waypoints; default the latest gravestone.'),
      radius: z.number().int().min(2).max(16).default(12).describe('How far around the marker to look for dropped items.'),
      arrivalRadius: z.number().min(1).max(8).default(3),
      manageFood: z.boolean().default(false),
      sprint: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).max(3600000).optional(),
    })
    .strict(),
  destructive: true,
  description:
    'Travel to the latest "You died here" marker on the game map, pick up the dropped items around it that fit ' +
    'in an empty slot (the rest are skipped and reported; death drops despawn after 10 minutes), then delete the ' +
    'marker like the map screen would. Requires the map_waypoints mod feature. Storm, damage, death and control ' +
    'loss interrupt as travel. Returns START; poll goal_status.',
  announce: () => 'Going back for my things.',
  run: (env, options) => runField(env, { manageFood: false, ...options }, ['inventory', 'map_waypoints'], retrieveBody),
});
