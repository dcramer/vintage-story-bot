import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectItem } from '../src/goals/collect_item.ts';
import { until } from '../src/support/fieldwork.ts';

// A scripted field: what each look and each read returns is a script, time is a counter, and
// every loop a goal runs against it must be bounded by what it watches, never by luck.
function scripted({ states = [{}], inventory = () => ({ inventories: [] }) }: any = {}) {
  let clock = 0,
    looks = 0;
  const field: any = {
    latest: { position: { x: 0, y: 64, z: 0, dimension: 0 }, body: { eyeHeight: 1.6 } },
    moved: 0,
    now: () => clock,
    wait: async (ms: number) => {
      clock += ms;
    },
    observe: async () => {
      looks++;
      return { ok: true, ...(states[Math.min(looks - 1, states.length - 1)] ?? {}), position: field.latest.position };
    },
    send: async (request: any) => (request.action === 'inventory' ? inventory() : { ok: true }),
    report: () => {},
    calls: { walks: 0, scans: 0 },
    get looks() {
      return looks;
    },
  };
  field.until = (condition, options) => until(field, condition, options);
  return field;
}

test('until ends on the first look that meets the condition and reports a miss at the deadline', async () => {
  const met = scripted({ states: [{ activeSlot: 0 }, { activeSlot: 0 }, { activeSlot: 3 }] });
  const hit = await until(met, state => state.activeSlot === 3, { timeoutMs: 2000, everyMs: 100 });
  assert.equal(hit.met, true);
  assert.equal(met.looks, 3);
  assert.equal(met.now(), 200);
  const missed = scripted({ states: [{ activeSlot: 0 }] });
  const miss = await until(missed, state => state.activeSlot === 3, { timeoutMs: 500, everyMs: 100 });
  assert.equal(miss.met, false);
  assert.equal(missed.now(), 500);
  assert.equal(missed.looks, 6);
  const read = scripted({ inventory: () => ({ n: 7 }) });
  const seen = await until(read, (_, contents) => contents.n === 7, { read: () => read.send({ action: 'inventory' }) });
  assert.equal(seen.read.n, 7);
});

test('a drop that is never picked up ends the goal after a bounded number of approaches', async () => {
  const drop = { key: 'entity:9', code: 'game:stick', kind: 'item', quantity: 1, point: { x: 3, y: 64, z: 0 } };
  const field = scripted();
  field.scan = async () => {
    field.calls.scans++;
    return [drop];
  };
  field.approach = () => ({ x: 2.5, y: 64, z: 0.5 });
  field.walk = async () => {
    field.calls.walks++;
    // Arrives beside the drop every time; the pack never gains it.
    field.latest.position = { x: 2.5, y: 64, z: 0.5, dimension: 0 };
    return { state: 'arrived' };
  };
  const result = await collectItem(field, { target: 'entity:9', expectedItem: 'game:stick' });
  assert.equal(result.ok, false);
  assert.equal('reason' in result ? result.reason : null, 'pickup_failed');
  assert.equal(field.calls.walks, 6);
  assert.ok(field.looks < 200, `looked ${field.looks} times`);
});
