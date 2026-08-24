// Pin S3 + Config secrets migrations.
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
    /**
     * The operator-facing SQL sample shipped alongside this service told
     * operators to `INSERT` `S3_SECRET_KEY`, `JWT_SECRET_KEY` and
     * `OIDC_CLIENT_SECRET` into `global_settings` as PLAINTEXT rows — the exact
     * posture the migration above removed, and one `seed/06-stt.ts` actively
     * purges (`PURGED_PLAINTEXT_SECRET_KEYS`). A copy-pasteable instruction to
     * put a credential in a plaintext column is a live violation of
     * `09-infrastructure-devops.md` §9.3 M10 however inert the file is: it is
     * read by humans, and it is what they will run.
     */
    it('ships no example SQL that writes a credential into global_settings', () => {
      const example = rel('services/baseServices/storage/s3/examples/minio-example.ts');
      const offenders = ['S3_SECRET_KEY', 'S3_ACCESS_KEY', 'JWT_SECRET_KEY', 'OIDC_CLIENT_SECRET'].filter((key) =>
        new RegExp(`\\('${key}'\\s*,`).test(example),
      );
      expect(offenders, 'Secrets live in Vault (SecretsService / credentialsRef), never in a global_settings row.').toEqual([]);
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
