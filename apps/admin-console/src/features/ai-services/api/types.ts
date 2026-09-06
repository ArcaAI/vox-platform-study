/**
 * Wire types for the read-only AI-services plane.
 *
 * ⚠ UPSTREAM-OWNED SHAPES. `GuardrailStatus`, `NlpStatus` and both halves of
 * `GuardrailConfig` are the guardrail/NLP Python services' own health/config
 * documents, proxied through the gateway VERBATIM
 * (`apps/api/src/modules/ai-service-admin/ai-service-proxy.client.ts`). The
 * console does NOT own, version, or validate them — they are typed as open
 * records on purpose, and the panels render them defensively (badge what is
 * recognizable, key/value the rest). Never add a zod schema or a fixed
 * interface here: an upstream field rename must degrade the panel, not crash
 * the screen.
 *
 * `AgenticInstructions` is the one shape we DO own — it mirrors
 * `AgenticInstructionsResponse` in @arcaai/applications field-for-field (the
 * console cannot import that server package).
 */

/** Upstream guardrail `GET /api/health`, proxied verbatim. Shape not ours. */
export type GuardrailStatus = Record<string, unknown>;

/** Upstream NLP `GET /api/v1/health`, proxied verbatim. Shape not ours. */
export type NlpStatus = Record<string, unknown>;

/** `GuardrailConfigResult` — two upstream documents joined by the gateway. */
export interface GuardrailConfig {
  /** Guardian engine settings (provider, model, thresholds). Upstream-owned. */
  medicalValidation: Record<string, unknown>;
  /** Supported analysis types with descriptions. Upstream-owned. */
  analysisTypes: Record<string, unknown>;
}

/** Where the effective harness policy behind the instruction set resolved from. */
export type HarnessPolicySource = 'tenant' | 'system-default' | 'code-default';

/** The prompt tier resolution picked (preferred → department → default). */
export interface ResolvedPromptTier {
  template: string;
  promptId: string;
  resolvedFrom: 'preferred' | 'department' | 'default';
  departmentId: string | null;
  promptType: string;
}

/** The vendored PDSQI-9 judge-prompt pin — version/hash only, non-editable. */
export interface JudgePromptPin {
  instrument: string;
  version: string;
  promptHash: string;
  source: string;
  license: string;
  paperDoi: string;
  rubricDimensions: string[];
  editable: boolean;
}

/** The five clinical-loop sensor thresholds from the effective policy. */
export interface SensorThresholds {
  entityFaithfulnessThreshold: number;
  coverageThreshold: number;
  citationPresenceThreshold: number;
  numericDoseThreshold: number;
  groundednessThreshold: number;
}

/** One safety criterion the loop enforces (derived from the effective policy). */
export interface SafetyCriterion {
  key: string;
  label: string;
  enabled: boolean;
  detail: string | null;
}

/** GET /admin/agentic/instructions — the effective instruction set for a tenant. */
export interface AgenticInstructions {
  tenantId: string;
  policySource: HarnessPolicySource;
  promptTier: ResolvedPromptTier;
  judgePrompt: JudgePromptPin;
  sensorThresholds: SensorThresholds;
  safetyCriteria: SafetyCriterion[];
}

/** Query params for the instruction-set read (all optional). */
export interface AgenticInstructionsParams {
  /** Super Admins target a tenant; tenant admins are pinned server-side. */
  tenantId?: string;
  /** Resolve the prompt tier against a department (omit = tenant baseline). */
  departmentId?: string;
  /**
   * A PHASE selector (`pre-summary`, `live`) or a free-text prompt key. It
   * stopped being a closed union at row 3, when visit type was still
   * tenant-admin defined; TASK-882 retired that catalogue outright (workflow
   * authors branch, and tenants align agents by `Agent.tags`), so the field is
   * now simply an open key and never a closed vocabulary.
   */
  promptType?: string;
}

/**
 * ── Inference readiness (TASK-890 §3.12) ───────────────────────────────────
 *
 * Unlike the guardrail/NLP documents above, this shape IS ours: a hand-declared
 * mirror of `InferenceReadinessResponse` in @arcaai/applications, field for
 * field (the BFF boundary means no server import). It is a snapshot the PLATFORM
 * took, not a live probe — `checkedAt` is part of the contract, not decoration.
 */

/** How a model is served, which is what decides how its readiness was derived. */
export type ReadinessProviderClass = 'cloud-byo' | 'cloud-platform' | 'engine-served' | 'platform-self-host';

/** `unknown` means nothing was measured — never a synonym for "bad". */
export type ModelReadiness = 'ready' | 'loadable' | 'engine_down' | 'weights_missing' | 'credential_missing' | 'unknown';

export interface ReadinessEngine {
  provider: string;
  providerClass: ReadinessProviderClass;
  /** Host only; the gateway never sends the full endpoint to a browser. */
  baseUrlHost: string | null;
  /** `unknown` = the probe aggregator did not answer, which is not "down". */
  status: 'up' | 'down' | 'unknown';
  latencyMs: number | null;
  loadedCount: number;
  listedCount: number;
  detail: string | null;
}

export interface ReadinessService {
  key: string;
  healthy: boolean;
  lastSeenAt: string | null;
}

export interface ReadinessModel {
  id: string;
  slug: string;
  taskType: string;
  provider: string | null;
  providerClass: ReadinessProviderClass | null;
  readiness: ModelReadiness;
  detail: string | null;
}

export interface InferenceReadiness {
  /** `null` with empty collections = nothing has been observed yet. */
  checkedAt: string | null;
  engines: ReadinessEngine[];
  services: ReadinessService[];
  models: ReadinessModel[];
}
