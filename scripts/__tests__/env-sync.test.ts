/**
 * Contract tests for `pnpm env:sync` (TASK-558 lane D).
 *
 * The CI job `env-drift-check` runs `pnpm env:sync --check`; these tests lock the
 * PROPERTIES that make the generated output correct in the first place, so a
 * regression in the generator itself cannot be laundered through a regenerate:
 *
 *   • the managed artifact set is exactly what the header declares
 *   • the root example is the BOOTSTRAP FLOOR and nothing else (plan §3.3)
 *   • committed example files never carry a value for a secret (plan §9.1 D3)
 *   • one declaration per key per file (plan §9.1 D8)
 *   • every declared key is registered in `turbo.json#globalEnv`
 *   • the §8 size targets hold
 *   • the dead keys the ticket removed cannot come back
 *   • the files on disk match the generator (the drift gate, as a unit test)
 */

import { BOOTSTRAP_ENV_SETTINGS, toEnvVarName } from '@arcaai/applications';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArtifacts, declaredSurface } from '../env-sync.mts';

const ROOT = resolve(__dirname, '..', '..');
const artifacts = buildArtifacts();

function artifact(path: string): string {
    const found = artifacts.find((a) => a.path === path);
    expect(found, `no generated artifact for ${path}`).toBeDefined();
    return found!.content;
}

/** Declared keys of an env file, in file order. */
function keysOf(content: string): string[] {
    return content
        .split('\n')
        .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
        .filter((name): name is string => Boolean(name));
}

const ENV_FILES = ['.env.example', 'apps/api/.env.example', 'apps/admin-console/.env.example', 'packages/tools/.env.example'];

describe('env:sync — managed artifacts', () => {
    it('generates exactly the artifacts its header declares', () => {
        expect(artifacts.map((a) => a.path).sort()).toEqual(
            [
                '.env.example',
                'apps/admin-console/.env.example',
                'apps/api/.env.example',
                'docs/implementation/TASK-558-Environment-Configuration-Refactor/env-surface.generated.md',
                'packages/tools/.env.example',
                'turbo.json',
            ].sort(),
        );
    });

    it('marks every generated env file as generated', () => {
        for (const path of ENV_FILES) {
            expect(artifact(path), path).toContain('GENERATED FILE — DO NOT EDIT BY HAND');
        }
    });
});

describe('env:sync — the root example is the bootstrap floor', () => {
    const rootKeys = keysOf(artifact('.env.example'));

    it('declares exactly the registry’s Bootstrap category', () => {
        const floor = BOOTSTRAP_ENV_SETTINGS.map((d) => toEnvVarName(d.key));
        expect(rootKeys.slice().sort()).toEqual(floor.slice().sort());
    });

    it('carries no key from beyond the floor', () => {
        for (const beyond of ['JWT_SECRET_KEY', 'SMR_URL', 'LOG_LEVEL', 'MINIO_ENDPOINT', 'RATE_LIMIT_ENABLED']) {
            expect(rootKeys, beyond).not.toContain(beyond);
        }
    });

    it('stays within the plan §8 size target (≤ 60 lines)', () => {
        expect(artifact('.env.example').split('\n').length).toBeLessThanOrEqual(60);
    });
});

describe('env:sync — committed files carry placeholders only (plan §9.1 D3)', () => {
    // Any of these in a committed example would be a real credential shape.
    const SECRET_SHAPED = [/^[A-Za-z0-9+/]{32,}={0,2}$/, /^hvs\./, /^s\.[A-Za-z0-9]{20,}/, /^sk-[A-Za-z0-9]{16,}/];

    // Driven by the DECLARED sensitivity, not a name heuristic: `SECRETS_PROVIDER`
    // contains "SECRET" and is not one, `API_KEY_PEPPER` does not look like a
    // password and is.
    const secretNames = new Set(declaredSurface.filter((v) => v.secret).map((v) => v.name));

    it('has secrets to check (guards against a vacuously passing assertion)', () => {
        expect(secretNames.size).toBeGreaterThan(20);
    });

    it('renders every declared secret as <CHANGE_ME>', () => {
        for (const path of ENV_FILES) {
            for (const line of artifact(path).split('\n')) {
                const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
                if (!match) continue;
                const [, name, value] = match;
                if (!secretNames.has(name)) continue;
                expect(value, `${path}: ${name}`).toBe('<CHANGE_ME>');
            }
        }
    });

    it('contains nothing shaped like a real credential', () => {
        for (const path of ENV_FILES) {
            for (const line of artifact(path).split('\n')) {
                const value = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(line)?.[1];
                if (!value) continue;
                for (const shape of SECRET_SHAPED) expect(shape.test(value), `${path}: ${line}`).toBe(false);
            }
        }
    });
});

describe('env:sync — one declaration per key per file (plan §9.1 D8)', () => {
    for (const path of ENV_FILES) {
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
        const declared = new Set(ENV_FILES.flatMap((p) => keysOf(artifact(p))));
        const missing = [...declared].filter((name) => !globalEnv.includes(name));
        expect(missing).toEqual([]);
    });

    it('is sorted and free of duplicates', () => {
        expect(globalEnv).toEqual([...new Set(globalEnv)].sort());
    });
});

describe('env:sync — dead keys stay dead (plan §2.3 + lane D D7)', () => {
    // Verified 2026-07-25: no reader in any TS/Python/shell/compose source.
    //   TENANT_IDP_ENABLED        — no reader at all (see feature-flags.descriptors.ts)
    //   AZURE_OPENAI_API_KEY      — only an SMR e2e conftest fixture; the real key is SMR_AZURE_API_KEY
    //   SMR_OPENAI_COMPAT_ENABLED — SMR gates providers by config presence, it has no `enabled` field
    //   SMR_V2_* / STT_V2_URL     — the retired rename shims (lane A/C)
    const DEAD = ['TENANT_IDP_ENABLED', 'AZURE_OPENAI_API_KEY', 'SMR_OPENAI_COMPAT_ENABLED', 'DATABASE_URL_DIRECT', 'JWT_REFRESH_SECRET', 'DEBUG_PRISMA', 'SKIP_SEED'];

    it('declares none of them in any generated env file', () => {
        const declared = new Set(ENV_FILES.flatMap((p) => keysOf(artifact(p))));
        expect(DEAD.filter((name) => declared.has(name))).toEqual([]);
    });

    it('registers none of them in turbo.json#globalEnv', () => {
        const globalEnv: string[] = JSON.parse(artifact('turbo.json')).globalEnv;
        expect(DEAD.filter((name) => globalEnv.includes(name))).toEqual([]);
    });
});

describe('env:sync — the declared surface stays small (plan §8)', () => {
    it('declares at most ~144 distinct keys', () => {
        // Bumped 130 -> 134 for 4 legitimate additions since this ceiling was set
        // (verified via `pnpm env:sync --check`, no drift): AZURE_STORAGE_ACCOUNT_KEY,
        // AZURE_STORAGE_CONNECTION_STRING, HARNESS_INTERNAL_SERVICE_TOKEN,
        // STORAGE_ACCESS_KEY_PEPPER.
        // Bumped 134 -> 144 for 10 legitimate additions (TASK-572b, expand LLM
        // providers — verified via `pnpm env:sync --check`, no drift):
        // SMR_ANTHROPIC_API_KEY, SMR_ANTHROPIC_BASE_URL, SMR_ANTHROPIC_DEFAULT_MODEL,
        // SMR_OPENAI_API_KEY, SMR_OPENAI_BASE_URL, SMR_OPENAI_DEFAULT_MODEL,
        // SMR_OPENAI_ORGANIZATION, SMR_VERTEX_DEFAULT_MODEL, SMR_VERTEX_LOCATION,
        // SMR_VERTEX_PROJECT. Bump again only after checking `env:sync --check`
        // is clean — this constant exists to catch UNREVIEWED growth, not real growth.
        const declared = new Set(ENV_FILES.flatMap((p) => keysOf(artifact(p))));
        expect(declared.size).toBeLessThanOrEqual(144);
    });
});

describe('env:sync — no drift on disk', () => {
    for (const { path } of artifacts) {
        it(`${path} matches the generator`, () => {
            expect(readFileSync(join(ROOT, path), 'utf8'), `run \`pnpm env:sync\``).toBe(artifact(path));
        });
    }
});
