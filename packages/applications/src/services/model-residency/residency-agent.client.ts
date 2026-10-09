import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../common/internal-service-headers';
import { IConfigService } from '../baseServices/_meta/config';
import { SecretsService } from '../baseServices/_meta/secrets';
import type { ReportedDevice, ReportedLoadConfig, ReportedResidentModel, ResidencyLoadError, ServiceResidencyReport } from './model-residency.types';

/**
 * TASK-1005 — the gateway's client for the residency AGENT every model-serving
 * Python process mounts (`hope_runtime_models.residency_api`, today in `stt`,
 * `nlp` and — TASK-1055 wave 3 — `tts`, at `TTS_URL`). Wire contract: `tests/contracts/model-residency-agent.fixture.json`
 * → `python` (snake_case); this client hands the controller the camelCase
 * `gateway` shape.
 *
 * TASK-1055 — LM Studio is commanded through the SAME contract: an in-pod Node
 * sidecar on :8869 (`tests/contracts/model-residency-task1055.fixture.json` →
 * `lmStudioAgent`) reached at `LMSTUDIO_AGENT_URL`, an env-tier bootstrap
 * TRANSPORT address. Unset = LM Studio is unreachable for residency; there is
 * deliberately no fallback to its REST API, which cannot carry the serving
 * profile (parallel slots, KV quant, GPU split, identifier — ticket E3).
 * v2 adds an optional `device` (`cuda:<n>`) on load and unload.
 *
 *   GET  /internal/residency
 *   POST /internal/residency/load     {model_ref, load_spec, pin, ttl_seconds, device?}
 *   POST /internal/residency/unload   {model_ref, force, reason, device?}
 *   PUT  /internal/residency/models/{model_ref}/policy {admin_pinned?, ttl_seconds?}
 *
 * Mounted at the service ROOT (not under `/api/v1`), behind each service's
 * `X-Service-Token` middleware. The work is platform-wide, so the tenant header
 * DECLARES itself tenant-less (`tenantless:control-plane`) rather than being
 * absent — an absent header is a caller defect (owner directive 2026-08-16).
 *
 * `stt-worker` has no HTTP API (metrics only on :9191): it is not addressable
 * here, by design — the controller observes it through Prometheus and never
 * commands it.
 */

export type ResidencyAgentService = 'stt' | 'nlp' | 'lm-studio' | 'tts';

export type ResidencyAgentErrorCode =
  | 'MODEL_UNKNOWN'
  | 'IN_FLIGHT'
  | 'INSUFFICIENT_MEMORY'
  | 'LOAD_FAILED'
  | 'LOAD_IN_PROGRESS'
  // TASK-1055 — the agent sees no such device.
  | 'DEVICE_UNAVAILABLE'
  | 'SERVICE_UNREACHABLE'
  | 'AGENT_ERROR';

const KNOWN_CODES: readonly ResidencyAgentErrorCode[] = [
  'MODEL_UNKNOWN',
  'IN_FLIGHT',
  'INSUFFICIENT_MEMORY',
  'LOAD_FAILED',
  'LOAD_IN_PROGRESS',
  'DEVICE_UNAVAILABLE',
];

/** TASK-1055 — what an `INSUFFICIENT_MEMORY` / `DEVICE_UNAVAILABLE` refusal says about the device. */
export interface ResidencyAgentErrorDetail {
  device?: string;
  neededBytes?: number;
  freeBytes?: number;
  headroomBytes?: number;
  /** TASK-1055 review R1-F5 — the GATEWAY gave up waiting (the agent may still be working on it). */
  timedOut?: boolean;
}

/** A refused or failed agent call. `status` is the agent's own HTTP status (0 when it never answered). */
export class ResidencyAgentError extends Error {
  readonly device?: string;
  readonly neededBytes?: number;
  readonly freeBytes?: number;
  readonly headroomBytes?: number;
  readonly timedOut?: boolean;

  constructor(
    readonly code: ResidencyAgentErrorCode,
    message: string,
    readonly status: number,
    readonly inFlight?: number,
    readonly retryAfterSeconds?: number,
    detail: ResidencyAgentErrorDetail = {},
  ) {
    super(message);
    this.name = 'ResidencyAgentError';
    if (detail.device !== undefined) this.device = detail.device;
    if (detail.neededBytes !== undefined) this.neededBytes = detail.neededBytes;
    if (detail.freeBytes !== undefined) this.freeBytes = detail.freeBytes;
    if (detail.headroomBytes !== undefined) this.headroomBytes = detail.headroomBytes;
    if (detail.timedOut) this.timedOut = true;
  }
}

export interface AgentLoadRequest {
  modelRef: string;
  /**
   * Service-specific: stt `{resolved_spec}`, nlp `{cache, model_path, …}` (fixture `loadSpecExamples`), lm-studio the resolved serving
   * profile (`identifier`, `context_length`, `parallel`, …). Forwarded verbatim.
   */
  loadSpec: Record<string, unknown>;
  pin: boolean;
  ttlSeconds?: number | null;
  /** TASK-1055 — the AGENT's device id (`cuda:<n>`, `cpu`); absent = the service's own placement. */
  device?: string;
}

export interface AgentLoadResult {
  outcome: 'loaded' | 'already_loaded';
  model: ReportedResidentModel;
}

export interface AgentUnloadRequest {
  modelRef: string;
  force: boolean;
  /** Labels the agent's `model_evictions_total{reason}`. */
  reason: 'admin' | 'policy';
  /** TASK-1055 — unload only the copy on this AGENT device; absent = every copy. */
  device?: string;
}

export interface AgentUnloadResult {
  outcome: 'unloaded' | 'not_loaded';
  modelRef: string;
}

/** An ABSENT field is left as it is on the agent; `ttlSeconds: null` resets it to the service default. */
export interface AgentPolicyRequest {
  adminPinned?: boolean;
  ttlSeconds?: number | null;
}

/** Where each agent lives — env-tier bootstrap transport addresses (`IConfigService`). */
const URL_KEYS: Record<ResidencyAgentService, string> = { stt: 'STT_URL', nlp: 'NLP_URL', 'lm-studio': 'LMSTUDIO_AGENT_URL', tts: 'TTS_URL' };

/** A report is cheap; it must never hold up the 10 s decision tick. */
const REPORT_TIMEOUT_MS = 3_000;
/**
 * A load runs off every request path (async 202 / background tick), and the gateway must outwait the
 * agent's OWN load budget — otherwise it reports a timeout (and frees the card) while the agent is still
 * loading. LM Studio's agent allows 600 s by default (`LMS_AGENT_LOAD_TIMEOUT_SECONDS`, infrastructure/
 * docker/lmstudio/agent/server.mjs), the python agents less; 900 s leaves a margin over the longest.
 * A constant (TASK-1055 review R1-F5): there is no residency transport-timeout setting to resolve it from,
 * and a timeout that disagrees with the agents' is a bug in either place, not a tuning knob.
 */
export const RESIDENCY_AGENT_LOAD_TIMEOUT_MS = 900_000;
const LOAD_TIMEOUT_MS = RESIDENCY_AGENT_LOAD_TIMEOUT_MS;
const COMMAND_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function toDevice(raw: unknown): ReportedDevice {
  const d = asRecord(raw);
  const device: ReportedDevice = {
    id: str(d.id) ?? 'unknown',
    kind: d.kind === 'cpu' ? 'cpu' : 'gpu',
    totalBytes: num(d.total_bytes) ?? 0,
    freeBytes: num(d.free_bytes) ?? 0,
  };
  // TASK-1055 v2 extras — present only when the agent sends them, so a TASK-1005 agent's report reads exactly as before.
  const index = num(d.index);
  if (index !== null) device.index = index;
  const name = str(d.name);
  if (name) device.name = name;
  const uuid = str(d.uuid);
  if (uuid) device.uuid = uuid;
  if ('process_bytes' in d) device.processBytes = num(d.process_bytes);
  return device;
}

const intList = (value: unknown): number[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : undefined;

/** The agent's `load_config` (snake_case) → camelCase. Unknown keys are dropped. */
function toLoadConfig(raw: unknown): ReportedLoadConfig | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = asRecord(raw);
  const out: ReportedLoadConfig = {};
  const contextLength = num(c.context_length);
  if (contextLength !== null) out.contextLength = contextLength;
  const parallel = num(c.parallel);
  if (parallel !== null) out.parallel = parallel;
  if (typeof c.flash_attention === 'boolean') out.flashAttention = c.flash_attention;
  const kv = asRecord(c.kv_cache_quant);
  if (str(kv.k) || str(kv.v)) out.kvCacheQuant = { ...(str(kv.k) ? { k: str(kv.k)! } : {}), ...(str(kv.v) ? { v: str(kv.v)! } : {}) };
  if (c.gpu_split && typeof c.gpu_split === 'object') {
    const g = asRecord(c.gpu_split);
    out.gpuSplit = {
      ...(str(g.strategy) ? { strategy: str(g.strategy)! } : {}),
      ...(intList(g.priority) ? { priority: intList(g.priority) } : {}),
      ...(intList(g.disabled_gpus) ? { disabledGpus: intList(g.disabled_gpus) } : {}),
      ...(intList(g.custom_ratio) ? { customRatio: intList(g.custom_ratio) } : {}),
    };
  }
  return out;
}

function toDeviceBytes(raw: unknown): Record<string, number> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [device, bytes] of Object.entries(raw as Json)) if (num(bytes) !== null) out[device] = num(bytes)!;
  return out;
}

function toLoadError(raw: unknown): ResidencyLoadError | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = asRecord(raw);
  return { code: str(e.code) ?? 'LOAD_FAILED', message: (str(e.message) ?? '').slice(0, 500), at: str(e.at) };
}

/** snake_case agent model → the contract's camelCase `gateway` model. */
export function toReportedModel(raw: unknown): ReportedResidentModel {
  const m = asRecord(raw);
  const state = m.state === 'loading' || m.state === 'unloading' || m.state === 'failed' ? m.state : 'loaded';
  const error = toLoadError(m.error);
  return {
    modelRef: str(m.model_ref) ?? '',
    aiModelId: str(m.ai_model_id),
    cache: str(m.cache) ?? 'unknown',
    state,
    device: str(m.device) ?? 'unknown',
    bytes: num(m.bytes),
    bytesSource: m.bytes_source === 'measured' || m.bytes_source === 'estimated' ? m.bytes_source : 'unknown',
    inFlight: num(m.in_flight),
    pinned: m.pinned === true,
    adminPinned: m.admin_pinned === true,
    ttlSeconds: num(m.ttl_seconds),
    loadedAt: str(m.loaded_at),
    lastUsedAt: str(m.last_used_at),
    loadSeconds: num(m.load_seconds),
    // TASK-1055 — LM Studio agent extras and per-device bytes; absent from a TASK-1005 report, and then not set at all.
    ...(str(m.instance_id) ? { instanceId: str(m.instance_id)! } : {}),
    ...(str(m.engine_key) ? { engineKey: str(m.engine_key)! } : {}),
    ...(toDeviceBytes(m.device_bytes) ? { deviceBytes: toDeviceBytes(m.device_bytes) } : {}),
    ...(toLoadConfig(m.load_config) ? { loadConfig: toLoadConfig(m.load_config) } : {}),
    // A `failed` model always carries an error, even from an agent that omitted it.
    ...(state === 'failed' ? { error: error ?? { code: 'LOAD_FAILED', message: '', at: null } } : error ? { error } : {}),
  };
}

@Injectable()
export class ResidencyAgentClient {
  private readonly logger = new Logger(ResidencyAgentClient.name);

  constructor(
    @Inject(IConfigService) private readonly config: IConfigService,
    // Optional: without it no token is presented, which is the local-dev bypass
    // every Python `ServiceAuthMiddleware` already implements.
    @Optional() private readonly secrets?: SecretsService,
  ) {}

  async report(service: ResidencyAgentService): Promise<ServiceResidencyReport> {
    const body = asRecord(await this.call(service, 'GET', '/internal/residency', undefined, REPORT_TIMEOUT_MS));
    return {
      service,
      instance: str(body.instance) ?? service,
      reportedAt: str(body.reported_at) ?? new Date().toISOString(),
      devices: (Array.isArray(body.devices) ? body.devices : []).map(toDevice),
      models: (Array.isArray(body.models) ? body.models : []).map(toReportedModel).filter((m) => m.modelRef.length > 0),
    };
  }

  async load(service: ResidencyAgentService, request: AgentLoadRequest): Promise<AgentLoadResult> {
    const body = asRecord(
      await this.call(
        service,
        'POST',
        '/internal/residency/load',
        {
          model_ref: request.modelRef,
          load_spec: request.loadSpec,
          pin: request.pin,
          ttl_seconds: request.ttlSeconds ?? null,
          ...(request.device ? { device: request.device } : {}),
        },
        LOAD_TIMEOUT_MS,
      ),
    );
    return { outcome: body.outcome === 'already_loaded' ? 'already_loaded' : 'loaded', model: toReportedModel(body.model) };
  }

  async unload(service: ResidencyAgentService, request: AgentUnloadRequest): Promise<AgentUnloadResult> {
    const body = asRecord(
      await this.call(
        service,
        'POST',
        '/internal/residency/unload',
        { model_ref: request.modelRef, force: request.force, reason: request.reason, ...(request.device ? { device: request.device } : {}) },
        COMMAND_TIMEOUT_MS,
      ),
    );
    return { outcome: body.outcome === 'not_loaded' ? 'not_loaded' : 'unloaded', modelRef: str(body.model_ref) ?? request.modelRef };
  }

  async setPolicy(service: ResidencyAgentService, modelRef: string, request: AgentPolicyRequest): Promise<ReportedResidentModel> {
    const payload: Json = {};
    if (request.adminPinned !== undefined) payload.admin_pinned = request.adminPinned;
    if (request.ttlSeconds !== undefined) payload.ttl_seconds = request.ttlSeconds;
    // A hub id contains `/`; the route takes the rest of the path, but a caller still encodes it.
    const path = `/internal/residency/models/${encodeURIComponent(modelRef)}/policy`;
    const body = asRecord(await this.call(service, 'PUT', path, payload, COMMAND_TIMEOUT_MS));
    return toReportedModel(body.model);
  }

  // ── transport ─────────────────────────────────────────────────────────────

  /**
   * One agent call. A refusal or failure of a COMMAND (anything but the 10 s report read, whose outage the
   * controller logs once per outage) is logged at warn with the agent's code and reason (TASK-1055 AC-6) before
   * it is thrown.
   */
  private async call(service: ResidencyAgentService, method: string, path: string, payload: Json | undefined, timeoutMs: number): Promise<unknown> {
    try {
      return await this.send(service, method, path, payload, timeoutMs);
    } catch (error) {
      if (error instanceof ResidencyAgentError && method !== 'GET') {
        this.logger.warn({
          message: 'residency.agent.call_failed',
          service,
          method,
          path,
          status: error.status,
          code: error.code,
          reason: error.message,
          ...(error.device ? { device: error.device } : {}),
        });
      }
      throw error;
    }
  }

  private async send(service: ResidencyAgentService, method: string, path: string, payload: Json | undefined, timeoutMs: number): Promise<unknown> {
    const urlKey = URL_KEYS[service];
    // The key set is wider than the shared `IAppConfig` typing knows until the domains build carries `LMSTUDIO_AGENT_URL`.
    const read = this.config.getConfigValue as (key: string) => unknown;
    const base = String(read.call(this.config, urlKey) ?? '').replace(/\/+$/, '');
    if (!base) {
      throw new ResidencyAgentError(
        'SERVICE_UNREACHABLE',
        `The ${service} residency agent has no address: ${urlKey} is not set, so ${method} ${path} was not sent.`,
        0,
      );
    }
    const headers = internalServiceHeaders({
      serviceToken: await resolveInternalAccessToken(this.secrets, service === 'nlp' ? 'NLP_SERVICE_TOKEN' : 'INTERNAL_ACCESS_TOKEN'),
      tenantId: null,
      tenantlessReason: TENANTLESS.CONTROL_PLANE,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      const reason = timedOut ? `timed out after ${timeoutMs} ms` : String(error);
      throw new ResidencyAgentError(
        'SERVICE_UNREACHABLE',
        `The ${service} residency agent did not answer ${method} ${path}: ${reason}`,
        0,
        undefined,
        undefined,
        timedOut ? { timedOut: true } : {},
      );
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (response.ok) return body;

    const error = asRecord(asRecord(body).error);
    const code = str(error.code);
    const retryAfter = Number(response.headers.get('Retry-After'));
    throw new ResidencyAgentError(
      code && (KNOWN_CODES as readonly string[]).includes(code) ? (code as ResidencyAgentErrorCode) : 'AGENT_ERROR',
      str(error.message)?.slice(0, 500) ?? `The ${service} residency agent answered HTTP ${response.status} to ${method} ${path}.`,
      response.status,
      num(error.in_flight) ?? undefined,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      {
        ...(str(error.device) ? { device: str(error.device)! } : {}),
        ...(num(error.needed_bytes) !== null ? { neededBytes: num(error.needed_bytes)! } : {}),
        ...(num(error.free_bytes) !== null ? { freeBytes: num(error.free_bytes)! } : {}),
        ...(num(error.headroom_bytes) !== null ? { headroomBytes: num(error.headroom_bytes)! } : {}),
      },
    );
  }
}
