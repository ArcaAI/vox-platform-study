// TASK-302 Phase 3B Tasks 3.5–3.8 — pin auth-strategy secret migrations.
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
  describe('Task 3.5 — gateway-auth.strategy.ts: JWT_SECRET_KEY', () => {
    const src = rel('src/services/auth/gateway-auth.strategy.ts');
    it('does not read JWT_SECRET_KEY from AppSettings', () => {
      expect(src).not.toMatch(/appSettingsService\.getValueWithDefault\(['"]JWT_SECRET_KEY['"]/);
    });
    it('reads JWT_SECRET_KEY from SecretsService', () => {
      expect(src).toMatch(/secretsService\.getSecretSync\(['"]JWT_SECRET_KEY['"]\)/);
    });
  });

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

  describe('Task 3.8 — auth.service.module.ts: OIDC_CLIENT_SECRET', () => {
    const src = rel('src/services/auth/auth.service.module.ts');
    it('does not read OIDC_CLIENT_SECRET from AppSettings', () => {
      expect(src).not.toMatch(/appSettingsService\.getValueWithDefault\(['"]OIDC_CLIENT_SECRET['"]/);
    });
    it('reads OIDC_CLIENT_SECRET from SecretsService', () => {
      expect(src).toMatch(/secretsService\.getSecretSync\(['"]OIDC_CLIENT_SECRET['"]\)/);
    });
    it('keeps OIDC_DISCOVERY_URL on AppSettings (non-secret)', () => {
      // Tolerate the multi-line call site `getValueWithDefault(\n 'OIDC_DISCOVERY_URL', ...`
      expect(src).toMatch(/appSettingsService\.getValueWithDefault\(\s*['"]OIDC_DISCOVERY_URL['"]/);
    });
    it('keeps OIDC_CLIENT_ID on AppSettings (non-secret)', () => {
      expect(src).toMatch(/appSettingsService\.getValueWithDefault\(['"]OIDC_CLIENT_ID['"]/);
    });
  });
});
