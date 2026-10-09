// nvidia-smi parsing, per-GPU deltas and the settle wait. nvidia-smi is never run.
import test from 'node:test';
import assert from 'node:assert/strict';

import { MIB, NVIDIA_SMI_ARGS, deviceDeltas, measureSettled, parseNvidiaSmi, readGpus } from './gpus.mjs';

const SMI = [
  '0, GPU-be50f6fc-59ec-9c5b-c925-c962344c734c, 10573, 5807, 16380, NVIDIA RTX 2000 Ada Generation',
  '1, GPU-55c35bac-8291-a08a-2cb2-a43648336aa5, 2119, 14261, 16380, NVIDIA RTX 2000 Ada Generation',
  '',
].join('\n');

test('NVIDIA_SMI_ARGS query index, uuid, used/free/total and name, unitless CSV', () => {
  assert.deepEqual(NVIDIA_SMI_ARGS, [
    '--query-gpu=index,uuid,memory.used,memory.free,memory.total,name',
    '--format=csv,noheader,nounits',
  ]);
});

test('parseNvidiaSmi: one row per GPU, MiB converted to bytes, name may hold commas', () => {
  const gpus = parseNvidiaSmi(`${SMI}2, GPU-x, 1, 2, 3, Weird, Name\n`);
  assert.equal(gpus.length, 3);
  assert.deepEqual(gpus[0], {
    index: 0,
    uuid: 'GPU-be50f6fc-59ec-9c5b-c925-c962344c734c',
    name: 'NVIDIA RTX 2000 Ada Generation',
    usedBytes: 10573 * MIB,
    freeBytes: 5807 * MIB,
    totalBytes: 16380 * MIB,
  });
  assert.equal(gpus[0].totalBytes, 17175674880); // the contract fixture's total_bytes
  assert.equal(gpus[2].name, 'Weird, Name');
});

test('parseNvidiaSmi: garbage or an error banner is "unknown", never a partial list', () => {
  assert.equal(parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate with the driver'), null);
  assert.equal(parseNvidiaSmi(''), null);
  assert.equal(parseNvidiaSmi(undefined), null);
  assert.equal(parseNvidiaSmi('0, GPU-a, [N/A], 1, 2, X'), null);
});

test('readGpus runs nvidia-smi with the query and returns null when it fails', async () => {
  const seen = [];
  const ok = await readGpus(async (file, args) => {
    seen.push([file, args]);
    return SMI;
  });
  assert.equal(ok.length, 2);
  assert.deepEqual(seen[0], ['nvidia-smi', NVIDIA_SMI_ARGS]);
  assert.equal(await readGpus(async () => { throw new Error('ENOENT'); }), null);
});

test('deviceDeltas: only cards that GREW past the noise floor are attributed', () => {
  const before = parseNvidiaSmi(SMI);
  const after = before.map((g) => ({ ...g }));
  after[1].usedBytes += 4096 * MIB;
  after[0].usedBytes += 8 * MIB; // another pod's allocator jitter
  assert.deepEqual(deviceDeltas(before, after, 32 * MIB), { 'cuda:1': 4096 * MIB });
  assert.deepEqual(deviceDeltas(before, after.map((g) => ({ ...g, usedBytes: 0 })), 32 * MIB), {});
  assert.deepEqual(deviceDeltas(null, after, 32 * MIB), {});
});

test('measureSettled waits until two consecutive readings agree, then returns the last', async () => {
  const readings = [100, 900, 1500, 1510, 1512].map((mib) => [{ index: 0, uuid: 'u', name: 'n', usedBytes: mib * MIB, freeBytes: 0, totalBytes: 0 }]);
  let i = 0;
  const sleeps = [];
  const settled = await measureSettled({
    read: async () => readings[Math.min(i++, readings.length - 1)],
    sleep: async (ms) => sleeps.push(ms),
    intervalMs: 250,
    toleranceBytes: 32 * MIB,
    maxWaitMs: 10_000,
  });
  assert.equal(settled[0].usedBytes, 1510 * MIB);
  assert.equal(sleeps.length, 3);
});

test('measureSettled gives up at the deadline and returns the latest reading', async () => {
  let mib = 0;
  const settled = await measureSettled({
    read: async () => [{ index: 0, uuid: 'u', name: 'n', usedBytes: (mib += 500) * MIB, freeBytes: 0, totalBytes: 0 }],
    sleep: async () => {},
    intervalMs: 1000,
    toleranceBytes: MIB,
    maxWaitMs: 3000,
  });
  assert.equal(settled[0].usedBytes, 2000 * MIB);
});

test('measureSettled is null when nvidia-smi is unreadable', async () => {
  assert.equal(await measureSettled({ read: async () => null, sleep: async () => {}, intervalMs: 1, toleranceBytes: 1, maxWaitMs: 5 }), null);
});
