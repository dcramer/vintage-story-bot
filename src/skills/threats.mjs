import { horizontal } from '../navigation/terrain.mjs';

// Explicit game-code markers only. Neutral wildlife and unknown modded entities
// never become hostile by inference.
const hostileMarkers = ['drifter', 'wolf-', 'bear-', 'locust-', 'bell-', 'bowtorn-', 'shiver-', 'hyena-'];

export const hostileEntity = entity => typeof entity?.code === 'string' &&
  hostileMarkers.some(marker => entity.code.toLowerCase().includes(marker));

export const nearestThreat = (state, radius = 32) => (state.nearbyEntities ?? [])
  .filter(entity => hostileEntity(entity) && horizontal(state.position, entity.point) <= radius)
  .sort((a, b) => horizontal(state.position, a.point) - horizontal(state.position, b.point))[0] ?? null;

export const fleeTarget = (position, threat, distance = 32) => {
  let dx = position.x - threat.point.x, dz = position.z - threat.point.z;
  const length = Math.hypot(dx, dz);
  if (length < .01) { dx = 0; dz = 1; }
  else { dx /= length; dz /= length; }
  return { x: Math.floor(position.x + dx * distance) + .5, y: position.y,
    z: Math.floor(position.z + dz * distance) + .5, horizontalOnly: true,
    arrivalRadius: 3, sprint: true, emergency: true };
};
