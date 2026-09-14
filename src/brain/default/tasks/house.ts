import { FARM_SOIL } from '../../../support/crops.ts';
import { houseFoundationSafe, houseGroundwork, houseSurveyClearing, houseSurveyGroundwork } from '../../../support/house-site.ts';
import { supportedFloor } from '../../../support/sites.ts';
import { house as blueprint, houseScaffold } from '../../../support/structures.ts';
import type { Cell, Concern } from '../concern.ts';
import { allStashes, failedOnItsOwn, goTo, noteContents, selectStash, setHome } from '../concern.ts';

export type Construction = { origin: Cell; phase: 'survey' | 'site' | 'walls' | 'floor' | 'enter'; surveyed?: boolean };
export const RAMMED = 'game:rammed-light-plain';
export const HAY = 'game:hay-normal-ud';
export const HOUSE_BLOCKS = blueprint({ x: 0, y: 0, z: 0 }, RAMMED).length + houseScaffold({ x: 0, y: 0, z: 0 }, RAMMED).length;
const SITE_OFFSETS = Array.from({ length: 25 }, (_, ix) => ix * 2 - 24)
  .flatMap(dx => Array.from({ length: 25 }, (_, iz) => ({ dx, dz: iz * 2 - 24 })))
  .sort((a, b) => Math.hypot(a.dx, a.dz) - Math.hypot(b.dx, b.dz) || a.dx - b.dx || a.dz - b.dz);

// Choose only a level footprint the surroundings actually show, with a dry margin.
// The footprint is much larger than the starter shelter, so inspect a modest
// remembered area instead of requiring the bot to step within six blocks of
// the one suitable patch before it can recognize it.
export function houseSite(terrain: any, position: Cell): Cell | null {
  if (!terrain) return null;
  for (const y of [0, 1, -1, 2, -2].map(dy => Math.floor(position.y) + dy))
    for (const { dx, dz } of SITE_OFFSETS) {
      const origin = { x: Math.floor(position.x) - 4 + dx, y, z: Math.floor(position.z) - 3 + dz };
      if (houseGroundwork(terrain, origin)) return origin;
    }
  return null;
}

export function houseSurveySite(terrain: any, position: Cell): Cell | null {
  if (!terrain) return null;
  for (const y of [0, 1, -1, 2, -2].map(dy => Math.floor(position.y) + dy))
    for (const { dx, dz } of SITE_OFFSETS) {
      const origin = { x: Math.floor(position.x) - 4 + dx, y, z: Math.floor(position.z) - 3 + dz };
      if (houseSurveyGroundwork(terrain, origin)) return origin;
    }
  return null;
}

export const house: Concern = {
  id: 'house',
  title: 'an 8x5 home with rammed-earth walls and an A-frame roof',
  done: s => s.house === true,
  after: ['shelter', 'storage', 'shovel'],
  // Site work and placed blocks survive death. Running away from every nearby
  // creature costs more progress than a keep-inventory respawn, so finish the
  // current construction action and let death itself interrupt if necessary.
  uncuttable: true,
  run: ctx => {
    const { k, memory } = ctx;
    let plan = memory.notes.construction;
    if (plan?.phase === 'walls' && typeof ctx.reading?.terrain?.get === 'function' && !houseFoundationSafe(ctx.reading.terrain, plan.origin)) {
      // A winter collision surface may have fooled an older controller. Do not
      // commit another material batch to seasonal water.
      memory.notes.construction = null;
      plan = null;
    }
    if (!plan) {
      // Prefer known terrain around the established camp. An earlier errand
      // may have left the body far away, but that should not move the planned
      // permanent home or send site search farther from its storage. A camp
      // itself founded on seasonal ice is not an anchor: search around the
      // currently surveyed position until the bot reaches real land.
      const home = memory.notes.home;
      const homeY = home ? Math.floor(home.y) : 0;
      const permanentCamp = home && supportedFloor(ctx.reading.terrain?.get(Math.floor(home.x), homeY - 1, Math.floor(home.z)), homeY);
      const center = permanentCamp ? home : ctx.state.position;
      const ready = houseSite(ctx.reading.terrain, center);
      const origin = ready ?? houseSurveySite(ctx.reading.terrain, center);
      if (!origin) return { start: 'explore', args: { legs: 1, timeoutMs: 180000 }, why: 'looking for level ground for the house' };
      plan = memory.notes.construction = { origin, phase: ready ? 'site' : 'survey' };
    }
    if (plan.phase === 'survey') {
      if (houseGroundwork(ctx.reading.terrain, plan.origin)) plan.phase = 'site';
      else {
        // The exact center may itself be a tree or a ledge. Any nearby
        // viewpoint is enough for the full head sweep; only later block work
        // uses exact cells and verified approaches.
        const viewpoint = { x: plan.origin.x + 4.5, z: plan.origin.z + 3.5 };
        const trip = goTo(ctx, viewpoint, 'surveying the house footprint', 8, 6);
        if (trip) return trip;
        if (!plan.surveyed)
          return {
            start: 'look_around',
            args: { radius: 16, limit: 16, timeoutMs: 60000 },
            why: 'checking the whole house footprint before clearing it',
          };
        const clearing = houseSurveyClearing(ctx.reading.terrain, plan.origin);
        if (clearing.length)
          return {
            start: 'dig_area',
            args: { cells: clearing.slice(0, 12), timeoutMs: 600000 },
            why: 'removing snow, vegetation and trees from the house footprint',
          };
        memory.notes.construction = null;
        return { start: 'explore', args: { legs: 1, timeoutMs: 180000 }, why: 'looking beyond the rejected house footprint' };
      }
    }
    const count = (item: string) => k.slots.reduce((n, s) => n + (s.code?.includes(item) ? s.quantity : 0), 0);
    if (plan.phase === 'site') {
      const groundwork = houseGroundwork(ctx.reading.terrain, plan.origin);
      if (!groundwork) {
        memory.notes.construction = null;
        return { start: 'explore', args: { legs: 1, timeoutMs: 180000 }, why: 'refreshing terrain for a permanent house site' };
      }
      const soils = ['verylow', 'low']
        .map(grade => ({ grade, item: `game:soil-${grade}-none`, count: count(`game:soil-${grade}-none`) }))
        .sort((a, b) => b.count - a.count);
      const soil = soils[0];
      if (groundwork.fill.length > soil.count) {
        const forestFloor =
          soil.grade === 'low' &&
          [...(ctx.reading?.terrain?.cells?.values() ?? [])].some(
            (cell: any) =>
              cell.code?.startsWith('game:forestfloor-') && Math.hypot(cell.x + 0.5 - plan!.origin.x, cell.z + 0.5 - plan!.origin.z) <= 64,
          );
        return {
          start: 'harvest',
          args: {
            match: forestFloor ? 'forestfloor-' : `soil-${soil.grade}-`,
            item: soil.item,
            count: groundwork.fill.length - soil.count,
            tool: 'Shovel',
            timeoutMs: 600000,
          },
          why: 'earth to level the permanent house site',
        };
      }
      return {
        start: 'house',
        args: { ...plan, foundationItem: soil.item, timeoutMs: 1800000 },
        why: 'clearing and leveling the permanent house site',
      };
    }
    if (plan.phase === 'walls' && count(RAMMED) < 6) {
      for (const item of [RAMMED, 'game:packeddirt', 'game:soil-low-none', 'game:soil-verylow-none']) {
        if (count(item) >= (item.includes('soil-') ? 10 : 6)) break;
        const chest = allStashes(memory.notes).find(
          s => Math.hypot(s.x - plan.origin.x, s.z - plan.origin.z) <= 48 && (s.seen?.items[item] ?? 0) > 0,
        );
        if (!chest) continue;
        selectStash(memory, chest);
        return (
          goTo(ctx, chest, 'fetching stored house materials') ?? {
            start: 'take_items',
            args: { target: chest.key, items: [{ item, count: Math.min(28 - count(item), chest.seen.items[item]) }], timeoutMs: 300000 },
            why: 'use stored construction supplies before digging more soil',
          }
        );
      }
      // The handbook's packed-dirt recipe accepts one soil variant per batch;
      // high-fertility soil and mixed partial stacks cannot satisfy that batch.
      const soils = ['verylow', 'low'].map(grade => ({ grade, count: count(`game:soil-${grade}-none`) }));
      soils.sort((a, b) => b.count - a.count);
      let soil = soils[0];
      if (!soil.count) {
        const seen = [...(ctx.reading?.terrain?.cells?.values() ?? [])]
          .filter((c: any) => /^game:soil-(verylow|low)-/.test(c.code ?? '') && !c.hazard)
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
          args: { output: 'game:packeddirt', count: Math.min(24, Math.floor((soil.count - 4) / 6) * 6), exclude: FARM_SOIL, timeoutMs: 300000 },
          why: 'packing soil for rammed earth',
        };
      // The game's forest-floor block is the common exposed form of low soil
      // and its live handbook page says it drops soil-low-none. Use it only
      // when the surroundings actually show it beside the bot; otherwise keep
      // searching for the requested soil block itself.
      const localForestFloor =
        soil.grade === 'low' &&
        [...(ctx.reading?.terrain?.cells?.values() ?? [])].some(
          (cell: any) => cell.code?.startsWith('game:forestfloor-') && Math.hypot(cell.x + 0.5 - plan.origin.x, cell.z + 0.5 - plan.origin.z) <= 64,
        );
      return {
        start: 'harvest',
        args: {
          match: localForestFloor ? 'forestfloor-' : `soil-${soil.grade}-`,
          item: `soil-${soil.grade}-none`,
          count: 28 - soil.count,
          tool: 'Shovel',
          timeoutMs: 600000,
        },
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
      goTo(ctx, { x: plan.origin.x + 4.5, y: plan.origin.y, z: plan.origin.z + 7.5 }, 'returning to the house site') ?? {
        start: 'house',
        args: { ...plan, timeoutMs: 1800000 },
        why: `house ${plan.phase}`,
      }
    );
  },
  // Site preparation is incremental: snow or vegetation cleared before one
  // awkward cell failed remains cleared. Retry the same owned construction
  // site instead of blacklisting the house and wandering off to another job.
  setAside: last => failedOnItsOwn(last) && last.reason !== 'out_of_material' && last.result?.phase !== 'site',
  ended: (last, memory, { now, terrain }) => {
    if (last.kind === 'take_items') noteContents(memory, last, now);
    const plan = memory.notes.construction;
    if (!plan || !last.ok) return;
    if (last.kind === 'look_around' && plan.phase === 'survey') {
      if (houseGroundwork(terrain, plan.origin)) plan.phase = 'site';
      else plan.surveyed = true;
      return;
    }
    if (last.kind === 'dig_area' && plan.phase === 'survey') {
      plan.surveyed = false;
      return;
    }
    if (last.kind === 'house') plan.phase = plan.phase === 'site' ? 'walls' : plan.phase === 'walls' ? 'floor' : 'enter';
    if (last.kind === 'enter_shelter' && plan.phase === 'enter') {
      setHome(memory, last.result.home);
      memory.notes.house = plan.origin;
      memory.notes.dwelling = { door: { x: plan.origin.x + 4, y: plan.origin.y, z: plan.origin.z + 6 }, item: HAY };
      memory.notes.construction = null;
    }
  },
};
