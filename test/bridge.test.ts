import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { requestBridge, bridgePort } from '../src/runtime/bridge.ts';
import { tools as actions } from '../src/runtime/registry.ts';
import { uiTools, isBotCommand, validateClick } from '../src/operator/bot-window.ts';
import { normalizeMapView } from '../src/operator/world-map.ts';
import { decodeChunkIndex, decodeMapPiece } from '../src/operator/native-map.ts';

async function fakeBridge(t, handle) {
  const sockets = new Set<any>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let line = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      line += chunk;
      if (line.includes('\n')) handle(socket, JSON.parse(line.trim()));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return (server.address() as any).port;
}

test('validates bridge ports and bounded action inputs', () => {
  assert.equal(bridgePort('42157'), 42157);
  for (const invalid of ['', '0', '65536', '1.2', 'localhost']) assert.throws(() => bridgePort(invalid));
  const move = actions.find(tool => tool.name === 'move').schema;
  for (const durationMs of [0, 2001, 1.5, NaN, Infinity, '250']) assert.equal(move.safeParse({ durationMs }).success, false);
  assert.equal(move.safeParse({ durationMs: 250 }).success, true);
  assert.equal(move.safeParse({ durationMs: 250, action: 'attack' }).success, false);
  assert.equal(move.safeParse({ durationMs: 250, direction: 'backward', jump: true }).success, true);
  assert.equal(move.safeParse({ durationMs: 250, direction: 'teleport' }).success, false);
  assert.equal(actions.find(tool => tool.name === 'look').schema.safeParse({ yawDegrees: 0, pitchDegrees: 90 }).success, false);
  const scan = actions.find(tool => tool.name === 'scan').schema;
  for (const args of [{ radius: 65 }, { radius: 0 }, { limit: 33 }, { kind: 'hidden' }, { match: 'x'.repeat(65) }]) assert.equal(scan.safeParse(args).success, false);
  assert.equal(scan.safeParse({ match: 'stick' }).success, true);
  assert.equal(actions.find(tool => tool.name === 'interact').schema.safeParse({ durationMs: 250, expectedTarget: '' }).success, false);
  const schema = name => actions.find(tool => tool.name === name).schema;
  const destination = { x: 12.5, y: 100, z: 8.5, dimension: 0 };
  assert.equal(schema('move_to').safeParse(destination).success, true);
  assert.equal(schema('move_to').safeParse({ ...destination, timeoutMs: 120000 }).success, true);
  for (const change of [{ x: Infinity }, { y: NaN }, { dimension: 1 }, { timeoutMs: 120001 }, { timeoutMs: 0 }])
    assert.equal(schema('move_to').safeParse({ ...destination, ...change }).success, false);
  assert.equal(schema('gather_sticks').safeParse({ count: 10 }).success, true);
  assert.equal(schema('gather_sticks').safeParse({ count: 65 }).success, false);
  assert.equal(schema('gather_sticks').safeParse({ timeoutMs: 3600001 }).success, false);
  for (const after of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(schema('events').safeParse({ after }).success, false);
  assert.equal(schema('respawn').safeParse({ deathId: '' }).success, false);
  assert.equal(schema('select_hotbar').safeParse({ slot: 10 }).success, false);
  for (const args of [{ match: '' }, { match: 'stick', limit: 9 }, { match: 'stick', offset: -1 }]) assert.equal(schema('recipes').safeParse(args).success, false);
  const transfer = { from: { inventory: 'hotbar', slot: 0 }, to: { inventory: 'craftinggrid', slot: 0 }, expectedState: 'a'.repeat(64), quantity: 1 };
  assert.equal(schema('inventory_move').safeParse(transfer).success, true);
  for (const change of [{ expectedState: '' }, { quantity: 0 }, { quantity: 65 }, { to: { inventory: 'creative', slot: 0 } }]) {
    assert.equal(schema('inventory_move').safeParse({ ...transfer, ...change }).success, false);
  }
});

test('reads fragmented JSON and preserves game errors', async t => {
  const port = await fakeBridge(t, (socket, request) => {
    assert.equal(request.action, 'observe');
    socket.write('{"ok":');
    setImmediate(() => socket.end('false,"error":"Paused"}\n'));
  });
  assert.deepEqual(await requestBridge({ action: 'observe' }, { port }), { ok: false, error: 'Paused' });
});

test('rejects malformed, incomplete, oversized and invalid replies', async t => {
  for (const [reply, expected, options] of ([
    ['not json\n', /Invalid bridge response/, {}],
    ['{"ok":true}', /without a complete response/, {}],
    ['{"ok":true}\n', /size limit/, { maxBytes: 5 }],
    ['null\n', /Invalid bridge response/, {}],
    ['{}\n', /Invalid bridge response/, {}],
  ] as [string, RegExp, object][])) {
    const port = await fakeBridge(t, socket => socket.end(reply));
    await assert.rejects(requestBridge({ action: 'observe' }, { port, ...options }), expected);
  }
});

test('times out without retrying and caps request size', async t => {
  let calls = 0;
  const port = await fakeBridge(t, () => { calls++; });
  await assert.rejects(requestBridge({ action: 'move', durationMs: 250 }, { port, timeoutMs: 40 }), /timed out/);
  assert.equal(calls, 1);
  await assert.rejects(requestBridge({ action: 'x'.repeat(1024) }, { port }), /exceeds/);
  assert.equal(calls, 1);
});


test('UI restricts bot identity, keys and click bounds without touching a display', () => {
  const root = '/repo';
  const argv = ['dotnet', '/repo/.runtime/linux-client/Vintagestory.dll', '--dataPath=/repo/.runtime/bot-data'];
  assert.equal(isBotCommand(argv, root), true);
  assert.equal(isBotCommand(argv.slice(0, 2), root), false);
  assert.equal(isBotCommand([...argv.slice(0, 2), '--dataPath=/personal'], root), false);
  assert.doesNotThrow(() => validateClick({ x: 0, y: 719 }, { width: 1280, height: 720 }));
  for (const point of [{ x: -1, y: 1 }, { x: 1280, y: 1 }, { x: 0, y: 720 }, { x: 0.5, y: 1 }]) {
    assert.throws(() => validateClick(point, { width: 1280, height: 720 }));
  }
  const key = uiTools.find(tool => tool.name === 'ui_key').schema;
  assert.equal(key.safeParse({ key: 'Escape' }).success, true);
  assert.equal(key.safeParse({ key: 'm' }).success, true);
  assert.equal(key.safeParse({ key: 'Alt+F4' }).success, false);
});

test('normalizes native World Map calibration to the captured game window', () => {
  const view = normalizeMapView({ opened: true, world: { x: 512000, z: 512000, dimension: 0 },
    view: { here: [640, 360], east100: [740, 360], south100: [640, 460] } }, 1280, 720);
  assert.deepEqual(view, { world: { x: 512000, z: 512000, dimension: 0 }, here: [.5, .5], east100: [740 / 1280, .5], south100: [.5, 460 / 720] });
  assert.equal(normalizeMapView({ opened: false }, 1280, 720), null);
});

test('decodes Vintage Story native map chunk keys and protobuf RGBA pixels', () => {
  const mask = (1n << 27n) - 1n, encoded = ((BigInt(-11) & mask) << 27n) | (BigInt(17) & mask);
  assert.deepEqual(decodeChunkIndex(encoded), { x: 17, z: -11 });
  const parts = [], expected = Buffer.alloc(4096);
  for (let index = 0; index < 1024; index++) {
    const color = (0xff000000 | index * 7919) >>> 0; expected.writeUInt32LE(color, index * 4);
    let value = BigInt.asUintN(64, BigInt(color | 0)); parts.push(Buffer.from([8]));
    const bytes = [];
    while (value >= 128n) { bytes.push(Number(value & 127n) | 128); value >>= 7n; }
    bytes.push(Number(value)); parts.push(Buffer.from(bytes));
  }
  assert.deepEqual(decodeMapPiece(Buffer.concat(parts)), expected);
});
