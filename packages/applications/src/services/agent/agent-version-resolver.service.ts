import { Injectable, NotFoundException } from '@nestjs/common';
import { AgentEntity, AgentRepository, WorkflowDefinitionStatus } from '@arcaai/domains';
import type { ResolvedAgent } from '@arcaai/types';
import { AgentResolverService } from './agent-resolver.service';

export interface ResolveAgentVersionInput {
  tenantId: string;
  slug: string;
  versionNumber: number;
}

/** A pinned version still RUNS while published or deprecated (owner decision OD-21). */
const RUNNABLE_PINNED_STATUSES: ReadonlySet<string> = new Set([WorkflowDefinitionStatus.PUBLISHED, WorkflowDefinitionStatus.DEPRECATED]);

/**
 * TASK-1038 (D-A, the gateway half) — resolve ONE PINNED version of an agent lineage, for
 * `GET /internal/agents/:slug/versions/:versionNumber/resolved`.
 *
 * `AgentResolverService.resolve` serves the ACTIVE published version, so a workflow that pinned
 * `agentRef.versionNumber` could only REFUSE when the agent was republished (`agent_version_drift`)
 * — never run what it pinned. This serves exactly the pinned version: PUBLISHED, or DEPRECATED
 * (OD-21: deprecating a version some published workflow pins must not break that workflow).
 * A draft, an unknown version, or another tenant's lineage is one 404 (404-over-403): the lookup
 * reads the CALLER's own versions only (`findAllVersionsBySlug` filters by tenant).
 *
 * **One materialisation, not two.** Everything after the row lookup — the platform-hidden rule,
 * the compiled-config check, the model rows, the fallback chain, the provider credential and its
 * funding tier — is the existing resolver's, run against a view of the agent table that answers
 * with the pinned row. A second copy of that logic would drift from the first in exactly the
 * fields the harness relies on, and the route's whole contract is "the SAME shape as resolve".
 * (Folding a `versionNumber` input into `AgentResolverService.resolve` itself would be the
 * tidier end state; it was kept out of this change to leave that file to its owner.)
 */
@Injectable()
export class AgentVersionResolverService {
  constructor(
    private readonly agentRepository: AgentRepository,
    private readonly resolver: AgentResolverService,
  ) {}

  async resolveVersion(input: ResolveAgentVersionInput): Promise<ResolvedAgent> {
    const versions = await this.agentRepository.findAllVersionsBySlug(input.tenantId, input.slug);
    const pinned = versions.find((row) => row.versionNumber === input.versionNumber && RUNNABLE_PINNED_STATUSES.has(String(row.status)));
    if (!pinned) throw new NotFoundException('Agent version not found');
    return this.resolverFor(input.tenantId, pinned).resolve({ tenantId: input.tenantId, agentSlug: pinned.slug });
  }

  /** The shared resolver, with its by-slug row lookup answering with `pinned` and nothing else. */
  private resolverFor(tenantId: string, pinned: AgentEntity): AgentResolverService {
    const pinnedView: Pick<AgentRepository, 'findPublishedActiveBySlug'> = {
      findPublishedActiveBySlug: async (lookupTenantId: string, slug: string) =>
        lookupTenantId === tenantId && slug === pinned.slug ? pinned : null,
    };
    return Object.create(this.resolver, { agentRepository: { value: pinnedView } }) as AgentResolverService;
  }
}
