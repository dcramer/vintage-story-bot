import { horizontal } from '../navigation/terrain.mjs';
import { itemCount, ownedSlots } from './inventory.mjs';
import { travel } from './travel.mjs';

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
  const collected = [], skipped = [];
  const done = new Set();
  while (true) {
    await field.observe(true);
    const drops = (await field.scan(radius, undefined, 'items'))
      .filter(d => !done.has(d.key) && horizontal(d.point, body) <= radius);
    const drop = drops[0];
    if (!drop) break;
    done.add(drop.key);
    const skip = reason => { skipped.push({ key: drop.key, item: drop.code, quantity: drop.quantity, reason }); };
    let inventory = await field.send({ action: 'inventory' });
    if (!hasEmptySlot(inventory)) { skip('bag_full'); continue; }
    const before = itemCount(inventory, drop.code);
    field.report('collecting', { item: drop.code, quantity: drop.quantity, collected: collected.length, skipped: skipped.length });
    const destination = field.approach(drop);
    if (!destination) { skip('no_safe_pickup_position'); continue; }
    const gainedNow = async () => itemCount(await field.send({ action: 'inventory' }), drop.code) - before;
    const result = await field.walk(destination, state => null);
    let gained = await gainedNow();
    // Native proximity pickup and the server's inventory update trail arrival.
    for (let i = 0; i < 8 && gained <= 0; i++) { await field.wait(200); await field.observe(); gained = await gainedNow(); }
    if (gained > 0) collected.push({ item: drop.code, quantity: gained });
    else skip(['arrived', 'paused'].includes(result.state) ? 'pickup_failed' : result.reason ?? 'route_blocked');
  }
  field.report('clearing_marker', { marker: marker.guid });
  const removal = await field.send({ action: 'map_waypoint_remove', guid: marker.guid });
  let markerRemoved = false;
  for (let i = 0; i < 15 && removal.ok && !markerRemoved; i++) {
    await field.wait(200);
    markerRemoved = !(await readMarkers(field)).some(w => w.guid === marker.guid);
  }
  return { ok: true, goal: 'retrieve_body', marker: marker.guid, body, moved: +field.moved.toFixed(1),
    legs: trip.legs, collected, skipped, markerRemoved, verification: 'inventory_delta,map_waypoints' };
}
