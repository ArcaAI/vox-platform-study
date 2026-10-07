import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { IRedisCacheService } from '../baseServices/redis';
import { IGovernedPromptRegistry } from '../governed-prompt/IGovernedPromptRegistry';
import { GUARDRAIL_POLICY_INVALIDATION_CHANNEL } from './policy-v2';

/**
 * TASK-1050 — what happens after a committed `TenantGuardrailPolicy` write, from EITHER plane (the
 * tenant on/off route and the platform per-tenant route).
 *
 *  1. OD-11: publish `guardrail:config:invalidate` `{ tenantId }`, so apps/guardrail drops that
 *     tenant's cached config at once (a SYSTEM write names SYSTEM; every tenant that widens to it
 *     re-reads it). The TTL stays the bounded-staleness backstop.
 *  2. TASK-1049 F2: the tenant's guardrail POLICY VERSION moved, so every governed-prompt verdict it
 *     held is void. Schedule a re-screen of that tenant's governed sources (a SYSTEM write re-screens
 *     every tenant), instead of leaving them ungoverned and screened at call time until a later pass.
 *
 * FAIL-OPEN by construction: the row is already committed, so neither half may turn a successful
 * write into an error. A Redis outage degrades propagation to guardrail's TTL; a registry that is not
 * wired (or has no re-screen) leaves the next composer call to register lazily.
 */
@Injectable()
export class GuardrailPolicyChangePublisher {
  private readonly logger = new Logger(GuardrailPolicyChangePublisher.name);

  constructor(
    @Optional() @Inject(IRedisCacheService) private readonly redisCacheService?: IRedisCacheService,
    @Optional() @Inject(IGovernedPromptRegistry) private readonly governedPrompts?: IGovernedPromptRegistry,
  ) {}

  async policyChanged(tenantId: string): Promise<void> {
    await this.publishInvalidation(tenantId);
    try {
      this.governedPrompts?.scheduleTenantRescreen?.(tenantId);
    } catch (error) {
      this.logger.warn({
        message: 'Governed-prompt re-screen could not be scheduled after a guardrail policy change (fail-open)',
        tenantId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private async publishInvalidation(tenantId: string): Promise<void> {
    if (!this.redisCacheService) return;
    try {
      await this.redisCacheService.publish(GUARDRAIL_POLICY_INVALIDATION_CHANNEL, JSON.stringify({ tenantId }));
    } catch (error) {
      this.logger.warn({
        message: 'Failed to publish guardrail config invalidation (fail-open — guardrail TTL still converges)',
        channel: GUARDRAIL_POLICY_INVALIDATION_CHANNEL,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
