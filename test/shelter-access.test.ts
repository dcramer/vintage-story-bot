import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crossDoorway, insideDoorway } from '../src/goals/shelter_access.ts';

test('leaving first approaches the inside of the doorway', () => {
  assert.deepEqual(insideDoorway({ x: 10, y: 5, z: 20 }, { x: 10.5, y: 4, z: 17.5 }), { x: 10.5, y: 4, z: 19.5 });
});

test('shelter doorway crossing uses a horizontal threshold waypoint instead of routing over the roof', async () => {
  const door = { x: 10, y: 5, z: 20 };
  const home = { x: 10.5, y: 4, z: 17.5 };
  let walked: any = null;
  const field: any = {
    latest: null,
    report: () => {},
    observe: async () => ({ position: { x: 10.5, y: 5, z: 21.5 } }),
    walk: async target => {
      walked = target;
      field.latest = { position: { x: 10.5, y: 4, z: 19.8 } };
      return { state: 'arrived' };
    },
  };

  assert.equal(await crossDoorway(field, door, home, 'enter'), true);
  assert.deepEqual(walked, { x: 10.5, y: 4, z: 19.5, horizontalOnly: true, arrivalRadius: 0.3 });
});

test('shelter doorway crossing verifies that navigation actually passed the threshold', async () => {
  const position = { x: 10.5, y: 5, z: 21.5 };
  const field: any = {
    latest: null,
    report: () => {},
    observe: async () => ({ position }),
    walk: async () => {
      field.latest = { position };
      return { state: 'blocked' };
    },
  };

  assert.equal(await crossDoorway(field, { x: 10, y: 5, z: 20 }, { x: 10.5, y: 4, z: 17.5 }, 'enter'), false);
});
