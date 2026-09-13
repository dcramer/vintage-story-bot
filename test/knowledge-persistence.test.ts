import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Knowledge } from '../src/runtime/navigation/knowledge.ts';
import { SightingsMemory } from '../src/runtime/navigation/sightings.ts';
import { SurfaceMemory } from '../src/runtime/navigation/surface.ts';
import { TerrainMemory } from '../src/runtime/navigation/terrain.ts';

function fixture() {
  const memories = { map: new TerrainMemory(), surface: new SurfaceMemory(), sightings: new SightingsMemory() };
  const dir = mkdtempSync(join(tmpdir(), 'seraph-persistence-'));
  const knowledge = new Knowledge(dir, memories);
  knowledge.enter('a');
  const put = (x: number, code: string) => {
    memories.map.put({ x, y: 0, z: 0, at: 1, seenAt: Date.now(), traits: [], code, boxes: [] });
    knowledge.touch();
  };
  const read = (world = 'a') => JSON.parse(readFileSync(knowledge.file(world), 'utf8'));
  return { knowledge, memories, dir, put, read };
}

test('saving preserves a snapshot while new observations remain dirty', async () => {
  const { knowledge, memories, put, read } = fixture();
  for (let x = 0; x < 8192; x++) put(x, 'game:stone');
  const expected = memories.map.export();
  const saving = knowledge.save(true);
  await setImmediate();
  put(0, 'game:soil');
  await saving;
  assert.deepEqual(read().terrain, expected);
  assert.equal(knowledge.dirty, true, 'the in-flight save must not clear later observations');
  await knowledge.save(true);
  assert.deepEqual(read().terrain, memories.map.export());
  assert.equal(knowledge.dirty, false);
  assert.equal(knowledge.status().saving, false);
});

test('world switches during a save restore the newest pending memory without mixing worlds', async () => {
  const { knowledge, memories, put, read } = fixture();
  put(1, 'game:a-old');
  const first = knowledge.save(true);
  await setImmediate();
  put(1, 'game:a-new');
  knowledge.enter('b');
  put(2, 'game:b');
  knowledge.enter('a');
  assert.equal(memories.map.get(1, 0, 0)?.code, 'game:a-new');
  assert.equal(memories.map.get(2, 0, 0), undefined);
  await knowledge.save(true);
  await first;
  assert.equal(read('a').terrain[0][6], 'game:a-new');
  assert.equal(read('b').terrain[0][6], 'game:b');
});

test('a failed partial write preserves the last file and permits another save', async () => {
  const { knowledge, memories, dir, put, read } = fixture();
  put(1, 'game:original');
  await knowledge.save(true);
  const original = read();
  put(1, 'game:changed');
  const encode = memories.map.export;
  memories.map.export = () => {
    throw new Error('simulated encoding failure');
  };
  await assert.rejects(knowledge.save(true), /simulated encoding failure/);
  assert.deepEqual(read(), original);
  assert.equal(knowledge.dirty, true);
  assert.equal(knowledge.status().saving, false);
  assert.equal(
    readdirSync(dir).some(name => name.endsWith('.tmp')),
    false,
  );
  memories.map.export = encode;
  await knowledge.save(true);
  assert.equal(read().terrain[0][6], 'game:changed');
  assert.equal(knowledge.status().error, null);
});
