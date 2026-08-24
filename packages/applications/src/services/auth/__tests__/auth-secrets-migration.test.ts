// Pin auth-strategy secret migrations.
//
// Each strategy/factory MUST:
//   - NOT call appSettingsService.getValueWithDefault('<SECRET>', …)
//   - read the secret via SecretsService.getSecret(Sync|Optional)('<SECRET>')
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
    it('reads JWT_SECRET_KEY from SecretsService', () => {
      expect(src).toMatch(/secretsService\.getSecretSync\(['"]JWT_SECRET_KEY['"]\)/);
    });
  });

  describe('Task 3.7 — oidc.strategy.ts: JWT_SECRET_KEY only', () => {
    const src = rel('src/services/auth/oidc.strategy.ts');
    it('does not read JWT_SECRET_KEY from AppSettings', () => {
      expect(src).not.toMatch(/appSettingsService\.getValueWithDefault\(['"]JWT_SECRET_KEY['"]/);
    });
    it('reads JWT_SECRET_KEY from SecretsService', () => {
      expect(src).toMatch(/secretsService\.getSecretSync\(['"]JWT_SECRET_KEY['"]\)/);
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
