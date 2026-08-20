// The FROZEN per-service effective-config contract.
//
// This shape is reused verbatim across retention adoption and agentic
// context consumers. Fields may be ADDED; existing fields must not change
// meaning, because the Python pull clients treat an omitted/null field as
// "keep my env/bootstrap value".

/** The services the internal route will serve a subset for. */
export const EFFECTIVE_CONFIG_SERVICES = ['text', 'nlp', 'stt', 'guardrail', 'harness', 'tts'] as const;

export type EffectiveConfigServiceName = (typeof EFFECTIVE_CONFIG_SERVICES)[number];

/**
 * Which lane supplied a group's values. Mirrored into each service's `/health`
 * diagnostics block so operators can see per-key whether the control plane or
 * the service's own env is live.
 */
export type EffectiveConfigSource = 'db' | 'env-fallback';

/** One `AiRuntimeProfile` row, flattened for the wire. */
export interface EffectiveRuntimeProfile {
  provider: string;
  /** Empty string = the provider-level default row. */
  modelSlug: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  contextLength: number | null;
  maxConcurrent: number | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  timeoutS: number | null;
  keepAliveSeconds: number | null;
  extraJson: Record<string, unknown> | null;
  source: EffectiveConfigSource;
}

/**
 * Model-cache retention knobs, covering every in-process service
 * (nlp/guardrail/harness/tts/stt) plus text, whose
 * `ttlSeconds` is forwarded to server-managed engines rather than a cache.
 *
 * Every field is nullable BY CONTRACT: null/omitted means "the service keeps its
 * own env/bootstrap value". `maxMemoryMb` is stt-only (its historical MB
 * budget); `vramBudgetMb` is the generalized, opt-in VRAM bound (0/null = unset).
 */
export interface EffectiveRetention {
  ttlSeconds: number | null;
  maxModels: number | null;
  maxMemoryMb: number | null;
  vramBudgetMb: number | null;
  source: EffectiveConfigSource;
}

/** Capacity ceilings. Null on any field ⇒ the service keeps its own default. */
export interface EffectiveConcurrency {
  maxConcurrent: number | null;
  workerConcurrency: number | null;
  streamingMaxConcurrent: number | null;
  source: EffectiveConfigSource;
}

/**
 * PHI-redaction knobs (guardrail only). `chunkChars` bounds ONE GLiNER
 * extraction call: the model's cost is super-linear in input length, so an
 * unbounded call over a large corpus exhausts both the caller's HTTP timeout and
 * the worker's memory (measured in TASK-710 §7 Task 6). Null ⇒ guardrail keeps
 * its own built-in bound — never "unbounded".
 */
export interface EffectiveRedaction {
  chunkChars: number | null;
  source: EffectiveConfigSource;
}

export interface EffectiveConfigResponse {
  service: string;
  /** ISO-8601. Lets a client log how stale its cached snapshot is. */
  generatedAt: string;
  runtimeProfiles?: EffectiveRuntimeProfile[];
  retention?: EffectiveRetention;
  concurrency?: EffectiveConcurrency;
  /** Served for guardrail only. */
  redaction?: EffectiveRedaction;
  /** Served for harness/live-doc agentic-context consumers only. */
  agenticContext?: Record<string, unknown>;
}

export const IEffectiveConfigService = Symbol('IEffectiveConfigService');

export interface IEffectiveConfigService {
  /**
   * Resolve one service's subset. Throws `ArgumentInvalidException` (→ 400) for
   * an unrecognised service name.
   *
   * NEVER throws for a control-plane read failure — a cold cache or an
   * unreachable override lane degrades to `env-fallback` with null values, so a
   * degraded control plane leaves services on exactly their env behaviour
   * rather than failing their config pull.
   */
  resolveForService(service: string): Promise<EffectiveConfigResponse>;
}
