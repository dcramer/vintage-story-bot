import assert from 'node:assert/strict';
import test from 'node:test';
import { hunt } from '../src/goals/hunt.ts';

test('a terrestrial hunt refuses to start swimming after prey', async () => {
  const state = {
    ok: true,
    alive: true,
    controlReady: true,
    mounted: false,
    player: { uid: 'hunter' },
    position: { x: 0.5, y: 10, z: 0.5, dimension: 0 },
    orientation: { yawDegrees: 0 },
    body: { eyeHeight: 1.6 },
    motion: { onGround: true, swimming: true, feetInLiquid: true },
    life: { session: 'life', alerts: [], lastDamageAt: null },
    condition: { temporalStorm: { phase: 'clear' } },
    capabilities: [],
  };
  const env = {
    sync: async () => state,
    send: async request => (request.action === 'stop' ? { ok: true } : state),
  };

  await assert.rejects(() => hunt(env, { match: 'hare', count: 1 }), /Gameplay interruption: life, controls or liquid/);
});
