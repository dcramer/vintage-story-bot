import { horizontal } from '../navigation/terrain.mjs';

// Explicit game-code markers only. Neutral wildlife and unknown modded entities
// never become hostile by inference.
const hostileMarkers = ['drifter', 'wolf-', 'bear-', 'locust-', 'bell-', 'bowtorn-', 'shiver-', 'hyena-'];

// Start fleeing only when a hostile enters the actionable perimeter, then
// keep the wider observed perimeter until escape is complete. Using the full
// scan radius for both thresholds makes entities hovering at its edge start
// repeated long evasions despite never approaching the player.
export const threatStartRadius = 20;
export const threatClearRadius = 32;

// Ranged mobs and fast large predators need more reaction time than a walking
// drifter. Keep these explicit by known game code: unknown/modded entities do
// not become dangerous through behavioral inference.
export const threatStartDistance = code => {
  const lower = code.toLowerCase();
  if (lower.includes('bowtorn-')) return 36;
  if (['bear-', 'wolf-', 'hyena-'].some(marker => lower.includes(marker))) return 28;
  return threatStartRadius;
};

export const threatClearDistance = code => {
  const lower = code.toLowerCase();
  if (lower.includes('bowtorn-')) return 48;
  if (['bear-', 'wolf-', 'hyena-'].some(marker => lower.includes(marker))) return 36;
  return threatClearRadius;
};

export const hostileEntity = entity => typeof entity?.code === 'string' &&
  hostileMarkers.some(marker => entity.code.toLowerCase().includes(marker));

export const threatVerticalRange = code => {
  const lower = code.toLowerCase();
  if (lower.includes('bowtorn-')) return 24;
  if (['bear-', 'wolf-', 'hyena-'].some(marker => lower.includes(marker))) return 12;
  return 8;
};

export const nearbyThreats = (state, radius) => (state.nearbyEntities ?? [])
  .filter(entity => hostileEntity(entity) &&
    Math.abs(state.position.y - entity.point.y) <= threatVerticalRange(entity.code) &&
    horizontal(state.position, entity.point) <= (radius ?? threatStartDistance(entity.code)))
  .sort((a, b) => horizontal(state.position, a.point) - horizontal(state.position, b.point));

export const nearbyUnclearedThreats = state => (state.nearbyEntities ?? [])
  .filter(entity => hostileEntity(entity) &&
    Math.abs(state.position.y - entity.point.y) <= threatVerticalRange(entity.code) &&
    horizontal(state.position, entity.point) <= threatClearDistance(entity.code))
  .sort((a, b) => horizontal(state.position, a.point) - horizontal(state.position, b.point));

export const nearestThreat = (state, radius) => nearbyThreats(state, radius)[0] ?? null;
export const nearestUnclearedThreat = state => nearbyUnclearedThreats(state)[0] ?? null;

export const fleeTarget = (position, threat, distance = 32) => {
  const threats = Array.isArray(threat) ? threat : [threat];
  // Pick the compass heading whose endpoint maximizes clearance from the
  // entire visible hostile perimeter. Fleeing only the nearest hostile can
  // route directly into another one, especially at night.
  const candidates = Array.from({ length: 16 }, (_, index) => {
    const radians = index * Math.PI / 8;
    const point = { x: position.x + Math.cos(radians) * distance,
      z: position.z + Math.sin(radians) * distance };
    const clearances = threats.map(entity => horizontal(point, entity.point));
    return { point, minimum: Math.min(...clearances), total: clearances.reduce((sum, value) => sum + value, 0), index };
  });
  candidates.sort((a, b) => b.minimum - a.minimum || b.total - a.total || a.index - b.index);
  const point = candidates[0].point;
  return { x: Math.floor(point.x) + .5, y: position.y,
    z: Math.floor(point.z) + .5, horizontalOnly: true,
    arrivalRadius: 3, sprint: true, emergency: true };
};
