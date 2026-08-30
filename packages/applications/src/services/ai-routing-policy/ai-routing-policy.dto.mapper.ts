import { AiRoutingPolicyEntity } from '@arcaai/domains';
import { AiRoutingPolicyResponse, RejectedRoutingCandidateResponse, ResolvedRoutingCandidateResponse } from './dto';
import { FundedCandidate, RoutingFunding, RoutingHopRejection } from './routing-gates';
import { RoutingCandidate } from './routing-policy.contract';

export class AiRoutingPolicyDtoMapper {
  static toResponse(entity: AiRoutingPolicyEntity): AiRoutingPolicyResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      taskKey: entity.taskKey,
      policyVersion: entity.policyVersion,
      status: entity.status,
      strategy: entity.strategy,
      explicitProviderMode: entity.explicitProviderMode,
      priority: entity.priority,
      killSwitch: entity.killSwitch,
      match: entity.matchJson ?? null,
      candidates: entity.candidatesJson,
      fallback: entity.fallbackJson ?? null,
      health: entity.healthJson ?? null,
      affinity: entity.affinityJson ?? null,
      maxConcurrentStreams: entity.maxConcurrentStreams ?? null,
      requestsPerMinute: entity.requestsPerMinute ?? null,
      tokensPerMinute: entity.tokensPerMinute ?? null,
      supersedesVersion: entity.supersedesVersion ?? null,
      activatedAt: entity.activatedAt?.toISOString() ?? null,
      resourceStatus: entity.resourceStatus ?? undefined,
      version: entity.version,
      createdAt: entity.createdAt?.toISOString(),
      updatedAt: entity.updatedAt?.toISOString(),
      createdBy: entity.createdBy ?? null,
      updatedBy: entity.updatedBy ?? null,
    };
  }

  /**
   * `funding` is read off the {@link FundedCandidate} the resolver already
   * derived from the connection row — never recomputed here. One derivation,
   * one place (the `AiProviderConnectionService.fundingOf` precedent).
   */
  static toResolvedCandidate(funded: FundedCandidate, step: number): ResolvedRoutingCandidateResponse {
    const { candidate } = funded;
    return {
      step,
      rank: candidate.rank,
      weight: candidate.weight,
      connectionRef: candidate.connectionRef,
      model: candidate.model,
      residency: candidate.residency,
      baaCovered: candidate.baaCovered,
      funding: funded.funding as RoutingFunding,
      maxTtftMs: candidate.maxTtftMs ?? null,
    };
  }

  static toRejectedCandidate(candidate: RoutingCandidate, reason: RoutingHopRejection): RejectedRoutingCandidateResponse {
    return {
      rank: candidate.rank,
      connectionRef: candidate.connectionRef,
      model: candidate.model,
      reason,
    };
  }
}
