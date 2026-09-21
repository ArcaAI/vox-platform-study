import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { IProviderConnectionService } from '../ai-provider-connection';

/**
 * TASK-996 Phase 3 — the gateway's outbound half of the LM Studio control
 * plane.
 *
 * ── WHAT THIS CLIENT DELIBERATELY DOES NOT DO ────────────────────────────────
 *
 * It does not LOAD a model, and the omission is measured rather than
 * conservative. `POST /api/v1/models/load` fails on this deployment under EVERY
 * payload tried, including a control carrying only `{model, context_length}`
 * (ticket §2.8) — so it cannot load `hope/`-published symlinked GGUFs at all.
 * Even where it answered, it could not carry three of the five profile fields:
 * the REST body has no key for KV-cache quantization and none for GPU
 * placement. The ONE working load path is the `@lmstudio/sdk` kvConfig
 * websocket, which `infrastructure/docker/lmstudio/loader/load.mjs` drives over
 * LOOPBACK at pod boot; it is not reachable from the gateway process.
 *
 * So there is no `load()` here to call by accident. `LmStudioServingService`
 * refuses the route with a typed, honest error instead of dispatching to an
 * endpoint that is known not to work.
 *
 * UNLOAD, by contrast, IS reachable and is implemented: `POST
 * /api/v1/models/unload` takes `{instance_id}` and answers 404
 * `model_not_found` for an instance that is not loaded (both verified against
 * the live pod, 2026-09-21).
 *
 * ── ADDRESS ──────────────────────────────────────────────────────────────────
 *
 * From the SYSTEM `AiProviderConnection` row for `llm:lm-studio`, never from an
 * environment variable: an engine endpoint is `db-config`, not the bootstrap
 * floor (`09-infrastructure-devops.md` §Configuration Tiers). The stored value
 * is the OpenAI-compatible base (`http://hope-lmstudio:1234/v1`), so the `/v1`
 * suffix is stripped — LM Studio's own control API lives beside it under
 * `/api/v1`, not beneath it.
 */

/** Provider identifiers the seed has used for LM Studio; `lm-studio` is canonical. */
const LM_STUDIO_PROVIDERS = ['lm-studio', 'lmstudio'] as const;

const REQUEST_TIMEOUT_MS = 5_000;

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

@Injectable()
export class LmStudioEngineClient {
  private readonly logger = new Logger(LmStudioEngineClient.name);

  constructor(
    // Optional so a unit fixture can construct the service graph without the
    // provider-connection module; an unresolved address simply reads as an
    // unreachable engine.
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnections?: IProviderConnectionService,
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

    const body = await this.getJson(`${baseUrl}/api/v1/models`);
    const models = body && Array.isArray(body.models) ? body.models : undefined;
    if (!models) return { reachable: false, models: [] };

    return { reachable: true, models: models.map((raw) => this.toModel(raw)).filter((model): model is LmStudioModel => model !== null) };
  }

  /**
   * Unload one loaded instance.
   *
   * ADVISORY, always: JIT loading cannot be disabled on this build (no CLI
   * flag, no REST field, no settings key — measured), so the next inference
   * request loads the model straight back, on the JIT defaults rather than on
   * the profile it was unloaded from. The caller says so in its response; this
   * method does not pretend the eviction is permanent.
   *
   * Throws when the engine refuses, so the route reports a failure rather than
   * a 202 for an instance that is still resident.
   */
  async unload(instanceId: string): Promise<void> {
    const baseUrl = await this.baseUrl();
    if (!baseUrl) throw new Error('The LM Studio engine address is not configured.');

    const response = await this.fetchWithTimeout(`${baseUrl}/api/v1/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance_id: instanceId }),
    });
    if (!response.ok) {
      throw new Error(`LM Studio refused to unload '${instanceId}' (HTTP ${response.status}).`);
    }
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

  private toModel(raw: unknown): LmStudioModel | null {
    const model = asRecord(raw);
    const modelKey = typeof model?.key === 'string' ? model.key : null;
    if (!modelKey) return null;

    const instances = Array.isArray(model?.loaded_instances) ? model.loaded_instances : [];
    return {
      modelKey,
      weightsBytes: typeof model?.size_bytes === 'number' && Number.isFinite(model.size_bytes) ? model.size_bytes : 0,
      instances: instances.map((entry) => this.toInstance(entry)).filter((entry): entry is LmStudioInstance => entry !== null),
    };
  }

  private toInstance(raw: unknown): LmStudioInstance | null {
    const instance = asRecord(raw);
    const identifier = typeof instance?.id === 'string' ? instance.id : null;
    if (!identifier) return null;

    const config = asRecord(instance?.config) ?? {};
    return {
      identifier,
      contextLength: asPositiveNumber(config.context_length),
      parallel: asPositiveNumber(config.parallel),
      flashAttention: typeof config.flash_attention === 'boolean' ? config.flash_attention : undefined,
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
      const response = await this.fetchWithTimeout(url, { method: 'GET' });
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

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
