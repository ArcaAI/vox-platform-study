import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Where the effective policy was resolved from:
 *  - `tenant`         — the calling tenant's own override row.
 *  - `system-default` — the SYSTEM-tenant GLOBAL-DEFAULT row (no tenant row).
 *  - `code-default`   — neither row exists yet; values are the harness code
 *                       defaults (the platform default has not been seeded).
 */
export type HarnessPolicySource = 'tenant' | 'system-default' | 'code-default';

/**
 * The effective harness policy (TASK-330 Phase 6). Returned by
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

  @ApiProperty({ description: 'Bounded-regen budget.', example: 2 })
  maxRegen: number;

  @ApiProperty({ description: 'Clinician-gate SLA in seconds.', example: 86400 })
  gateSlaSeconds: number;

  @ApiProperty({ description: 'Clinician-gate escalation in seconds.', example: 43200 })
  gateEscalationSeconds: number;

  @ApiPropertyOptional({ description: 'Allow-listed tool ids the loop may call (null = all tools allowed).', type: [String], nullable: true })
  toolAllowlist: string[] | null;

  // ── TASK-511 (Phase 3A) — agentic loop knobs (null ⇒ harness env/code default) ──

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
