import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameClient } from '../src/runtime/game.ts';
import { SightingsMemory } from '../src/runtime/navigation/sightings.ts';

const ripe = 'block:0:1:2:3:game:crop-rye-9';
const growing = 'block:0:1:2:3:game:crop-rye-1';

test('observed replacement crops invalidate the former ripe sighting', () => {
  const memory = new SightingsMemory();
  memory.apply({ clock: 100, sightings: [[ripe, 'block', 'game:crop-rye-9', 1.5, 2, 3.5, 'seen', 100]] });
  memory.apply({ clock: 200, sightings: [[growing, 'block', 'game:crop-rye-1', 1.5, 2, 3.5, 'seen', 200]] });
  assert.equal(memory.records.has(ripe), false);
  assert.equal(memory.records.has(growing), true);
});

test('only observed changed terrain invalidates a food lead', () => {
  const game = new GameClient(async () => ({ ok: false }));
  game.sightings.apply({ clock: 100, sightings: [[ripe, 'block', 'game:crop-rye-9', 1.5, 2, 3.5, 'seen', 100]] });
  const update = row => game.remember({ terrain: { session: 'test', cursor: 1, clock: 200, cells: [row] } });
  update([1, 2, 3, 200, null, null, 'forgot']);
  assert.equal(game.sightings.records.has(ripe), true, 'leaving view is not a harvest');
  update([1, 2, 3, 50, null, [], null]);
  assert.equal(game.sightings.records.has(ripe), true, 'older terrain cannot erase a newer sighting');
  update([1, 2, 3, 200, null, [], null]);
  assert.equal(game.sightings.records.has(ripe), false, 'observed air must erase harvested food');
});
