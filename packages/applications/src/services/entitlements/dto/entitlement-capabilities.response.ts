import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantPlan } from '@arcaai/domains';

/**
 * TASK-392 (Q4) — trial-clock snapshot for the countdown/expiry banner. A
 * tenant is "trial" while `plan === TRIAL`; `expired` flips once
 * `trialEndsAt < now` (until the scheduled downgrade job flips the plan).
 */
export class TrialInfoResponse {
  @ApiProperty({ description: 'Whether the tenant is currently on the TRIAL plan' })
  isTrial: boolean;

  @ApiPropertyOptional({ description: 'Trial end timestamp (ISO-8601); null when not on trial', nullable: true })
  trialEndsAt?: string | null;

  @ApiPropertyOptional({ description: 'Whole days remaining until trial expiry (0 when expired); null when not on trial', nullable: true })
  daysRemaining?: number | null;

  @ApiProperty({ description: 'True when on TRIAL and past trialEndsAt (pending auto-downgrade to STARTER)' })
  expired: boolean;
}

/** One resolved capability with its live usage (proposal §2, display-only in Phase 1). */
export class CapabilityUsageRow {
  @ApiProperty({ description: 'Stable capability key (e.g. "users", "storageBytes", "monthlyConsultations")' })
  key: string;

  @ApiPropertyOptional({ description: 'Resolved limit; null = unlimited/ungated', nullable: true })
  limit?: number | null;

  @ApiPropertyOptional({ description: 'Current usage; null when not yet metered (M1–M3 land in Phase 2)', nullable: true })
  used?: number | null;

  @ApiPropertyOptional({ description: 'limit − used (floored at 0); null when unlimited or unmetered', nullable: true })
  remaining?: number | null;

  @ApiProperty({ description: 'True when the limit is null (unlimited)' })
  unlimited: boolean;

  @ApiProperty({ description: 'True when usage ≥ 80% of the limit' })
  nearLimit: boolean;

  @ApiProperty({ description: 'True when usage strictly exceeds the limit' })
  exceeded: boolean;
}

export class ResolvedFeaturesResponse {
  @ApiProperty({ description: 'DNA writing-style + reports (F2)' })
  dnaReports: boolean;

  @ApiProperty({ description: 'Voice enrollment / diarization (F3)' })
  voiceEnrollment: boolean;

  @ApiProperty({ description: 'Monitoring / telemetry access (F5)' })
  monitoringAccess: boolean;
}

/**
 * TASK-392 (Phase 1) — the read-only capability/usage snapshot for a tenant:
 * resolved limits (seeded ← plan row ← tenant override) composed with live
 * usage from `getUsageStats`, plus features, tiers, and the trial clock.
 * Enforcement state is surfaced via `enforcementEnabled` (the kill-switch).
 */
export class EntitlementCapabilitiesResponse {
  @ApiProperty({ description: 'Tenant ID' })
  tenantId: string;

  @ApiPropertyOptional({ description: 'Commercial plan; null = ungated-legacy', enum: TenantPlan, nullable: true })
  plan?: TenantPlan | null;

  @ApiProperty({ description: 'False for a null-plan (ungated-legacy) tenant' })
  gated: boolean;

  @ApiProperty({ description: 'Global enforcement kill-switch state (entitlements.enabled). Phase 1 ships OFF.' })
  enforcementEnabled: boolean;

  @ApiProperty({ description: 'Quantity capabilities C1–C6 (users, departments, prompt templates, ASR pipelines, API keys, storage bytes)', type: [CapabilityUsageRow] })
  quantities: CapabilityUsageRow[];

  @ApiProperty({ description: 'Rolling-monthly meters M1–M3 (used is null until Phase 2 metering lands)', type: [CapabilityUsageRow] })
  meters: CapabilityUsageRow[];

  @ApiProperty({ description: 'Resolved feature toggles', type: () => ResolvedFeaturesResponse })
  features: ResolvedFeaturesResponse;

  @ApiProperty({ description: 'Model-access tier driving the clone-subset (base | full | full_custom)' })
  modelTier: string;

  @ApiProperty({ description: 'Rate-limit tier (strict | default | relaxed | heavy)' })
  rateLimitTier: string;

  @ApiPropertyOptional({ description: 'Per-tenant absolute rate override (req/min); null = use the tier', nullable: true })
  rateLimitPerMinute?: number | null;

  @ApiProperty({ description: 'Trial clock snapshot', type: () => TrialInfoResponse })
  trial: TrialInfoResponse;
}
