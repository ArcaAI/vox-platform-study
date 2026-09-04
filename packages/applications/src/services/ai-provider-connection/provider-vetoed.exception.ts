import { ProviderCredentialVetoedException } from '@arcaai/exceptions';
import { ProviderService } from './constants';

/**
 * TASK-862 — thrown by `ProviderCredentialResolver.resolve` when the tenant's
 * OWN connection row for `(service, provider)` is DISABLED.
 *
 * A disabled tenant row is a VETO, not "unused": it blocks the platform-default
 * credential too, and the resolver must fail closed rather than fall through to
 * the SYSTEM tier or to another provider. Same code (`PROVIDER_CREDENTIAL_VETOED`
 * → HTTP 409) as the request-fold's `assertProviderAvailable`, so a consumer
 * that already handles that exception handles this one; the subclass exists so
 * an Agent invocation (TASK-863) can name the veto precisely in its own error.
 */
export class ProviderVetoedException extends ProviderCredentialVetoedException {
  constructor(service: ProviderService, provider: string, tenantId: string) {
    super(
      `Provider '${provider}' is disabled for tenant '${tenantId}' on the '${service}' capability. ` +
        'A disabled connection row is a veto: it blocks the platform-provided credential too. ' +
        'Re-enable (or delete) the row to use this provider.',
      { service, provider },
    );
  }
}
