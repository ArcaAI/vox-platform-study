/**
 * Wire types mirroring the prompt-management DTOs in @arcaai/applications
 * (PromptTemplateResponse and friends — the console cannot import that server
 * package, so the shapes are declared here once, matching the gateway).
 */

import type { ResourceStatus } from '@/shared/api';

export type PromptTemplateCategory = 'SYSTEM' | 'SUMMARY' | 'DNA_ANALYSIS' | 'CUSTOM';
/**
 * Mirrors the `PromptTemplateStatus` Prisma enum
 * (`packages/database/src/prisma/db_main/prompt-template.prisma`).
 *
 * `APPROVED` was MISSING here — the retired `/prompt-studio` feature
 * declared all three while this copy stopped at PUBLISHED, so an approved row
 * coming back from the list endpoint was already outside the declared type. The
 * governance fold made it load-bearing (the approve write returns APPROVED), so
 * the type is corrected rather than worked around.
 */
export type PromptTemplateStatus = 'DRAFT' | 'PUBLISHED' | 'APPROVED';
export type PromptTemplateScope = 'TENANT_DEFAULT' | 'DEPARTMENT_DEFAULT' | 'USER_PERSONAL';

/**
 * GET /admin/prompt-templates rows (PromptTemplateResponse). `version` is the
 * OCC row token (echo as If-Match), DISTINCT from `currentVersionNumber` —
 * the human-meaningful PromptVersion history counter shown as "vN".
 */
export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  content: string;
  category: PromptTemplateCategory;
  scope?: PromptTemplateScope;
  status: PromptTemplateStatus;
  variables?: Record<string, unknown>;
  currentVersionNumber: number;
  /**
   * The `PromptVersion` snapshot pinned at the last approval; `null`/absent =
   * never approved. `PromptResolutionService` serves THIS snapshot to clinical
   * flows, never the mutable `content` row — so `approvedVersionNumber <
   * currentVersionNumber` means the template has been edited ahead of what is
   * actually running. Optional here because older gateways omit the field.
   */
  approvedVersionNumber?: number | null;
  departmentId?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  resourceStatus?: ResourceStatus;
  /** Score (0-100 per DTO example; service emits [0,1]) of the last test run. */
  lastTestScore?: number;
  lastTestAt?: string;
  version: number;
}

/**
 * List query for GET /admin/prompt-templates. NOTE: unlike the platform's
 * zero-based PaginatedQuery, this controller is ONE-based (`page || 1`);
 * page=0 silently becomes page 1.
 */
export interface ListTemplatesParams {
  category?: PromptTemplateCategory;
  status?: PromptTemplateStatus;
  departmentId?: string;
  search?: string;
  includeDisabled?: boolean;
  scope?: PromptTemplateScope;
  ownerUserId?: string;
  /** One-based page number (this endpoint deviates from the 0-based convention). */
  page?: number;
  limit?: number;
  [key: string]: string | number | boolean | undefined | null;
}

export interface CreateTemplateRequest {
  name: string;
  description?: string;
  content: string;
  category: PromptTemplateCategory;
  status?: PromptTemplateStatus;
  variables?: Record<string, unknown>;
  departmentId?: string;
  tags?: string[];
  scope?: PromptTemplateScope;
  ownerUserId?: string;
}

/** PATCH :id body — If-Match route; expectedVersion is added by the client. */
export interface UpdateTemplateRequest {
  name?: string;
  description?: string;
  content?: string;
  status?: PromptTemplateStatus;
  variables?: Record<string, unknown>;
  tags?: string[];
  /** Stored in the PromptVersion history row. */
  changeReason?: string;
  resourceStatus?: 'ENABLED' | 'DISABLED';
}

/** GET :id/versions rows (PromptVersionResponse). */
export interface PromptVersion {
  id: string;
  promptTemplateId: string;
  versionNumber: number;
  content: string;
  variables?: Record<string, unknown>;
  changeReason?: string;
  changedBy?: string;
  createdAt: string;
}

/** One line-diff segment (shape-compatible with the `diff` npm package). */
export interface PromptDiffChange {
  value: string;
  added?: boolean;
  removed?: boolean;
  count?: number;
}

export interface PromptDiffStats {
  additions: number;
  deletions: number;
  unchanged: number;
}

export interface PromptFieldDiff {
  field: string;
  changed: boolean;
  before?: string;
  after?: string;
  changes: PromptDiffChange[];
  stats: PromptDiffStats;
}

/**
 * GET :id/versions/:from/diff/:to (PromptVersionDiffResponse). Top-level
 * changes/patch/stats are the COMBINED content+variables line diff;
 * `fields[]` is the per-field breakdown.
 */
export interface PromptVersionDiff {
  promptTemplateId: string;
  fromVersion: number;
  toVersion: number;
  fields: PromptFieldDiff[];
  changes: PromptDiffChange[];
  patch: string;
  stats: PromptDiffStats;
}

/**
 * POST :id/test body — If-Match route; expectedVersion is added by the
 * client. `sampleInput` and `goldenCaseId` are mutually exclusive (the panel
 * enforces the XOR client-side); omitting `provider`/`model`/`versionNumber`
 * falls back to the tenant default / current draft content respectively.
 */
export interface TestTemplateRequest {
  /** Sample values interpolated into the template `{{variables}}`. */
  variables?: Record<string, unknown>;
  /** Extra sample input (e.g. transcript excerpt) appended to the prompt. Mutually exclusive with `goldenCaseId`. */
  sampleInput?: string;
  /** Golden-case example data (PHI-safe reference decrypted server-side). Mutually exclusive with `sampleInput`. */
  goldenCaseId?: string;
  /** Explicit provider override; omitted = tenant default via the HarnessPolicy cascade. */
  provider?: string;
  /** Explicit model override; only meaningful alongside `provider`. */
  model?: string;
  /**
   * Assemble the prompt ONLY — no generation, no task, instant response
   * (BUG-018). The ack comes back as `mode: 'dry-run'` carrying
   * `assembledPrompt`.
   */
  dryRun?: boolean;
  /** Test a specific pinned PromptVersion instead of the current draft content. */
  versionNumber?: number;
}

/** Per-dimension breakdown behind the composite test score. */
export interface PromptTestMetrics {
  wordCount: number;
  nonEmpty: boolean;
  lengthScore: number;
  jsonExpected: boolean;
  jsonValid: boolean | null;
  variablesDeclared: number;
  variableCoverage: number | null;
}

/**
 * POST :id/test ack (BUG-018). The endpoint returns IMMEDIATELY — a blocking
 * 2–3½ minute generation always 524'd at the CDN. `mode: 'stream'` carries the
 * SMR task to stream; `mode: 'dry-run'` carries the assembled prompt only and
 * opens no stream. `provider`/`model` are the EFFECTIVE resolved selection, so
 * the panel can show which model actually ran.
 */
export interface PromptTestAck {
  mode: 'stream' | 'dry-run';
  provider: string;
  model: string;
  assembledPrompt: string;
  /** Present on `mode: 'stream'` only. */
  taskId?: string;
  /** Gateway SSE path (`text/tasks/<taskId>/stream`); `mode: 'stream'` only. */
  streamUrl?: string;
}

/** POST :id/test/finalize body — persists the score once the stream is done. */
export interface FinalizeTestRequest {
  taskId: string;
  expectedVersion: number;
}

/**
 * POST :id/test result (PromptTestResultResponse). `version` is the row's NEW
 * OCC token after the score/output were persisted, so the caller can keep
 * editing without a re-fetch.
 */
export interface PromptTestResult {
  id: string;
  /** Composite deterministic output-quality proxy in [0, 1]. */
  score: number;
  output: string;
  testedAt: string;
  version: number;
  metrics?: PromptTestMetrics;
}

/** GET :id/usage (PromptUsageStatsResponse — all-time, not windowed). */
export interface PromptUsageStats {
  totalUsages: number;
  lastUsedAt: string | null;
}

export interface PromptUsageByDepartment {
  departmentId: string | null;
  count: number;
}

export interface PromptUsageByDoctor {
  doctorId: string | null;
  count: number;
}

export interface PromptUsageByDay {
  /** UTC day bucket (YYYY-MM-DD). */
  day: string;
  count: number;
}

/** GET analytics/usage (PromptUsageAnalyticsResponse). */
export interface PromptUsageAnalytics {
  totalUsages: number;
  byDepartment: PromptUsageByDepartment[];
  byDoctor: PromptUsageByDoctor[];
  byDay: PromptUsageByDay[];
}

/** GET usage-records rows (PromptUsageRecordResponse — one agent run each). */
export interface PromptUsageRecord {
  id: string;
  promptTemplateId?: string | null;
  promptVersionNumber?: number | null;
  consultationId?: string | null;
  doctorId?: string | null;
  departmentId?: string | null;
  createdAt: string;
}

/** GET usage-records query — ZERO-based page (default 0), unlike the list. */
export interface ListUsageRecordsParams {
  page?: number;
  limit?: number;
  promptTemplateId?: string;
  [key: string]: string | number | boolean | undefined | null;
}

/**
 * POST assign-department body (AssignDepartmentPromptRequest). The REQUIRED
 * expectedVersion is the DEPARTMENT row's OCC version (from a prior
 * departments read) — not the template's.
 */
export interface AssignDepartmentRequest {
  departmentId: string;
  preSummaryPromptId?: string | null;
  newPatientPromptId?: string | null;
  revisitPromptId?: string | null;
  expectedVersion: number;
}

/**
 * GET /admin/departments rows (DepartmentResponse projection): the assign
 * dialog needs the id/code/name for the select, the current slot assignments,
 * and `version` as the assign-department expectedVersion source.
 */
export interface Department {
  id: string;
  code?: string;
  name?: string;
  isRootDepartment: boolean;
  preSummaryPromptId?: string;
  newPatientPromptId?: string;
  revisitPromptId?: string;
  resourceStatus?: ResourceStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/**
 * `DepartmentAgent` (TASK-546) — the first-class "Agent" row: one department
 * bound to an Agent Template at a pinned-or-tracked version, plus a DNA gate.
 * Mirrors `DepartmentAgentResponse` in `@arcaai/applications`
 * (`packages/applications/src/services/departmentAgent/dto/department-agent.response.ts`).
 */
export type DepartmentAgentDnaPolicy = 'INHERIT' | 'DISABLED';

/**
 * Loop role (TASK-659) — at most one ENABLED PRIMARY agent per department,
 * enforced server-side (`assertSinglePrimaryPerDepartment`). Defaults to
 * SPECIALIST so a newly created agent never silently contests an existing
 * department PRIMARY.
 */
export type DepartmentAgentRole = 'PRIMARY' | 'SPECIALIST';

/**
 * Closed catalogue of named guardrail profiles (TASK-654 D9) — this field only
 * SELECTS which profile the (out-of-scope-here) enforcement boundary applies;
 * it never authors the boundary itself.
 */
export type GuardrailProfile = 'STANDARD' | 'STRICT' | 'RELAXED';

/**
 * The seven action-registry names TASK-662's loop dispatches (TASK-654 §4.4).
 * `alwaysActions`/`neverActions` (D11's compliance envelope) may name only
 * these — mirrors `AGENT_ACTION_KEYS` in
 * `packages/applications/src/services/departmentAgent/constants.ts`.
 */
export type AgentActionKey =
  | 'livedoc.start'
  | 'livedoc.stop'
  | 'vision.extract_text'
  | 'document.extract_text'
  | 'nlp.extract_entities'
  | 'harness.finalize'
  | 'client.emit';

/** `subscribedKinds` JSONB shape: `{ version: 1, kinds: [{ key, filter? }] }`. */
export interface AgentSubscribedKinds {
  version: 1;
  kinds: { key: string; filter?: Record<string, string> }[];
}

/** `writeScope` JSONB shape: `{ version: 1, outputs: ["soap_note"] }`. */
export interface AgentWriteScope {
  version: 1;
  outputs: string[];
}

/**
 * `goal` JSONB shape — a CONSTRAINED goal statement, deliberately NOT a
 * free-text system prompt (TASK-654 D8): a short, length-capped objective
 * plus optional bounded success criteria.
 */
export interface AgentGoal {
  version: 1;
  objective: string;
  successCriteria?: string[];
}

/**
 * `toolConfig` JSONB shape (TASK-635 RF-4) — which live-loop tools run. The
 * "Tool allowlist" the console form exposes: a CLOSED catalogue of exactly
 * three named tools, picked not authored.
 */
export interface AgentToolConfig {
  version: 1;
  tools?: Partial<Record<'ner' | 'vitals' | 'groundedness', { enabled: boolean | null }>>;
}

export interface DepartmentAgent {
  id: string;
  departmentId: string;
  name: string;
  slug: string;
  description?: string;
  /** Bound Agent Template id (a `PromptTemplate` row). */
  promptTemplateId: string;
  /** Pinned `PromptVersion` number; null/undefined ⇒ tracks latest APPROVED. */
  pinnedVersionNumber?: number | null;
  dnaStylePolicy: DepartmentAgentDnaPolicy;
  harnessOverrides?: Record<string, unknown>;
  goldenSetId?: string;
  isDefault: boolean;
  sourceAgentTemplateSlug?: string | null;
  /** Cloned from the SYSTEM template library — content is read-only until cloned. */
  templateLocked: boolean;
  tags?: string[];
  resourceStatus?: ResourceStatus;
  createdAt: string;
  updatedAt: string;
  version: number;

  // ── TASK-659 loop configuration + promotion surface. Null on every agent
  // that has never touched this surface (the entire seeded catalogue today).
  /**
   * Loop role. The server always populates it (DB default SPECIALIST) —
   * optional here only so pre-TASK-667 test fixtures across this feature that
   * predate the field keep compiling; treat an absent value as SPECIALIST.
   */
  role?: DepartmentAgentRole;
  subscribedKinds?: Record<string, unknown> | null;
  writeScope?: Record<string, unknown> | null;
  goal?: Record<string, unknown> | null;
  guardrailProfile?: string | null;
  alwaysActions?: string[] | null;
  neverActions?: string[] | null;
  /** Live-loop tool plan (TASK-635) — "Tool allowlist" in the console. Null ⇒ platform default. */
  toolConfig?: Record<string, unknown> | null;
}

/** GET /admin/department-agents query — platform-standard ZERO-based page. */
export interface ListDepartmentAgentsParams {
  departmentId?: string;
  page?: number;
  limit?: number;
  [key: string]: string | number | boolean | undefined | null;
}

/** POST /admin/department-agents body (CreateDepartmentAgentRequest). */
export interface CreateDepartmentAgentRequest {
  departmentId: string;
  name: string;
  slug: string;
  description?: string;
  promptTemplateId: string;
  pinnedVersionNumber?: number | null;
  dnaStylePolicy?: DepartmentAgentDnaPolicy;
  harnessOverrides?: Record<string, unknown>;
  goldenSetId?: string;
  tags?: string[];
  // ── TASK-659 loop configuration. All optional; omitted ⇒ no loop
  // participation (role still defaults server-side to SPECIALIST).
  role?: DepartmentAgentRole;
  subscribedKinds?: Record<string, unknown> | null;
  writeScope?: Record<string, unknown> | null;
  goal?: Record<string, unknown> | null;
  guardrailProfile?: string | null;
  alwaysActions?: string[] | null;
  neverActions?: string[] | null;
  toolConfig?: Record<string, unknown> | null;
}

/**
 * PATCH :id body (UpdateDepartmentAgentRequest) — If-Match route;
 * `expectedVersion` is added by the client from the ETag. `departmentId` is
 * identity (not editable); pinning has its own `POST :id/pin` endpoint, so
 * `pinnedVersionNumber` is deliberately absent here.
 *
 * `goldenSetId` widens to `| null` (the server DTO's declared type is bare
 * `string`, but `@IsOptional()` accepts `null` at runtime and the service only
 * skips the assignment on `undefined` — so `null` is how the Settings-tab
 * "detach" affordance clears an attached golden set; TASK-549).
 */
export interface UpdateDepartmentAgentRequest {
  name?: string;
  slug?: string;
  description?: string;
  promptTemplateId?: string;
  dnaStylePolicy?: DepartmentAgentDnaPolicy;
  harnessOverrides?: Record<string, unknown>;
  goldenSetId?: string | null;
  tags?: string[];
  resourceStatus?: 'ENABLED' | 'DISABLED';
  // ── TASK-659 loop configuration. All optional.
  role?: DepartmentAgentRole;
  subscribedKinds?: Record<string, unknown> | null;
  writeScope?: Record<string, unknown> | null;
  goal?: Record<string, unknown> | null;
  guardrailProfile?: string | null;
  alwaysActions?: string[] | null;
  neverActions?: string[] | null;
  toolConfig?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Resolved consultation context schema (TASK-658) — READ-ONLY, minimal
// projection of `GET /tenant/me/context-schema`. `subscribedKinds`/`writeScope`
// must be picked from HERE, never typed free-hand (TASK-667 scope): the
// server cross-checks every referenced key against exactly this resolved
// definition and rejects an unknown one (TASK-659 AC-4). Owned by this
// feature's read path only — the schema AUTHORING screen is TASK-666's
// (`features/<its-own-feature>/**`); features never import each other.
// ---------------------------------------------------------------------------

/** One `definition.kinds[]` / `definition.outputs[]` entry — only the fields the picker needs. */
export interface ResolvedContextEntry {
  key: string;
  label?: string;
  primitive?: string;
}

/** `GET tenant/me/context-schema?departmentId=` (ConsultationContextSchemaBundleResponse). */
export interface ResolvedContextSchemaBundle {
  schemaId: string | null;
  versionNumber: number | null;
  definition: { kinds?: ResolvedContextEntry[]; outputs?: ResolvedContextEntry[] } | null;
  etag: string;
}

// ---------------------------------------------------------------------------
// Eval-gated promotion (TASK-549) — the `/agents?tab=governance` Eval panel.
// These are READ-mostly projections of the harness admin surface
// (`admin/harness/golden-sets` + `admin/harness/eval-runs`), duplicated here
// rather than imported from the `harness-ops` feature (which owns golden-set
// CRUD + the full eval-runs grid on `/harness/observability`) because
// features never import each other (rule 13). This panel only needs a
// golden-set picker + a scoped "last runs" read + the run-now write.
// ---------------------------------------------------------------------------

/** GET admin/harness/golden-sets row — a slim GoldenSetResponse projection. */
export interface EvalGoldenSet {
  id: string;
  name: string;
  description?: string | null;
  pinnedVersion?: string | null;
}

export interface EvalGoldenSetList {
  items: EvalGoldenSet[];
  total: number;
}

/** NOTE: `page` is ONE-based on this endpoint (matches the harness-ops copy). */
export interface ListEvalGoldenSetsParams {
  page?: number;
  limit?: number;
  [key: string]: string | number | boolean | undefined | null;
}

/**
 * GET admin/harness/golden-sets/:id/cases row — a slim GoldenCaseMetaResponse
 * projection (PHI-SAFE metadata only; the encrypted transcript/reference note
 * are never surfaced through this plane). Feeds the Test Bench's "Golden
 * case" example-data picker.
 */
export interface EvalGoldenCase {
  id: string;
  goldenSetId: string;
  label?: string | null;
}

export interface EvalGoldenCaseList {
  items: EvalGoldenCase[];
  total: number;
}

export interface ListEvalGoldenCasesParams {
  page?: number;
  limit?: number;
  [key: string]: string | number | boolean | undefined | null;
}

/** GET admin/harness/eval-runs row — a slim EvalRunResponse projection. */
export interface AgentEvalRun {
  id: string;
  goldenSetId: string;
  status: string | null;
  /** How the run was triggered: MANUAL (run-now) | PROMOTION (approve/pin gate) | CI. Null on legacy rows. */
  triggerType: string | null;
  startedAt: string | null;
  completedAt: string | null;
  aggregateScores: unknown;
  createdAt: string;
}

export interface AgentEvalRunList {
  items: AgentEvalRun[];
  total: number;
}

/** NOTE: `page` is ONE-based on this endpoint (matches the harness-ops copy). */
export interface ListAgentEvalRunsParams {
  goldenSetId?: string;
  page?: number;
  limit?: number;
  [key: string]: string | number | boolean | undefined | null;
}

/** POST golden-sets/:id/run result (EvalRunTriggerResponse) — synchronous run-now verdict. */
export interface EvalRunTrigger {
  runId: string;
  passed: boolean;
  failures: string[];
  aggregates: Record<string, number>;
}

// ---------------------------------------------------------------------------
// TASK-674 — `DepartmentAgentVersion` history (`GET :id/versions`) and
// `AgentPromotion` lineage (`GET admin/agent-promotions?targetAgentId=`).
// Both READ-only: the immutable audit trail TASK-659/663 already write, with
// no console surface until now (TASK-667 OI-3). Mirrors
// `DepartmentAgentVersionResponse`/`AgentPromotionResponse` in
// `packages/applications/src/services/{departmentAgent,agentPromotion}/dto/`.
// ---------------------------------------------------------------------------

/** One immutable loop-configuration snapshot (TASK-659). */
export interface DepartmentAgentVersion {
  id: string;
  agentId: string;
  versionNumber: number;
  /** The seven TASK-659 loop-configuration fields, canonical snapshot. */
  configSnapshot: Record<string, unknown>;
  /** sha256 over the canonical (key-sorted) JSON of `configSnapshot`. */
  checksum: string;
  /** Why this version was written, when recorded (e.g. clone lineage). Absent on an ordinary save. */
  changeReason: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** One immutable cross-tenant promotion record, read from the TARGET tenant (TASK-663). */
export interface AgentPromotion {
  id: string;
  fromTenantId: string;
  toTenantId: string;
  agentVersionId: string;
  sourceAgentId: string;
  targetAgentId: string;
  targetAgentVersionId: string | null;
  configSnapshot: Record<string, unknown>;
  checksum: string;
  evalRunId: string | null;
  sourceEvalRunId: string | null;
  warnings: string[];
  promotedBy: string | null;
  /** True when the target agent has been edited since this promotion. Absent when not computable. */
  drifted?: boolean;
  createdAt: string;
  version: number;
}

export interface ListAgentPromotionsParams {
  targetAgentId?: string;
  page?: number;
  limit?: number;
  [key: string]: string | number | boolean | undefined | null;
}
