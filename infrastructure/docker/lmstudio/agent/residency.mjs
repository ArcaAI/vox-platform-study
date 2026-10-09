// =============================================================================
// The LM Studio residency agent — report / load / unload / policy (TASK-1055)
// =============================================================================
// Same verbs and snake_case shapes as the Python residency agent
// (packages/py-runtime-models/.../residency_agent.py; contract
// tests/contracts/model-residency-agent.fixture.json `python` +
// model-residency-task1055.fixture.json `lmStudioAgent`), so the gateway drives
// lm-studio through the same ResidencyAgentClient as stt and nlp.
//
// Why this exists (ticket §2): the gateway could only reach LM Studio over
// REST, which cannot set parallel slots, KV-cache quantization, GPU split or
// the identifier (E3), and needs the exact engine key the catalogue does not
// hold (E2). Only the SDK `loadModel` channel over loopback can apply the whole
// profile — which is what the boot loader does, and this module reuses it.
//
// I/O is injected (`daemon`, `gpus`, `clock`, `sleep`), so every rule here is
// unit-tested with no daemon and no GPU.
//
// What LM Studio does NOT tell us, and how each gap is filled:
//   * no in-flight count       -> `in_flight: null`; an unload never refuses
//                                 IN_FLIGHT (treated as 0, `force` is moot).
//   * no per-model bytes       -> this agent measures each card around its OWN
//                                 serialised load (`measured`); an instance it
//                                 did not load (boot plan, JIT) gets the GGUF
//                                 size split by its gpuSplit (`estimated`).
//   * no post-load TTL change  -> `admin_pinned` / `ttl_seconds` set by a
//                                 policy PUT live in this process's memory and
//                                 are REPORTED; the daemon's own TTL is fixed
//                                 when the instance is loaded (a pinned load is
//                                 sent with no TTL), so a policy ttl takes
//                                 effect at the next load.
// =============================================================================
import { diffAppliedConfig, selectModelKey } from '../loader/kvconfig.mjs';
import { deviceDeltas, measureSettled } from './gpus.mjs';
import { LoadSpecError, buildLoadRequest, deviceOfSplit, estimateDeviceBytes, loadConfigFromFields } from './loadspec.mjs';
import { createMetrics } from './metrics.mjs';

/** A refused verb: contract error `code`, HTTP `status`, extra body fields. */
export class ResidencyError extends Error {
  constructor(code, message, { status, extra = {} } = {}) {
    super(message);
    this.name = 'ResidencyError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }

  body() {
    return { error: { code: this.code, message: this.message, ...this.extra } };
  }
}

const NOT_FOUND = /not found|no model found|does not exist|no such/i;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

const sum = (record) => Object.values(record).reduce((a, b) => a + b, 0);

const splitOf = (fields) => (fields ?? []).find((field) => field.key === 'load.gpuSplitConfig')?.value;

const errorMessage = (error) => String(error?.message ?? error);

/** Measurement knobs. Defaults: 500 ms between nvidia-smi reads, settle within 32 MiB, give up after 15 s. */
export const DEFAULT_MEASURE = Object.freeze({
  intervalMs: 500,
  toleranceBytes: 32 * 1024 * 1024,
  maxWaitMs: 15_000,
  noiseBytes: 32 * 1024 * 1024,
});

/**
 * @param {{
 *   daemon: { greet, listModels, listLoaded, appliedFields, load, unload },
 *   gpus: { read: () => Promise<Array|null> },
 *   env: Record<string, string|undefined>,
 *   instance: string,
 *   clock?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (level: string, event: string, fields?: object) => void,
 *   measure?: Partial<typeof DEFAULT_MEASURE>,
 *   metrics?: ReturnType<typeof createMetrics>,
 * }} deps
 */
export function createResidencyAgent({
  daemon,
  gpus,
  env,
  instance,
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  measure = {},
  metrics = createMetrics(),
}) {
  const knobs = { ...DEFAULT_MEASURE, ...measure };
  /** identifier -> what THIS agent measured when it loaded that instance. */
  const records = new Map();
  /** model_ref -> { admin_pinned?, ttl_seconds? } (policy PUT / load `pin`). */
  const policies = new Map();
  let loading = false;
  let unloadsSeen = 0;

  const gpuCountFrom = (readings) => {
    const override = env.LMS_GPU_COUNT?.trim();
    if (override) {
      const value = Number(override);
      if (Number.isSafeInteger(value) && value >= 1) return value;
      log('warn', 'residency.gpu_count_invalid', { LMS_GPU_COUNT: override });
    }
    return Array.isArray(readings) && readings.length > 0 ? readings.length : undefined;
  };

  const daemonCall = async (what, fn) => {
    try {
      return await fn();
    } catch (error) {
      log('warn', 'residency.daemon_unavailable', { call: what, reason: errorMessage(error) });
      throw new ResidencyError('DAEMON_UNAVAILABLE', `LM Studio daemon did not answer ${what}: ${errorMessage(error)}`, {
        status: 503,
      });
    }
  };

  const appliedOf = async (inst) => {
    try {
      return await daemon.appliedFields(inst);
    } catch (error) {
      log('warn', 'residency.load_config_unreadable', { model_ref: inst.identifier, reason: errorMessage(error) });
      return [];
    }
  };

  const deviceJson = (gpu) => ({
    id: `cuda:${gpu.index}`,
    kind: 'gpu',
    total_bytes: gpu.totalBytes,
    free_bytes: gpu.freeBytes,
    index: gpu.index,
    name: gpu.name,
    uuid: gpu.uuid,
    // The daemon is another process; what IT holds per card is not readable
    // from here without host PID visibility. The gateway attributes per model
    // from `device_bytes` instead.
    process_bytes: null,
  });

  const modelJson = (inst, fields, gpuCount) => {
    const split = splitOf(fields);
    const record = records.get(inst.identifier);
    const own = record && record.instanceReference === inst.instanceReference ? record : undefined;

    let deviceBytes;
    let bytesSource;
    if (own && Object.keys(own.deviceBytes).length > 0) {
      deviceBytes = own.deviceBytes;
      bytesSource = own.bytesSource;
    } else {
      deviceBytes = estimateDeviceBytes(inst.sizeBytes, split, gpuCount);
      bytesSource = Number.isFinite(inst.sizeBytes) && inst.sizeBytes > 0 ? 'estimated' : 'unknown';
    }
    const bytes =
      Object.keys(deviceBytes).length > 0 ? sum(deviceBytes) : bytesSource === 'estimated' ? inst.sizeBytes : null;

    const policy = policies.get(inst.identifier) ?? {};
    const adminPinned = policy.admin_pinned === true;
    const ttlSeconds = 'ttl_seconds' in policy ? policy.ttl_seconds : (own?.ttlSeconds ?? null);

    return {
      model_ref: inst.identifier,
      engine_key: inst.modelKey,
      instance_id: inst.identifier,
      ai_model_id: null,
      cache: inst.type ?? 'llm',
      state: 'loaded',
      device: deviceOfSplit(split, gpuCount),
      bytes,
      bytes_source: bytesSource,
      device_bytes: deviceBytes,
      in_flight: null,
      pinned: adminPinned,
      admin_pinned: adminPinned,
      ttl_seconds: ttlSeconds,
      loaded_at: own ? iso(own.loadedAt) : null,
      last_used_at: null,
      load_seconds: own ? own.loadSeconds : null,
      error: null,
      load_config: loadConfigFromFields(fields),
    };
  };

  const applyLoadPolicy = (modelRef, { pin, ttlSeconds }) => {
    // A load's `pin` only ever ADDS the operator pin; unpinning is a policy PUT.
    if (!pin && (ttlSeconds === null || ttlSeconds === undefined)) return;
    const policy = policies.get(modelRef) ?? {};
    if (pin) policy.admin_pinned = true;
    if (ttlSeconds !== null && ttlSeconds !== undefined) policy.ttl_seconds = ttlSeconds;
    policies.set(modelRef, policy);
  };

  /** JIT instances carry no identifier of their own (identifier === engine key). */
  const matches = (inst, ref) =>
    inst.identifier === ref ||
    (inst.identifier === inst.modelKey &&
      typeof inst.modelKey === 'string' &&
      (inst.modelKey === ref || (inst.modelKey.startsWith(`${ref}@`) && !inst.modelKey.endsWith('@?'))));

  const readSettled = () =>
    measureSettled({
      read: () => gpus.read(),
      sleep,
      intervalMs: knobs.intervalMs,
      toleranceBytes: knobs.toleranceBytes,
      maxWaitMs: knobs.maxWaitMs,
    });

  /**
   * R2-F10: when the load names `load_spec.expected_bytes`, refuse before
   * touching the daemon if a target card has less free memory than its share
   * (the bytes divided by the split, as estimateDeviceBytes books a boot
   * instance — so a split is checked per card). Absent = no check. No reading
   * (no nvidia-smi, or a card missing from it) = skipped with a warning: the
   * gateway's admission has already run, and this is a second line, not the gate.
   */
  const assertRoomFor = (modelRef, request, readings, gpuCount) => {
    if (request.expectedBytes === undefined) return;
    const needs = estimateDeviceBytes(request.expectedBytes, request.gpuSplit, gpuCount);
    const byDevice = new Map((Array.isArray(readings) ? readings : []).map((gpu) => [`cuda:${gpu.index}`, gpu]));
    const entries = Object.entries(needs);
    if (entries.length === 0 || byDevice.size === 0) {
      log('warn', 'residency.memory_check_skipped', {
        model_ref: modelRef,
        expected_bytes: request.expectedBytes,
        reason: 'no usable nvidia-smi reading',
      });
      return;
    }
    for (const [device, needed] of entries) {
      const gpu = byDevice.get(device);
      if (!gpu) {
        log('warn', 'residency.memory_check_skipped', { model_ref: modelRef, device, reason: 'no reading for this card' });
        continue;
      }
      if (gpu.freeBytes < needed) {
        log('warn', 'residency.load_refused_memory', {
          model_ref: modelRef,
          device,
          needed_bytes: needed,
          free_bytes: gpu.freeBytes,
        });
        throw new ResidencyError(
          'INSUFFICIENT_MEMORY',
          `no room to load ${modelRef} on ${device}: needs ${needed} bytes, ${gpu.freeBytes} free`,
          { status: 503, extra: { device, needed_bytes: needed, free_bytes: gpu.freeBytes } },
        );
      }
    }
  };

  // ── read side ─────────────────────────────────────────────────────────────

  async function report() {
    const readings = await gpus.read();
    const gpuCount = gpuCountFrom(readings);
    const loaded = await daemonCall('listLoaded', () => daemon.listLoaded());

    // Forget measurements of instances the daemon no longer holds (its own TTL).
    const live = new Set(loaded.map((inst) => inst.instanceReference));
    for (const [identifier, record] of records) {
      if (!live.has(record.instanceReference)) records.delete(identifier);
    }

    const models = [];
    for (const inst of loaded) models.push(modelJson(inst, await appliedOf(inst), gpuCount));
    return {
      service: 'lm-studio',
      instance,
      reported_at: iso(clock()),
      devices: (readings ?? []).map(deviceJson),
      models,
    };
  }

  async function healthy() {
    try {
      return (await daemon.greet()) === true;
    } catch {
      return false;
    }
  }

  // ── verbs ─────────────────────────────────────────────────────────────────

  async function load({ model_ref: modelRef, load_spec: loadSpec, pin = false, ttl_seconds: ttlSeconds = null, device = null }) {
    // Taken BEFORE the first await: one load at a time per daemon, both because
    // the per-card delta is only meaningful with one load in flight and because
    // two callers could otherwise both see "not loaded" and load two copies.
    if (loading) {
      throw new ResidencyError('LOAD_IN_PROGRESS', 'LM Studio is loading another model; loads are serialised', {
        status: 409,
      });
    }
    loading = true;
    try {
      const readings = await gpus.read();
      const gpuCount = gpuCountFrom(readings);

      let request;
      try {
        request = buildLoadRequest({ modelRef, loadSpec, device, pin, ttlSeconds, gpuCount, env });
      } catch (error) {
        if (!(error instanceof LoadSpecError)) throw error;
        const extra = error.code === 'DEVICE_UNAVAILABLE' ? { device: error.device } : { field: error.field };
        throw new ResidencyError(error.code, error.message, { status: 400, extra });
      }

      const loaded = await daemonCall('listLoaded', () => daemon.listLoaded());
      const existing = loaded.find((inst) => inst.identifier === request.identifier);
      if (existing) {
        applyLoadPolicy(existing.identifier, { pin, ttlSeconds });
        return { outcome: 'already_loaded', model: modelJson(existing, await appliedOf(existing), gpuCount) };
      }

      const catalogue = await daemonCall('listModels', () => daemon.listModels());
      const choice = selectModelKey(catalogue, modelRef);
      if (choice.ambiguous) {
        throw new ResidencyError(
          'LOAD_FAILED',
          `'${modelRef}' is ambiguous — ${choice.ambiguous.length} loadable models match (${choice.ambiguous.join(', ')}); ` +
            'name one exact key. Refusing to guess between quantizations.',
          { status: 400, extra: { candidates: choice.ambiguous } },
        );
      }
      if (!choice.key) {
        throw new ResidencyError('MODEL_UNKNOWN', `LM Studio carries no loadable model '${modelRef}'`, { status: 404 });
      }

      assertRoomFor(modelRef, request, readings, gpuCount);

      const sent = request.kvConfig.fields;
      log('info', 'residency.load_started', {
        model_ref: modelRef,
        engine_key: choice.key,
        identifier: request.identifier,
        device: device ?? null,
        kv_config: Object.fromEntries(sent.map(({ key, value }) => [key, value])),
      });

      const unloadsBefore = unloadsSeen;
      const before = await readSettled();
      const startedAt = clock();
      let info;
      try {
        info = await daemon.load({
          modelKey: choice.key,
          identifier: request.identifier,
          ttlMs: request.ttlMs,
          kvConfig: request.kvConfig,
        });
      } catch (error) {
        log('warn', 'residency.load_failed', { model_ref: modelRef, engine_key: choice.key, reason: errorMessage(error) });
        throw new ResidencyError('LOAD_FAILED', `${modelRef} failed to load: ${errorMessage(error)}`, { status: 500 });
      }
      const loadSeconds = Math.round((clock() - startedAt) / 10) / 100;

      // Fail CLOSED when the read-back itself fails: an unverified load is
      // exactly what the read-back exists to refuse (same posture as A-6).
      let applied = [];
      let problems;
      try {
        applied = await daemon.appliedFields(info);
        problems = diffAppliedConfig(sent, applied);
      } catch (error) {
        problems = [{ key: 'getLoadConfig', message: `the applied configuration could not be verified: ${errorMessage(error)}` }];
      }
      if (problems.length > 0) {
        const summary = problems.map((problem) => problem.message).join('; ');
        if ((env.HOPE_KVCONFIG_ENFORCE ?? 'strict') === 'strict') {
          log('warn', 'residency.load_config_drift', { model_ref: modelRef, problems: summary, action: 'unloaded' });
          try {
            await daemon.unload(info);
          } catch (error) {
            log('warn', 'residency.drift_unload_failed', { model_ref: modelRef, reason: errorMessage(error) });
          }
          throw new ResidencyError(
            'LOAD_FAILED',
            `${modelRef} loaded on different parameters than requested, so it was unloaded again: ${summary}`,
            { status: 500, extra: { fields: problems.map((problem) => problem.key) } },
          );
        }
        log('warn', 'residency.load_config_drift', { model_ref: modelRef, problems: summary, action: 'kept' });
      }

      const after = await readSettled();
      const deviceBytes = deviceDeltas(before, after, knobs.noiseBytes);

      // E13: the daemon numbers GPUs with the CUDA runtime, nvidia-smi with
      // NVML (PCI order). They agree only under CUDA_DEVICE_ORDER=PCI_BUS_ID.
      // A single-card load whose memory grew mostly on ANOTHER card is that
      // disagreement, caught in the act.
      const requestedDevice = deviceOfSplit(request.gpuSplit, gpuCount);
      const grown = Object.entries(deviceBytes).sort((a, b) => b[1] - a[1]);
      if (requestedDevice.startsWith('cuda:') && grown.length > 0 && grown[0][0] !== requestedDevice) {
        log('warn', 'residency.device_order_mismatch', {
          model_ref: modelRef,
          requested: requestedDevice,
          measured: grown[0][0],
          device_bytes: deviceBytes,
          cuda_device_order: env.CUDA_DEVICE_ORDER ?? null,
          message:
            'the load was pinned to one card but its memory appeared on another: the daemon and nvidia-smi number ' +
            'GPUs differently (is CUDA_DEVICE_ORDER=PCI_BUS_ID set on the daemon?) — or a card-mate allocated at the same time',
        });
      }

      records.set(info.identifier, {
        instanceReference: info.instanceReference,
        deviceBytes,
        // An unload during the window frees memory the delta then cannot see.
        bytesSource: unloadsSeen === unloadsBefore ? 'measured' : 'estimated',
        loadedAt: startedAt,
        loadSeconds,
        ttlSeconds: request.ttlMs === undefined ? null : request.ttlMs / 1000,
      });
      applyLoadPolicy(info.identifier, { pin, ttlSeconds });
      metrics.observeLoad(info.identifier, loadSeconds);

      const model = modelJson({ type: 'llm', ...info }, applied, gpuCount);
      log('info', 'residency.loaded', {
        model_ref: modelRef,
        engine_key: info.modelKey,
        device: model.device,
        device_bytes: model.device_bytes,
        load_seconds: loadSeconds,
      });
      return { outcome: 'loaded', model };
    } finally {
      loading = false;
    }
  }

  async function unload({ model_ref: modelRef, device = null, reason = 'admin' }) {
    const loaded = await daemonCall('listLoaded', () => daemon.listLoaded());
    let targets = loaded.filter((inst) => matches(inst, modelRef));
    if (device) {
      const gpuCount = gpuCountFrom(await gpus.read());
      const kept = [];
      for (const inst of targets) {
        if (deviceOfSplit(splitOf(await appliedOf(inst)), gpuCount) === device) kept.push(inst);
      }
      targets = kept;
    }

    let unloaded = false;
    for (const inst of targets) {
      try {
        await daemon.unload(inst);
        unloaded = true;
        unloadsSeen += 1;
        metrics.countEviction(reason);
      } catch (error) {
        if (!NOT_FOUND.test(errorMessage(error))) {
          log('warn', 'residency.unload_failed', { model_ref: modelRef, identifier: inst.identifier, reason: errorMessage(error) });
          throw new ResidencyError('UNLOAD_FAILED', `${inst.identifier} failed to unload: ${errorMessage(error)}`, {
            status: 500,
          });
        }
      }
      // Gone (unloaded now, or already gone): forget what was known about it.
      records.delete(inst.identifier);
      policies.delete(inst.identifier);
      log('info', 'residency.unloaded', { model_ref: modelRef, identifier: inst.identifier });
    }
    return { outcome: unloaded ? 'unloaded' : 'not_loaded', model_ref: modelRef };
  }

  async function setPolicy(modelRef, body) {
    const loaded = await daemonCall('listLoaded', () => daemon.listLoaded());
    const inst = loaded.find((candidate) => candidate.identifier === modelRef) ?? loaded.find((c) => matches(c, modelRef));
    if (!inst) {
      throw new ResidencyError('MODEL_UNKNOWN', `${modelRef} is not loaded in LM Studio`, { status: 404 });
    }
    const policy = policies.get(inst.identifier) ?? {};
    if ('admin_pinned' in body) policy.admin_pinned = body.admin_pinned === true;
    if ('ttl_seconds' in body) policy.ttl_seconds = body.ttl_seconds;
    policies.set(inst.identifier, policy);
    const gpuCount = gpuCountFrom(await gpus.read());
    return { model: modelJson(inst, await appliedOf(inst), gpuCount) };
  }

  /**
   * The Prometheus exposition, its gauges rebuilt from a fresh report (the
   * same bounded daemon reads the report makes). A daemon that does not answer
   * leaves the per-model gauges empty rather than failing the scrape.
   */
  async function metricsText() {
    let current = null;
    try {
      current = await report();
    } catch (error) {
      if (!(error instanceof ResidencyError)) throw error;
    }
    return metrics.render(current);
  }

  return { report, healthy, load, unload, setPolicy, metrics: metricsText };
}
