// File-based grep tests that pin secrets-handling
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

  // Boot moved from main.ts into the
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
    // The placeholder audit is still invoked after the
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

// apps/api/.env.prod must carry NO plaintext secret
// material. All secrets resolve from Vault (warmup keys + dynamic DB creds);
// AppRole credentials arrive via file mounts. Pin the secret-free shape so a
// future edit can't silently reintroduce a plaintext secret.
//
// This file now also carries the K8s-posture section (relocated
// from the monorepo-root `.env.production`), whose keys are declared empty
// with a trailing inline comment (`KEY=                # explanation`) —
// the regexes below require a NON-whitespace character immediately after
// `=` so an empty-with-trailing-comment line does not false-positive as a
// real inlined secret.
describe('apps/api/.env.prod is Vault-backed and secret-free', () => {
  const env = readSource('apps/api/.env.prod');

  it('has no inline SESSION_SECRET_KEY value (resolved from Vault)', () => {
    expect(env).not.toMatch(/^SESSION_SECRET_KEY=\S/m);
  });

  it('has no inline REDIS_PASS value (resolved from Vault)', () => {
    expect(env).not.toMatch(/^REDIS_PASS=\S/m);
  });

  it('embeds no DB password in a connection string', () => {
    // No `postgres://user:password@host` style URLs. A masked example
    // (`user:****@host`, an all-asterisk placeholder) is documentation, not
    // a leaked credential — the negative lookahead excludes only that shape.
    expect(env).not.toMatch(/postgres(?:ql)?:\/\/[^:\s/]+:(?!\*+@)[^@\s]+@/);
  });

  it('is wired for Vault: provider, file-based AppRole creds, dynamic DB creds, audit path', () => {
    expect(env).toMatch(/^SECRETS_PROVIDER=vault$/m);
    expect(env).toMatch(/^VAULT_ROLE_ID_FILE=\S+/m);
    expect(env).toMatch(/^VAULT_WRAPPED_SECRET_ID_FILE=\S+/m);
    expect(env).toMatch(/^PG_DYNAMIC_CREDS=true$/m);
    expect(env).toMatch(/^VAULT_AUDIT_LOG_PATH=\S+/m);
  });
});
