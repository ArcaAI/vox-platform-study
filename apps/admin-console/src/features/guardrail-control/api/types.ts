/**
 * Platform guardrail control (TASK-1050 W3c, README §11.3 F / §12.2) — the client mirror of the
 * W2h `admin/guardrail/*` DTOs (`packages/applications/src/services/guardrail-policy/dto/**`) and the
 * W2b v2 availability shape (`admin/guardrail/availability/:tenantId`). Read-only projections: the
 * gateway stays authoritative for every rule restated here.
 */

export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export type GuardrailDirection = 'inbound' | 'outbound';
export type GuardrailAction = 'ignore' | 'warn' | 'block';

// ── Rules: catalogue + availability v2 (W2b) ──────────────────────────────────

export interface GuardrailCatalogueEntry {
  id: string;
  label: string;
  description: string;
  directions: GuardrailDirection[];
  threshold: { field: string; floorDirection: string; minimum: number; maximum: number } | null;
  /** v2 (W2b). Optional so a v1 gateway still renders (the editor then offers no action control). */
  allowedActions?: GuardrailAction[];
  platformDefaultAction?: GuardrailAction;
  locked?: boolean;
  defaultEnabled?: boolean;
  platformDefaultDataRegionAction?: GuardrailAction | null;
}

/** One check as it is IN FORCE for a tenant (W2b `GuardrailCheckStateResponse`). */
export interface GuardrailEffectiveCheck {
  checkId: string;
  label: string;
  description: string;
  directions: GuardrailDirection[];
  enabled: boolean;
  action: GuardrailAction;
  allowedActions: GuardrailAction[];
  locked: boolean;
  lockReason: 'catalogue' | 'platform' | null;
  editable: boolean;
  dataRegionAction?: GuardrailAction;
  minScore?: number;
  inherited: boolean;
  setBy: 'platform_admin' | 'tenant_admin' | null;
}

export interface GuardrailEffectivePolicy {
  directions: Record<GuardrailDirection, { enabled: boolean }>;
  checks: GuardrailEffectiveCheck[];
}

export interface GuardrailAvailabilityRow {
  tenantId: string;
  /** `0` ⇒ no row yet; `If-Match: "0"` creates one. */
  version: number;
  /** The row's OWN stored policy (v2 `{ directions, checks }`, or the legacy flat shape). */
  policies: Record<string, unknown>;
  effective: Record<string, unknown>;
  /** v2 (W2b): the policy in force, field by field. */
  effectivePolicy?: GuardrailEffectivePolicy;
  effectiveSourceTenantId: string;
  reason: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The fields one tier STATED for one check (the v2 stored blob). `setBy` is server-stamped and never sent. */
export interface GuardrailStatedCheck {
  enabled?: boolean;
  action?: GuardrailAction;
  locked?: boolean;
  minScore?: number;
  dataRegionAction?: GuardrailAction;
}

export interface GuardrailStoredPolicy {
  directions: Partial<Record<GuardrailDirection, { enabled: boolean }>>;
  checks: Record<string, GuardrailStatedCheck>;
}

// ── Policy keys (W2h) ─────────────────────────────────────────────────────────

export type GuardrailPolicyKeyKind = 'criteria' | 'hyperparameter' | 'threshold' | 'geometry' | 'operational';

export interface GuardrailPolicyRevisionSummary {
  id: string;
  reason: string;
  actorId: string;
  at: string;
  valueHash: string;
}

export interface GuardrailPolicyKeyEntry {
  key: string;
  kind: GuardrailPolicyKeyKind | string;
  type: string;
  min: number | null;
  max: number | null;
  failMode: string;
  taskKey: string;
  inPolicyVersion: boolean;
  editable: boolean;
  lane: string | null;
  modelId: string | null;
  modelSlug: string | null;
  modelVersion: number | null;
  currentValue: unknown;
  defaultValue: unknown;
  isDefault: boolean;
  lastRevision: GuardrailPolicyRevisionSummary | null;
}

export interface GuardrailPolicyKeyGroup {
  taskKey: string;
  lane: string | null;
  modelId: string | null;
  modelSlug: string | null;
  modelVersion: number | null;
  protocol: string | null;
  keys: GuardrailPolicyKeyEntry[];
}

export interface GuardrailPolicyKeys {
  catalogueAvailable: boolean;
  groups: GuardrailPolicyKeyGroup[];
}

export interface GuardrailPolicyKeyWriteResult extends GuardrailPolicyKeyEntry {
  version: number;
  changed?: boolean;
  revisionId?: string | null;
}

export interface GuardrailPolicyRevision extends GuardrailPolicyRevisionSummary {
  aiModelId: string;
  policyKey: string;
  value: unknown;
  restoredFromRevisionId: string | null;
}

export interface GuardrailPolicyRevisions {
  key: string;
  modelId: string | null;
  revisions: GuardrailPolicyRevision[];
}

export interface GuardrailLaneResetResult {
  taskKey: string;
  version: number | null;
  resetKeys: string[];
  skippedKeys: string[];
}

// ── Judge models (W2h, README §12.2) ──────────────────────────────────────────

export interface GuardrailJudgeCategoryTarget {
  lane: string;
  category: string;
}

export interface GuardrailJudgeDeclaration {
  protocol: string;
  lanes: string[];
  categoryMap?: Record<string, GuardrailJudgeCategoryTarget>;
  tiers?: Record<string, string>;
}

export interface GuardrailJudgeMeta {
  modelId: string;
  slug: string;
  version: number;
  judge: GuardrailJudgeDeclaration;
  judgeDefaults: GuardrailJudgeDeclaration | null;
  isDefault: boolean;
  changed?: boolean;
}

export interface GuardrailJudgeLaneCandidate {
  modelId: string;
  slug: string;
  name: string | null;
  protocol: string;
  servedBy: string | null;
  residency: string;
}

export interface GuardrailJudgeLane {
  lane: string;
  taskKey: string;
  policyId: string | null;
  selected: GuardrailJudgeLaneCandidate | null;
  candidates: GuardrailJudgeLaneCandidate[];
}

export interface GuardrailJudgeLanes {
  lanes: GuardrailJudgeLane[];
}

// ── Dry run (W2h) ─────────────────────────────────────────────────────────────

export interface GuardrailDryRunRequest {
  lanes: string[];
  direction: GuardrailDirection;
  mode?: 'prompt' | 'response';
  promptContext?: string;
  samples: string[];
  policy?: Record<string, unknown>;
  judgeMeta?: { categoryMap?: Record<string, GuardrailJudgeCategoryTarget>; tiers?: Record<string, string> };
}

export interface GuardrailDryRunVerdict {
  lane: string;
  verdict: string;
  category: string | null;
  confidence: number | null;
  model: string | null;
  latencyMs: number | null;
  tier: string | null;
}

export interface GuardrailDryRunResult {
  models: { lane: string; modelId: string | null; modelSlug: string | null }[];
  results: { sampleIndex: number; latencyMs: number | null; verdicts: GuardrailDryRunVerdict[] }[];
  latencyMs: number | null;
  persisted: false;
}

/** The 409 `MODEL_NOT_RESIDENT` body (`{ code, message, link, models }`). */
export interface ModelNotResidentDetails {
  code: 'MODEL_NOT_RESIDENT';
  message?: string;
  link?: string;
  models?: { lane: string; modelId: string | null; slug: string | null; state: string }[];
}

// ── Monitoring (W2h) ──────────────────────────────────────────────────────────

export type GuardrailMetricsBucket = '5m' | '1h' | '1d';

export interface GuardrailMetricsWindow {
  from?: string;
  to?: string;
  bucket?: GuardrailMetricsBucket;
  tenantId?: string;
}

export interface GuardrailActivity {
  from: string;
  to: string;
  bucket: string;
  tenantId: string | null;
  totals: { evaluations: number; allow: number; warn: number; block: number; unverified: number; flagRate: number; overrides: number };
  series: { bucketStart: string; direction: string; decision: string; count: number }[];
  checks: { checkId: string; direction: string; verdict: string; actionTaken: string; count: number }[];
  topCategories: { checkId: string; category: string; count: number }[];
  perTenant: { tenantId: string; evaluations: number; warn: number; block: number; unverified: number }[];
  perModel: { model: string; checkId: string; calls: number; flags: number; undetermined: number; avgLatencyMs: number | null }[];
}

export interface GuardrailMetricSample {
  labels: Record<string, string>;
  value: number;
}

export interface GuardrailPerformance {
  at: string;
  available: boolean;
  windowLatencyP50: GuardrailMetricSample[];
  windowLatencyP95: GuardrailMetricSample[];
  modelLatencyP50: GuardrailMetricSample[];
  modelLatencyP95: GuardrailMetricSample[];
  judgeCallsPerSecond: number | null;
  peerCallsPerSecond: GuardrailMetricSample[];
  queueDepth: GuardrailMetricSample[];
  admissionRejectionsPerSecond: GuardrailMetricSample[];
  circuitBreakers: GuardrailMetricSample[];
  peerFailuresPerSecond: GuardrailMetricSample[];
  windowCacheHitRatio: GuardrailMetricSample[];
  evaluationsMissing: number | null;
  outbox: GuardrailMetricSample[];
}

export interface GuardrailHealth {
  at: string;
  models: { taskKey: string; lane: string | null; modelId: string | null; slug: string | null; residency: string }[];
  undeterminedRate: number | null;
  lastEvaluationAt: string | null;
  secondsSinceLastEvaluation: number | null;
}

export interface GuardrailEvaluationQuery extends GuardrailMetricsWindow {
  decision?: string;
  direction?: string;
  checkId?: string;
  consultationId?: string;
  cursor?: string;
  limit?: number;
}

export interface GuardrailEvaluationItem {
  id: string;
  tenantId: string;
  at: string;
  direction: string;
  decision: string;
  caller: string;
  consultationId: string | null;
  runId: string | null;
  nodeId: string | null;
  agentSlug: string | null;
  exempt: string | null;
  policyVersion: string;
  noticeIds: string[];
  checks: unknown[];
  hasWithheldContent: boolean;
}

export interface GuardrailEvaluationPage {
  items: GuardrailEvaluationItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** The subset of an `AiModel` row the read-only serving summary shows (→ `/ai-models` edits it). */
export interface GuardrailModelServingSummary {
  id: string;
  slug: string;
  name?: string | null;
  servedBy?: string | null;
  format?: string | null;
  quantization?: string | null;
  contextLength?: number | null;
  servingFacts?: Record<string, unknown> | null;
}
