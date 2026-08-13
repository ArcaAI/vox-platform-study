// (J4) — the three secrets that MUST NEVER move into Vault.
//
// `VAULT_SECRET_ID`, `VAULT_WRAPPED_SECRET_ID` and `VAULT_DB_ADMIN_PASS` are the
// credentials used *to reach* Vault (and the one Vault itself uses to reach
// PostgreSQL). Storing them in Vault is circular: the process would need the
// secret in order to fetch the secret. They are the irreducible bootstrap floor
// and the only secrets a deployed host env or a CI variable should
// ever carry.
//
// This is not a style preference — "finishing the migration" by reclassifying
// them to `vault-kv` produces a deadlocked deployment that cannot boot at all,
// and the mistake looks like tidiness. So it is asserted, in all three ways it
// could be made:
//
//   1. reclassifying the descriptor,
//   2. adding the name to the seeding script's source list, and
//   3. fetching the value through `SecretsService` at runtime.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { BOOTSTRAP_ENV_SETTINGS, PLATFORM_SECRET_SETTINGS, toEnvVarName } from '@arcaai/applications';

/** The circular three. */
const BOOTSTRAP_ONLY_SECRETS = ['VAULT_SECRET_ID', 'VAULT_WRAPPED_SECRET_ID', 'VAULT_DB_ADMIN_PASS'] as const;

const REPO_ROOT = resolve(__dirname, '../../../../..');

describe('the Vault-reaching credentials stay in env, permanently', () => {
  const byName = new Map(BOOTSTRAP_ENV_SETTINGS.map((d) => [toEnvVarName(d.key), d]));

  it.each(BOOTSTRAP_ONLY_SECRETS)('%s is declared at tier `env`', (name) => {
    const descriptor = byName.get(name);
    expect(descriptor, `${name} must be declared in BOOTSTRAP_ENV_SETTINGS`).toBeDefined();
    expect(descriptor!.tier).toBe('env');
  });

  it('none is a vault-kv descriptor, so vault-seed-secrets.sh can never seed it', () => {
    // The seeding script derives its key list from exactly this array; a name
    // that is absent here cannot be written to Vault by it.
    const seedable = new Set(PLATFORM_SECRET_SETTINGS.filter((d) => d.tier === 'vault-kv').map((d) => toEnvVarName(d.key)));
    expect(BOOTSTRAP_ONLY_SECRETS.filter((name) => seedable.has(name))).toEqual([]);
  });

  it('no production source resolves one through SecretsService', () => {
    const rx = new RegExp(`getSecret(Sync|Optional|Json)?\\(\\s*'(${BOOTSTRAP_ONLY_SECRETS.join('|')})'`);
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
          walk(fullPath);
          continue;
        }
        const relativePath = fullPath
          .slice(REPO_ROOT.length + 1)
          .split(sep)
          .join('/');
        if (!relativePath.endsWith('.ts') || relativePath.endsWith('.d.ts')) continue;
        if (relativePath.includes('/__tests__/') || relativePath.endsWith('.test.ts')) continue;
        readFileSync(fullPath, 'utf8')
          .split(/\r?\n/)
          .forEach((line, index) => {
            if (rx.test(line)) offenders.push(`${relativePath}:${index + 1}`);
          });
      }
    };

    walk(resolve(REPO_ROOT, 'apps/api/src'));
    walk(resolve(REPO_ROOT, 'packages/applications/src'));

    expect(
      offenders,
      'These credentials are how the process REACHES Vault. Reading them back OUT of Vault is circular — ' +
        'they must come from the host environment (or a *_FILE mount), which is what SecretsModule.forRoot already does.',
    ).toEqual([]);
  });

  it('SecretsModule reads them from the environment directly, not through the provider it is building', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'packages/applications/src/services/baseServices/_meta/secrets/secrets.module.ts'), 'utf8');
    // The AppRole pair is resolved by readEnvOrFile()/requireEnvOrFile() while
    // CONSTRUCTING the Vault provider — i.e. strictly before any Vault read.
    expect(source).toContain("readEnvOrFile('VAULT_WRAPPED_SECRET_ID')");
    expect(source).toContain("readEnvOrFile('VAULT_SECRET_ID')");
  });
});
