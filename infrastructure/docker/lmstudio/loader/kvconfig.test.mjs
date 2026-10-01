// =============================================================================
// Unit tests for the PURE half of the loader: env -> kvConfig.
// =============================================================================
// `node --test kvconfig.test.mjs` — no daemon, no websocket, no network. That
// split is the whole point of kvconfig.mjs being a separate module: the half
// that decides WHAT to send is the half that can be wrong in a way no
// integration test would catch quickly, and it is testable in milliseconds.
//
// node:test is deliberate: the image ships a Node runtime and the SDK, and
// nothing else. A test runner would be a dependency bought for one file.
//
// The kvConfig KEY NAMES asserted below are not guesses. They were produced by
// running SDK 1.5.0's own `llmLoadModelConfigToKVConfig` and reading the output
// (see kvconfig.mjs §Provenance). If an SDK upgrade renames one, these fail.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KvConfigError,
  CACHE_QUANTIZATION_TYPES,
  GPU_SPLIT_STRATEGIES,
  assembleLoadRequest,
  parseGpuCount,
  resolvePreloadRequests,
  selectModelKey,
} from './kvconfig.mjs';

/** Every field in the assembled request, as a plain {key: value} map. */
const fieldMap = (req) => Object.fromEntries(req.kvConfig.fields.map((f) => [f.key, f.value]));

/** The minimum env that assembles at all. */
const base = (extra = {}) => ({ LMS_LOAD: 'hope/gemma-4-e4b-it-qat', ...extra });

// ── the floor ───────────────────────────────────────────────────────────────

test('LMS_LOAD is required — an absent model key is a configuration error', () => {
  assert.throws(() => assembleLoadRequest({}), (err) => {
    assert.ok(err instanceof KvConfigError);
    assert.equal(err.envVar, 'LMS_LOAD');
    return true;
  });
});

test('the bare floor carries the model key and the GPU offload default', () => {
  const req = assembleLoadRequest(base());
  assert.equal(req.modelKey, 'hope/gemma-4-e4b-it-qat');
  assert.equal(req.identifier, undefined);
  assert.equal(req.ttlMs, undefined);
  // `lms load` defaulted --gpu to max; replacing the CLI must not quietly
  // change how much of the model is offloaded. 1 IS "max" — the daemon stores
  // the ratio as a number and reads it back as one (measured on the live pod),
  // so the canonical form is what goes on the wire.
  assert.deepEqual(fieldMap(req), { 'llm.load.llama.acceleration.offloadRatio': 1 });
});

test('an unset knob emits no field at all — absent is not the same as default', () => {
  const req = assembleLoadRequest(base({ LMS_CONTEXT: '', LMS_PARALLEL: '' }));
  const keys = Object.keys(fieldMap(req));
  assert.ok(!keys.includes('llm.load.contextLength'));
  assert.ok(!keys.includes('llm.load.numParallelSessions'));
});

// ── the knobs `lms load` could already set ──────────────────────────────────

test('context, parallel, ttl and identifier survive the move off the CLI', () => {
  const req = assembleLoadRequest(
    base({
      LMS_CONTEXT: '65536',
      LMS_PARALLEL: '4',
      LMS_TTL: '3600',
      LMS_IDENTIFIER: 'hope-text',
      LMS_GPU: '0.75',
    }),
  );
  assert.equal(req.identifier, 'hope-text');
  assert.equal(req.ttlMs, 3_600_000); // seconds on the CLI, milliseconds on the wire
  assert.deepEqual(fieldMap(req), {
    'llm.load.contextLength': 65536,
    'llm.load.numParallelSessions': 4,
    'llm.load.llama.acceleration.offloadRatio': 0.75,
  });
});

test('LMS_GPU accepts the two CLI words and a 0..1 ratio, and nothing else', () => {
  // The words are canonicalised to the numbers the daemon actually stores, so
  // that load.mjs can compare what it sent against what came back verbatim.
  for (const [value, expected] of [['max', 1], ['off', 0], ['0', 0], ['1', 1], ['0.5', 0.5]]) {
    const req = assembleLoadRequest(base({ LMS_GPU: value }));
    assert.equal(fieldMap(req)['llm.load.llama.acceleration.offloadRatio'], expected);
  }
  for (const bad of ['1.5', '-0.1', 'most']) {
    assert.throws(() => assembleLoadRequest(base({ LMS_GPU: bad })), KvConfigError, `LMS_GPU=${bad}`);
  }
  // A manifest that sets the variable to "" means the same as not setting it,
  // and must land on the CLI's old default rather than on an error.
  assert.equal(
    fieldMap(assembleLoadRequest(base({ LMS_GPU: '' })))['llm.load.llama.acceleration.offloadRatio'],
    1,
  );
});

test('a non-integer or non-positive context or parallel is refused, not rounded', () => {
  for (const [name, value] of [
    ['LMS_CONTEXT', '65536.5'],
    ['LMS_CONTEXT', '0'],
    ['LMS_CONTEXT', '-1'],
    ['LMS_CONTEXT', '64k'],
    ['LMS_PARALLEL', '0'],
    ['LMS_PARALLEL', 'four'],
    ['LMS_TTL', '-5'],
  ]) {
    assert.throws(
      () => assembleLoadRequest(base({ [name]: value })),
      (err) => err instanceof KvConfigError && err.envVar === name,
      `${name}=${value}`,
    );
  }
});

// ── R-3: the keys no CLI and no REST call could reach ───────────────────────

test('flash attention is a real boolean field, spelled several ways', () => {
  for (const on of ['true', '1', 'on', 'yes', 'TRUE']) {
    assert.equal(fieldMap(assembleLoadRequest(base({ LMS_FLASH_ATTENTION: on })))['llm.load.llama.flashAttention'], true);
  }
  for (const off of ['false', '0', 'off', 'no']) {
    assert.equal(fieldMap(assembleLoadRequest(base({ LMS_FLASH_ATTENTION: off })))['llm.load.llama.flashAttention'], false);
  }
  assert.throws(
    () => assembleLoadRequest(base({ LMS_FLASH_ATTENTION: 'maybe' })),
    (err) => err instanceof KvConfigError && err.envVar === 'LMS_FLASH_ATTENTION',
  );
});

test('KV cache quantization uses the checkbox value shape the daemon expects', () => {
  const req = assembleLoadRequest(
    base({ LMS_FLASH_ATTENTION: 'true', LMS_KV_CACHE_K: 'q8_0', LMS_KV_CACHE_V: 'q4_0' }),
  );
  const fields = fieldMap(req);
  assert.deepEqual(fields['llm.load.llama.kCacheQuantizationType'], { checked: true, value: 'q8_0' });
  assert.deepEqual(fields['llm.load.llama.vCacheQuantizationType'], { checked: true, value: 'q4_0' });
});

test('"off" disables quantization explicitly, and needs no flash attention', () => {
  const req = assembleLoadRequest(base({ LMS_KV_CACHE_K: 'off', LMS_KV_CACHE_V: 'off' }));
  const fields = fieldMap(req);
  assert.deepEqual(fields['llm.load.llama.kCacheQuantizationType'], { checked: false, value: 'f16' });
  assert.deepEqual(fields['llm.load.llama.vCacheQuantizationType'], { checked: false, value: 'f16' });
});

test('every quantization type the SDK declares is accepted; an invented one is not', () => {
  for (const type of CACHE_QUANTIZATION_TYPES) {
    assert.doesNotThrow(() =>
      assembleLoadRequest(base({ LMS_FLASH_ATTENTION: 'true', LMS_KV_CACHE_K: type })),
    );
  }
  assert.throws(
    () => assembleLoadRequest(base({ LMS_FLASH_ATTENTION: 'true', LMS_KV_CACHE_K: 'q3_0' })),
    (err) => err instanceof KvConfigError && err.envVar === 'LMS_KV_CACHE_K',
  );
});

test('KV quantization without flash attention is refused — llama.cpp cannot serve it', () => {
  for (const name of ['LMS_KV_CACHE_K', 'LMS_KV_CACHE_V']) {
    // Not merely absent: explicitly OFF must fail too, so a half-applied
    // request can never reach the daemon.
    for (const fa of [undefined, 'false']) {
      const env = base({ [name]: 'q8_0' });
      if (fa !== undefined) env.LMS_FLASH_ATTENTION = fa;
      assert.throws(
        () => assembleLoadRequest(env),
        (err) => {
          assert.ok(err instanceof KvConfigError);
          assert.match(err.message, /flash attention/i);
          return true;
        },
        `${name} with LMS_FLASH_ATTENTION=${fa}`,
      );
    }
  }
});

// ── R-6: per-model GPU assignment ───────────────────────────────────────────

test('no gpu-split variable set emits no split field — the daemon keeps its default', () => {
  assert.ok(!('load.gpuSplitConfig' in fieldMap(assembleLoadRequest(base()))));
});

test('disabling a GPU confines the model to the others', () => {
  const req = assembleLoadRequest(base({ LMS_GPU_DISABLED: '1' }));
  assert.deepEqual(fieldMap(req)['load.gpuSplitConfig'], {
    strategy: 'evenly', // the daemon's own default, restated because all four sub-fields are required
    disabledGpus: [1],
    priority: [],
    customRatio: [],
  });
});

test('priorityOrder carries the full priority list, in order', () => {
  const req = assembleLoadRequest(
    base({ LMS_GPU_SPLIT_STRATEGY: 'priorityOrder', LMS_GPU_PRIORITY: '1, 0' }),
  );
  assert.deepEqual(fieldMap(req)['load.gpuSplitConfig'], {
    strategy: 'priorityOrder',
    disabledGpus: [],
    priority: [1, 0],
    customRatio: [],
  });
});

test('a custom split carries its ratios', () => {
  const req = assembleLoadRequest(
    base({ LMS_GPU_SPLIT_STRATEGY: 'custom', LMS_GPU_CUSTOM_RATIO: '0.7,0.3' }),
  );
  assert.deepEqual(fieldMap(req)['load.gpuSplitConfig'], {
    strategy: 'custom',
    disabledGpus: [],
    priority: [],
    customRatio: [0.7, 0.3],
  });
});

test('every strategy the SDK declares is accepted; an unknown one is refused by name', () => {
  for (const strategy of GPU_SPLIT_STRATEGIES) {
    const env = base({ LMS_GPU_SPLIT_STRATEGY: strategy });
    if (strategy === 'custom') env.LMS_GPU_CUSTOM_RATIO = '1';
    if (strategy === 'priorityOrder') env.LMS_GPU_PRIORITY = '0';
    assert.doesNotThrow(() => assembleLoadRequest(env), `strategy=${strategy}`);
  }
  assert.throws(
    () => assembleLoadRequest(base({ LMS_GPU_SPLIT_STRATEGY: 'even' })), // a plausible typo
    (err) => {
      assert.ok(err instanceof KvConfigError);
      assert.equal(err.envVar, 'LMS_GPU_SPLIT_STRATEGY');
      assert.match(err.message, /evenly/); // the message must list what IS allowed
      return true;
    },
  );
});

test('a strategy that needs a list and has none is refused, not silently ignored', () => {
  assert.throws(
    () => assembleLoadRequest(base({ LMS_GPU_SPLIT_STRATEGY: 'priorityOrder' })),
    (err) => err instanceof KvConfigError && /LMS_GPU_PRIORITY/.test(err.message),
  );
  assert.throws(
    () => assembleLoadRequest(base({ LMS_GPU_SPLIT_STRATEGY: 'custom' })),
    (err) => err instanceof KvConfigError && /LMS_GPU_CUSTOM_RATIO/.test(err.message),
  );
});

test('a malformed GPU index list is refused by name', () => {
  for (const [name, value] of [
    ['LMS_GPU_DISABLED', '0,,1'],
    ['LMS_GPU_DISABLED', '-1'],
    ['LMS_GPU_DISABLED', 'gpu0'],
    ['LMS_GPU_DISABLED', '1.5'],
    ['LMS_GPU_PRIORITY', 'first'],
    ['LMS_GPU_CUSTOM_RATIO', '0.5,abc'],
    ['LMS_GPU_CUSTOM_RATIO', '-0.5'],
  ]) {
    assert.throws(
      () => assembleLoadRequest(base({ [name]: value })),
      (err) => err instanceof KvConfigError && err.envVar === name,
      `${name}=${value}`,
    );
  }
});

test('a GPU index repeated in one list is refused — it is always a typo', () => {
  assert.throws(
    () => assembleLoadRequest(base({ LMS_GPU_DISABLED: '1,1' })),
    (err) => err instanceof KvConfigError && err.envVar === 'LMS_GPU_DISABLED',
  );
});

test('a GPU that is both disabled and prioritised is a contradiction, not a preference', () => {
  assert.throws(
    () =>
      assembleLoadRequest(
        base({ LMS_GPU_SPLIT_STRATEGY: 'priorityOrder', LMS_GPU_PRIORITY: '0,1', LMS_GPU_DISABLED: '1' }),
      ),
    (err) => err instanceof KvConfigError && /disabled/i.test(err.message),
  );
});

// ── the whole point of Phase 1 ──────────────────────────────────────────────

test('the full TASK-996 target profile assembles into exactly seven fields', () => {
  // Every key here was measured as REJECTED by POST /api/v1/models/load
  // (`unrecognized_keys`) or absent from `lms load` — see the ticket §2.3.
  const req = assembleLoadRequest(
    base({
      LMS_CONTEXT: '65536',
      LMS_PARALLEL: '4',
      LMS_GPU: 'max',
      LMS_TTL: '3600',
      LMS_IDENTIFIER: 'hope-text',
      LMS_FLASH_ATTENTION: 'true',
      LMS_KV_CACHE_K: 'q8_0',
      LMS_KV_CACHE_V: 'q8_0',
      LMS_GPU_SPLIT_STRATEGY: 'priorityOrder',
      LMS_GPU_PRIORITY: '0',
      LMS_GPU_DISABLED: '1',
    }),
  );
  assert.deepEqual(fieldMap(req), {
    'llm.load.contextLength': 65536,
    'llm.load.numParallelSessions': 4,
    'llm.load.llama.acceleration.offloadRatio': 1,
    'llm.load.llama.flashAttention': true,
    'llm.load.llama.kCacheQuantizationType': { checked: true, value: 'q8_0' },
    'llm.load.llama.vCacheQuantizationType': { checked: true, value: 'q8_0' },
    'load.gpuSplitConfig': {
      strategy: 'priorityOrder',
      disabledGpus: [1],
      priority: [0],
      customRatio: [],
    },
  });
});

test('field order is deterministic, so a failed load logs a stable, diffable request', () => {
  const env = base({ LMS_CONTEXT: '4096', LMS_FLASH_ATTENTION: 'true' });
  const once = assembleLoadRequest(env).kvConfig.fields.map((f) => f.key);
  const again = assembleLoadRequest(env).kvConfig.fields.map((f) => f.key);
  assert.deepEqual(once, again);
});

// ---------------------------------------------------------------------------
// selectModelKey — pinned against the LIVE `/api/v1/models` payload captured
// from hope-lmstudio on 2026-09-21. These are the exact entries whose shape
// CrashLoopBackOffed the first Phase 1 image; the fixture is trimmed to the
// fields the selector reads, and nothing else.
// ---------------------------------------------------------------------------
const LIVE_MODELS = [
  { type: 'embedding', key: 'text-embedding-nomic-embed-text-v1.5' },
  { type: 'embedding', key: 'text-embedding-embeddinggemma-300m-qat' },
  { type: 'llm', key: 'granite-guardian-4.1-8b' },
  { type: 'llm', key: 'gemma-4-e4b-it-qat@?', architecture: 'clip' },
  { type: 'llm', key: 'gemma-4-e4b-it-qat@q4_0', architecture: 'gemma4' },
  { type: 'llm', key: 'gemma-4-e2b-it-qat@?', architecture: 'clip' },
  { type: 'llm', key: 'gemma-4-e2b-it-qat@q4_0', architecture: 'gemma4' },
];

test('selectModelKey: the bare LMS_LOAD resolves past the @? projector', () => {
  // THE REGRESSION. `gemma-4-e2b-it-qat` is not a key at all — it is the loaded
  // instance id — and two `llm` entries carry it as a prefix.
  assert.deepEqual(selectModelKey(LIVE_MODELS, 'gemma-4-e2b-it-qat'), {
    key: 'gemma-4-e2b-it-qat@q4_0',
  });
});

test('selectModelKey: an exact key is taken verbatim', () => {
  assert.deepEqual(selectModelKey(LIVE_MODELS, 'gemma-4-e2b-it-qat@q4_0'), {
    key: 'gemma-4-e2b-it-qat@q4_0',
  });
});

test('selectModelKey: a key with no quantization suffix still resolves', () => {
  assert.deepEqual(selectModelKey(LIVE_MODELS, 'granite-guardian-4.1-8b'), {
    key: 'granite-guardian-4.1-8b',
  });
});

test('selectModelKey: embeddings are never loadable as an LLM', () => {
  const choice = selectModelKey(LIVE_MODELS, 'text-embedding-embeddinggemma-300m-qat');
  assert.equal(choice.key, undefined);
  assert.ok(Array.isArray(choice.none));
});

test('selectModelKey: two quantizations REFUSE rather than guess', () => {
  const twoQuants = [
    { type: 'llm', key: 'gemma-4-e2b-it-qat@?' },
    { type: 'llm', key: 'gemma-4-e2b-it-qat@q4_0' },
    { type: 'llm', key: 'gemma-4-e2b-it-qat@q8_0' },
  ];
  assert.deepEqual(selectModelKey(twoQuants, 'gemma-4-e2b-it-qat'), {
    ambiguous: ['gemma-4-e2b-it-qat@q4_0', 'gemma-4-e2b-it-qat@q8_0'],
  });
});

test('selectModelKey: a projector-only prefix is no match, never the projector', () => {
  const projectorOnly = [{ type: 'llm', key: 'some-model@?' }];
  assert.deepEqual(selectModelKey(projectorOnly, 'some-model'), { none: ['some-model@?'] });
});

test('selectModelKey: an empty/absent index is a no-match, not a crash', () => {
  assert.deepEqual(selectModelKey([], 'x'), { none: [] });
  assert.deepEqual(selectModelKey(undefined, 'x'), { none: [] });
});

// ── TASK-1031: the governed multi-model preload plan ────────────────────────
// Source precedence: gateway effective-config -> LMS_PRELOAD_PLAN -> the
// legacy single-model LMS_LOAD env. Every plan entry is loaded, pinned (no
// TTL) and addressed by its slug.

/** The two roles the owner fixed on 2026-10-01 (TASK-1031 §4a). */
const GEMMA = {
  slug: 'gemma-4-e2b-it-qat',
  contextLength: 65536,
  parallel: 10,
  flashAttention: true,
  gpuSplit: null,
  gpu: 1,
  kvCacheQuant: { k: 'f16', v: 'f16' },
};
const GRANITE = {
  slug: 'granite-guardian-4.1-8b',
  contextLength: 16384,
  parallel: 10,
  flashAttention: true,
  gpuSplit: null,
  gpu: 0,
  kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
};
const DEFAULTS = { contextLength: 65536, parallel: 10, gpu: 1, flashAttention: null, kvCacheQuant: null };
const servingBody = (preload, defaults = DEFAULTS) => ({ lmStudioServing: { defaults, preload } });

test('plan: the gateway plan wins and loads EVERY entry, each with its own kvConfig', () => {
  const plan = resolvePreloadRequests({
    effectiveConfig: servingBody([GEMMA, GRANITE]),
    env: { LMS_LOAD: 'something-else', LMS_PRELOAD_PLAN: JSON.stringify([GRANITE]) },
    gpuCount: 2,
  });
  assert.equal(plan.source, 'gateway');
  assert.equal(plan.requests.length, 2);

  const [gemma, granite] = plan.requests;
  assert.equal(gemma.modelKey, 'gemma-4-e2b-it-qat');
  assert.equal(gemma.identifier, 'gemma-4-e2b-it-qat');
  assert.equal(gemma.ttlMs, undefined, 'a preloaded model is pinned — no TTL');
  assert.deepEqual(fieldMap(gemma), {
    'llm.load.contextLength': 65536,
    'llm.load.numParallelSessions': 10,
    'llm.load.llama.acceleration.offloadRatio': 1,
    'llm.load.llama.flashAttention': true,
    'llm.load.llama.kCacheQuantizationType': { checked: true, value: 'f16' },
    'llm.load.llama.vCacheQuantizationType': { checked: true, value: 'f16' },
    'load.gpuSplitConfig': { strategy: 'priorityOrder', priority: [1], disabledGpus: [0], customRatio: [] },
  });

  assert.equal(granite.identifier, 'granite-guardian-4.1-8b');
  assert.equal(granite.ttlMs, undefined);
  assert.deepEqual(fieldMap(granite), {
    'llm.load.contextLength': 16384,
    'llm.load.numParallelSessions': 10,
    'llm.load.llama.acceleration.offloadRatio': 1,
    'llm.load.llama.flashAttention': true,
    'llm.load.llama.kCacheQuantizationType': { checked: true, value: 'q8_0' },
    'llm.load.llama.vCacheQuantizationType': { checked: true, value: 'q8_0' },
    'load.gpuSplitConfig': { strategy: 'priorityOrder', priority: [0], disabledGpus: [1], customRatio: [] },
  });
});

test('plan: wire field order matches the legacy env path, so logs stay diffable', () => {
  const plan = resolvePreloadRequests({ effectiveConfig: servingBody([GRANITE]), env: {}, gpuCount: 2 });
  assert.deepEqual(plan.requests[0].kvConfig.fields.map((f) => f.key), [
    'llm.load.contextLength',
    'llm.load.numParallelSessions',
    'llm.load.llama.acceleration.offloadRatio',
    'llm.load.llama.flashAttention',
    'llm.load.llama.kCacheQuantizationType',
    'llm.load.llama.vCacheQuantizationType',
    'load.gpuSplitConfig',
  ]);
});

test('plan: `gpu` pins to one card by disabling EVERY other detected GPU', () => {
  const plan = resolvePreloadRequests({ effectiveConfig: servingBody([{ ...GRANITE, gpu: 2 }]), env: {}, gpuCount: 4 });
  assert.deepEqual(fieldMap(plan.requests[0])['load.gpuSplitConfig'], {
    strategy: 'priorityOrder',
    priority: [2],
    disabledGpus: [0, 1, 3],
    customRatio: [],
  });
});

test('plan: an explicit gpuSplit wins over gpu and is completed to the daemon shape', () => {
  const plan = resolvePreloadRequests({
    effectiveConfig: servingBody([{ ...GEMMA, gpu: 0, gpuSplit: { strategy: 'custom', customRatio: [1, 3] } }]),
    env: {},
    gpuCount: undefined, // not needed when the split is explicit
  });
  assert.deepEqual(fieldMap(plan.requests[0])['load.gpuSplitConfig'], {
    strategy: 'custom',
    priority: [],
    disabledGpus: [],
    customRatio: [1, 3],
  });
});

test('plan: an absent entry knob takes the served default; null flash attention / KV quant emit nothing', () => {
  const entry = { slug: 'x-model', contextLength: null, parallel: null, flashAttention: null, gpuSplit: null, gpu: null, kvCacheQuant: null };
  const plan = resolvePreloadRequests({ effectiveConfig: servingBody([entry]), env: {}, gpuCount: 2 });
  const fields = fieldMap(plan.requests[0]);
  assert.equal(fields['llm.load.contextLength'], 65536);
  assert.equal(fields['llm.load.numParallelSessions'], 10);
  assert.deepEqual(fields['load.gpuSplitConfig'], { strategy: 'priorityOrder', priority: [1], disabledGpus: [0], customRatio: [] });
  assert.ok(!('llm.load.llama.flashAttention' in fields));
  assert.ok(!('llm.load.llama.kCacheQuantizationType' in fields));
});

test('plan: an empty or absent gateway preload falls back to LMS_PRELOAD_PLAN', () => {
  for (const effectiveConfig of [null, {}, servingBody([]), { lmStudioServing: null }]) {
    const plan = resolvePreloadRequests({
      effectiveConfig,
      env: { LMS_PRELOAD_PLAN: JSON.stringify([GRANITE]), LMS_LOAD: 'ignored' },
      gpuCount: 2,
    });
    assert.equal(plan.source, 'env-plan');
    assert.deepEqual(plan.requests.map((r) => r.identifier), ['granite-guardian-4.1-8b']);
  }
});

test('plan: an unusable gateway plan falls back to env and says why', () => {
  const plan = resolvePreloadRequests({
    effectiveConfig: servingBody([{ ...GRANITE, flashAttention: false }]),
    env: { LMS_PRELOAD_PLAN: JSON.stringify([GEMMA]) },
    gpuCount: 2,
  });
  assert.equal(plan.source, 'env-plan');
  assert.match(plan.rejected, /flash attention/);
});

test('plan: with neither plan, the legacy single-model LMS_LOAD env still works unchanged', () => {
  const env = base({ LMS_CONTEXT: '65536', LMS_PARALLEL: '4', LMS_TTL: '600', LMS_IDENTIFIER: 'gemma' });
  const plan = resolvePreloadRequests({ effectiveConfig: null, env, gpuCount: 2 });
  assert.equal(plan.source, 'env-legacy');
  assert.deepEqual(plan.requests, [assembleLoadRequest(env)]);
});

test('plan: a malformed LMS_PRELOAD_PLAN is a configuration error, not a silent fallback', () => {
  for (const raw of ['not json', '{"slug":"x"}', '[]', '[{"contextLength":4096}]', '[{"slug":"a"},{"slug":"a"}]']) {
    assert.throws(
      () => resolvePreloadRequests({ effectiveConfig: null, env: { LMS_PRELOAD_PLAN: raw, LMS_LOAD: 'x' }, gpuCount: 2 }),
      (err) => err instanceof KvConfigError && /LMS_PRELOAD_PLAN/.test(err.message),
      raw,
    );
  }
});

test('plan: entry values are validated like the env knobs', () => {
  const bad = [
    { ...GEMMA, contextLength: 0 },
    { ...GEMMA, parallel: 2.5 },
    { ...GEMMA, kvCacheQuant: { k: 'q9_9' } },
    { ...GEMMA, flashAttention: 'yes' },
    { ...GEMMA, gpuSplit: { strategy: 'evenly ' } },
    { ...GEMMA, gpuSplit: { strategy: 'priorityOrder' } },
    { ...GEMMA, gpu: -1 },
    { ...GEMMA, gpu: 2 }, // only two GPUs (0, 1)
  ];
  for (const entry of bad) {
    assert.throws(
      () => resolvePreloadRequests({ effectiveConfig: null, env: { LMS_PRELOAD_PLAN: JSON.stringify([entry]) }, gpuCount: 2 }),
      (err) => err instanceof KvConfigError && /LMS_PRELOAD_PLAN\[0\]/.test(err.message),
      JSON.stringify(entry),
    );
  }
});

test('plan: pinning to a GPU with an unknown GPU count is refused, never guessed', () => {
  assert.throws(
    () => resolvePreloadRequests({ effectiveConfig: null, env: { LMS_PRELOAD_PLAN: JSON.stringify([GRANITE]) }, gpuCount: undefined }),
    (err) => err instanceof KvConfigError && /GPU count/.test(err.message),
  );
});

test('plan: "off" in kvCacheQuant disables quantization explicitly and needs no flash attention', () => {
  const plan = resolvePreloadRequests({
    effectiveConfig: servingBody([{ ...GEMMA, flashAttention: null, kvCacheQuant: { k: 'off' } }]),
    env: {},
    gpuCount: 2,
  });
  const fields = fieldMap(plan.requests[0]);
  assert.deepEqual(fields['llm.load.llama.kCacheQuantizationType'], { checked: false, value: 'f16' });
  assert.ok(!('llm.load.llama.vCacheQuantizationType' in fields));
});

test('parseGpuCount: counts nvidia-smi index lines; empty or garbage is unknown', () => {
  assert.equal(parseGpuCount('0\n1\n'), 2);
  assert.equal(parseGpuCount('0\n'), 1);
  assert.equal(parseGpuCount(''), undefined);
  assert.equal(parseGpuCount(undefined), undefined);
  assert.equal(parseGpuCount('NVIDIA-SMI has failed\n'), undefined);
});
