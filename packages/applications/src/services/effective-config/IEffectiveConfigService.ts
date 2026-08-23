// The FROZEN per-service effective-config contract.
//
// This shape is reused verbatim across retention adoption and agentic
// context consumers. Fields may be ADDED; existing fields must not change
// meaning, because the Python pull clients treat an omitted/null field as
// "keep my env/bootstrap value".

import { CONSUMING_DEPLOYABLES, type ConsumingDeployable, type SettingDataType } from '../settings-registry/registry.types';

/**
 * The services the internal route will serve a subset for.
 *
 * This IS `CONSUMING_DEPLOYABLES` — the same list a descriptor names in its
 * `consumedBy`, imported rather than transcribed, so the wire contract and the
 * registry can never disagree about which deployables exist.
 */
export const EFFECTIVE_CONFIG_SERVICES = CONSUMING_DEPLOYABLES;

export type EffectiveConfigServiceName = ConsumingDeployable;

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
  /**
   * nlp's OUTBOUND PEER HTTP bound — the `nlp` → `text` delegation behind
   * `/classify/topic` / `/classify/intent`. Deliberately a SEPARATE field from
   * `maxConcurrent` (nlp's local-inference bound): sharing one ceiling between
   * local GPU/CPU inference and an outbound HTTP round-trip to a peer service
   * would let either starve the other. Null ⇒ nlp keeps its own bootstrap value.
   */
  peerCallMaxConcurrent: number | null;
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

/**
 * ONE resolved registry key on the wire — the GENERIC channel that replaced the
 * hand-shaped, numeric-only groups below.
 *
 * `value` is `unknown` ON PURPOSE. It used to be typed `number | null`, and any
 * non-number was silently replaced by the code default, so a string, boolean,
 * enum, URL, threshold or label taxonomy could not cross the DB→Python boundary
 * at all. `dataType` travels WITH the value so a client can check what it was
 * promised instead of guessing from the runtime type.
 *
 * `value: null` means UNRESOLVED — either the control-plane read failed or the
 * stored value did not match `dataType`. It never means "the default": a client
 * keeps its own bootstrap value, exactly as it does for an omitted group.
 */
export interface EffectiveSetting {
  value: unknown;
  dataType: SettingDataType;
  source: EffectiveConfigSource;
}

/**
 * Where ONE model's weights can be materialised from — the block
 * `apps/harness` already codes against
 * (`models/source_resolver.py`: `modelWeights[<slug>]` → `sourceUri` /
 * `localPath` / `checksum`) and which had no counterpart in this contract at
 * all, so the consumer could only ever take its env branch.
 *
 * Transcribed verbatim from the resolved `AiModel` row. Deliberately NOT
 * scheme-filtered: `sourceUri`'s grammar (`hf:` / `file://` / `s3://`) is
 * interpreted by each service's own `resolve_model_dir`, and re-implementing
 * that dispatch here would give it a second, drifting definition.
 */
export interface EffectiveModelWeight {
  sourceUri: string;
  /** Operator override — highest precedence in every service's resolver. */
  localPath: string | null;
  /** SHA256, when the registry row carries one. */
  checksum: string | null;
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
  /**
   * Every registry key whose descriptor names this service in `consumedBy`,
   * keyed by its canonical dotted key. THE extension point: a new key appears
   * here the moment its descriptor declares the service, with no change to this
   * contract, the read service, or any defaults map.
   *
   * The groups above are the frozen, pre-existing views of a subset of these
   * same keys, kept verbatim so existing Python clients are unaffected.
   */
  settings?: Record<string, EffectiveSetting>;
  /**
   * Model slug → weight source, for the models this service's `AiTaskDefault`
   * rows select. Served only to services that materialise weights in their own
   * process; omitted (never empty) when there are none.
   */
  modelWeights?: Record<string, EffectiveModelWeight>;
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
