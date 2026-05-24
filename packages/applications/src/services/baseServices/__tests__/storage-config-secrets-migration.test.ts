// TASK-302 Phase 3C Tasks 3.9-3.11 — pin S3 + Config secrets migrations.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
function rel(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

describe('Phase 3C — S3 + Config secret migrations', () => {
  describe('Task 3.9 — s3.service.ts: S3_ACCESS_KEY + S3_SECRET_KEY', () => {
    const src = rel('services/baseServices/storage/s3/s3.service.ts');
    it('does not read S3_ACCESS_KEY from AppSettings', () => {
      expect(src).not.toMatch(/appSettingsService\.getValueWithDefault\(['"]S3_ACCESS_KEY['"]/);
    });
    it('does not read S3_SECRET_KEY from AppSettings', () => {
      expect(src).not.toMatch(/appSettingsService\.getValueWithDefault\(['"]S3_SECRET_KEY['"]/);
    });
    it('reads S3_ACCESS_KEY via SecretsService.getSecretSync', () => {
      expect(src).toMatch(/secretsService\??\.getSecretSync\(['"]S3_ACCESS_KEY['"]\)/);
    });
    it('reads S3_SECRET_KEY via SecretsService.getSecretSync', () => {
      expect(src).toMatch(/secretsService\??\.getSecretSync\(['"]S3_SECRET_KEY['"]\)/);
    });
    // Non-secret surface stays on AppSettings:
    it('keeps S3_PUBLIC_BUCKET on AppSettings (non-secret)', () => {
      expect(src).toMatch(/appSettingsService\.getValueWithDefault\(['"]S3_PUBLIC_BUCKET['"]/);
    });
    it('keeps S3_ENDPOINT on AppSettings (non-secret)', () => {
      expect(src).toMatch(/appSettingsService\.getValueWithDefault\(['"]S3_ENDPOINT['"]/);
    });
  });

  describe('Task 3.10/3.11 — config.service.ts: loadVaultSecrets overlays MQTT_PASS + REDIS_PASS', () => {
    const src = rel('services/baseServices/_meta/config/config.service.ts');
    it('loadVaultSecrets is no longer a throw stub', () => {
      expect(src).not.toMatch(/throw new Error\(['"]Vault secrets are not supported yet/);
    });
    it('reads MQTT_PASS + REDIS_PASS via SecretsService.getSecrets', () => {
      expect(src).toMatch(/secretsService\.getSecrets\(\[['"]MQTT_PASS['"],\s*['"]REDIS_PASS['"]\]\)/);
    });
    it('loadConfig() awaits loadVaultSecrets() (overlay after env load)', () => {
      // Confirm the overlay actually runs in the boot path.
      expect(src).toMatch(/await\s+this\.loadVaultSecrets\(\)/);
    });
    // process.env.MQTT_PASS / process.env.REDIS_PASS reads are INTENTIONALLY
    // preserved in loadBaseConfig() as the env-only fallback that
    // loadVaultSecrets() overwrites — the plan's Task 3.12 coverage check
    // explicitly excludes this file for that reason.
    it('keeps env-fallback reads in loadBaseConfig (intentional)', () => {
      expect(src).toMatch(/process\.env\.MQTT_PASS\s*\|\|\s*['"]['"]/);
      expect(src).toMatch(/process\.env\.REDIS_PASS\s*\|\|\s*['"]['"]/);
    });
  });
});
