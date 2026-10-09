// The residency agent core: report / load / unload / policy, over a FAKE daemon
// (REST catalogue + SDK instances) and FAKE nvidia-smi readings. No model is
// ever loaded; nothing is spawned.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONTRACT_DEVICE_KEYS, CONTRACT_LOAD_REQUEST, CONTRACT_REPORT_MODEL_KEYS } from './fixtures.mjs';
import { MIB } from './gpus.mjs';
import { ResidencyError, createResidencyAgent } from './residency.mjs';

const GIB = 1024 * MIB;

/** Catalogue as `GET /api/v1/models` lists it: the projector `@?` beside the real quant. */
const CATALOGUE = [
  { key: 'gemma-4-e2b-it-qat@?', type: 'llm', size_bytes: 986_000_000 },
  { key: 'gemma-4-e2b-it-qat@q4_0', type: 'llm', size_bytes: 3_350_000_000 },
  { key: 'granite-guardian-3.3-8b@q4_k_m', type: 'llm', size_bytes: 4_900_000_000 },
  { key: 'qwen@q4', type: 'llm', size_bytes: 1 },
  { key: 'qwen@q8', type: 'llm', size_bytes: 2 },
];

/**
 * A fake LM Studio: `loaded` instances with their applied kvConfig, and two
 * cards whose memory.used a load grows according to the split it was given.
 */
function fakeWorld({ gpuCount = 2, drift, loadError, loadBytes = 4 * GIB } = {}) {
  const gpus = [...Array(gpuCount).keys()].map((index) => ({
    index,
    uuid: `GPU-${index}`,
    name: 'NVIDIA RTX 2000 Ada Generation',
    usedBytes: 2 * GIB,
    freeBytes: 14 * GIB,
    totalBytes: 16 * GIB,
  }));
  const loaded = [];
  const applied = new Map();
  const calls = { loads: [], unloads: [] };
  let seq = 0;
  let greet = true;
  let down = false;

  const grow = (split, bytes, sign) => {
    const disabled = new Set(split?.disabledGpus ?? []);
    const cards = gpus.filter((g) => !disabled.has(g.index));
    for (const card of cards) {
      card.usedBytes += sign * Math.round(bytes / cards.length);
      card.freeBytes = card.totalBytes - card.usedBytes;
    }
  };

  const daemon = {
    async greet() {
      return greet;
    },
    async listModels() {
      if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:1234');
      return CATALOGUE;
    },
    async listLoaded() {
      if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:1234');
      return loaded.map((i) => ({ ...i }));
    },
    async appliedFields(instance) {
      return applied.get(instance.instanceReference) ?? [];
    },
    async load(request) {
      calls.loads.push(request);
      if (loadError) throw new Error(loadError);
      seq += 1;
      const entry = CATALOGUE.find((m) => m.key === request.modelKey);
      const info = {
        type: 'llm',
        identifier: request.identifier,
        modelKey: request.modelKey,
        instanceReference: `ref-${seq}`,
        sizeBytes: entry?.size_bytes ?? 0,
      };
      loaded.push(info);
      const fields = drift ? drift(request.kvConfig.fields) : request.kvConfig.fields;
      applied.set(info.instanceReference, fields);
      const split = request.kvConfig.fields.find((f) => f.key === 'load.gpuSplitConfig')?.value;
      grow(split, loadBytes, +1);
      return { ...info };
    },
    async unload(instance) {
      calls.unloads.push(instance.identifier);
      const at = loaded.findIndex((i) => i.identifier === instance.identifier);
      if (at < 0) throw new Error(`No model found that fits the query: ${instance.identifier}`);
      const [gone] = loaded.splice(at, 1);
      const split = (applied.get(gone.instanceReference) ?? []).find((f) => f.key === 'load.gpuSplitConfig')?.value;
      grow(split, loadBytes, -1);
    },
  };

  /** Seed an instance the agent did NOT load (boot plan / JIT). */
  const seed = (info, fields) => {
    seq += 1;
    const full = { type: 'llm', instanceReference: `boot-${seq}`, ...info };
    loaded.push(full);
    applied.set(full.instanceReference, fields);
  };

  return {
    daemon,
    gpus: { read: async () => gpus.map((g) => ({ ...g })) },
    calls,
    loaded,
    seed,
    setGreet: (v) => (greet = v),
    setDown: (v) => (down = v),
    cards: gpus,
  };
}

const agentFor = (world, extra = {}) => {
  let now = Date.parse('2026-10-09T09:00:00Z');
  const logs = [];
  const agent = createResidencyAgent({
    daemon: world.daemon,
    gpus: world.gpus,
    env: {},
    instance: 'hope-lmstudio-abc',
    clock: () => (now += 1000),
    sleep: async () => {},
    log: (level, event, fields) => logs.push({ level, event, ...fields }),
    measure: { intervalMs: 1, toleranceBytes: 32 * MIB, maxWaitMs: 10, noiseBytes: 32 * MIB },
    ...extra,
  });
  agent.logs = logs;
  return agent;
};

const loadBody = (overrides = {}) => ({ ...structuredClone(CONTRACT_LOAD_REQUEST), ...overrides });

const rejectsWith = async (promise, code, status) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof ResidencyError, `expected ResidencyError, got ${err}`);
    assert.equal(err.code, code);
    if (status !== undefined) assert.equal(err.status, status);
    return true;
  });

// ── report ──────────────────────────────────────────────────────────────────

test('report: every visible GPU as a contract device, even with nothing loaded', async () => {
  const world = fakeWorld();
  const report = await agentFor(world).report();
  assert.equal(report.service, 'lm-studio');
  assert.equal(report.instance, 'hope-lmstudio-abc');
  assert.match(report.reported_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(report.models, []);
  assert.equal(report.devices.length, 2);
  assert.deepEqual(Object.keys(report.devices[1]).sort(), [...CONTRACT_DEVICE_KEYS].sort());
  assert.deepEqual(report.devices[1], {
    id: 'cuda:1',
    kind: 'gpu',
    total_bytes: 16 * GIB,
    free_bytes: 14 * GIB,
    index: 1,
    name: 'NVIDIA RTX 2000 Ada Generation',
    uuid: 'GPU-1',
    process_bytes: null,
  });
});

test('report: a boot-plan instance is reported with its applied config and an ESTIMATED per-card split', async () => {
  const world = fakeWorld();
  world.seed(
    { identifier: 'gemma-4-e2b-it-qat', modelKey: 'gemma-4-e2b-it-qat@q4_0', sizeBytes: 3_350_000_000 },
    [
      { key: 'llm.load.contextLength', value: 65536 },
      { key: 'llm.load.numParallelSessions', value: 10 },
      { key: 'load.gpuSplitConfig', value: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0], customRatio: [] } },
    ],
  );
  const [model] = (await agentFor(world).report()).models;
  assert.deepEqual(Object.keys(model).sort(), [...CONTRACT_REPORT_MODEL_KEYS].sort());
  assert.equal(model.model_ref, 'gemma-4-e2b-it-qat');
  assert.equal(model.engine_key, 'gemma-4-e2b-it-qat@q4_0');
  assert.equal(model.instance_id, 'gemma-4-e2b-it-qat');
  assert.equal(model.device, 'cuda:1');
  assert.equal(model.bytes_source, 'estimated');
  assert.equal(model.bytes, 3_350_000_000);
  assert.deepEqual(model.device_bytes, { 'cuda:1': 3_350_000_000 });
  assert.equal(model.load_config.context_length, 65536);
  assert.equal(model.load_config.parallel, 10);
  assert.equal(model.in_flight, null);
  assert.equal(model.cache, 'llm');
  assert.equal(model.state, 'loaded');
});

test('report: a JIT instance (no identifier of its own) is named by its engine key', async () => {
  const world = fakeWorld();
  world.seed({ identifier: 'qwen@q4', modelKey: 'qwen@q4', sizeBytes: 1 }, []);
  const [model] = (await agentFor(world).report()).models;
  assert.equal(model.model_ref, 'qwen@q4');
  assert.equal(model.engine_key, 'qwen@q4');
  assert.equal(model.device, 'multi');
});

test('report: the daemon being unreachable is a 503, never an empty "nothing loaded"', async () => {
  const world = fakeWorld();
  world.setDown(true);
  await rejectsWith(agentFor(world).report(), 'DAEMON_UNAVAILABLE', 503);
});

// ── load ────────────────────────────────────────────────────────────────────

test('load: the bare catalogue ref resolves to the exact engine key, never the @? projector (E2)', async () => {
  const world = fakeWorld();
  const result = await agentFor(world).load(loadBody());
  assert.equal(result.outcome, 'loaded');
  assert.equal(world.calls.loads.length, 1);
  assert.equal(world.calls.loads[0].modelKey, 'gemma-4-e2b-it-qat@q4_0');
  assert.equal(world.calls.loads[0].identifier, 'gemma-4-e2b-it-qat');
});

test('load: the full profile reaches the daemon — parallel, KV quant and the card (E3)', async () => {
  const world = fakeWorld();
  await agentFor(world).load(loadBody());
  const sent = Object.fromEntries(world.calls.loads[0].kvConfig.fields.map((f) => [f.key, f.value]));
  assert.equal(sent['llm.load.numParallelSessions'], 10);
  assert.equal(sent['llm.load.contextLength'], 65536);
  assert.deepEqual(sent['llm.load.llama.vCacheQuantizationType'], { checked: true, value: 'f16' });
  assert.deepEqual(sent['load.gpuSplitConfig'], { strategy: 'priorityOrder', priority: [1], disabledGpus: [0], customRatio: [] });
});

test('load: per-card bytes are MEASURED around the load and reported as device_bytes', async () => {
  const world = fakeWorld({ loadBytes: 4 * GIB });
  const { model } = await agentFor(world).load(loadBody());
  assert.deepEqual(Object.keys(model).sort(), [...CONTRACT_REPORT_MODEL_KEYS].sort());
  assert.equal(model.device, 'cuda:1');
  assert.equal(model.bytes_source, 'measured');
  assert.deepEqual(model.device_bytes, { 'cuda:1': 4 * GIB });
  assert.equal(model.bytes, 4 * GIB);
  assert.deepEqual(model.load_config, {
    context_length: 65536,
    parallel: 10,
    flash_attention: true,
    kv_cache_quant: { k: 'f16', v: 'f16' },
    gpu_split: { strategy: 'priorityOrder', priority: [1], disabled_gpus: [0], custom_ratio: [] },
  });
  assert.equal(typeof model.load_seconds, 'number');
  assert.match(model.loaded_at, /Z$/);
});

test('load: a split load is `multi` with bytes on both cards', async () => {
  const world = fakeWorld({ loadBytes: 6 * GIB });
  const body = loadBody({ device: null });
  body.load_spec.gpu_split = { strategy: 'evenly', priority: [], disabled_gpus: [], custom_ratio: [] };
  const agent = agentFor(world);
  const { model } = await agent.load(body);
  assert.equal(model.device, 'multi');
  assert.deepEqual(model.device_bytes, { 'cuda:0': 3 * GIB, 'cuda:1': 3 * GIB });
  const [again] = (await agent.report()).models;
  assert.equal(again.bytes_source, 'measured');
  assert.deepEqual(again.device_bytes, { 'cuda:0': 3 * GIB, 'cuda:1': 3 * GIB });
});

test('load: an instance already loaded under that identifier is `already_loaded`, nothing sent', async () => {
  const world = fakeWorld();
  world.seed({ identifier: 'gemma-4-e2b-it-qat', modelKey: 'gemma-4-e2b-it-qat@q4_0', sizeBytes: 3 }, []);
  const result = await agentFor(world).load(loadBody({ pin: true }));
  assert.equal(result.outcome, 'already_loaded');
  assert.equal(world.calls.loads.length, 0);
  assert.equal(result.model.admin_pinned, true);
  assert.equal(result.model.pinned, true);
});

test('load: a second load while one is running is 409 LOAD_IN_PROGRESS (one at a time per daemon)', async () => {
  const world = fakeWorld();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const slowLoad = world.daemon.load;
  world.daemon.load = async (request) => {
    await gate;
    return slowLoad(request);
  };
  const agent = agentFor(world);
  const first = agent.load(loadBody());
  await new Promise((resolve) => setImmediate(resolve));
  await rejectsWith(agent.load(loadBody({ model_ref: 'granite-guardian-3.3-8b', load_spec: {}, device: null })), 'LOAD_IN_PROGRESS', 409);
  release();
  assert.equal((await first).outcome, 'loaded');
  // the lock is released after the load, success or failure
  assert.equal((await agent.load(loadBody({ model_ref: 'granite-guardian-3.3-8b', load_spec: {}, device: null }))).outcome, 'loaded');
});

test('load: read-back drift is LOAD_FAILED naming the fields, and the drifted instance is unloaded', async () => {
  const world = fakeWorld({
    drift: (fields) =>
      fields.map((f) => (f.key === 'llm.load.numParallelSessions' ? { ...f, value: 4 } : f)).filter((f) => f.key !== 'llm.load.llama.vCacheQuantizationType'),
  });
  const agent = agentFor(world);
  await assert.rejects(agent.load(loadBody()), (err) => {
    assert.equal(err.code, 'LOAD_FAILED');
    assert.equal(err.status, 500);
    assert.deepEqual(err.extra.fields, ['llm.load.numParallelSessions', 'llm.load.llama.vCacheQuantizationType']);
    assert.match(err.message, /requested 10 but the daemon applied 4/);
    return true;
  });
  assert.deepEqual(world.calls.unloads, ['gemma-4-e2b-it-qat']);
  assert.equal(world.loaded.length, 0);
});

test('load: HOPE_KVCONFIG_ENFORCE=warn keeps a drifted instance and warns', async () => {
  const world = fakeWorld({ drift: (fields) => fields.filter((f) => f.key !== 'llm.load.numParallelSessions') });
  const agent = agentFor(world, { env: { HOPE_KVCONFIG_ENFORCE: 'warn' } });
  const result = await agent.load(loadBody());
  assert.equal(result.outcome, 'loaded');
  assert.ok(agent.logs.some((l) => l.level === 'warn' && l.event === 'residency.load_config_drift'));
});

test('load: a daemon failure is LOAD_FAILED carrying the engine reason (E12)', async () => {
  const world = fakeWorld({ loadError: 'Failed to load model: CUDA out of memory' });
  const agent = agentFor(world);
  await assert.rejects(agent.load(loadBody()), (err) => {
    assert.equal(err.code, 'LOAD_FAILED');
    assert.match(err.message, /CUDA out of memory/);
    return true;
  });
  assert.ok(agent.logs.some((l) => l.level === 'warn' && l.event === 'residency.load_failed'));
});

test('load: unknown ref is 404 MODEL_UNKNOWN; two quantizations are refused, never guessed', async () => {
  const world = fakeWorld();
  const agent = agentFor(world);
  await rejectsWith(agent.load(loadBody({ model_ref: 'nope', load_spec: {}, device: null })), 'MODEL_UNKNOWN', 404);
  await assert.rejects(agent.load(loadBody({ model_ref: 'qwen', load_spec: {}, device: null })), (err) => {
    assert.equal(err.code, 'LOAD_FAILED');
    assert.equal(err.status, 400);
    assert.deepEqual(err.extra.candidates, ['qwen@q4', 'qwen@q8']);
    return true;
  });
  assert.equal(world.calls.loads.length, 0);
});

test('load: a device the pod does not have is 400 DEVICE_UNAVAILABLE before anything is sent', async () => {
  const world = fakeWorld();
  await assert.rejects(agentFor(world).load(loadBody({ device: 'cuda:5' })), (err) => {
    assert.equal(err.code, 'DEVICE_UNAVAILABLE');
    assert.equal(err.status, 400);
    assert.equal(err.extra.device, 'cuda:5');
    return true;
  });
  assert.equal(world.calls.loads.length, 0);
});

test('load: LMS_GPU_COUNT overrides the detected card count', async () => {
  const world = fakeWorld({ gpuCount: 2 });
  await agentFor(world, { env: { LMS_GPU_COUNT: '3' } }).load(loadBody({ device: 'cuda:2' }));
  const split = world.calls.loads[0].kvConfig.fields.find((f) => f.key === 'load.gpuSplitConfig').value;
  assert.deepEqual(split.disabledGpus, [0, 1]);
});

test('load: an invalid load_spec is 400 LOAD_FAILED naming the field', async () => {
  const world = fakeWorld();
  const body = loadBody();
  body.load_spec.flash_attention = false;
  body.load_spec.kv_cache_quant = { k: 'q8_0', v: 'q8_0' };
  await assert.rejects(agentFor(world).load(body), (err) => {
    assert.equal(err.code, 'LOAD_FAILED');
    assert.equal(err.status, 400);
    assert.equal(err.extra.field, 'load_spec.kv_cache_quant.k');
    return true;
  });
});

// ── unload ──────────────────────────────────────────────────────────────────

test('unload: by identifier; the instance is gone and its measurement forgotten', async () => {
  const world = fakeWorld();
  const agent = agentFor(world);
  await agent.load(loadBody());
  const result = await agent.unload({ model_ref: 'gemma-4-e2b-it-qat', force: false, reason: 'admin' });
  assert.deepEqual(result, { outcome: 'unloaded', model_ref: 'gemma-4-e2b-it-qat' });
  assert.deepEqual(world.calls.unloads, ['gemma-4-e2b-it-qat']);
  assert.deepEqual((await agent.report()).models, []);
});

test('unload: a JIT instance is reached by its engine key AND by the bare ref', async () => {
  const world = fakeWorld();
  world.seed({ identifier: 'gemma-4-e2b-it-qat@q4_0', modelKey: 'gemma-4-e2b-it-qat@q4_0', sizeBytes: 3 }, []);
  world.seed({ identifier: 'granite-guardian-3.3-8b@q4_k_m', modelKey: 'granite-guardian-3.3-8b@q4_k_m', sizeBytes: 3 }, []);
  const agent = agentFor(world);
  assert.equal((await agent.unload({ model_ref: 'gemma-4-e2b-it-qat', force: false })).outcome, 'unloaded');
  assert.equal((await agent.unload({ model_ref: 'granite-guardian-3.3-8b@q4_k_m', force: false })).outcome, 'unloaded');
  assert.deepEqual(world.calls.unloads, ['gemma-4-e2b-it-qat@q4_0', 'granite-guardian-3.3-8b@q4_k_m']);
});

test('unload: nothing by that name is `not_loaded`, not an error', async () => {
  const world = fakeWorld();
  assert.deepEqual(await agentFor(world).unload({ model_ref: 'gemma-4-e2b-it-qat', force: false }), {
    outcome: 'not_loaded',
    model_ref: 'gemma-4-e2b-it-qat',
  });
});

test('unload: a daemon "not found" race is `not_loaded`', async () => {
  const world = fakeWorld();
  world.seed({ identifier: 'x', modelKey: 'qwen@q4', sizeBytes: 1 }, []);
  world.daemon.unload = async () => {
    throw new Error('No model found that fits the query');
  };
  assert.equal((await agentFor(world).unload({ model_ref: 'x', force: false })).outcome, 'not_loaded');
});

test('unload: LM Studio has no in-flight count, so it is 0 — no IN_FLIGHT refusal with or without force', async () => {
  const world = fakeWorld();
  world.seed({ identifier: 'x', modelKey: 'qwen@q4', sizeBytes: 1 }, []);
  assert.equal((await agentFor(world).unload({ model_ref: 'x', force: false })).outcome, 'unloaded');
});

test('unload: `device` limits it to the copy on that card', async () => {
  const world = fakeWorld();
  const on = (n) => [{ key: 'load.gpuSplitConfig', value: { strategy: 'priorityOrder', priority: [n], disabledGpus: [1 - n], customRatio: [] } }];
  world.seed({ identifier: 'x', modelKey: 'qwen@q4', sizeBytes: 1 }, on(0));
  const agent = agentFor(world);
  assert.equal((await agent.unload({ model_ref: 'x', force: false, device: 'cuda:1' })).outcome, 'not_loaded');
  assert.equal((await agent.unload({ model_ref: 'x', force: false, device: 'cuda:0' })).outcome, 'unloaded');
});

// ── policy ──────────────────────────────────────────────────────────────────

test('policy: admin_pinned and ttl live in the agent and show on the report', async () => {
  const world = fakeWorld();
  world.seed({ identifier: 'gemma-4-e2b-it-qat', modelKey: 'gemma-4-e2b-it-qat@q4_0', sizeBytes: 3 }, []);
  const agent = agentFor(world);
  const { model } = await agent.setPolicy('gemma-4-e2b-it-qat', { admin_pinned: true, ttl_seconds: 1800 });
  assert.equal(model.admin_pinned, true);
  assert.equal(model.pinned, true);
  assert.equal(model.ttl_seconds, 1800);
  // an absent field is left alone; ttl null resets to the default
  const second = await agent.setPolicy('gemma-4-e2b-it-qat', { ttl_seconds: null });
  assert.equal(second.model.admin_pinned, true);
  assert.equal(second.model.ttl_seconds, null);
  const [reported] = (await agent.report()).models;
  assert.equal(reported.admin_pinned, true);
});

test('policy: on a model that is not loaded is 404 MODEL_UNKNOWN', async () => {
  await rejectsWith(agentFor(fakeWorld()).setPolicy('nope', { admin_pinned: true }), 'MODEL_UNKNOWN', 404);
});

test('policy: an unload forgets the policy (as the python agent: it lives on the resident entry)', async () => {
  const world = fakeWorld();
  world.seed({ identifier: 'x', modelKey: 'qwen@q4', sizeBytes: 1 }, []);
  const agent = agentFor(world);
  await agent.setPolicy('x', { admin_pinned: true });
  await agent.unload({ model_ref: 'x', force: true });
  world.seed({ identifier: 'x', modelKey: 'qwen@q4', sizeBytes: 1 }, []);
  const [model] = (await agent.report()).models;
  assert.equal(model.admin_pinned, false);
});

// ── health ──────────────────────────────────────────────────────────────────

test('health: true only when the daemon greets', async () => {
  const world = fakeWorld();
  const agent = agentFor(world);
  assert.equal(await agent.healthy(), true);
  world.setGreet(false);
  assert.equal(await agent.healthy(), false);
  world.daemon.greet = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.equal(await agent.healthy(), false);
});

test('ResidencyError serialises to the contract error body', () => {
  const err = new ResidencyError('IN_FLIGHT', 'busy', { status: 409, extra: { in_flight: 1 } });
  assert.deepEqual(err.body(), { error: { code: 'IN_FLIGHT', message: 'busy', in_flight: 1 } });
});

test('load: E13 — growth measured on a DIFFERENT card than the one pinned is logged as a device-order mismatch', async () => {
  const world = fakeWorld({ loadBytes: 4 * GIB });
  // Simulate a daemon whose GPU numbering is the reverse of nvidia-smi's.
  const realLoad = world.daemon.load;
  world.daemon.load = async (request) => {
    const fields = request.kvConfig.fields.map((f) =>
      f.key === 'load.gpuSplitConfig' ? { ...f, value: { ...f.value, disabledGpus: [1] } } : f,
    );
    const info = await realLoad({ ...request, kvConfig: { fields } });
    return info;
  };
  world.daemon.appliedFields = async () => [
    { key: 'llm.load.contextLength', value: 65536 },
    { key: 'llm.load.numParallelSessions', value: 10 },
    { key: 'llm.load.llama.acceleration.offloadRatio', value: 1 },
    { key: 'llm.load.llama.flashAttention', value: true },
    { key: 'llm.load.llama.kCacheQuantizationType', value: { checked: true, value: 'f16' } },
    { key: 'llm.load.llama.vCacheQuantizationType', value: { checked: true, value: 'f16' } },
    { key: 'load.gpuSplitConfig', value: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0], customRatio: [] } },
  ];
  const agent = agentFor(world);
  const { model } = await agent.load(loadBody({ device: 'cuda:1' }));
  assert.deepEqual(model.device_bytes, { 'cuda:0': 4 * GIB });
  const warn = agent.logs.find((l) => l.event === 'residency.device_order_mismatch');
  assert.ok(warn, 'mismatch warned');
  assert.equal(warn.level, 'warn');
  assert.equal(warn.requested, 'cuda:1');
  assert.equal(warn.measured, 'cuda:0');
});

test('load: no mismatch warning when the growth lands on the pinned card', async () => {
  const world = fakeWorld({ loadBytes: 4 * GIB });
  const agent = agentFor(world);
  await agent.load(loadBody({ device: 'cuda:1' }));
  assert.equal(agent.logs.some((l) => l.event === 'residency.device_order_mismatch'), false);
});

test('load: an unreadable read-back fails CLOSED with that reason, and the unverified instance is unloaded', async () => {
  const world = fakeWorld();
  world.daemon.appliedFields = async () => {
    throw new Error('getLoadConfig timed out');
  };
  await assert.rejects(agentFor(world).load(loadBody()), (err) => {
    assert.equal(err.code, 'LOAD_FAILED');
    assert.match(err.message, /could not be verified: getLoadConfig timed out/);
    return true;
  });
  assert.deepEqual(world.calls.unloads, ['gemma-4-e2b-it-qat']);
});

test('unload: a real unload failure is UNLOAD_FAILED and keeps the measurement and policy', async () => {
  const world = fakeWorld();
  const agent = agentFor(world);
  await agent.load(loadBody({ pin: true }));
  world.daemon.unload = async () => {
    throw new Error('daemon busy');
  };
  await rejectsWith(agent.unload({ model_ref: 'gemma-4-e2b-it-qat', force: false }), 'UNLOAD_FAILED', 500);
  const [model] = (await agent.report()).models;
  assert.equal(model.bytes_source, 'measured');
  assert.equal(model.admin_pinned, true);
});

// ── R2-F10: an optional load_spec.expected_bytes is checked against nvidia-smi free ──

const withExpected = (expected, overrides = {}) => {
  const body = loadBody(overrides);
  body.load_spec = { ...body.load_spec, expected_bytes: expected };
  return body;
};

test('load: expected_bytes above the target card\'s free memory -> 503 INSUFFICIENT_MEMORY, nothing loaded', async () => {
  const world = fakeWorld(); // each card: 14 GiB free
  const agent = agentFor(world);
  await assert.rejects(agent.load(withExpected(20 * GIB)), (err) => {
    assert.ok(err instanceof ResidencyError);
    assert.equal(err.code, 'INSUFFICIENT_MEMORY');
    assert.equal(err.status, 503);
    assert.deepEqual(err.body().error.device, 'cuda:1');
    assert.equal(err.body().error.needed_bytes, 20 * GIB);
    assert.equal(err.body().error.free_bytes, 14 * GIB);
    assert.match(err.message, /cuda:1/);
    return true;
  });
  assert.equal(world.calls.loads.length, 0);
  // The lock is released: a load that fits goes through next.
  assert.equal((await agent.load(withExpected(4 * GIB))).outcome, 'loaded');
});

test('load: a split is checked PER CARD (expected_bytes divided by the split)', async () => {
  const world = fakeWorld();
  const evenly = (expected) => {
    const body = withExpected(expected, { device: null });
    body.load_spec.gpu_split = { strategy: 'evenly', priority: [], disabled_gpus: [], custom_ratio: [] };
    return body;
  };
  // 20 GiB evenly = 10 GiB per card; 14 GiB free on each -> fits, though it fits on NO single card.
  world.cards[0].freeBytes = 10 * GIB;
  assert.equal((await agentFor(world).load(evenly(20 * GIB))).outcome, 'loaded');

  const tight = fakeWorld();
  tight.cards[0].freeBytes = 8 * GIB;
  await assert.rejects(agentFor(tight).load(evenly(20 * GIB)), (err) => {
    assert.equal(err.code, 'INSUFFICIENT_MEMORY');
    assert.equal(err.body().error.device, 'cuda:0');
    assert.equal(err.body().error.needed_bytes, 10 * GIB);
    assert.equal(err.body().error.free_bytes, 8 * GIB);
    return true;
  });
  assert.equal(tight.calls.loads.length, 0);
});

test('load: the daemon default split (no device, no gpu_split) is checked across every card', async () => {
  const world = fakeWorld();
  world.cards[1].freeBytes = 1 * GIB;
  await assert.rejects(agentFor(world).load(withExpected(6 * GIB, { load_spec: {}, device: null })), (err) => {
    assert.equal(err.code, 'INSUFFICIENT_MEMORY');
    assert.equal(err.body().error.device, 'cuda:1');
    assert.equal(err.body().error.needed_bytes, 3 * GIB);
    return true;
  });
});

test('load: expected_bytes absent = no memory check at all (TASK-1055 behaviour)', async () => {
  const world = fakeWorld();
  world.cards[1].freeBytes = 0;
  assert.equal((await agentFor(world).load(loadBody())).outcome, 'loaded');
});

test('load: an instance already loaded answers already_loaded without a memory check', async () => {
  const world = fakeWorld();
  const agent = agentFor(world);
  await agent.load(loadBody());
  world.cards[1].freeBytes = 0;
  assert.equal((await agent.load(withExpected(20 * GIB))).outcome, 'already_loaded');
});

test('load: no nvidia-smi reading -> the check is skipped with a warning, the load proceeds', async () => {
  const world = fakeWorld();
  const agent = agentFor(world, { gpus: { read: async () => null } });
  const result = await agent.load(withExpected(20 * GIB, { load_spec: {}, device: null }));
  assert.equal(result.outcome, 'loaded');
  assert.ok(agent.logs.some((l) => l.level === 'warn' && l.event === 'residency.memory_check_skipped'));
});

test('load: a malformed expected_bytes is 400 LOAD_FAILED naming load_spec.expected_bytes', async () => {
  for (const bad of [-1, 0, 1.5, '4096', true]) {
    const world = fakeWorld();
    await assert.rejects(agentFor(world).load(withExpected(bad)), (err) => {
      assert.equal(err.code, 'LOAD_FAILED');
      assert.equal(err.status, 400);
      assert.equal(err.body().error.field, 'load_spec.expected_bytes');
      return true;
    });
    assert.equal(world.calls.loads.length, 0);
  }
});

// ── metrics (the python residency contract, rendered from the report) ──────

test('metrics: resident bytes per card from the report, load seconds observed, unloads counted by reason', async () => {
  const world = fakeWorld();
  world.seed(
    { identifier: 'boot-model', modelKey: 'granite-guardian-3.3-8b@q4_k_m', sizeBytes: 4_900_000_000 },
    [{ key: 'load.gpuSplitConfig', value: { strategy: 'priorityOrder', priority: [0], disabledGpus: [1], customRatio: [] } }],
  );
  const agent = agentFor(world);
  await agent.load(loadBody());
  let text = await agent.metrics();
  assert.match(text, /^model_resident_bytes\{service="lm-studio",model="boot-model",device="cuda:0"\} 4900000000$/m);
  assert.match(text, /^model_resident_bytes\{service="lm-studio",model="gemma-4-e2b-it-qat",device="cuda:1"\} \d+$/m);
  assert.match(text, /^model_running_instances\{service="lm-studio",model="gemma-4-e2b-it-qat"\} 1$/m);
  assert.match(text, /^model_load_seconds_count\{service="lm-studio",model="gemma-4-e2b-it-qat"\} 1$/m);

  await agent.unload({ model_ref: 'gemma-4-e2b-it-qat', force: false, reason: 'policy' });
  await agent.unload({ model_ref: 'boot-model', force: false });
  await agent.unload({ model_ref: 'not-there', force: false, reason: 'admin' });
  text = await agent.metrics();
  assert.ok(!/model="gemma-4-e2b-it-qat",device=/.test(text), 'an unloaded instance leaves the gauges');
  assert.match(text, /^model_evictions_total\{service="lm-studio",reason="policy"\} 1$/m);
  // reason defaults to admin; a not_loaded unload evicts nothing
  assert.match(text, /^model_evictions_total\{service="lm-studio",reason="admin"\} 1$/m);
});

test('metrics: a down daemon still answers, without per-model gauges', async () => {
  const world = fakeWorld();
  world.setDown(true);
  const text = await agentFor(world).metrics();
  assert.match(text, /^# TYPE model_resident_bytes gauge$/m);
  assert.ok(!/^model_resident_bytes\{/m.test(text));
});
