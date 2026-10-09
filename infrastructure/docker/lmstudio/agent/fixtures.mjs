// In-tree copies of the TASK-1055 contract examples the agent tests build on.
//
// The image's build context is infrastructure/docker/lmstudio only, so the
// frozen fixture (tests/contracts/model-residency-task1055.fixture.json) is not
// there when the tests run inside the image. contract.test.mjs pins these
// copies to the fixture whenever it IS present (every repo checkout / CI), so a
// drift between them fails there.
export const CONTRACT_LOAD_REQUEST = Object.freeze({
  model_ref: 'gemma-4-e2b-it-qat',
  load_spec: {
    identifier: 'gemma-4-e2b-it-qat',
    context_length: 65536,
    parallel: 10,
    flash_attention: true,
    kv_cache_quant: { k: 'f16', v: 'f16' },
    gpu_split: { strategy: 'priorityOrder', priority: [1], disabled_gpus: [0], custom_ratio: [] },
    ttl_seconds: null,
  },
  pin: false,
  ttl_seconds: null,
  device: 'cuda:1',
});

export const CONTRACT_REPORT_MODEL_KEYS = Object.freeze([
  'model_ref',
  'engine_key',
  'instance_id',
  'ai_model_id',
  'cache',
  'state',
  'device',
  'bytes',
  'bytes_source',
  'device_bytes',
  'in_flight',
  'pinned',
  'admin_pinned',
  'ttl_seconds',
  'loaded_at',
  'last_used_at',
  'load_seconds',
  'error',
  'load_config',
]);

export const CONTRACT_LOAD_CONFIG = Object.freeze({
  context_length: 65536,
  parallel: 10,
  flash_attention: true,
  kv_cache_quant: { k: 'f16', v: 'f16' },
  gpu_split: { strategy: 'priorityOrder', priority: [1], disabled_gpus: [0], custom_ratio: [] },
});

export const CONTRACT_DEVICE_KEYS = Object.freeze([
  'id',
  'kind',
  'total_bytes',
  'free_bytes',
  'index',
  'name',
  'uuid',
  'process_bytes',
]);

// Wave 3 (`wave3.lmStudioOnDemand`): the served plan with `profiles`, and the
// ensure verb's responses.
const GPU1_ONLY = Object.freeze({ strategy: 'priorityOrder', priority: [1], disabledGpus: [0] });

export const CONTRACT_LMSTUDIO_SERVING = Object.freeze({
  defaults: { contextLength: 32768, parallel: 10, gpu: 1, flashAttention: true, kvCacheQuant: { k: 'q4_0', v: 'q4_0' } },
  preload: [
    {
      slug: 'gemma-4-e2b-it-qat',
      contextLength: 32768,
      parallel: 10,
      flashAttention: true,
      gpuSplit: { ...GPU1_ONLY },
      gpu: null,
      kvCacheQuant: { k: 'q4_0', v: 'q4_0' },
    },
  ],
  profiles: [
    {
      slug: 'gemma-4-e2b-it-qat',
      contextLength: 32768,
      parallel: 10,
      flashAttention: true,
      gpuSplit: { ...GPU1_ONLY },
      gpu: null,
      kvCacheQuant: { k: 'q4_0', v: 'q4_0' },
    },
    {
      slug: 'granite-guardian-4.1-8b',
      contextLength: 16384,
      parallel: 10,
      flashAttention: true,
      gpuSplit: { ...GPU1_ONLY },
      gpu: null,
      kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
    },
    {
      slug: 'qwen3guard-gen-0.6b',
      contextLength: 32768,
      parallel: 10,
      flashAttention: true,
      gpuSplit: null,
      gpu: 1,
      kvCacheQuant: { k: 'q4_0', v: 'q4_0' },
    },
  ],
});

export const CONTRACT_ENSURE_REQUEST = Object.freeze({ model_ref: 'granite-guardian-4.1-8b' });

export const CONTRACT_ENSURE_RESPONSES = Object.freeze({
  already_loaded: {
    status: 200,
    body: { outcome: 'already_loaded', model_ref: 'granite-guardian-4.1-8b', identifier: 'granite-guardian-4.1-8b' },
  },
  loaded: {
    status: 200,
    body: { outcome: 'loaded', model_ref: 'granite-guardian-4.1-8b', identifier: 'granite-guardian-4.1-8b', load_seconds: 21.4 },
  },
  MODEL_UNKNOWN: { status: 404, body: { code: 'MODEL_UNKNOWN', message: "no serving profile for 'x' in the LM Studio plan" } },
  LOAD_FAILED: { status: 503, body: { code: 'LOAD_FAILED', message: "<LM Studio's error>" } },
});
