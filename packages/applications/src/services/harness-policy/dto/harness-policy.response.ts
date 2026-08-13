import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { McpServerResponse } from '../../mcp-server/dto';

/**
 * Where the effective policy was resolved from:
 *  - `tenant`         — the calling tenant's own override row.
 *  - `system-default` — the SYSTEM-tenant GLOBAL-DEFAULT row (no tenant row).
 *  - `code-default`   — neither row exists yet; values are the harness code
 *                       defaults (the platform default has not been seeded).
 */
export type HarnessPolicySource = 'tenant' | 'system-default' | 'code-default';

/**
 * Provenance of a per-department-agent harness override overlay.
 * Present on the effective policy ONLY when a consultation's default
 * `DepartmentAgent` supplied at least one tenant-tier override that was applied
 * on top of the resolved tenant/SYSTEM policy. Additive + observability-only —
 * the harness ignores unknown response fields (`HarnessPolicy` is `extra=ignore`).
 */
export interface HarnessOverridesSource {
  /** The DepartmentAgent whose `harnessOverrides` governed this run. */
  agentId: string;
  /** Its slug (human-readable trace back to the agent). */
  agentSlug: string;
  /** The tenant-tier override keys actually applied (global-only keys are dropped, never listed). */
  keys: string[];
}

/**
 * The effective harness policy. Returned by
 * `GET /admin/harness/policy`, `GET /admin/harness/policy/global`, the PATCH
 * routes, and the worker-facing `GET /internal/harness/policy`. The 16 knob
 * fields are the runtime values the clinical loop reads; `version` is the OCC
 * token the `ETagInterceptor` renders as `ETag: "<version>"`.
 */
export class HarnessPolicyResponse {
  @ApiPropertyOptional({ description: 'Policy row id (null when source is `code-default`).', nullable: true })
  id: string | null;

  @ApiProperty({ description: 'Owning tenant id of the resolved policy row (SYSTEM tenant for the global default).' })
  tenantId: string;

  @ApiProperty({ description: 'Where the effective policy was resolved from.', enum: ['tenant', 'system-default', 'code-default'] })
  source: HarnessPolicySource;

  @ApiProperty({ description: 'Entity-faithfulness sensor threshold (fraction in [0,1]).', example: 1.0 })
  entityFaithfulnessThreshold: number;

  @ApiProperty({ description: 'Coverage sensor threshold (fraction in [0,1]).', example: 0.8 })
  coverageThreshold: number;

  @ApiProperty({ description: 'Citation-presence sensor threshold (fraction in [0,1]).', example: 1.0 })
  citationPresenceThreshold: number;

  @ApiProperty({ description: 'Numeric/dose sensor threshold (fraction in [0,1]).', example: 1.0 })
  numericDoseThreshold: number;

  @ApiProperty({ description: 'Groundedness (inferential) sensor threshold (fraction in [0,1]).', example: 0.8 })
  groundednessThreshold: number;

  @ApiProperty({ description: 'Master safety-guardrail toggle.', example: true })
  safetyEnabled: boolean;

  @ApiProperty({ description: 'PHI-detection toggle.', example: true })
  phiEnabled: boolean;

  @ApiProperty({ description: 'PHI fail-closed behaviour.', example: true })
  phiFailClosed: boolean;

  @ApiProperty({ description: 'Safety-guard provider id.', example: 'lm-studio' })
  safetyProvider: string;

  @ApiProperty({ description: 'Safety-guard model id.', example: 'granite-guardian-4.1-8b' })
  safetyModel: string;

  @ApiPropertyOptional({ description: 'SMR generation provider id (null = let the SMR service choose).', nullable: true })
  smrProvider: string | null;

  @ApiPropertyOptional({ description: 'SMR generation model id (null = let the SMR service choose).', nullable: true })
  smrModel: string | null;

  // ── LLM-as-judge selection (resolved from the SYSTEM-only
  // `harness.judge` AiTaskDefault; GLOBAL_ADMIN-managed). The harness worker's
  // `fetch_policy` activity reads these to pick the judge backend; null on both
  // ⇒ the harness falls back to its env/code judge default. `judgeProvider` is
  // normalised to a harness `JudgeProvider` value (e.g. `lm-studio` → `openai_compat`). ──

  @ApiPropertyOptional({ description: 'LLM-as-judge provider id (null = harness env/code default).', nullable: true })
  judgeProvider: string | null;

  @ApiPropertyOptional({ description: 'LLM-as-judge model id (null = harness env/code default).', nullable: true })
  judgeModel: string | null;

  @ApiProperty({ description: 'Bounded-regen budget.', example: 2 })
  maxRegen: number;

  @ApiProperty({ description: 'Clinician-gate SLA in seconds.', example: 86400 })
  gateSlaSeconds: number;

  @ApiProperty({ description: 'Clinician-gate escalation in seconds.', example: 43200 })
  gateEscalationSeconds: number;

  @ApiPropertyOptional({ description: 'Allow-listed tool ids the loop may call (null = all tools allowed).', type: [String], nullable: true })
  toolAllowlist: string[] | null;

  // ── agentic loop knobs (null ⇒ harness env/code default) ──

  @ApiPropertyOptional({ description: 'Optimistic-delivery loop toggle (null = harness env default).', nullable: true })
  optimisticDeliveryEnabled: boolean | null;

  @ApiPropertyOptional({ description: 'Atomic-fact decomposition toggle (null = harness env default).', nullable: true })
  atomicFactEnabled: boolean | null;

  @ApiPropertyOptional({ description: 'Guideline-retrieval toggle (null = harness env default).', nullable: true })
  retrievalEnabled: boolean | null;

  @ApiPropertyOptional({ description: 'Warm-start toggle (null = harness env default).', nullable: true })
  warmStartEnabled: boolean | null;

  @ApiPropertyOptional({ description: 'NER-priors toggle (null = harness env default).', nullable: true })
  nerPriorsEnabled: boolean | null;

  @ApiPropertyOptional({ description: 'Max edit re-runs (null = harness env default).', nullable: true })
  maxEditReruns: number | null;

  @ApiPropertyOptional({ description: 'Regeneration-feedback toggle (null = harness env default).', nullable: true })
  regenFeedbackEnabled: boolean | null;

  /**
   * MCP external-tools master switch. `null ⇒ OFF`. Global-admin
   * governed, so `getEffectivePolicy` always serves the SYSTEM value even when a
   * tenant row wins for the clinical thresholds.
   */
  @ApiPropertyOptional({ description: 'MCP external-tools master switch (null = OFF).', nullable: true })
  mcpToolsEnabled: boolean | null;

  /**
   * Enabled SYSTEM-shared MCP servers the worker may call.
   * Overlaid by `getEffectivePolicy` from the `McpServer` registry; the harness
   * `McpServerConfig.from_api` parses this exact shape. `authRef` is a Vault PATH,
   * NEVER secret material — the token itself is resolved out-of-band via
   * `GET /internal/harness/mcp-token`. Empty ⇒ nothing is callable.
   */
  @ApiPropertyOptional({ description: 'Enabled SYSTEM-shared MCP servers (authRef is a Vault path, never a secret).', type: 'array' })
  mcpServers: McpServerResponse[];

  /**
   * Per-run token budget from `agentic.context.tokenBudget.perRun`.
   * Served here so the worker gets it in the single policy fetch it already makes.
   * Null ⇒ unconfigured; the workflow then keeps its default of 0 (unbounded).
   */
  @ApiPropertyOptional({ description: 'Per-run token budget (0 or null = unbounded).', nullable: true })
  tokenBudgetPerRun: number | null;

  /**
   * Per-department-agent override provenance. Present only when a
   * consultation's default `DepartmentAgent` supplied tenant-tier overrides that
   * were layered on top of the resolved policy. Additive/observability-only —
   * the worker's `fetch_policy` reads it into the trajectory step; the harness
   * `HarnessPolicy` model ignores it (`extra=ignore`).
   */
  @ApiPropertyOptional({ description: 'Per-agent override provenance (present only when an agent overlay was applied).' })
  overridesSource?: HarnessOverridesSource;

  @ApiPropertyOptional({ description: 'Last update timestamp (ISO-8601; null for code-default).', nullable: true })
  updatedAt: string | null;

  /**
   * Row `_version` for optimistic concurrency. Clients echo it back via
   * `If-Match: "<version>"` (or `expectedVersion` in the body) on the next
   * PATCH; the server's compare-and-set fails with `412 Precondition Failed`
   * on drift. `0` when source is `code-default` (no row exists yet — the
   * `ETagInterceptor` then emits no ETag, which is correct).
   */
  @ApiProperty({ description: 'Row version for optimistic concurrency. Echo as `If-Match: "<version>"` on PATCH.', example: 1 })
  version!: number;
}
