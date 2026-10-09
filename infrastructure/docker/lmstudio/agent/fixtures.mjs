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
