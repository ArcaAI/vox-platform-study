// The seeding surface must equal the read surface.
//
// `scripts/vault-seed-secrets.sh` derives the set of secrets it writes into
// Vault kv-v2 from `PLATFORM_SECRET_SETTINGS` — deliberately, so no shell script
// carries a key list of its own. The corollary nobody was checking: a secret the
// gateway ASKS `SecretsService` for but that has NO `vault-kv` descriptor is
// never seeded, so on a `SECRETS_PROVIDER=vault` deployment it resolves to
// undefined while working fine on every `SECRETS_PROVIDER=env` dev box. That is
// the worst shape of configuration bug — invisible until production.
//
// This test closes the loop in the only direction that can break silently:
// read ⇒ declared. (The reverse — declared but unread — is legitimate: several
// descriptors name credentials read by the Python services, not by the gateway.)
import { describe, expect, it } from 'vitest';
import { PLATFORM_SECRET_SETTINGS } from '../../../../settings-registry/descriptors/platform-secrets.descriptors';
import { toEnvVarName } from '../../../../settings-registry/registry.types';
import { scanSecretCallSites } from './secret-key-surface';

/**
 * Secret names the gateway reads that are deliberately NOT `vault-kv`
 * descriptors. Empty by design — add an entry only with a reason, never to
 * silence the guard.
 */
const NOT_A_PLATFORM_SECRET = new Set<string>([]);

describe('every secret the gateway reads is a registered vault-kv descriptor', () => {
  const seedable = new Set(PLATFORM_SECRET_SETTINGS.filter((d) => d.tier === 'vault-kv').map((d) => toEnvVarName(d.key)));

  it('leaves no read-but-undeclared secret (which vault-seed-secrets.sh would never seed)', () => {
    const undeclared = scanSecretCallSites().filter((site) => !seedable.has(site.name) && !NOT_A_PLATFORM_SECRET.has(site.name));

    expect(
      [...new Set(undeclared.map((s) => `${s.name} @ ${s.where}`))].sort(),
      'Each name above is fetched through SecretsService but has no vault-kv descriptor, ' +
        'so `scripts/vault-seed-secrets.sh` cannot seed it and a Vault-backed deployment ' +
        'resolves it to undefined. Register it in platform-secrets.descriptors.ts.',
    ).toEqual([]);
  });

  it('derives Vault kv-v2 names mechanically, so the script needs no key table', () => {
    // The script's contract: the descriptor's env-var name IS the kv-v2 secret
    // name at `<mount>/data/<prefix>/<NAME>`.
    expect(seedable.has('JWT_SECRET_KEY')).toBe(true);
    expect(seedable.has('HARNESS_CLAIM_CHECK_ACCESS_KEY')).toBe(true);
  });
});
