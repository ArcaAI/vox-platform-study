// Identity has NO platform credential tier.
//
// Every other provider credential on this platform cascades tenant → SYSTEM: a
// tenant brings its own key, and the SYSTEM row is the fallback for tenants with
// no opinion (`09-infrastructure-devops.md` §"Tenant-first resolution & BYO").
// IDENTITY IS DELIBERATELY DIFFERENT. A tenant federates against ITS OWN
// identity provider or it does not federate at all — there is no coherent
// "platform default IdP" to fall back to, because falling back would
// authenticate a tenant's users against somebody else's directory.
//
// So identity is a ONE-tier plane: the tenant's own
// `TenantIdentityProvider.encryptedSecretRef`, sealed with Vault Transit and
// decrypted per login by `IdpResolverService` (covered behaviourally by
// `idp-resolver.service.test.ts` — "decrypts the sealed secret and builds a
// client from the persisted config").
//
// What this file pins is the NEGATIVE half of that contract, which no
// behavioural test can reach: that a SECOND, platform-wide client secret does
// not exist alongside it. Before this ticket `OIDC_CLIENT_SECRET` was still read
// out of Vault/env at module init, still warmed into the secrets cache at boot,
// and still registered as a seedable platform secret — a complete parallel
// credential path. It authenticated nothing (its passport strategy is reachable
// from no route), but "currently unreachable" is a property of the route table,
// not of the credential plane: re-attaching one guard would have silently
// restored a platform-tier login.
//
// A structural scan is the right shape here for the same reason it is in
// `warmup-coverage.test.ts` and `apps/text`'s BYOK guard: the absence of a
// credential path cannot be observed by calling anything.

import { describe, expect, it } from 'vitest';
import { COMMON_SERVICE_WARMUP_KEYS } from '../../baseServices/common.service.module';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { scanSecretCallSites } from '../../baseServices/_meta/secrets/__tests__/secret-key-surface';

/** The retired platform relying-party credential. */
const PLATFORM_OIDC_SECRET = 'OIDC_CLIENT_SECRET';

describe('OIDC — the platform credential tier is closed; only the tenant’s own secret authenticates', () => {
  it('is read by no production call site in the gateway', () => {
    const readers = scanSecretCallSites()
      .filter((site) => site.name === PLATFORM_OIDC_SECRET)
      .map((site) => `${site.method}('${site.name}') @ ${site.where}`);

    expect(
      readers,
      'A platform-wide OIDC client secret is a second way to authenticate a federated login. ' +
        'Identity resolves the TENANT’s own TenantIdentityProvider.encryptedSecretRef and nothing else.',
    ).toEqual([]);
  });

  it('is not warmed into the secrets cache at boot', () => {
    expect(
      [...COMMON_SERVICE_WARMUP_KEYS],
      'Warming a secret nothing reads keeps a retired credential alive in every process’s memory.',
    ).not.toContain(PLATFORM_OIDC_SECRET);
  });

  it('is not a registered platform secret, so nothing seeds it into Vault', () => {
    // `scripts/vault-seed-secrets.sh` derives its key list from the `vault-kv`
    // descriptors, and `turbo.json#globalEnv` mirrors the same mapping — so a
    // surviving descriptor would keep provisioning the credential even with no
    // reader left.
    const registered = HOPE_SETTINGS_REGISTRY.list()
      .filter((descriptor) => descriptor.key.toLowerCase().includes('oidc'))
      .filter((descriptor) => descriptor.sensitivity === 'secret')
      .map((descriptor) => descriptor.key);

    expect(registered, 'A platform OIDC secret descriptor re-provisions the credential this ticket retired.').toEqual([]);
  });
});
