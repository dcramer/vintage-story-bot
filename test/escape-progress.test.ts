import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Fieldwork } from '../src/support/fieldwork.ts';

test('food escape returns control when repeated routes leave the player trapped', async () => {
  let walks = 0;
  const field: any = {
    latest: { position: { x: 0, y: 0, z: 0 }, nearbyEntities: [{ code: 'game:drifter-normal', point: { x: 5, y: 0, z: 0 } }] },
    check: () => {},
    report: () => {},
    now: () => walks * 1000,
    walk: async () => {
      walks++;
      return { state: 'blocked' };
    },
  };
  assert.equal(await Fieldwork.prototype.evadeThreat.call(field), 'blocked');
  assert.equal(walks, 3);
  field.latest.nearbyEntities = [];
  assert.equal(await Fieldwork.prototype.evadeThreat.call(field), false);
});

test('food escape interrupts a stationary walk after one minute', async () => {
  let now = 0;
  const field: any = {
    latest: { position: { x: 0, y: 0, z: 0 }, nearbyEntities: [{ code: 'game:drifter-normal', point: { x: 5, y: 0, z: 0 } }] },
    check: () => {},
    report: () => {},
    now: () => now,
    walk: async (_, pause) => {
      now = 60000;
      assert.equal(pause(field.latest), 'threat_escape_blocked');
      return { state: 'paused', reason: 'threat_escape_blocked' };
    },
  };
  assert.equal(await Fieldwork.prototype.evadeThreat.call(field), 'blocked');
});
