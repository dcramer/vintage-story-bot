import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cook } from '../src/goals/cook.ts';
import { remember } from '../src/support/facts.ts';

test('cooking refuses to ignite when it cannot move clear of the cold firepit', async () => {
  remember('test:root', { combustible: { smeltsInto: 'test:cooked-root', smeltedRatio: 1 } });
  remember('test:cooked-root', { nutrition: { saturation: 100, health: 0 } });
  for (const available of [false, true]) {
    let walked = false;
    const field = {
      latest: { position: { x: 0.7, y: 0, z: 0.5 }, body: { halfWidth: 0.3 } },
      observe: async () => field.latest,
      approach: (_target, exclude) => {
        assert.equal(exclude({ x: 1.5, z: 0.5 }), true, 'leave room for arrival tolerance');
        assert.equal(exclude({ x: 2.5, z: 0.5 }), false);
        return available ? { x: 2.5, y: 0, z: 0.5 } : null;
      },
      walk: async () => {
        walked = true;
        return { state: 'blocked', reason: 'no_progress' };
      },
      send: async () => {
        throw Error('must not interact while standing in the firepit');
      },
    };
    const result = await cook(field, { target: 'block:0:0:0:0:game:firepit-cold', item: 'test:root', count: 2, fuel: 4 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_safe_cooking_position');
    assert.equal(walked, available);
  }
});
