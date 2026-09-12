import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { test } from 'node:test';
import { isBotCommand, uiTools, validateClick } from '../src/operator/bot-window.ts';
import { decodeChunkIndex, decodeMapPiece } from '../src/operator/native-map.ts';
import { mapMode, normalizeMapView } from '../src/operator/world-map.ts';
import { BridgeClient, bridgePort, requestBridge } from '../src/runtime/bridge.ts';
import { tools as actions } from '../src/runtime/registry.ts';

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
      let end = line.indexOf('\n');
      while (end >= 0) {
        const text = line.slice(0, end);
        line = line.slice(end + 1);
        handle(socket, JSON.parse(text));
        end = line.indexOf('\n');
      }
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
  assert.equal(actions.find(tool => tool.name === 'interact').schema.safeParse({ durationMs: 250, expectedTarget: '' }).success, false);
  const schema = name => actions.find(tool => tool.name === name).schema;
  const destination = { x: 12.5, y: 100, z: 8.5, dimension: 0 };
  assert.equal(schema('move_to').safeParse(destination).success, true);
  assert.equal(schema('move_to').safeParse({ ...destination, timeoutMs: 120000 }).success, true);
  for (const change of [{ x: Infinity }, { y: NaN }, { dimension: 1 }, { timeoutMs: 120001 }, { timeoutMs: 0 }])
    assert.equal(schema('move_to').safeParse({ ...destination, ...change }).success, false);
  assert.equal(schema('gather').safeParse({ count: 10 }).success, true);
  assert.equal(schema('gather').safeParse({ count: 65 }).success, false);
  assert.equal(schema('gather').safeParse({ timeoutMs: 3600001 }).success, false);
  for (const after of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(schema('events').safeParse({ after }).success, false);
  assert.equal(schema('respawn').safeParse({ deathId: '' }).success, false);
  assert.equal(schema('select_hotbar').safeParse({ slot: 10 }).success, false);
  for (const args of [{ match: '' }, { match: 'stick', limit: 9 }, { match: 'stick', offset: -1 }])
    assert.equal(schema('recipes').safeParse(args).success, false);
  const transfer = { from: { inventory: 'hotbar', slot: 0 }, to: { inventory: 'craftinggrid', slot: 0 }, expectedState: 'a'.repeat(64), quantity: 1 };
  assert.equal(schema('move_item').safeParse(transfer).success, true);
  for (const change of [{ expectedState: '' }, { quantity: 0 }, { quantity: 65 }, { to: { inventory: 'creative', slot: 0 } }]) {
    assert.equal(schema('move_item').safeParse({ ...transfer, ...change }).success, false);
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
  for (const [reply, expected, options] of [
    ['not json\n', /Invalid bridge response/, {}],
    ['{"ok":true}', /without a complete response/, {}],
    ['{"ok":true}\n', /size limit/, { maxBytes: 5 }],
    ['null\n', /Invalid bridge response/, {}],
    ['{}\n', /Invalid bridge response/, {}],
  ] as [string, RegExp, object][]) {
    const port = await fakeBridge(t, socket => socket.end(reply));
    await assert.rejects(requestBridge({ action: 'observe' }, { port, ...options }), expected);
  }
});

test('times out without retrying and caps request size', async t => {
  let calls = 0;
  const port = await fakeBridge(t, () => {
    calls++;
  });
  await assert.rejects(requestBridge({ action: 'move', durationMs: 250 }, { port, timeoutMs: 40 }), /timed out/);
  assert.equal(calls, 1);
  await assert.rejects(requestBridge({ action: 'x'.repeat(1024) }, { port }), /exceeds/);
  assert.equal(calls, 1);
});

test('pipelines requests on one connection without replacing action ids, and keeps deadlines apart', async t => {
  const port = await fakeBridge(t, (socket, request) => {
    // Answer in reverse order of arrival and leave one request unanswered; requestIds must pair them.
    if (request.action === 'never') return;
    setTimeout(
      () => socket.write(JSON.stringify({ requestId: request.requestId, ok: true, echo: request.action, operation: request.id }) + '\n'),
      request.action === 'slow' ? 30 : 5,
    );
  });
  const server = new BridgeClient({ port });
  t.after(() => server.close());
  const lost = server.request({ action: 'never' }, { timeoutMs: 40 });
  const [slow, fast, block] = await Promise.all([
    server.request({ action: 'slow' }),
    server.request({ action: 'fast' }),
    server.request({ action: 'block_action_begin', id: 'operation-id' }),
  ]);
  assert.equal(slow.echo, 'slow');
  assert.equal(fast.echo, 'fast');
  assert.equal(block.operation, 'operation-id', 'transport correlation must not replace an action operation id');
  assert.equal(server.pending.size, 1);
  await assert.rejects(lost, /timed out/);
  assert.equal(server.pending.size, 0);
  assert.equal(server.socket?.destroyed, false);
});

test('a dropped bridge connection rejects everything in flight and the next request reconnects', async t => {
  let sockets = 0;
  const port = await fakeBridge(t, (socket, request) => {
    sockets++;
    if (request.action === 'cut') return socket.destroy();
    socket.write(JSON.stringify({ requestId: request.requestId, ok: true }) + '\n');
  });
  const server = new BridgeClient({ port });
  t.after(() => server.close());
  // The cut lands first; the request queued behind it on the same connection is lost with it.
  const cut = server.request({ action: 'cut' });
  const waiting = server.request({ action: 'observe' });
  await assert.rejects(cut, /Bridge closed/);
  await assert.rejects(waiting, /Bridge closed/);
  assert.deepEqual(await server.request({ action: 'observe' }), { ok: true });
  assert.equal(sockets, 3);
});

test('UI restricts bot identity, keys and click bounds without touching a display', () => {
  const root = '/repo';
  const argv = ['dotnet', '/repo/.runtime/linux-client/Vintagestory.dll', '--dataPath=/repo/.runtime/bot-data'];
  assert.equal(isBotCommand(argv, root), true);
  assert.equal(isBotCommand(argv.slice(0, 2), root), false);
  assert.equal(isBotCommand([...argv.slice(0, 2), '--dataPath=/personal'], root), false);
  assert.doesNotThrow(() => validateClick({ x: 0, y: 719 }, { width: 1280, height: 720 }));
  for (const point of [
    { x: -1, y: 1 },
    { x: 1280, y: 1 },
    { x: 0, y: 720 },
    { x: 0.5, y: 1 },
  ]) {
    assert.throws(() => validateClick(point, { width: 1280, height: 720 }));
  }
  const key = uiTools.find(tool => tool.name === 'ui_key').schema;
  assert.equal(key.safeParse({ key: 'Escape' }).success, true);
  assert.equal(key.safeParse({ key: 'F6' }).success, true);
  assert.equal(key.safeParse({ key: 'm' }).success, true);
  assert.equal(key.safeParse({ key: 'Alt+F4' }).success, false);
});

test('normalizes native World Map calibration to the captured game window', () => {
  const view = normalizeMapView(
    { opened: true, world: { x: 512000, z: 512000, dimension: 0 }, view: { here: [640, 360], east100: [740, 360], south100: [640, 460] } },
    1280,
    720,
  );
  assert.deepEqual(view, { world: { x: 512000, z: 512000, dimension: 0 }, here: [0.5, 0.5], east100: [740 / 1280, 0.5], south100: [0.5, 460 / 720] });
  assert.equal(normalizeMapView({ opened: false }, 1280, 720), null);
  assert.equal(mapMode({ mode: 'minimap', opened: true }), 'minimap');
  assert.equal(mapMode({ mode: 'world', opened: true }), 'world');
  assert.equal(mapMode({ mode: 'closed', opened: false }), 'closed');
  assert.equal(mapMode({ opened: true }), 'world');
});

test('decodes Vintage Story native map chunk keys and protobuf RGBA pixels', () => {
  const mask = (1n << 27n) - 1n,
    encoded = ((BigInt(-11) & mask) << 27n) | (BigInt(17) & mask);
  assert.deepEqual(decodeChunkIndex(encoded), { x: 17, z: -11 });
  const parts = [],
    expected = Buffer.alloc(4096);
  for (let index = 0; index < 1024; index++) {
    const color = (0xff000000 | (index * 7919)) >>> 0;
    expected.writeUInt32LE(color, index * 4);
    let value = BigInt.asUintN(64, BigInt(color | 0));
    parts.push(Buffer.from([8]));
    const bytes = [];
    while (value >= 128n) {
      bytes.push(Number(value & 127n) | 128);
      value >>= 7n;
    }
    bytes.push(Number(value));
    parts.push(Buffer.from(bytes));
  }
  assert.deepEqual(decodeMapPiece(Buffer.concat(parts)), expected);
});
