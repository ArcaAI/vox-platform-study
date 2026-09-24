import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { realSecret } from '../../common/internal-service-headers';
import { IProviderConnectionService } from '../ai-provider-connection';
import { SecretsService } from '../baseServices/_meta/secrets';

/**
 * The gateway's outbound half of the LM Studio control plane, over LM Studio
 * REST v1 (TASK-996 Phase 3; load added by TASK-1005).
 *
 * ── LOAD WORKS, WITHIN FOUR MEASURED RULES (TASK-1005 §10.1) ─────────────────
 *
 * TASK-996 measured `POST /api/v1/models/load` "failing for every payload" and
 * shipped no load. The TASK-1005 Phase 0 spike re-ran it on the llmster pod and
 * found the cause: the schema is STRICT. `ttl`, `identifier` and `gpu` each
 * answer 400 `unrecognized_keys`; the documented keys load fine (an 84 MB
 * embedding in 0.97 s, a 5 GB LLM in 98.4 s). So:
 *
 *  1. ONLY documented keys are sent — built field by field below, never by
 *     spreading a caller's object, so nothing a caller smuggles in can reach
 *     the engine. There is no TTL, no identifier and no GPU placement on this
 *     surface: idle unload is the residency controller's job and the split is
 *     the daemon's own `LMS_GPU_SPLIT_STRATEGY`.
 *  2. Load is NOT idempotent — loading a loaded key creates `<key>:2`, a second
 *     full copy in VRAM. So the adapter LISTS FIRST and answers
 *     `already_loaded` with the existing instance.
 *  3. Loads are SERIALISED per engine: a second concurrent load is refused
 *     (`LOAD_IN_PROGRESS`), not raced — both because two callers could
 *     otherwise both see "not loaded", and because the controller measures a
 *     load's footprint as the device free-memory delta around it, which is
 *     only meaningful with one load in flight. The lock is per PROCESS; see
 *     the TASK-1005 README for the multi-replica caveat.
 *  4. A load gets 300 s; every other call keeps the 5 s read budget.
 *
 * The echoed `load_config` carries the model's whole `prompt_template` (tens
 * of KB of Jinja). It is mapped through a WHITELIST, so it never reaches a
 * response, an error or a log.
 *
 * UNLOAD takes `{instance_id}` and answers 404 `model_not_found` for an
 * instance that is not loaded — reported as `not_loaded`, not as an error.
 *
 * ── ADDRESS ──────────────────────────────────────────────────────────────────
 *
 * From the SYSTEM `AiProviderConnection` row for `llm:lm-studio`, never from an
 * environment variable: an engine endpoint is `db-config`, not the bootstrap
 * floor (`09-infrastructure-devops.md` §Configuration Tiers). The stored value
 * is the OpenAI-compatible base (`http://hope-lmstudio:1234/v1`), so the `/v1`
 * suffix is stripped — LM Studio's own control API lives beside it under
 * `/api/v1`, not beneath it.
 *
 * ── AUTH (optional, D-6) ─────────────────────────────────────────────────────
 *
 * When the `vault-kv` platform secret `LM_STUDIO_API_TOKEN` (descriptor
 * `lmStudio.apiToken`) is set, every request carries `Authorization: Bearer`.
 * Absent — or still the `CHANGE_ME` placeholder — means no header, which is
 * what the engine expects while its API auth is off. Read per request through
 * `SecretsService`, so a rotation needs no restart.
 */

/** Provider identifiers the seed has used for LM Studio; `lm-studio` is canonical. */
const LM_STUDIO_PROVIDERS = ['lm-studio', 'lmstudio'] as const;

const REQUEST_TIMEOUT_MS = 5_000;

/** A load's HTTP budget. The 5.15 GB `gemma-4-e4b-it-qat@q4_0` took 98.4 s on the live pod (§10.1). */
export const LM_STUDIO_LOAD_TIMEOUT_MS = 300_000;

/** One loaded instance, as `GET /api/v1/models[].loaded_instances[]` reports it. */
export interface LmStudioInstance {
  /** `loaded_instances[].id` — the handle `POST .../unload` takes as `instance_id`. */
  identifier: string;
  /** `config.context_length` — the window the engine was ACTUALLY loaded with. */
  contextLength?: number;
  /** `config.parallel` — the decode slots it was actually loaded with. */
  parallel?: number;
  /** `config.flash_attention`. */
  flashAttention?: boolean;
}

/** One catalogued model on the engine's disk, loaded or not. */
export interface LmStudioModel {
  /** `models[].key` — the id that rides the wire as the OpenAI `model` field. */
  modelKey: string;
  /** `models[].size_bytes` — the GGUF on disk. MEASURED, unlike the KV estimate. */
  weightsBytes: number;
  instances: LmStudioInstance[];
}

/**
 * One read of the engine. `reachable: false` is a RESULT, not an error: the
 * runtime screen must be able to say "the engine is down" rather than 500.
 */
export interface LmStudioSnapshot {
  reachable: boolean;
  models: LmStudioModel[];
}

/**
 * The documented REST v1 load options, camelCased. This is the WHOLE surface:
 * `parallel`, KV-cache quantization, GPU placement and TTL have no REST key.
 */
export interface LmStudioLoadOptions {
  contextLength?: number;
  evalBatchSize?: number;
  flashAttention?: boolean;
  numExperts?: number;
  offloadKvCacheToGpu?: boolean;
}

/** The config the engine reports an instance was loaded with, whitelisted (no `prompt_template`). */
export interface LmStudioLoadConfig {
  contextLength?: number;
  evalBatchSize?: number;
  physicalBatchSize?: number;
  parallel?: number;
  flashAttention?: boolean;
  offloadKvCacheToGpu?: boolean;
  numExperts?: number;
}

/**
 * One loaded INSTANCE in the residency contract's `gateway` shape
 * (`tests/contracts/model-residency-agent.fixture.json` → `gateway.report.models[]`).
 *
 * LM Studio reports no per-model bytes, in-flight count or timestamps, so those
 * are `null` — the controller fills `bytes` from the DCGM delta it measured
 * around its own serialised load. `device` is `multi` because the daemon splits
 * a model across both cards itself.
 */
export interface LmStudioResidencyModel {
  /** `models[].key` — the exact key a load takes. */
  modelRef: string;
  aiModelId: string | null;
  /** LM Studio's model `type` (`llm`, `embedding`, …). */
  cache: string;
  state: 'loading' | 'loaded' | 'unloading';
  device: string;
  bytes: number | null;
  bytesSource: 'measured' | 'unknown';
  inFlight: number | null;
  pinned: boolean;
  adminPinned: boolean;
  ttlSeconds: number | null;
  loadedAt: string | null;
  lastUsedAt: string | null;
  /** `load_time_seconds` on the load that produced this entry; `null` on a read. */
  loadSeconds: number | null;
  /** The instance handle an unload takes. */
  instanceId: string;
  loadConfig: LmStudioLoadConfig;
}

/** The `gateway.report` residency shape for the LM Studio engine. */
export interface LmStudioResidencyReport {
  service: 'lm-studio';
  /** The engine's address (`host:port`) — REST v1 exposes no pod or host name. */
  instance: string;
  reportedAt: string;
  /** Always empty: LM Studio reports no device memory. DCGM is the source. */
  devices: never[];
  models: LmStudioResidencyModel[];
}

export type LmStudioLoadOutcome = 'loaded' | 'already_loaded';
export type LmStudioUnloadOutcome = 'unloaded' | 'not_loaded';

export interface LmStudioLoadResult {
  outcome: LmStudioLoadOutcome;
  model: LmStudioResidencyModel;
}

export interface LmStudioUnloadResult {
  outcome: LmStudioUnloadOutcome;
  instanceId: string;
}

export type LmStudioEngineErrorCode =
  'ENGINE_NOT_CONFIGURED' | 'ENGINE_UNREACHABLE' | 'MODEL_UNKNOWN' | 'LOAD_IN_PROGRESS' | 'LOAD_FAILED' | 'UNLOAD_FAILED';

/** A typed engine failure; the serving service maps `code` to an HTTP status. */
export class LmStudioEngineError extends Error {
  constructor(
    readonly code: LmStudioEngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LmStudioEngineError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** snake_case engine config key → camelCase report key. Anything not listed (notably `prompt_template`) is dropped. */
const LOAD_CONFIG_NUMBERS = {
  context_length: 'contextLength',
  eval_batch_size: 'evalBatchSize',
  physical_batch_size: 'physicalBatchSize',
  parallel: 'parallel',
  num_experts: 'numExperts',
} as const;
const LOAD_CONFIG_BOOLEANS = {
  flash_attention: 'flashAttention',
  offload_kv_cache_to_gpu: 'offloadKvCacheToGpu',
} as const;

function toLoadConfig(raw: unknown): LmStudioLoadConfig {
  const config = asRecord(raw) ?? {};
  const out: LmStudioLoadConfig = {};
  for (const [from, to] of Object.entries(LOAD_CONFIG_NUMBERS)) {
    const value = asPositiveNumber(config[from]);
    if (value !== undefined) out[to] = value;
  }
  for (const [from, to] of Object.entries(LOAD_CONFIG_BOOLEANS)) {
    if (typeof config[from] === 'boolean') out[to] = config[from];
  }
  return out;
}

function residencyModel(modelRef: string, cache: string, instanceId: string, config: unknown, loadSeconds: number | null): LmStudioResidencyModel {
  return {
    modelRef,
    aiModelId: null,
    cache,
    state: 'loaded',
    device: 'multi',
    bytes: null,
    bytesSource: 'unknown',
    inFlight: null,
    pinned: false,
    adminPinned: false,
    ttlSeconds: null,
    loadedAt: null,
    lastUsedAt: null,
    loadSeconds,
    instanceId,
    loadConfig: toLoadConfig(config),
  };
}

/** `{ error: { message, code } }` → a short, template-free reason for an error message. */
function engineReason(body: unknown): string {
  const error = asRecord(asRecord(body)?.error);
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const message = typeof error?.message === 'string' ? error.message.slice(0, 300) : undefined;
  return [code, message].filter(Boolean).join(': ') || 'no reason given';
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

@Injectable()
export class LmStudioEngineClient {
  private readonly logger = new Logger(LmStudioEngineClient.name);

  /** Engines (by control-API base URL) with a load in flight. Claimed synchronously, so the check-and-claim cannot interleave. */
  private readonly loadsInFlight = new Set<string>();

  constructor(
    // Optional so a unit fixture can construct the service graph without the
    // provider-connection module; an unresolved address simply reads as an
    // unreachable engine.
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnections?: IProviderConnectionService,
    // Optional for the same reason; no SecretsService means no token, which is
    // the engine's own default (API auth off).
    @Optional() @Inject(SecretsService) private readonly secrets?: SecretsService,
  ) {}

  /**
   * Every catalogued model plus its loaded instances, or `reachable: false`.
   *
   * ONE call answers the whole runtime projection: `GET /api/v1/models` carries
   * the key, the weights and the in-force load config together, which is why
   * `/api/v0/models` (loaded state only, no config) is not also read.
   */
  async snapshot(): Promise<LmStudioSnapshot> {
    const baseUrl = await this.baseUrl();
    if (!baseUrl) return { reachable: false, models: [] };

    const models = await this.listModels(baseUrl);
    if (!models) return { reachable: false, models: [] };

    return { reachable: true, models: models.map((raw) => this.toModel(raw)).filter((model): model is LmStudioModel => model !== null) };
  }

  /**
   * The residency contract's `gateway.report` for this engine: one entry per
   * loaded INSTANCE (a `<key>:2` duplicate is its own row, which is how a
   * double load becomes visible).
   *
   * Throws `ENGINE_NOT_CONFIGURED` / `ENGINE_UNREACHABLE` — an empty report
   * would read as "nothing resident", which is a different, false statement.
   */
  async report(): Promise<LmStudioResidencyReport> {
    const baseUrl = await this.requireBaseUrl();
    const models = await this.listModels(baseUrl);
    if (!models) throw new LmStudioEngineError('ENGINE_UNREACHABLE', `LM Studio at ${baseUrl} did not answer GET /api/v1/models.`);

    return {
      service: 'lm-studio',
      instance: new URL(baseUrl).host,
      reportedAt: new Date().toISOString(),
      devices: [],
      models: models.flatMap((raw) => {
        const model = asRecord(raw);
        const key = typeof model?.key === 'string' ? model.key : null;
        if (!key) return [];
        return this.instancesOf(model).map((instance) => residencyModel(key, this.cacheOf(model), instance.id, instance.config, null));
      }),
    };
  }

  /**
   * Load one model by its EXACT key — or report the instance already holding it.
   *
   * Lists first under the per-engine lock (rule 2 and 3 in the class doc), so
   * an already-loaded key answers `already_loaded` and never creates `:2`. The
   * key must be one the engine lists; there is no prefix matching (a bare
   * `gemma-4-e2b-it-qat` matches both the model and its CLIP projector —
   * `infrastructure/docker/lmstudio/loader/load.mjs`).
   */
  async load(modelKey: string, options: LmStudioLoadOptions = {}): Promise<LmStudioLoadResult> {
    const baseUrl = await this.requireBaseUrl();

    if (this.loadsInFlight.has(baseUrl)) {
      throw new LmStudioEngineError(
        'LOAD_IN_PROGRESS',
        `Another load is in progress on LM Studio at ${baseUrl}. Loads are serialised per engine; retry once it settles.`,
      );
    }
    this.loadsInFlight.add(baseUrl);
    try {
      const models = await this.listModels(baseUrl);
      if (!models) {
        throw new LmStudioEngineError('ENGINE_UNREACHABLE', `LM Studio at ${baseUrl} could not be listed, so nothing was loaded.`);
      }

      const listed = models.map(asRecord).find((model) => model?.key === modelKey);
      if (!listed) throw new LmStudioEngineError('MODEL_UNKNOWN', `LM Studio does not carry a model with the exact key '${modelKey}'.`);

      const [existing] = this.instancesOf(listed);
      if (existing) {
        return { outcome: 'already_loaded', model: residencyModel(modelKey, this.cacheOf(listed), existing.id, existing.config, null) };
      }

      const started = Date.now();
      let response: Response;
      try {
        response = await this.fetchWithTimeout(
          `${baseUrl}/api/v1/models/load`,
          { method: 'POST', headers: await this.headers(true), body: JSON.stringify(this.loadBody(modelKey, options)) },
          LM_STUDIO_LOAD_TIMEOUT_MS,
        );
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'AbortError';
        throw new LmStudioEngineError(
          'LOAD_FAILED',
          timedOut
            ? `LM Studio did not finish loading '${modelKey}' within ${LM_STUDIO_LOAD_TIMEOUT_MS / 1000} s. The engine may still complete it — re-read the runtime before retrying.`
            : `LM Studio could not be reached to load '${modelKey}': ${String(error)}`,
        );
      }

      const body = await readBody(response);
      if (!response.ok) {
        throw new LmStudioEngineError('LOAD_FAILED', `LM Studio refused to load '${modelKey}' (HTTP ${response.status} ${engineReason(body)}).`);
      }

      const loaded = asRecord(body) ?? {};
      const instanceId = typeof loaded.instance_id === 'string' ? loaded.instance_id : modelKey;
      const loadSeconds = asPositiveNumber(loaded.load_time_seconds) ?? (Date.now() - started) / 1000;
      const cache = typeof loaded.type === 'string' ? loaded.type : this.cacheOf(listed);
      const model = residencyModel(modelKey, cache, instanceId, loaded.load_config, loadSeconds);

      this.logger.log({ message: 'LM Studio model loaded', modelKey, instanceId, loadSeconds, loadConfig: model.loadConfig });
      return { outcome: 'loaded', model };
    } finally {
      this.loadsInFlight.delete(baseUrl);
    }
  }

  /**
   * Unload one loaded instance. `not_loaded` when the engine holds no such
   * instance (404 `model_not_found`) — an absent instance is not an error.
   *
   * ADVISORY, always: JIT loading cannot be disabled on this build, so the next
   * inference request naming the model loads it straight back.
   *
   * Throws `UNLOAD_FAILED` on any other refusal, so a route never reports a
   * resident instance as gone.
   */
  async unload(instanceId: string): Promise<LmStudioUnloadResult> {
    const baseUrl = await this.requireBaseUrl();

    const response = await this.fetchWithTimeout(
      `${baseUrl}/api/v1/models/unload`,
      { method: 'POST', headers: await this.headers(true), body: JSON.stringify({ instance_id: instanceId }) },
      REQUEST_TIMEOUT_MS,
    );
    if (response.ok) return { outcome: 'unloaded', instanceId };

    const body = await readBody(response);
    const code = asRecord(asRecord(body)?.error)?.code;
    if (response.status === 404 || code === 'model_not_found') return { outcome: 'not_loaded', instanceId };

    throw new LmStudioEngineError('UNLOAD_FAILED', `LM Studio refused to unload '${instanceId}' (HTTP ${response.status} ${engineReason(body)}).`);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** The documented REST v1 body, built key by key — never a spread of caller input. */
  private loadBody(modelKey: string, options: LmStudioLoadOptions): Record<string, unknown> {
    const body: Record<string, unknown> = { model: modelKey };
    if (options.contextLength !== undefined) body.context_length = options.contextLength;
    if (options.evalBatchSize !== undefined) body.eval_batch_size = options.evalBatchSize;
    if (options.flashAttention !== undefined) body.flash_attention = options.flashAttention;
    if (options.numExperts !== undefined) body.num_experts = options.numExperts;
    if (options.offloadKvCacheToGpu !== undefined) body.offload_kv_cache_to_gpu = options.offloadKvCacheToGpu;
    body.echo_load_config = true;
    return body;
  }

  /** `Authorization: Bearer` only when a real token is configured. */
  private async headers(withBody: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = withBody ? { 'Content-Type': 'application/json' } : {};
    const token = realSecret(await this.secrets?.getSecretOptional('LM_STUDIO_API_TOKEN').catch(() => undefined));
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /**
   * The engine's own control-API base, `/v1` suffix removed.
   *
   * `null` when no SYSTEM row carries an address — which the caller renders as
   * an unreachable engine rather than as a crash, because "nobody configured
   * the endpoint" and "the pod is down" look identical to a console and are
   * both fixed on the providers screen.
   */
  private async baseUrl(): Promise<string | null> {
    if (!this.providerConnections) return null;
    for (const provider of LM_STUDIO_PROVIDERS) {
      const row = await this.providerConnections.resolveConnection('llm', provider, SYSTEM_TENANT_ID).catch(() => null);
      if (row?.baseUrl) return row.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    }
    return null;
  }

  private async requireBaseUrl(): Promise<string> {
    const baseUrl = await this.baseUrl();
    if (!baseUrl) {
      throw new LmStudioEngineError(
        'ENGINE_NOT_CONFIGURED',
        'The LM Studio engine address is not configured (SYSTEM `llm:lm-studio` provider connection).',
      );
    }
    return baseUrl;
  }

  /** `GET /api/v1/models` → `models[]`, or `null` when the engine did not answer with that shape. */
  private async listModels(baseUrl: string): Promise<unknown[] | null> {
    const body = await this.getJson(`${baseUrl}/api/v1/models`);
    return body && Array.isArray(body.models) ? body.models : null;
  }

  private instancesOf(model: Record<string, unknown> | undefined): Array<{ id: string; config: unknown }> {
    const instances = Array.isArray(model?.loaded_instances) ? model.loaded_instances : [];
    return instances.flatMap((raw) => {
      const instance = asRecord(raw);
      return typeof instance?.id === 'string' ? [{ id: instance.id, config: instance.config }] : [];
    });
  }

  private cacheOf(model: Record<string, unknown> | undefined): string {
    return typeof model?.type === 'string' ? model.type : 'llm';
  }

  private toModel(raw: unknown): LmStudioModel | null {
    const model = asRecord(raw);
    const modelKey = typeof model?.key === 'string' ? model.key : null;
    if (!modelKey) return null;

    return {
      modelKey,
      weightsBytes: typeof model?.size_bytes === 'number' && Number.isFinite(model.size_bytes) ? model.size_bytes : 0,
      instances: this.instancesOf(model).map(({ id, config }) => {
        const loadConfig = toLoadConfig(config);
        return {
          identifier: id,
          contextLength: loadConfig.contextLength,
          parallel: loadConfig.parallel,
          flashAttention: loadConfig.flashAttention,
        };
      }),
    };
  }

  /**
   * A GET that degrades to `null`. Every unknown path on this server answers
   * `200 {"error": "Unexpected endpoint..."}` rather than a 404 on some
   * versions, so the caller checks for the SHAPE it expects rather than for the
   * status alone.
   */
  private async getJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.fetchWithTimeout(url, { method: 'GET', headers: await this.headers(false) }, REQUEST_TIMEOUT_MS);
      if (!response.ok) {
        this.logger.debug({ message: 'LM Studio read returned non-200', url, status: response.status });
        return null;
      }
      return asRecord(await response.json()) ?? null;
    } catch (error) {
      this.logger.debug({ message: 'LM Studio read failed (reporting the engine as unreachable)', url, error: String(error) });
      return null;
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
