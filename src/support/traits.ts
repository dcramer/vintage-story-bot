import { known } from './facts.ts';
import { edible, foodYield } from './food.ts';
import { hostileEntity, youngEntity } from './threats.ts';

// What a thing affords, read from facts: the handbook page (the catalog, or a
// page read in play), the block facts the eye reported (growth), and the prior
// knowledge a player brings (which creatures hunt, which loose things are
// picked up, which stones knap). Never a hidden-world read and never a label
// the mod chose: the mod reports the game's own typing, Node reads it. Every
// object the bot reports carries `traits`; goals and brains test them instead
// of matching codes.
export const TRAITS = {
  // Blocks: what a hand or a tool does to it.
  pickup: 'a right-click picks it up: loose sticks, stones, flint',
  harvestable: 'a right-click yields its harvest and the block stays: berries, cattail tops',
  ready: 'harvestable now: no growth state needed, or the one it needs is showing',
  growing: 'harvestable later: the growth state the harvest needs is not showing',
  food: 'yields something edible, by harvest or by breaking',
  choppable: 'wood: an axe works it',
  diggable: 'soil, sand, gravel, snow: a shovel works it',
  mineable: 'stone, ore, metal: a pickaxe works it; tier:N says which',
  cuttable: 'plant matter a knife cuts: grass, reeds',
  ore: 'an ore block; worth marking',
  container: 'holds items: chest, basket, vessel',
  climbable: 'a ladder or vine',
  liquid: 'water or lava',
  replaceable: 'placing a block there replaces it: grass, flowers, snow',
  leaves: 'tree canopy',
  plant: 'plant matter',
  // Items and blocks alike.
  fuel: 'burns in a firepit or kiln',
  smeltable: 'melts into something',
  // Items: what it is good for in the hand.
  edible: 'feeds, does not hurt, does not alter the mind',
  bag: 'adds carrying slots',
  placeable: 'a block carried as an item',
  knappable: 'flint or stone: knaps into a tool head',
  clayformable: 'clay: forms into pottery',
  // tool:<Class> names the tool class an item is (Axe, Knife, Shovel, Pickaxe...).
  // Creatures.
  hostile: 'a creature that hunts the player; prior knowledge, never inferred',
  young: 'the young of a species; not a hunter',
  player: 'another player',
  creature: 'a living thing that is neither',
};

// The game's block materials, as what works them.
const materials = {
  Wood: ['choppable'],
  Leaves: ['leaves'],
  Plant: ['plant'],
  Soil: ['diggable'],
  Sand: ['diggable'],
  Gravel: ['diggable'],
  Snow: ['diggable'],
  Ice: ['mineable'],
  Stone: ['mineable'],
  Ore: ['mineable', 'ore'],
  Metal: ['mineable'],
  Ceramic: ['mineable'],
  Glass: ['mineable'],
  Brick: ['mineable'],
  Liquid: ['liquid'],
  Lava: ['liquid'],
};
const toolWorks = { Axe: 'choppable', Shovel: 'diggable', Pickaxe: 'mineable', Knife: 'cuttable', Scythe: 'cuttable', Sickle: 'cuttable' };
// Placing a block over one with this much give replaces it (Block.IsReplacableBy).
const REPLACEABLE = 6000;
// Prior knowledge by code, used only where the page lacks the fact (an older
// catalog, a page never read): what a player knows before reading anything.
const priors: [RegExp, string[]][] = [
  [/^game:(loosestick|loosestones|looseflints)-/, ['pickup']],
  [/^game:log-/, ['choppable']],
  [/^game:leaves/, ['leaves']],
  [/^game:(soil|sand|gravel|snowlayer|snowblock|peat|rawclay)-?/, ['diggable']],
  [/^game:(rock|ore|cobblestone|stonebricks)-/, ['mineable']],
  [/^game:ore-/, ['ore']],
  [/^game:(tallgrass|tallfern|fern|flower|sapling|mushroom|shortgrass|plant-|reedpapyrus|drygrass)/, ['plant', 'replaceable']],
  [/^game:(chest|basket|storagevessel|crock)-?/, ['container']],
];
// The knapping recipes take flint and these stones only; claystone, limestone and the rest do not knap.
const knappable = code => code === 'game:flint' || /^game:stone-(chert|granite|andesite|basalt|obsidian|flint|peridotite)$/.test(code);
const clayformable = code => /^game:clay-/.test(code);

// The traits of one object: a sighting, a scanned object, an inventory slot or
// a bare code. kind is block|item|entity; facts are the eye's (growth).
export function traitsOf(object: { kind?: string; code?: string; facts?: any } | null | undefined): string[] {
  const code = object?.code;
  if (typeof code !== 'string' || !code) return [];
  const page = known(code);
  const kind = object.kind ?? (page?.type === 'entity' ? 'entity' : 'block');
  const set = new Set<string>();
  if (kind === 'entity') {
    if (code === 'game:player') set.add('player');
    else if (hostileEntity({ code })) set.add('hostile');
    else set.add('creature');
    if (youngEntity({ code })) set.add('young');
    if ((page?.drops ?? []).some(drop => edible(known(drop.code)?.nutrition))) set.add('food');
    return [...set].sort();
  }
  // A handbook page describes the kind; the page of the block a held item places is the same page.
  const block = page?.type === 'block';
  if (page) {
    for (const trait of materials[page.material] ?? []) set.add(trait);
    if (page.miningTier > 0) set.add(`tier:${page.miningTier}`);
    const behaviors: string[] = page.behaviors ?? [];
    if (behaviors.includes('RightClickPickup')) set.add('pickup');
    if (page.harvest || behaviors.includes('Harvestable') || behaviors.includes('FruitingBush')) set.add('harvestable');
    if (page.harvest) {
      const need = page.harvest.requiresGrowth,
        growth = object.facts?.growth;
      if (!need || growth === need) set.add('ready');
      else if (growth) set.add('growing');
    }
    for (const drop of [...(page.drops ?? []), ...(page.harvest?.drops ?? [])]) if (toolWorks[drop.tool]) set.add(toolWorks[drop.tool]);
    if (foodYield(object, page)) set.add('food');
    if (page.combustible?.burnTemperature > 0 && page.combustible.burnDuration > 0) set.add('fuel');
    if (page.combustible?.smeltsInto) set.add('smeltable');
    if (page.climbable) set.add('climbable');
    if (page.liquid || page.material === 'Liquid') set.add('liquid');
    if (page.replaceable >= REPLACEABLE) set.add('replaceable');
    if (/Container|Chest|Basket|Vessel|Crock|Barrel/.test(page.class ?? '')) set.add('container');
    if (edible(page.nutrition)) set.add('edible');
    if (page.tool) set.add(`tool:${page.tool}`);
    if (page.bagSlots > 0) set.add('bag');
    if (block && kind === 'item') set.add('placeable');
  }
  if (knappable(code)) set.add('knappable');
  if (clayformable(code)) set.add('clayformable');
  for (const [pattern, traits] of priors) {
    if (!pattern.test(code)) continue;
    for (const trait of traits) {
      const known =
        trait === 'pickup'
          ? page?.behaviors
          : trait === 'replaceable'
            ? page?.replaceable != null
            : trait === 'container'
              ? page?.class
              : page?.material;
      if (!known) set.add(trait);
    }
  }
  return [...set].sort();
}

export const has = (object, trait: string) => (object?.traits ?? traitsOf(object)).includes(trait);

// The traits a page's kind has, for the catalog: a block as it stands, with no growth seen.
export const traitsOfPage = page => traitsOf({ kind: page.type === 'entity' ? 'entity' : page.type === 'block' ? 'block' : 'item', code: page.code });

// Everything the mod returns that names a thing carries its traits. Sightings
// carry theirs from memory; this covers the direct reads.
export function decorate(request, result) {
  if (!result?.ok) return result;
  switch (request?.action) {
    case 'scan':
      for (const object of result.objects ?? []) object.traits = traitsOf(object);
      break;
    case 'inspect_target':
      if (result.code) result.traits = traitsOf(result);
      break;
    case 'observe':
      if (result.target?.code) result.target.traits = traitsOf(result.target);
      break;
    case 'inventory':
      for (const inventory of result.inventories ?? [])
        for (const slot of inventory.slots ?? []) if (slot.code) slot.traits = traitsOf({ kind: 'item', code: slot.code });
      break;
    case 'container_slots':
      for (const slot of result.slots ?? []) if (slot.code) slot.traits = traitsOf({ kind: 'item', code: slot.code });
      break;
  }
  return result;
}
