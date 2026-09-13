import { house as blueprint } from '../../../support/structures.ts';
import type { Cell, Concern } from '../concern.ts';
import { failedOnItsOwn, goTo, setHome } from '../concern.ts';

export type Construction = { origin: Cell; phase: 'walls' | 'floor' | 'enter' };
export const RAMMED = 'game:rammed-light-plain';
export const HAY = 'game:hay-normal-ud';
export const HOUSE_BLOCKS = blueprint({ x: 0, y: 0, z: 0 }, RAMMED).length;

// Choose only a level footprint the surroundings actually show, with a dry margin.
export function houseSite(terrain: any, position: Cell): Cell | null {
  if (!terrain) return null;
  const y = Math.floor(position.y);
  for (const dx of [0, -2, 2])
    for (const dz of [0, -2, 2]) {
      const origin = { x: Math.floor(position.x) - 4 + dx, y, z: Math.floor(position.z) - 3 + dz };
      let fits = true;
      for (let x = -1; x <= 10 && fits; x++)
        for (let z = -1; z <= 7 && fits; z++) {
          const ground = terrain.get(origin.x + x, y - 1, origin.z + z);
          if (!ground || ground.hazard || !ground.boxes.length) {
            fits = false;
            break;
          }
          for (let h = 0; h <= 4; h++) {
            const air = terrain.get(origin.x + x, y + h, origin.z + z);
            if (!air || air.hazard || air.boxes.length) {
              fits = false;
              break;
            }
          }
        }
      if (fits) return origin;
    }
  return null;
}

export const house: Concern = {
  id: 'house',
  title: 'an 8x5 home with rammed-earth walls and an A-frame roof',
  done: s => s.house === true,
  after: ['shelter', 'storage', 'shovel'],
  run: ctx => {
    const { k, memory } = ctx;
    let plan = memory.notes.construction;
    if (!plan) {
      const origin = houseSite(ctx.reading.terrain, ctx.state.position);
      if (!origin) return { start: 'explore', args: { legs: 1, timeoutMs: 180000 }, why: 'looking for level ground for the house' };
      plan = memory.notes.construction = { origin, phase: 'walls' };
    }
    const count = (item: string) => k.slots.reduce((n, s) => n + (s.code?.includes(item) ? s.quantity : 0), 0);
    if (plan.phase === 'walls' && count(RAMMED) < 6) {
      // The handbook's packed-dirt recipe accepts one soil variant per batch;
      // high-fertility soil and mixed partial stacks cannot satisfy that batch.
      const soils = ['verylow', 'low', 'medium'].map(grade => ({ grade, count: count(`game:soil-${grade}-none`) }));
      soils.sort((a, b) => b.count - a.count);
      let soil = soils[0];
      if (!soil.count) {
        const seen = [...(ctx.reading?.terrain?.cells?.values() ?? [])]
          .filter((c: any) => /^game:soil-(verylow|low|medium)-/.test(c.code ?? '') && !c.hazard)
          .sort(
            (a: any, b: any) =>
              Math.hypot(a.x - ctx.state.position.x, a.y - ctx.state.position.y, a.z - ctx.state.position.z) -
              Math.hypot(b.x - ctx.state.position.x, b.y - ctx.state.position.y, b.z - ctx.state.position.z),
          )[0] as any;
        soil = soils.find(s => seen?.code?.startsWith(`game:soil-${s.grade}-`)) ?? soils.find(s => s.grade === 'low')!;
      }
      if (count('game:packeddirt') >= 6)
        return {
          start: 'craft_item',
          args: { output: RAMMED, count: Math.min(24, Math.floor(count('game:packeddirt') / 6) * 6), timeoutMs: 300000 },
          why: 'rammed earth for the house',
        };
      if (soil.count >= 10)
        return {
          start: 'craft_item',
          args: { output: 'game:packeddirt', count: Math.min(24, Math.floor((soil.count - 4) / 6) * 6), timeoutMs: 300000 },
          why: 'packing soil for rammed earth',
        };
      return {
        start: 'harvest',
        args: { match: `soil-${soil.grade}-`, item: `soil-${soil.grade}-none`, count: 28 - soil.count, tool: 'Shovel', timeoutMs: 600000 },
        why: 'soil for the house, keeping its door reserve',
      };
    }
    if (plan.phase === 'enter') {
      if (count(HAY) < 2) {
        if (count('drygrass') < 16)
          return {
            start: 'harvest',
            args: { match: 'tallgrass', item: 'drygrass', count: 16 - count('drygrass'), timeoutMs: 600000 },
            why: 'grass for the two hay-bale door blocks',
          };
        return { start: 'craft_item', args: { output: HAY, count: 2 - count(HAY), timeoutMs: 300000 }, why: 'hay bales to seal the house' };
      }
      return {
        start: 'enter_shelter',
        args: {
          door: { x: plan.origin.x + 4, y: plan.origin.y, z: plan.origin.z + 6 },
          home: { x: plan.origin.x + 4.5, y: plan.origin.y - 1, z: plan.origin.z + 3.5 },
          item: HAY,
          timeoutMs: 600000,
        },
        why: 'moving into the completed house',
      };
    }
    return (
      goTo(ctx, { x: plan.origin.x + 4.5, z: plan.origin.z + 7.5 }, 'returning to the house site') ?? {
        start: 'house',
        args: { ...plan, timeoutMs: 1800000 },
        why: `house ${plan.phase}`,
      }
    );
  },
  setAside: last => failedOnItsOwn(last) && last.reason !== 'out_of_material',
  ended: (last, memory) => {
    const plan = memory.notes.construction;
    if (!plan || !last.ok) return;
    if (last.kind === 'house') plan.phase = plan.phase === 'walls' ? 'floor' : 'enter';
    if (last.kind === 'enter_shelter' && plan.phase === 'enter') {
      setHome(memory, last.result.home);
      memory.notes.house = plan.origin;
      memory.notes.dwelling = { door: { x: plan.origin.x + 4, y: plan.origin.y, z: plan.origin.z + 6 }, item: HAY };
      memory.notes.construction = null;
    }
  },
};
