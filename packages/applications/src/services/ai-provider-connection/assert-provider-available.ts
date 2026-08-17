import { ProviderCredentialVetoedException, QuotaExceededException } from '@arcaai/exceptions';
import { ProviderService } from './constants';
import { ResolvedProviderOverrides } from './IProviderConnectionService';

/**
 * The entitlement key that grants a tenant the SYSTEM-tenant platform-default
 * credential. Matches `ResolvedFeatures.platformDefaultCredential`'s column name
 * `featurePlatformDefaultCredential`, which is what `mapQuotaCapabilityToHttp`
 * keys its `startsWith('feature') → 403` branch off.
 */
export const PLATFORM_DEFAULT_CAPABILITY = 'featurePlatformDefaultCredential';

/**
 * Turn "this provider has no credential" into an ATTRIBUTABLE error — call it
 * at the point of SELECTION, once a provider is chosen and found to have no
 * entry in `overrides`.
 *
 * Three outcomes, three remediations, three different people:
 *
 * | Situation | Exception | HTTP | Who fixes it |
 * |---|---|---|---|
 * | The tenant vetoed this provider (its own row is disabled) | `ProviderCredentialVetoedException` | 409 | the tenant admin, in the console |
 * | No `featurePlatformDefaultCredential` grant | `QuotaExceededException` | 403 | the account owner / a super admin |
 * | Neither — genuinely nothing configured | *(returns void)* | 503 downstream | a super admin, by keying a SYSTEM row |
 *
 * VETO BEATS GRANT: a tenant's refusal to send PHI to a shared vendor
 * account outranks a commercial grant, so the veto is checked first. The third
 * case is deliberately NOT an error here — an unconfigured provider is the
 * pre-existing downstream 503 and this helper must not convert it into
 * something that reads like a policy decision.
 *
 * One honest wrinkle, and it is by design: when the gate suppressed the SYSTEM
 * tier the resolver never read it, so a tenant with no grant gets the 403 even
 * when the platform has nothing configured either. Reading the platform's
 * ciphertext to produce a more precise message for a caller who may not use it
 * is the worse trade; the 403 is the more actionable message in both cases.
 */
export function assertProviderAvailable(resolved: ResolvedProviderOverrides, service: ProviderService, provider: string): void {
  if (resolved.overrides[provider]) return;

  const outcome = resolved.platformDefault;
  if (!outcome) return;

  if (outcome.vetoed.includes(provider)) {
    throw new ProviderCredentialVetoedException(
      `Provider '${provider}' is disabled for this tenant on the '${service}' capability. ` +
        'A disabled connection row is a veto: it blocks the platform-provided credential too. ' +
        'Re-enable (or delete) the row to use this provider.',
      { service, provider },
    );
  }

  if (outcome.entitlementSuppressed) {
    throw new QuotaExceededException(
      `This tenant is not entitled to the platform-provided credential for '${provider}' (${service}). ` +
        'Bring your own credential for this provider, or ask your account owner to enable the platform-default entitlement.',
      // A boolean grant has no numeric limit: the tenant holds zero of it and
      // the call asked for one. `capability` is the field that matters — the
      // gateway maps every `feature*` capability to 403.
      { capability: PLATFORM_DEFAULT_CAPABILITY, limit: 0, used: 0, requested: 1 },
    );
  }
}
