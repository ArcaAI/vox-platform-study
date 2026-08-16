/**
 * Contract tests for `pnpm env:sync`.
 *
 * The CI job `env-drift-check` runs `pnpm env:sync --check`; these tests lock the
 * PROPERTIES that make the generated output correct in the first place, so a
 * regression in the generator itself cannot be laundered through a regenerate:
 *
 *   • the managed artifact set is exactly what the header declares
 *   • the root example is the BOOTSTRAP FLOOR and nothing else
 *   • committed example files never carry a value for a secret
 *   • one declaration per key per file
 *   • every declared key is registered in `turbo.json#globalEnv`
 *   • the size targets hold
 *   • the dead keys that were removed cannot come back
 *   • the files on disk match the generator (the drift gate, as a unit test)
 */

import { BOOTSTRAP_ENV_SETTINGS, toEnvVarName } from '@arcaai/applications';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArtifacts, declaredSurface, getBootstrapFloorContent } from '../env-sync.mts';

const ROOT = resolve(__dirname, '..', '..');
const artifacts = buildArtifacts();

function artifact(path: string): string {
  const found = artifacts.find((a) => a.path === path);
  expect(found, `no generated artifact for ${path}`).toBeDefined();
  return found!.content;
}

/** Declared (ACTIVE) keys of an env file, in file order — lines commented out
 * by `.env.sample`'s de-duplication (`# [duplicate key, ...] # KEY=value`)
 * don't match, by design (they aren't a second active declaration). */
function keysOf(content: string): string[] {
  return content
    .split('\n')
    .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

/** The TS-declared-surface files — root floor (via `getBootstrapFloorContent`,
 * no longer a standalone artifact) + the 3 generated per-app files.
 * Used by checks specific to that surface (turbo.json#globalEnv registration,
 * dead-keys-in-turbo, the size ceiling) — `.env.sample` deliberately also
 * carries the 6 Python services' own keys, which are NOT part of this surface
 * and must not be pulled into those TS-specific assertions. */
const ENV_FILES = ['apps/api/.env.sample', 'apps/admin-console/.env.sample', 'packages/tools/.env.sample'];

/** Every committed, generated artifact that should read like a normal env
 * file — the 3 above plus the consolidated `.env.sample`. Used by checks that
 * legitimately apply file-wide (generated banner, placeholders-only, no two
 * active declarations of one key). */
const GENERATED_ENV_ARTIFACTS = [...ENV_FILES, '.env.sample'];

/** The full TS-declared surface: bootstrap floor + the 3 generated per-app
 * files. The floor is no longer a standalone artifact, so it's
 * pulled in via `getBootstrapFloorContent()` rather than `ENV_FILES`. */
function declaredTsSurfaceKeys(): Set<string> {
  return new Set([...keysOf(getBootstrapFloorContent()), ...ENV_FILES.flatMap((p) => keysOf(artifact(p)))]);
}

describe('env:sync — managed artifacts', () => {
  it('generates exactly the artifacts its header declares', () => {
    expect(artifacts.map((a) => a.path).sort()).toEqual(
      [
        '.env.sample',
        'apps/admin-console/.env.sample',
        'apps/api/.env.sample',
        'env-surface.generated.md',
        'packages/tools/.env.sample',
        'turbo.json',
      ].sort(),
    );
  });

  it('marks every generated env file as generated', () => {
    for (const path of GENERATED_ENV_ARTIFACTS) {
      expect(artifact(path), path).toContain('GENERATED FILE — DO NOT EDIT BY HAND');
    }
  });
});

describe('env:sync — the bootstrap floor (.env.sample first section) carries only the floor', () => {
  // The floor is no longer its own file (`.env.example`) — it's
  // `.env.sample`'s first section, exported directly so this stays testable.
  const rootKeys = keysOf(getBootstrapFloorContent());

  it('declares exactly the registry’s Bootstrap category', () => {
    const floor = BOOTSTRAP_ENV_SETTINGS.map((d) => toEnvVarName(d.key));
    expect(rootKeys.slice().sort()).toEqual(floor.slice().sort());
  });

  it('carries no key from beyond the floor', () => {
    for (const beyond of ['JWT_SECRET_KEY', 'TEXT_URL', 'LOG_LEVEL', 'MINIO_ENDPOINT', 'RATE_LIMIT_ENABLED']) {
      expect(rootKeys, beyond).not.toContain(beyond);
    }
  });

  it('stays within the size target (≤ 60 lines)', () => {
    expect(getBootstrapFloorContent().split('\n').length).toBeLessThanOrEqual(60);
  });
});

describe('env:sync — committed files carry placeholders only', () => {
  // Any of these in a committed example would be a real credential shape.
  const SECRET_SHAPED = [/^[A-Za-z0-9+/]{32,}={0,2}$/, /^hvs\./, /^s\.[A-Za-z0-9]{20,}/, /^sk-[A-Za-z0-9]{16,}/];

  // Driven by the DECLARED sensitivity, not a name heuristic: `SECRETS_PROVIDER`
  // contains "SECRET" and is not one, `API_KEY_PEPPER` does not look like a
  // password and is.
  const secretNames = new Set(declaredSurface.filter((v) => v.secret).map((v) => v.name));

  it('has secrets to check (guards against a vacuously passing assertion)', () => {
    expect(secretNames.size).toBeGreaterThan(20);
  });

  it('renders every declared secret as CHANGE_ME', () => {
    for (const path of GENERATED_ENV_ARTIFACTS) {
      for (const line of artifact(path).split('\n')) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (!match) continue;
        const [, name, value] = match;
        if (!secretNames.has(name)) continue;
        expect(value, `${path}: ${name}`).toBe('CHANGE_ME');
      }
    }
  });

  it('contains nothing shaped like a real credential', () => {
    for (const path of GENERATED_ENV_ARTIFACTS) {
      for (const line of artifact(path).split('\n')) {
        const value = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(line)?.[1];
        if (!value) continue;
        for (const shape of SECRET_SHAPED) expect(shape.test(value), `${path}: ${line}`).toBe(false);
      }
    }
  });

  // `sampleValue` (a ready-to-use local-dev value, distinct
  // from `default` — see registry.types.ts) renders into `.env.sample`, but a
  // secret's `CHANGE_ME` redaction still wins even if one were mistakenly set
  // (the registry itself refuses to assemble that combination — belt-and-suspenders).
  it('never lets a sampleValue override a secret redaction', () => {
    for (const v of declaredSurface) {
      if (v.secret) expect(v.sampleValue, v.name).toBeUndefined();
    }
  });

  it('renders a fixed local-dev sampleValue where one is declared', () => {
    const sampled = declaredSurface.filter((v) => !v.secret && v.sampleValue !== undefined);
    expect(sampled.length, 'no sampleValue-bearing keys found — guards a vacuous pass').toBeGreaterThan(0);
    for (const v of sampled) {
      const found = GENERATED_ENV_ARTIFACTS.map((path) => [path, artifact(path)] as const).find(([, content]) => new RegExp(`^${v.name}=`, 'm').test(content));
      expect(found, `${v.name} not rendered in any generated artifact`).toBeDefined();
      const [path, content] = found!;
      const match = new RegExp(`^${v.name}=(.*)$`, 'm').exec(content);
      expect(match?.[1], `${path}: ${v.name}`).toBe(String(v.sampleValue));
    }
  });
});

describe('env:sync — one ACTIVE declaration per key per file', () => {
  // `.env.sample` deliberately carries commented-out duplicates (its own
  // de-duplication) — `keysOf()` only matches ACTIVE (non-commented)
  // lines, so this still correctly asserts zero active duplicates there too,
  // the exact property that guards against the "silent last-wins" defect.
  for (const path of GENERATED_ENV_ARTIFACTS) {
    it(`${path} declares no key twice`, () => {
      const keys = keysOf(artifact(path));
      const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
      expect(duplicates).toEqual([]);
    });
  }
});

describe('env:sync — turbo.json#globalEnv', () => {
  const globalEnv: string[] = JSON.parse(artifact('turbo.json')).globalEnv;

  it('registers every declared key', () => {
    const declared = declaredTsSurfaceKeys();
    const missing = [...declared].filter((name) => !globalEnv.includes(name));
    expect(missing).toEqual([]);
  });

  it('is sorted and free of duplicates', () => {
    expect(globalEnv).toEqual([...new Set(globalEnv)].sort());
  });
});

describe('env:sync — dead keys stay dead', () => {
  // Verified 2026-07-25: no reader in any TS/Python/shell/compose source.
  //   TENANT_IDP_ENABLED        — no reader at all (see feature-flags.descriptors.ts)
  //   AZURE_OPENAI_API_KEY      — only an SMR e2e conftest fixture; the real key is TEXT_AZURE_API_KEY
  //   TEXT_OPENAI_COMPAT_ENABLED — SMR gates providers by config presence, it has no `enabled` field
  //   TEXT_V2_* / STT_V2_URL     — the retired rename shims
  const DEAD = [
    'TENANT_IDP_ENABLED',
    'AZURE_OPENAI_API_KEY',
    'TEXT_OPENAI_COMPAT_ENABLED',
    'DATABASE_URL_DIRECT',
    'JWT_REFRESH_SECRET',
    'DEBUG_PRISMA',
    'SKIP_SEED',
  ];

  it('declares none of them in any generated env file', () => {
    const declared = declaredTsSurfaceKeys();
    expect(DEAD.filter((name) => declared.has(name))).toEqual([]);
  });

  it('registers none of them in turbo.json#globalEnv', () => {
    const globalEnv: string[] = JSON.parse(artifact('turbo.json')).globalEnv;
    expect(DEAD.filter((name) => globalEnv.includes(name))).toEqual([]);
  });
});

describe('env:sync — the declared surface stays small', () => {
  it('declares at most ~144 distinct keys', () => {
    // Bumped 130 -> 134 for 4 legitimate additions since this ceiling was set
    // (verified via `pnpm env:sync --check`, no drift): AZURE_STORAGE_ACCOUNT_KEY,
    // AZURE_STORAGE_CONNECTION_STRING, HARNESS_INTERNAL_SERVICE_TOKEN,
    // STORAGE_ACCESS_KEY_PEPPER.
    // Bumped 134 -> 144 for 10 legitimate additions (expand LLM
    // providers — verified via `pnpm env:sync --check`, no drift):
    // TEXT_ANTHROPIC_API_KEY, TEXT_ANTHROPIC_BASE_URL, TEXT_ANTHROPIC_DEFAULT_MODEL,
    // TEXT_OPENAI_API_KEY, TEXT_OPENAI_BASE_URL, TEXT_OPENAI_DEFAULT_MODEL,
    // TEXT_OPENAI_ORGANIZATION, TEXT_VERTEX_DEFAULT_MODEL, TEXT_VERTEX_LOCATION,
    // TEXT_VERTEX_PROJECT. Bump again only after checking `env:sync --check`
    // is clean — this constant exists to catch UNREVIEWED growth, not real growth.
    // Bumped 144 -> 145 for 1 legitimate addition (secrets rewarm interval —
    // verified via `pnpm env:sync --check`, no drift): SECRETS_REWARM_INTERVAL_SEC.
    // Bumped 145 -> 147 for 2 legitimate additions (TASK-722's exposure-plane
    // kill-switches — verified via `pnpm env:sync --check`, no drift):
    // WORKFLOW_EXPOSURE_ENABLED, WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS.
    // Bumped 147 -> 148 for 1 legitimate addition (TASK-727's dedicated
    // webhook-signing encryption key, deliberately NOT reusing API_KEY_PEPPER
    // — verified via `pnpm env:sync`, no drift): WEBHOOK_SECRET_PEPPER.
    const declared = declaredTsSurfaceKeys();
    expect(declared.size).toBeLessThanOrEqual(148);
  });
});

describe('env:sync — no drift on disk', () => {
  for (const { path } of artifacts) {
    it(`${path} matches the generator`, () => {
      expect(readFileSync(join(ROOT, path), 'utf8'), `run \`pnpm env:sync\``).toBe(artifact(path));
    });
  }
});
