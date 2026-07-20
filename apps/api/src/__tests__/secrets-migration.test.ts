// TASK-302 Phase 3 - file-based grep tests that pin the Phase 3
// migrations in place. Each test reads the source file and asserts
// the (replaced) process.env line is gone and the SecretsService call
// is present. Faster + more deterministic than spinning up a Nest
// testing module for what is fundamentally a code-shape assertion.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSource(relPath: string): string {
  // Tests run from the apps/api package root; walk up to the worktree.
  return readFileSync(resolve(__dirname, '../../../../', relPath), 'utf8');
}

describe('Phase 3 — secrets migration grep', () => {
  it('main.ts no longer reads process.env.SESSION_SECRET_KEY directly', () => {
    const src = readSource('apps/api/src/main.ts');
    expect(src).not.toMatch(/process\.env\.SESSION_SECRET_KEY/);
    expect(src).toMatch(/secretsService\.getSecret\(['"]SESSION_SECRET_KEY['"]\)/);
  });

  // TASK-307 W2.1 follow-up — boot moved from main.ts into the
  // SecretsModule.forRoot async useFactory (driven by
  // COMMON_SERVICE_WARMUP_KEYS) so NestJS awaits the warmup before
  // any provider that reads the cache synchronously (JwtStrategy,
  // OPENID_CLIENT factory) is instantiated.
  // The previous `secretsService.boot()` call in main.ts ran AFTER
  // NestFactory.create(AppModule) had already wired those providers
  // against an empty cache, which is why the strategy threw on every
  // boot. Pin the new shape here.
  it('CommonServiceModule passes a non-empty warmupKeys list to SecretsModule.forRoot', () => {
    const src = readSource('packages/applications/src/services/baseServices/common.service.module.ts');
    expect(src).toMatch(/COMMON_SERVICE_WARMUP_KEYS/);
    expect(src).toMatch(/JWT_SECRET_KEY/);
    expect(src).toMatch(/SecretsModule\.forRoot\([\s\S]*warmupKeys/);
  });

  it('main.ts no longer calls secretsService.boot() directly (factory handles it)', () => {
    const src = readSource('apps/api/src/main.ts');
    expect(src).not.toMatch(/secretsService\.boot\(/);
    // The placeholder audit (W2.2) is still invoked after the
    // factory has warmed the cache — defense-in-depth.
    expect(src).toMatch(/assertJwtSecretNotPlaceholder\(secretsService\)/);
  });

  it('SecretsModuleOptions exposes warmupKeys so apps can drive the factory boot', () => {
    const src = readSource('packages/applications/src/services/baseServices/_meta/secrets/secrets.module.ts');
    expect(src).toMatch(/warmupKeys\?:\s*string\[\]/);
    expect(src).toMatch(/provide:\s*SecretsService/);
    expect(src).toMatch(/useFactory:\s*async/);
  });
});

// TASK-312 B.9 — apps/api/.env.production must carry NO plaintext secret
// material. All secrets resolve from Vault (warmup keys + dynamic DB creds);
// AppRole credentials arrive via file mounts. Pin the secret-free shape so a
// future edit can't silently reintroduce a plaintext secret.
describe('TASK-312 B.9 — apps/api/.env.production is Vault-backed and secret-free', () => {
  const env = readSource('apps/api/.env.production');

  it('has no inline SESSION_SECRET_KEY value (resolved from Vault)', () => {
    expect(env).not.toMatch(/^SESSION_SECRET_KEY=.+/m);
  });

  it('has no inline REDIS_PASS value (resolved from Vault)', () => {
    expect(env).not.toMatch(/^REDIS_PASS=.+/m);
  });

  it('embeds no DB password in a connection string', () => {
    // No `postgres://user:password@host` style URLs.
    expect(env).not.toMatch(/postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@/);
  });

  it('is wired for Vault: provider, file-based AppRole creds, dynamic DB creds, audit path', () => {
    expect(env).toMatch(/^SECRETS_PROVIDER=vault$/m);
    expect(env).toMatch(/^VAULT_ROLE_ID_FILE=\S+/m);
    expect(env).toMatch(/^VAULT_WRAPPED_SECRET_ID_FILE=\S+/m);
    expect(env).toMatch(/^PG_DYNAMIC_CREDS=true$/m);
    expect(env).toMatch(/^VAULT_AUDIT_LOG_PATH=\S+/m);
  });
});
