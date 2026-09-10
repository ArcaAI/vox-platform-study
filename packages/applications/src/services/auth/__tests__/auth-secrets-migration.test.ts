// Pin auth-strategy secret migrations.
//
// Each strategy/factory MUST:
//   - NOT call appSettingsService.getValueWithDefault('<SECRET>', …)
//   - read the secret via SecretsService.getSecret(Sync|Optional)('<SECRET>')
//
// TASK-944 amended the JWT_SECRET_KEY half of that. The REQUIREMENT is unchanged —
// the secret comes from SecretsService, never from AppSettings — but the two JWT
// strategies no longer spell the read out inline: both now go through
// `resolveJwtSecret()` (`services/auth/jwt-secret.ts`), the ONE resolver the mint
// paths also use, because a `getSecretSync` captured once in `JwtStrategy`'s
// constructor pinned verification to the boot-time value and turned a Vault rotation
// into a platform-wide 401 outage. The assertions below therefore name the resolver
// rather than the byte sequence it wraps — asserting the inline call would now forbid
// exactly the fix.
//
// Non-secret OIDC config (DISCOVERY_URL, CLIENT_ID, CALLBACK_URL, SCOPES,
// JWT_EXPIRES_IN) MUST stay on AppSettingsService (surgical scope).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
function rel(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

describe('Phase 3B auth secret migration', () => {
  // gateway-auth.strategy.ts was RETIRED (the
  // `gateway-jwt` strategy was wired to zero routes; UnifiedAuthGuard is the
  // single enforcement point). Its JWT_SECRET_KEY assertions moved with it —
  // the remaining secret consumers are pinned below.

  describe('Task 3.6 — jwt.strategy.ts: JWT_SECRET_KEY', () => {
    const src = rel('src/services/auth/jwt.strategy.ts');
    it('does not read JWT_SECRET_KEY from AppSettings', () => {
      expect(src).not.toMatch(/appSettingsService\.getValueWithDefault\(['"]JWT_SECRET_KEY['"]/);
    });
    it('reads JWT_SECRET_KEY from SecretsService, through the shared resolver', () => {
      expect(src).toMatch(/resolveJwtSecret\(secretsService\)/);
    });
  });

  describe('Task 3.7 — oidc.strategy.ts: JWT_SECRET_KEY only', () => {
    const src = rel('src/services/auth/oidc.strategy.ts');
    it('does not read JWT_SECRET_KEY from AppSettings', () => {
      expect(src).not.toMatch(/appSettingsService\.getValueWithDefault\(['"]JWT_SECRET_KEY['"]/);
    });
    it('reads JWT_SECRET_KEY from SecretsService, through the shared resolver', () => {
      expect(src).toMatch(/resolveJwtSecret\(this\.secretsService\)/);
    });
    // TASK-944 — and never substitutes a literal. This line used to end
    // `?? 'default-secret-key'`, so one lapsed cache TTL made an OIDC login mint a
    // token signed with a hard-coded string no verifier would ever accept.
    it('never falls back to a hard-coded secret', () => {
      expect(src).not.toMatch(/\?\?\s*['"]default-secret-key['"]/);
    });
    // Surgical-scope invariants: non-secret OIDC fields stay on AppSettings.
    it('keeps OIDC_SCOPES on AppSettings (non-secret)', () => {
      expect(src).toMatch(/appSettingsService\.getValueWithDefault\(['"]OIDC_SCOPES['"]/);
    });
    it('keeps OIDC_CALLBACK_URL on AppSettings (non-secret)', () => {
      expect(src).toMatch(/appSettingsService\.getValueWithDefault\(['"]OIDC_CALLBACK_URL['"]/);
    });
  });

  // Task 3.8 — auth.service.module.ts: OIDC_CLIENT_SECRET — SUPERSEDED, and
  // deliberately not rewritten here. It pinned an INTERMEDIATE state: that the
  // platform OIDC client secret had moved from AppSettings to SecretsService.
  // The platform OIDC tier is now retired outright — identity is a one-tier
  // plane resolved from the tenant's own
  // `TenantIdentityProvider.encryptedSecretRef` — so "reads it from the right
  // place" no longer has a subject.
  //
  // The replacement is STRICTLY STRONGER and lives in
  // `oidc-platform-tier-closed.test.ts`: no production call site reads the key
  // at all, it is not warmed at boot, and no descriptor re-provisions it. Same
  // supersession precedent as `gateway-auth.strategy.ts` above.
});
