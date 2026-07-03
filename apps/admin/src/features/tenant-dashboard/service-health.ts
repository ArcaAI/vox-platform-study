/**
 * TASK-380 — Tenant Dashboard service-health derivations.
 *
 * Pure functions that turn the `useHealthCheck().services` map into the
 * dashboard view models: the "Services healthy n/total" headline KPI and the
 * audio-pipeline status strip. Type-only SDK import keeps this module testable
 * under the app's `@arcaai/vox` vitest stub.
 */

/** Normalized health a `StatusDot`/`ServiceStatusItem` can render. */
export type ServiceHealthState = 'healthy' | 'degraded' | 'unhealthy' | 'checking' | 'unknown';

/** Minimal shape we read off each `useHealthCheck` service entry. */
export interface ServiceHealthInput {
  status?: string;
  version?: string;
  uptime_seconds?: number;
}

type ServiceMap = Record<string, ServiceHealthInput | null | undefined> | null | undefined;

const HEALTHY = new Set(['healthy', 'ok', 'up', 'pass', 'passing', 'ready', 'online', 'available']);
const DEGRADED = new Set(['degraded', 'warn', 'warning', 'partial']);
const UNHEALTHY = new Set(['unhealthy', 'down', 'error', 'fail', 'failed', 'offline', 'unavailable']);
const CHECKING = new Set(['checking', 'idle', 'pending', 'starting']);

/** Map a raw backend status string (any casing) to a {@link ServiceHealthState}. */
export function normalizeServiceHealth(raw: string | null | undefined): ServiceHealthState {
  if (!raw) return 'unknown';
  const key = String(raw).trim().toLowerCase();
  if (HEALTHY.has(key)) return 'healthy';
  if (DEGRADED.has(key)) return 'degraded';
  if (UNHEALTHY.has(key)) return 'unhealthy';
  if (CHECKING.has(key)) return 'checking';
  return 'unknown';
}

const ACRONYMS = new Set(['smr', 'stt', 'nlp', 'api', 'vad', 'apilive']);
const NAME_OVERRIDES: Record<string, string> = { apiLive: 'API (live)' };

/** Human display name for a service key (`smr` → `SMR`, `guardrail` → `Guardrail`). */
export function serviceDisplayName(key: string): string {
  if (NAME_OVERRIDES[key]) return NAME_OVERRIDES[key];
  if (ACRONYMS.has(key.toLowerCase())) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export interface ServiceHealthSummary {
  /** Count of services in the `healthy` state. */
  healthy: number;
  /** Total number of services reported. */
  total: number;
  /** Display names of degraded services (for the KPI hint, e.g. `["SMR"]`). */
  degraded: string[];
  /** True when every reported service is healthy. */
  allHealthy: boolean;
  /** True when at least one service is unhealthy/down. */
  hasUnhealthy: boolean;
}

/** Summarize a `useHealthCheck().services` map into the "Services healthy" KPI. */
export function summarizeServiceHealth(services: ServiceMap): ServiceHealthSummary {
  const entries = services ? Object.entries(services) : [];
  let healthy = 0;
  let hasUnhealthy = false;
  const degraded: string[] = [];

  for (const [key, svc] of entries) {
    const state = normalizeServiceHealth(svc?.status);
    if (state === 'healthy') healthy += 1;
    else if (state === 'degraded') degraded.push(serviceDisplayName(key));
    else if (state === 'unhealthy') hasUnhealthy = true;
  }

  const total = entries.length;
  return { healthy, total, degraded, allHealthy: total > 0 && healthy === total, hasUnhealthy };
}

/** A row in the audio-pipeline status strip. */
export interface AudioPipelineRow {
  name: string;
  /** Service key in the health map this row reads (`vad` is derived from `stt`). */
  serviceKey: string;
  status: ServiceHealthState;
  /** Model/engine label (TARGET — static; no per-model telemetry endpoint yet). */
  version?: string;
  /** True when the status is inferred from another service rather than reported directly. */
  derived?: boolean;
}

/**
 * Canonical audio-pipeline stages, in display order. `VAD` has no dedicated
 * health endpoint, so it is derived from `STT` (the service that hosts it).
 * `version` strings are TARGET labels (no per-model telemetry hook yet).
 */
export const AUDIO_PIPELINE_SPECS: ReadonlyArray<{ name: string; serviceKey: string; version: string; derivedFrom?: string }> = [
  { name: 'STT', serviceKey: 'stt', version: 'whisper-large-v3-turbo' },
  { name: 'VAD', serviceKey: 'vad', version: 'silero-vad-v5', derivedFrom: 'stt' },
  { name: 'SMR', serviceKey: 'smr', version: 'summarizer-v2' },
  { name: 'Guardrail', serviceKey: 'guardrail', version: 'safety-engine' },
  { name: 'NLP', serviceKey: 'nlp', version: 'medical-ner' },
] as const;

/** Build the fixed STT/VAD/SMR/Guardrail/NLP rows from the health map. */
export function audioPipelineRows(services: ServiceMap): AudioPipelineRow[] {
  const map = services ?? {};
  return AUDIO_PIPELINE_SPECS.map((spec) => {
    const sourceKey = spec.derivedFrom ?? spec.serviceKey;
    const status = normalizeServiceHealth(map[sourceKey]?.status);
    return {
      name: spec.name,
      serviceKey: spec.serviceKey,
      status,
      version: spec.version,
      ...(spec.derivedFrom ? { derived: true } : {}),
    };
  });
}
