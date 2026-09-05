import { ServiceUnavailableException } from '@nestjs/common';

/**
 * A tenant has explicitly DISABLED its own elected `AiRoutingPolicy` row for a
 * task key. The selection is REFUSED, not absent.
 *
 * ## Why this is not just "no row"
 *
 * `AiProviderConnection` fixes the platform's resolution vocabulary in three
 * states (`09-infrastructure-devops.md` §Tenant-first resolution & BYO):
 *
 *   absent   no opinion   → widen to SYSTEM, the platform default applies
 *   enabled  the tenant's row wins outright, SYSTEM is not consulted
 *   DISABLED a VETO       → no tier serves it
 *
 * Collapsing the third state into the first is the failure this exception
 * exists to make impossible. A tenant that switches its own selection off has
 * said something — very often *"do not send our data to this model"* — and
 * folding through to SYSTEM answers that with the platform's model. The tenant
 * is then served by a vendor it declined, silently, with `source: 'system'` on
 * the response to say everything is normal.
 *
 * ## The same shape guardrail already ships
 *
 * `apps/guardrail/src/guardrail/core/tenant_config.py` implements exactly this
 * for its own SQL resolver (`TenantSelectionVetoedError`, mapped to HTTP 503 in
 * `core/dependencies.py`), including caching the veto so it keeps raising
 * inside the TTL window rather than being read back as "no opinion". This is
 * the gateway-side twin of that class, and the 503 is deliberate parity: the
 * task genuinely cannot be served, and a caller that already fails closed on an
 * unresolved selection needs no new branch to do the right thing.
 *
 * NOT the 404-over-403 cross-tenant posture, and not a 4xx at all: the caller
 * addressed its own tenant legitimately and asked a question the configuration
 * refuses to answer.
 */
export class TaskSelectionVetoedError extends ServiceUnavailableException {
  constructor(
    readonly tenantId: string,
    readonly taskKey: string,
  ) {
    super(
      `Tenant '${tenantId}' has DISABLED its own elected routing configuration for task '${taskKey}'. ` +
        'That is a veto, not an absence: the platform (SYSTEM) default is deliberately NOT substituted. ' +
        'Re-enable the tenant configuration, or delete it so the platform default applies again.',
    );
  }
}
