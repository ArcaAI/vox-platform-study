import { Inject, Injectable, Optional } from '@nestjs/common';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../common/internal-service-headers';
import { IConfigService } from '../baseServices/_meta/config';
import { SecretsService } from '../baseServices/_meta/secrets';
import type { ReportedDevice, ReportedResidentModel, ResidencyLoadError, ServiceResidencyReport } from './model-residency.types';

/**
 * TASK-1005 — the gateway's client for the residency AGENT every model-serving
 * Python process mounts (`hope_runtime_models.residency_api`, today in `stt` and
 * `nlp`). Wire contract: `tests/contracts/model-residency-agent.fixture.json`
 * → `python` (snake_case); this client hands the controller the camelCase
 * `gateway` shape.
 *
 *   GET  /internal/residency
 *   POST /internal/residency/load     {model_ref, load_spec, pin, ttl_seconds}
 *   POST /internal/residency/unload   {model_ref, force, reason}
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

export type ResidencyAgentService = 'stt' | 'nlp';

export type ResidencyAgentErrorCode =
  'MODEL_UNKNOWN' | 'IN_FLIGHT' | 'INSUFFICIENT_MEMORY' | 'LOAD_FAILED' | 'LOAD_IN_PROGRESS' | 'SERVICE_UNREACHABLE' | 'AGENT_ERROR';

/** A refused or failed agent call. `status` is the agent's own HTTP status (0 when it never answered). */
export class ResidencyAgentError extends Error {
  constructor(
    readonly code: ResidencyAgentErrorCode,
    message: string,
    readonly status: number,
    readonly inFlight?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ResidencyAgentError';
  }
}

export interface AgentLoadRequest {
  modelRef: string;
  /** Service-specific: stt `{resolved_spec}`, nlp `{cache, model_path, …}` (fixture `loadSpecExamples`). Forwarded verbatim. */
  loadSpec: Record<string, unknown>;
  pin: boolean;
  ttlSeconds?: number | null;
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

const URL_KEYS: Record<ResidencyAgentService, 'STT_URL' | 'NLP_URL'> = { stt: 'STT_URL', nlp: 'NLP_URL' };

/** A report is cheap; it must never hold up the 10 s decision tick. */
const REPORT_TIMEOUT_MS = 3_000;
/** A load runs off every request path (async 202 / background tick); the agent's own budget is shorter. */
const LOAD_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function toDevice(raw: unknown): ReportedDevice {
  const d = asRecord(raw);
  return {
    id: str(d.id) ?? 'unknown',
    kind: d.kind === 'cpu' ? 'cpu' : 'gpu',
    totalBytes: num(d.total_bytes) ?? 0,
    freeBytes: num(d.free_bytes) ?? 0,
  };
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
    bytesSource: m.bytes_source === 'measured' ? 'measured' : 'unknown',
    inFlight: num(m.in_flight),
    pinned: m.pinned === true,
    adminPinned: m.admin_pinned === true,
    ttlSeconds: num(m.ttl_seconds),
    loadedAt: str(m.loaded_at),
    lastUsedAt: str(m.last_used_at),
    loadSeconds: num(m.load_seconds),
    // A `failed` model always carries an error, even from an agent that omitted it.
    ...(state === 'failed' ? { error: error ?? { code: 'LOAD_FAILED', message: '', at: null } } : error ? { error } : {}),
  };
}

@Injectable()
export class ResidencyAgentClient {
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
        { model_ref: request.modelRef, load_spec: request.loadSpec, pin: request.pin, ttl_seconds: request.ttlSeconds ?? null },
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
        { model_ref: request.modelRef, force: request.force, reason: request.reason },
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

  private async call(service: ResidencyAgentService, method: string, path: string, payload: Json | undefined, timeoutMs: number): Promise<unknown> {
    const base = String(this.config.getConfigValue(URL_KEYS[service]) ?? '').replace(/\/+$/, '');
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
      const reason = error instanceof Error && error.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : String(error);
      throw new ResidencyAgentError('SERVICE_UNREACHABLE', `The ${service} residency agent did not answer ${method} ${path}: ${reason}`, 0);
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
    const known: ResidencyAgentErrorCode[] = ['MODEL_UNKNOWN', 'IN_FLIGHT', 'INSUFFICIENT_MEMORY', 'LOAD_FAILED', 'LOAD_IN_PROGRESS'];
    const retryAfter = Number(response.headers.get('Retry-After'));
    throw new ResidencyAgentError(
      code && (known as string[]).includes(code) ? (code as ResidencyAgentErrorCode) : 'AGENT_ERROR',
      str(error.message)?.slice(0, 500) ?? `The ${service} residency agent answered HTTP ${response.status} to ${method} ${path}.`,
      response.status,
      num(error.in_flight) ?? undefined,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
}
