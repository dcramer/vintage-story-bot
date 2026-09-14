import assert from 'node:assert/strict';
import test from 'node:test';
import { waitTargetDay } from '../src/goals/wait.ts';

test('wait until a later hour stays on the same day', () => {
  assert.equal(waitTargetDay(144.1875, 4.5, 5), 144.1875 + 0.5 / 24);
});

test('wait until an earlier hour crosses midnight once', () => {
  assert.equal(waitTargetDay(144.875, 21, 5), 144.875 + 8 / 24);
});
