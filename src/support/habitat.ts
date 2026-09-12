import { horizontal } from '../runtime/navigation/terrain.ts';

// Where things are found, as a player knows from the handbook and from
// looking: sticks under trees and in the twiggy canopy, loose flint and stones
// on open ground, cattails and reeds at the water's edge, berries and
// mushrooms where forest meets open ground. A search that has seen nothing
// heads for the nearest such place it has not walked yet, from far-view
// memory, instead of walking whichever way it faces.
export type Habitat = 'canopy' | 'edge' | 'shore' | 'open';

// The habitats a block or item code substring is looked for in, best first.
export function habitatsFor(match: string): Habitat[] {
  const m = match.toLowerCase();
  if (/cattail|reed|papyrus|water|clay/.test(m)) return ['shore'];
  if (/leaves|stick|log|mushroom|resin/.test(m)) return ['canopy', 'edge'];
  if (/berry|bush|fruit|crop|flax|flower|food|forage/.test(m)) return ['edge', 'open'];
  if (/soil|grass|stone|flint|peat|sand|gravel/.test(m)) return ['open'];
  return ['edge', 'open'];
}

// The nearest far-view column of the habitat, beyond minDistance and in a
// 16x16 area not yet walked, or null when none is remembered.
export function habitatTarget(
  surface,
  position,
  habitats: Habitat[],
  known: (c: { x: number; z: number }) => boolean,
  { radius = 96, minDistance = 12 } = {},
) {
  if (!surface?.columns?.size) return null;
  const columns = [...surface.columns.values()];
  const kinds = new Map<string, Set<string>>();
  for (const c of columns) {
    let set = kinds.get(c.kind);
    if (!set) kinds.set(c.kind, (set = new Set()));
    set.add(`${c.x},${c.z}`);
  }
  const near = (c, kind: string, r: number) => {
    const set = kinds.get(kind);
    if (!set) return false;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (set.has(`${c.x + dx},${c.z + dz}`)) return true;
    return false;
  };
  const fits = (c, habitat: Habitat) =>
    habitat === 'canopy'
      ? c.kind === 'canopy'
      : habitat === 'edge'
        ? c.kind === 'ground' && near(c, 'canopy', 3)
        : habitat === 'shore'
          ? c.kind === 'ground' && near(c, 'water', 3)
          : c.kind === 'ground';
  for (const habitat of habitats) {
    let best = null,
      bestFar = Infinity;
    for (const c of columns) {
      const far = horizontal(position, { x: c.x + 0.5, z: c.z + 0.5 });
      if (far < minDistance || far > radius || far >= bestFar || known(c) || !fits(c, habitat)) continue;
      best = c;
      bestFar = far;
    }
    if (best) return { x: best.x + 0.5, y: best.y, z: best.z + 0.5, habitat };
  }
  return null;
}
