// load_spec (snake_case, contract lmStudioAgent.loadRequest) -> the kvConfig the
// boot loader would send for the same profile; applied fields -> load_config.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LoadSpecError,
  buildLoadRequest,
  deviceOfSplit,
  estimateDeviceBytes,
  loadConfigFromFields,
  loadSpecFromProfile,
} from './loadspec.mjs';
import { assemblePlanRequest } from '../loader/kvconfig.mjs';
import { CONTRACT_LMSTUDIO_SERVING, CONTRACT_LOAD_CONFIG, CONTRACT_LOAD_REQUEST as CONTRACT_LOAD } from './fixtures.mjs';

const fields = (req) => Object.fromEntries(req.kvConfig.fields.map((f) => [f.key, f.value]));

const build = (overrides = {}) =>
  buildLoadRequest({
    modelRef: CONTRACT_LOAD.model_ref,
    loadSpec: CONTRACT_LOAD.load_spec,
    device: CONTRACT_LOAD.device,
    pin: false,
    ttlSeconds: null,
    gpuCount: 2,
    env: {},
    ...overrides,
  });

test('the contract load request builds the full profile: ctx, parallel, flash, KV quant, card 1 only', () => {
  const req = build();
  assert.equal(req.identifier, 'gemma-4-e2b-it-qat');
  assert.equal(req.ttlMs, undefined);
  assert.deepEqual(fields(req), {
    'llm.load.contextLength': 65536,
    'llm.load.numParallelSessions': 10,
    'llm.load.llama.acceleration.offloadRatio': 1,
    'llm.load.llama.flashAttention': true,
    'llm.load.llama.kCacheQuantizationType': { checked: true, value: 'f16' },
    'llm.load.llama.vCacheQuantizationType': { checked: true, value: 'f16' },
    'load.gpuSplitConfig': { strategy: 'priorityOrder', priority: [1], disabledGpus: [0], customRatio: [] },
  });
});

test('a console load equals a boot-plan load of the same profile, field for field (AC-2)', () => {
  const spec = { ...CONTRACT_LOAD.load_spec };
  const agent = build({ device: null, loadSpec: spec });
  const boot = assemblePlanRequest(
    {
      slug: 'gemma-4-e2b-it-qat',
      contextLength: 65536,
      parallel: 10,
      flashAttention: true,
      kvCacheQuant: { k: 'f16', v: 'f16' },
      gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0], customRatio: [] },
    },
    'LMS_PRELOAD_PLAN[0]',
    { env: {}, gpuCount: 2 },
  );
  assert.deepEqual(agent.kvConfig, boot.kvConfig);
  assert.equal(agent.identifier, boot.identifier);
});

test('device cuda:<n> OVERRIDES the profile split: priority [n], every other card disabled', () => {
  const req = build({ device: 'cuda:0' });
  assert.deepEqual(fields(req)['load.gpuSplitConfig'], {
    strategy: 'priorityOrder',
    priority: [0],
    disabledGpus: [1],
    customRatio: [],
  });
  const three = build({ device: 'cuda:2', gpuCount: 3 });
  assert.deepEqual(fields(three)['load.gpuSplitConfig'].disabledGpus, [0, 1]);
});

test('no device keeps the profile split; no split at all sends none', () => {
  const evenly = build({ device: null, loadSpec: { ...CONTRACT_LOAD.load_spec, gpu_split: { strategy: 'evenly', priority: [], disabled_gpus: [], custom_ratio: [] } } });
  assert.equal(fields(evenly)['load.gpuSplitConfig'].strategy, 'evenly');
  const none = build({ device: null, loadSpec: { identifier: 'x' } });
  assert.ok(!('load.gpuSplitConfig' in fields(none)));
});

test('identifier defaults to model_ref; an empty load_spec is a load on daemon defaults', () => {
  const req = build({ modelRef: 'granite-guardian', device: null, loadSpec: {} });
  assert.equal(req.identifier, 'granite-guardian');
  assert.deepEqual(fields(req), { 'llm.load.llama.acceleration.offloadRatio': 1 });
});

test('ttl: pin wins (no daemon TTL); else load_spec.ttl_seconds, else the request ttl_seconds', () => {
  const spec = { ...CONTRACT_LOAD.load_spec, ttl_seconds: 600 };
  assert.equal(build({ loadSpec: spec }).ttlMs, 600_000);
  assert.equal(build({ loadSpec: spec, pin: true }).ttlMs, undefined);
  assert.equal(build({ ttlSeconds: 120 }).ttlMs, 120_000);
});

test('an unknown load_spec field is refused by name — the daemon would silently ignore it', () => {
  assert.throws(
    () => build({ loadSpec: { ...CONTRACT_LOAD.load_spec, n_gpu_layers: 99 } }),
    (err) => err instanceof LoadSpecError && err.code === 'LOAD_FAILED' && /n_gpu_layers/.test(err.message),
  );
  assert.throws(
    () => build({ loadSpec: { gpu_split: { strategy: 'evenly', main_gpu: 1 } }, device: null }),
    (err) => err instanceof LoadSpecError && /main_gpu/.test(err.message),
  );
});

test('the boot rules apply and are named in snake_case: KV quant without flash attention is refused', () => {
  assert.throws(
    () => build({ loadSpec: { ...CONTRACT_LOAD.load_spec, flash_attention: false, kv_cache_quant: { k: 'q8_0', v: null } } }),
    (err) => err instanceof LoadSpecError && err.code === 'LOAD_FAILED' && /load_spec\.kv_cache_quant\.k/.test(err.message),
  );
  assert.throws(
    () => build({ loadSpec: { context_length: 0 } }),
    (err) => err instanceof LoadSpecError && /load_spec\.context_length/.test(err.message),
  );
});

test('a device the pod does not have, cpu, or an unknown GPU count is DEVICE_UNAVAILABLE', () => {
  for (const [device, gpuCount] of [['cuda:2', 2], ['cpu', 2], ['cuda:0', undefined], ['gpu0', 2]]) {
    assert.throws(
      () => build({ device, gpuCount }),
      (err) => err instanceof LoadSpecError && err.code === 'DEVICE_UNAVAILABLE' && err.device === device,
      `${device} / ${gpuCount}`,
    );
  }
});

test('loadConfigFromFields maps applied kvConfig back to the contract load_config', () => {
  const req = build();
  assert.deepEqual(loadConfigFromFields(req.kvConfig.fields), CONTRACT_LOAD_CONFIG);
  assert.deepEqual(
    loadConfigFromFields([
      { key: 'llm.load.contextLength', value: 8192 },
      { key: 'llm.load.llama.kCacheQuantizationType', value: { checked: false, value: 'f16' } },
    ]),
    { context_length: 8192, parallel: null, flash_attention: null, kv_cache_quant: { k: null, v: null }, gpu_split: null },
  );
  assert.equal(loadConfigFromFields([]).kv_cache_quant, null);
});

test('deviceOfSplit: one enabled card is cuda:<n>, anything wider is multi', () => {
  const pin1 = { strategy: 'priorityOrder', priority: [1], disabledGpus: [0], customRatio: [] };
  assert.equal(deviceOfSplit(pin1, 2), 'cuda:1');
  assert.equal(deviceOfSplit({ strategy: 'priorityOrder', priority: [1], disabledGpus: [], customRatio: [] }, 2), 'multi');
  assert.equal(deviceOfSplit({ strategy: 'evenly', priority: [], disabledGpus: [], customRatio: [] }, 2), 'multi');
  assert.equal(deviceOfSplit(undefined, 2), 'multi');
  assert.equal(deviceOfSplit(undefined, 1), 'cuda:0');
  assert.equal(deviceOfSplit(pin1, undefined), 'multi');
});

test('estimateDeviceBytes: file size split by the configured gpuSplit', () => {
  const size = 3_000_000_001;
  assert.deepEqual(
    estimateDeviceBytes(size, { strategy: 'priorityOrder', priority: [1], disabledGpus: [0], customRatio: [] }, 2),
    { 'cuda:1': size },
  );
  assert.deepEqual(
    estimateDeviceBytes(size, { strategy: 'priorityOrder', priority: [1, 0], disabledGpus: [], customRatio: [] }, 2),
    { 'cuda:1': size },
  );
  const even = estimateDeviceBytes(size, { strategy: 'evenly', priority: [], disabledGpus: [], customRatio: [] }, 2);
  assert.deepEqual(even, { 'cuda:0': 1_500_000_000, 'cuda:1': 1_500_000_001 });
  assert.deepEqual(
    estimateDeviceBytes(1000, { strategy: 'custom', priority: [], disabledGpus: [], customRatio: [3, 1] }, 2),
    { 'cuda:0': 750, 'cuda:1': 250 },
  );
  assert.deepEqual(estimateDeviceBytes(size, undefined, undefined), {});
  assert.deepEqual(estimateDeviceBytes(null, undefined, 2), {});
});

// ── wave 3: a plan profile (camelCase) -> the load_spec an ensure sends ──────

const { profiles: PROFILES, defaults: DEFAULTS } = CONTRACT_LMSTUDIO_SERVING;
const profile = (slug) => structuredClone(PROFILES.find((p) => p.slug === slug));

test('loadSpecFromProfile: a gpuSplit profile becomes the snake_case load_spec, identifier = slug, no device', () => {
  assert.deepEqual(loadSpecFromProfile(profile('granite-guardian-4.1-8b'), DEFAULTS), {
    loadSpec: {
      identifier: 'granite-guardian-4.1-8b',
      context_length: 16384,
      parallel: 10,
      flash_attention: true,
      kv_cache_quant: { k: 'q8_0', v: 'q8_0' },
      gpu_split: { strategy: 'priorityOrder', priority: [1], disabled_gpus: [0], custom_ratio: [] },
    },
    device: null,
  });
});

test('loadSpecFromProfile: a `gpu: n` profile is a pin to cuda:<n> (the device path disables every other card)', () => {
  const { loadSpec, device } = loadSpecFromProfile(profile('qwen3guard-gen-0.6b'), DEFAULTS);
  assert.equal(device, 'cuda:1');
  assert.equal('gpu_split' in loadSpec, false);
});

test('loadSpecFromProfile: null knobs take the plan defaults, as the boot loader does (gpuSplit is never defaulted)', () => {
  const sparse = { slug: 'm', contextLength: null, parallel: null, flashAttention: null, kvCacheQuant: null, gpuSplit: null, gpu: null };
  assert.deepEqual(loadSpecFromProfile(sparse, DEFAULTS), {
    loadSpec: { identifier: 'm', context_length: 32768, parallel: 10, flash_attention: true, kv_cache_quant: { k: 'q4_0', v: 'q4_0' } },
    device: 'cuda:1',
  });
  assert.deepEqual(loadSpecFromProfile(sparse, undefined), { loadSpec: { identifier: 'm' }, device: null });
});

test('loadSpecFromProfile: an ensure load sends EXACTLY the kvConfig a boot load of the same profile sends', () => {
  for (const entry of PROFILES) {
    const { loadSpec, device } = loadSpecFromProfile(structuredClone(entry), DEFAULTS);
    const ensure = buildLoadRequest({ modelRef: entry.slug, loadSpec, device, pin: false, ttlSeconds: null, gpuCount: 2, env: {} });
    const boot = assemblePlanRequest(structuredClone(entry), 'lmStudioServing.profiles[0]', { env: {}, defaults: DEFAULTS, gpuCount: 2 });
    assert.deepEqual(ensure.kvConfig, boot.kvConfig, entry.slug);
    assert.equal(ensure.identifier, boot.identifier);
  }
});
