import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remember } from '../src/support/facts.ts';
import { decorate, has, traitsOf } from '../src/support/traits.ts';

const page = (code, extra = {}) => remember(code, { ok: true, code, type: 'block', ...extra });
const food = { saturation: 80, health: 0 };

test('traits are read from the page and the facts, not from the code', () => {
  page('game:fruit-redcurrant', { type: 'item', nutrition: food });
  page('game:fruitingbush-redcurrant-ripe', {
    material: 'Plant',
    behaviors: ['FruitingBush'],
    harvest: { drops: [{ code: 'game:fruit-redcurrant' }], requiresGrowth: 'mature' },
    drops: [],
  });
  const bush = growth => ({ kind: 'block', code: 'game:fruitingbush-redcurrant-ripe', facts: { growth } });
  assert.deepEqual(traitsOf(bush('mature')), ['food', 'harvestable', 'plant', 'ready']);
  assert.deepEqual(traitsOf(bush('flowering')), ['growing', 'harvestable', 'plant']);
  assert.deepEqual(traitsOf(bush(undefined)), ['harvestable', 'plant'], 'unknown growth is neither ready nor growing');
  page('game:fancyblock-oak', {
    material: 'Wood',
    behaviors: ['RightClickPickup'],
    replaceable: 0,
    combustible: { burnTemperature: 800, burnDuration: 40 },
  });
  assert.deepEqual(traitsOf({ kind: 'block', code: 'game:fancyblock-oak' }), ['choppable', 'fuel', 'pickup']);
  assert.deepEqual(traitsOf({ kind: 'item', code: 'game:fancyblock-oak' }), ['choppable', 'fuel', 'pickup', 'placeable']);
  page('game:tallgrass-tall-free', { material: 'Plant', replaceable: 6500, drops: [{ code: 'game:drygrass', tool: 'Knife' }] });
  assert.deepEqual(traitsOf({ kind: 'block', code: 'game:tallgrass-tall-free' }), ['cuttable', 'plant', 'replaceable']);
  page('game:ore-rich-nativecopper-granite', { material: 'Ore', miningTier: 1, behaviors: [] });
  assert.deepEqual(traitsOf({ kind: 'block', code: 'game:ore-rich-nativecopper-granite' }), ['mineable', 'ore', 'tier:1']);
  page('game:axe-flint', { type: 'item', tool: 'Axe' });
  assert.deepEqual(traitsOf({ kind: 'item', code: 'game:axe-flint' }), ['tool:Axe']);
});

// Codes the catalog does not carry, so only the prior applies.
test('prior knowledge fills in only what no page says', () => {
  assert.deepEqual(traitsOf({ kind: 'block', code: 'game:loosestick-imagined' }), ['pickup']);
  assert.deepEqual(traitsOf({ kind: 'block', code: 'game:log-grown-nowhere-ud' }), ['choppable']);
  assert.deepEqual(traitsOf({ kind: 'block', code: 'game:leavesbranchy-grown-nowhere' }), ['leaves']);
  assert.deepEqual(traitsOf({ kind: 'block', code: 'game:flower-nowhere-free' }), ['plant', 'replaceable']);
  assert.deepEqual(traitsOf({ kind: 'item', code: 'game:stone-nowhere' }), [], 'only some stones knap');
  assert.equal(has({ kind: 'item', code: 'game:stone-chert' }, 'knappable'), true);
  assert.deepEqual(traitsOf({ kind: 'item', code: 'game:clay-nowhere' }), ['clayformable']);
  assert.deepEqual(traitsOf({ kind: 'item', code: 'game:log-grown-nowhere-ud' }), ['choppable'], 'an unread code may be a block');
  page('game:log-grown-nowhere-ud', { type: 'item' });
  assert.deepEqual(traitsOf({ kind: 'item', code: 'game:log-grown-nowhere-ud' }), [], 'a page that says item is not a block');
  page('game:loosestones-granite-free', { material: 'Stone', behaviors: [] });
  assert.deepEqual(
    traitsOf({ kind: 'block', code: 'game:loosestones-granite-free' }),
    ['mineable'],
    'a page without the behavior wins over the prior',
  );
  assert.deepEqual(traitsOf({ kind: 'block', code: 'game:unheardof' }), []);
  assert.deepEqual(traitsOf(null), []);
});

test('creatures: hostility is prior knowledge, the young are not hunters', () => {
  assert.deepEqual(traitsOf({ kind: 'entity', code: 'game:wolf-male' }), ['hostile']);
  assert.deepEqual(traitsOf({ kind: 'entity', code: 'game:wolf-pup' }), ['creature', 'young']);
  assert.deepEqual(traitsOf({ kind: 'entity', code: 'game:player' }), ['player']);
  page('game:meat-raw', { type: 'item', nutrition: food });
  remember('game:hare-male', { ok: true, code: 'game:hare-male', type: 'entity', drops: [{ code: 'game:meat-raw' }] });
  assert.deepEqual(traitsOf({ kind: 'entity', code: 'game:hare-male' }), ['creature', 'food']);
  assert.equal(has({ code: 'game:drifter-normal', kind: 'entity' }, 'hostile'), true);
  assert.equal(has({ code: 'game:drifter-normal', kind: 'entity', traits: [] }, 'hostile'), false, 'given traits are trusted');
});

test('direct reads carry traits', () => {
  const scan = decorate({ action: 'scan' }, { ok: true, objects: [{ kind: 'block', code: 'game:loosestick-imagined' }] });
  assert.deepEqual(scan.objects[0].traits, ['pickup']);
  const target = decorate({ action: 'inspect_target' }, { ok: true, kind: 'entity', code: 'game:wolf-male' });
  assert.deepEqual(target.traits, ['hostile']);
  const inventory = decorate(
    { action: 'inventory' },
    { ok: true, inventories: [{ name: 'hotbar', slots: [{ slot: 0, code: 'game:clay-nowhere' }, { slot: 1 }] }] },
  );
  assert.deepEqual(inventory.inventories[0].slots[0].traits, ['clayformable']);
  assert.equal(inventory.inventories[0].slots[1].traits, undefined);
  assert.deepEqual(decorate({ action: 'observe' }, { ok: false }), { ok: false });
});
