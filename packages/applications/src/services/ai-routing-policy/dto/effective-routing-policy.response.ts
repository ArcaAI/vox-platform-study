import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A candidate the resolver ADMITTED, with the funding tier derived from the
 * connection row that will supply its credential.
 */
export class ResolvedRoutingCandidateResponse {
  @ApiProperty({ description: 'Position in the chain. 0 = the primary (`x-hope-fallback-step`).' })
  step!: number;

  @ApiProperty({ description: 'Rank as authored on the candidate' })
  rank!: number;

  @ApiProperty({ description: 'Weight within the rank tier' })
  weight!: number;

  @ApiProperty({ description: 'AiProviderConnection `provider` under the `llm` service', example: 'azure' })
  connectionRef!: string;

  @ApiProperty({ description: 'Model this candidate serves' })
  model!: string;

  @ApiProperty({ description: 'Residency-class label' })
  residency!: string;

  @ApiProperty({ description: 'Whether a BAA covers this vendor AND model' })
  baaCovered!: boolean;

  @ApiProperty({
    description:
      'BYOK | CLOUD — DERIVED from which cascade tier supplied the credential (`row.tenantId === SYSTEM` ⇒ CLOUD), never stamped by a caller. Becomes `x-hope-funding`.',
  })
  funding!: string;

  @ApiPropertyOptional({ description: 'TTFT budget, advisory to the router', nullable: true })
  maxTtftMs!: number | null;
}

/** A candidate the resolver REFUSED, and why. */
export class RejectedRoutingCandidateResponse {
  @ApiProperty({ description: 'Rank as authored' })
  rank!: number;

  @ApiProperty({ description: 'AiProviderConnection `provider` under the `llm` service' })
  connectionRef!: string;

  @ApiProperty({ description: 'Model this candidate would have served' })
  model!: string;

  @ApiProperty({
    description:
      'RESIDENCY_CLASS_MISMATCH | NOT_BAA_COVERED | FUNDING_TIER_MISMATCH | FALLBACK_DEPTH_EXCEEDED | CONNECTION_UNRESOLVED | PROVIDER_UNHEALTHY | EXPLICIT_PROVIDER_STRICT',
  })
  reason!: string;
}

/** A refusal to serve the request at all, in the caller's terms. */
export class RoutingRejectionResponse {
  @ApiProperty({
    description:
      'provider_unavailable | provider_not_in_policy | no_policy | kill_switch_engaged | no_eligible_candidate — machine-readable, per §3A.4.',
  })
  code!: string;

  @ApiProperty({ description: 'Human-readable explanation naming the offending provider/gate' })
  message!: string;

  @ApiPropertyOptional({ description: 'Whether retrying the same request may succeed later (a health ejection) or never (a gate)', nullable: true })
  retryable!: boolean | null;
}

/**
 * The resolved routing decision for one (tenant, taskKey) request.
 *
 * `fallbackChain` is ALREADY GATED: every §3A.4 hard gate has run, so a hop
 * that appears here is one the router may legitimately take. Everything the
 * gates refused appears in `rejectedCandidates` with its reason, so a rejection
 * is never silent.
 */
export class EffectiveRoutingPolicyResponse {
  @ApiProperty({ description: 'Tenant the resolution ran for' })
  tenantId!: string;

  @ApiProperty({ description: 'AI task key' })
  taskKey!: string;

  @ApiPropertyOptional({
    description:
      "'tenant' when the request tenant's own ACTIVE policy won, 'system' when it inherited the platform default, null when neither exists.",
    nullable: true,
  })
  source!: string | null;

  @ApiPropertyOptional({ description: 'Winning policy id', nullable: true })
  policyId!: string | null;

  @ApiPropertyOptional({ description: 'Winning AUTHORED revision', nullable: true })
  policyVersion!: number | null;

  @ApiPropertyOptional({ description: 'Selection strategy of the winning policy', nullable: true })
  strategy!: string | null;

  @ApiPropertyOptional({ description: 'Explicit-provider mode of the winning policy', nullable: true })
  explicitProviderMode!: string | null;

  @ApiPropertyOptional({
    description: 'The primary candidate (step 0), or null when nothing may serve',
    nullable: true,
    type: ResolvedRoutingCandidateResponse,
  })
  primary!: ResolvedRoutingCandidateResponse | null;

  @ApiProperty({
    description: 'Admitted fallback hops in order, already gated and depth-bounded',
    type: ResolvedRoutingCandidateResponse,
    isArray: true,
  })
  fallbackChain!: ResolvedRoutingCandidateResponse[];

  @ApiProperty({ description: 'Every candidate the resolver refused, with its reason', type: RejectedRoutingCandidateResponse, isArray: true })
  rejectedCandidates!: RejectedRoutingCandidateResponse[];

  @ApiPropertyOptional({ description: 'Set when the request cannot be served at all', nullable: true, type: RoutingRejectionResponse })
  rejection!: RoutingRejectionResponse | null;

  @ApiProperty({
    description:
      'Which of the three §3A.4 hard gates the winning policy explicitly relaxed. Empty in the default posture; every entry is a deliberate, audited super-admin act.',
    isArray: true,
    type: String,
  })
  relaxedGates!: string[];

  @ApiPropertyOptional({ description: 'Circuit/health thresholds the router should apply (§3A.5)', nullable: true, type: Object })
  health!: unknown;

  @ApiPropertyOptional({ description: 'Concurrent-stream ceiling from the winning policy', nullable: true })
  maxConcurrentStreams!: number | null;

  @ApiPropertyOptional({ description: 'Requests-per-minute ceiling from the winning policy', nullable: true })
  requestsPerMinute!: number | null;

  @ApiPropertyOptional({ description: 'Tokens-per-minute ceiling from the winning policy', nullable: true })
  tokensPerMinute!: number | null;
}
