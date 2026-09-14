import assert from 'node:assert/strict';
import test from 'node:test';
import clayform from '../src/goals/clayform.ts';

test('clay forming has no implicit deadline', () => {
  const args = clayform.schema.parse({ output: 'game:storagevessel-red-raw' });

  assert.equal(args.timeoutMs, undefined);
});
