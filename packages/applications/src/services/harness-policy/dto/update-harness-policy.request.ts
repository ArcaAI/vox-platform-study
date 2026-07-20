import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * PATCH body for `/admin/harness/policy` and `/admin/harness/policy/global`
 * (TASK-330 Phase 6). Every knob is OPTIONAL — only supplied fields are
 * applied over the current effective policy (a sparse patch). Thresholds are
 * fractions in [0, 1]; the regen budget + gate timers are non-negative
 * integers. `expectedVersion` is the OCC token (folded from the `If-Match`
 * header by the controller; body fallback for service-to-service callers).
 *
 * Sending `null` for `smrProvider` / `smrModel` / `toolAllowlist` explicitly
 * clears the field ("let the service choose" / "no tool restriction"); OMITTING
 * a field leaves it unchanged.
 */
export class UpdateHarnessPolicyRequest {
  @ApiPropertyOptional({ description: 'Entity-faithfulness sensor threshold (fraction in [0,1]).', minimum: 0, maximum: 1, example: 1.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  entityFaithfulnessThreshold?: number;

  @ApiPropertyOptional({ description: 'Coverage sensor threshold (fraction in [0,1]).', minimum: 0, maximum: 1, example: 0.8 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  coverageThreshold?: number;

  @ApiPropertyOptional({ description: 'Citation-presence sensor threshold (fraction in [0,1]).', minimum: 0, maximum: 1, example: 1.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  citationPresenceThreshold?: number;

  @ApiPropertyOptional({ description: 'Numeric/dose sensor threshold (fraction in [0,1]).', minimum: 0, maximum: 1, example: 1.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  numericDoseThreshold?: number;

  @ApiPropertyOptional({ description: 'Groundedness (inferential) sensor threshold (fraction in [0,1]).', minimum: 0, maximum: 1, example: 0.8 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  groundednessThreshold?: number;

  @ApiPropertyOptional({ description: 'Master safety-guardrail toggle.', example: true })
  @IsOptional()
  @IsBoolean()
  safetyEnabled?: boolean;

  @ApiPropertyOptional({ description: 'PHI-detection toggle.', example: true })
  @IsOptional()
  @IsBoolean()
  phiEnabled?: boolean;

  @ApiPropertyOptional({ description: 'PHI fail-closed behaviour (block on detector error).', example: true })
  @IsOptional()
  @IsBoolean()
  phiFailClosed?: boolean;

  @ApiPropertyOptional({ description: 'Safety-guard provider id.', example: 'lm-studio' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  safetyProvider?: string;

  @ApiPropertyOptional({ description: 'Safety-guard model id.', example: 'granite-guardian-4.1-8b' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  safetyModel?: string;

  @ApiPropertyOptional({ description: 'SMR generation provider id (null = let the SMR service choose).', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  smrProvider?: string | null;

  @ApiPropertyOptional({ description: 'SMR generation model id (null = let the SMR service choose).', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  smrModel?: string | null;

  @ApiPropertyOptional({ description: 'Bounded-regen budget (non-negative integer).', minimum: 0, example: 2 })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxRegen?: number;

  @ApiPropertyOptional({ description: 'Clinician-gate SLA in seconds (non-negative integer).', minimum: 0, example: 86400 })
  @IsOptional()
  @IsInt()
  @Min(0)
  gateSlaSeconds?: number;

  @ApiPropertyOptional({ description: 'Clinician-gate escalation in seconds (non-negative integer).', minimum: 0, example: 43200 })
  @IsOptional()
  @IsInt()
  @Min(0)
  gateEscalationSeconds?: number;

  @ApiPropertyOptional({ description: 'Allow-listed tool ids the loop may call (null = all tools allowed).', type: [String], nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  toolAllowlist?: string[] | null;

  // ── agentic loop knobs ──
  // Every knob is a nullable override: send `null` to clear it back to the
  // harness env/code default; OMIT to leave unchanged; send a value to override.
  // These keys sit under the `agentic.*` privilege boundary (GLOBAL_ADMIN only)
  // enforced at the controller/route layer.

  @ApiPropertyOptional({ description: 'Optimistic-delivery loop toggle (null = harness env default).', nullable: true })
  @IsOptional()
  @IsBoolean()
  optimisticDeliveryEnabled?: boolean | null;

  @ApiPropertyOptional({ description: 'Atomic-fact decomposition toggle (null = harness env default).', nullable: true })
  @IsOptional()
  @IsBoolean()
  atomicFactEnabled?: boolean | null;

  @ApiPropertyOptional({ description: 'Guideline-retrieval toggle (null = harness env default).', nullable: true })
  @IsOptional()
  @IsBoolean()
  retrievalEnabled?: boolean | null;

  @ApiPropertyOptional({ description: 'Warm-start toggle (null = harness env default).', nullable: true })
  @IsOptional()
  @IsBoolean()
  warmStartEnabled?: boolean | null;

  @ApiPropertyOptional({ description: 'NER-priors toggle (null = harness env default).', nullable: true })
  @IsOptional()
  @IsBoolean()
  nerPriorsEnabled?: boolean | null;

  @ApiPropertyOptional({ description: 'Max edit re-runs (non-negative integer; null = harness env default).', minimum: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxEditReruns?: number | null;

  @ApiPropertyOptional({ description: 'Regeneration-feedback toggle (null = harness env default).', nullable: true })
  @IsOptional()
  @IsBoolean()
  regenFeedbackEnabled?: boolean | null;

  /**
   * TASK-533 D-24 — master gate for the MCP external-tools path. GLOBAL_ADMIN
   * only (see `GLOBAL_ADMIN_ONLY_POLICY_KEYS`): a tenant PATCH carrying it is
   * rejected 403. `null ⇒ OFF`; arming it additionally requires the referenced
   * `McpServer.enabled` to be true, so this alone cannot open an egress path.
   *
   * Its absence here is what made the knob unpatchable: the global validation
   * pipe runs `forbidNonWhitelisted`, so the field was stripped before it could
   * ever reach `mergeKnobs`.
   */
  @ApiPropertyOptional({ description: 'MCP external-tools master switch (null = OFF). Global-admin only.', nullable: true })
  @IsOptional()
  @IsBoolean()
  mcpToolsEnabled?: boolean | null;

  @ApiPropertyOptional({ description: 'Free-text reason for the edit, recorded on the WORM change row.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /**
   * Optimistic-concurrency token. The client reads the policy first, then
   * echoes the observed `version`. On a `@RequiresIfMatch()` route the
   * controller folds the RFC 7232 `If-Match` header over this field, so the
   * canonical request carries the version in the header and omits it here.
   * Service-to-service callers may pass it in the body. Version drift on an
   * existing row raises `412 Precondition Failed`.
   */
  @ApiPropertyOptional({ description: 'Current row version (from the prior GET). PATCH fails 412 if it drifted.', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
