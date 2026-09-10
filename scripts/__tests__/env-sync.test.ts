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

import { BOOTSTRAP_ENV_SETTINGS, HOPE_SETTINGS_REGISTRY, toEnvVarName } from '@arcaai/applications';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArtifacts, declaredSurface, DOCUMENTATION_SURFACES, getBootstrapFloorContent, scanSourceForTests, scanTypeScriptReads } from '../env-sync.mts';

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
        // the six Python samples are GENERATED now, not
        // inlined verbatim. That inlining is why 243 of 297 Python env vars were
        // invisible to this gate — the generator could not validate what it only
        // copied. Adding them here is the point of that change, not drift.
        'apps/guardrail/.env.sample',
        'apps/harness/.env.sample',
        'apps/nlp/.env.sample',
        'apps/stt/.env.sample',
        'apps/text/.env.sample',
        'apps/tts/.env.sample',
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

describe('env:sync — rendered documentation is not a read', () => {
  /**
   * The admin console's developer portal ships copy-pasteable SDK snippets as
   * `.tsx` template literals. The names inside them are the API CONSUMER's own
   * (`process.env.HOPE_API_KEY` in THEIR service) — this repo never reads them,
   * so they must not enter the turbo cache key, and must not be documented as
   * part of HOPE's platform env surface. See `DOCUMENTATION_SURFACES`.
   *
   * `HOPE_API_BASE_URL` / `HOPE_API_TOKEN` predate the portal and ARE genuine
   * declared keys — the assertion below is deliberately exact, not a
   * `HOPE_*` prefix sweep, so it cannot swallow them. `HOPE_API_KEY` left this
   * list with TASK-931: `vox-codegen`'s business-plane mode reads it as the
   * fallback for `--api-key` (`packages/vox-codegen/src/cli.ts`), the same way
   * the CLI already reads `HOPE_API_TOKEN` — a real member expression, not a
   * rendered snippet.
   */
  const CONSUMER_SNIPPET_ONLY = ['HOPE_API_URL', 'HOPE_SA_CLIENT_ID', 'HOPE_SA_CLIENT_SECRET', 'HOPE_TENANT_ID'];

  it('registers no snippet-only consumer variable in turbo.json#globalEnv', () => {
    const globalEnv: string[] = JSON.parse(artifact('turbo.json')).globalEnv;
    expect(CONSUMER_SNIPPET_ONLY.filter((name) => globalEnv.includes(name))).toEqual([]);
  });

  it('does not register names that appear only inside rendered snippets', () => {
    const found = scanTypeScriptReads();
    expect(CONSUMER_SNIPPET_ONLY.filter((name) => found.has(name))).toEqual([]);
  });

  it('STILL detects a genuine read written as code in a documentation surface', () => {
    // The exclusion blanks TEMPLATE-LITERAL contents, not whole files. That
    // distinction is the only safety net here: `eslint-config-turbo` — whose
    // `turbo/no-undeclared-env-vars` normally catches an undeclared read — is
    // spread into `flat/core.js` but NOT into `flat/next.js`, which
    // `apps/admin-console` uses. `eslint --print-config` on a console file
    // resolves zero `turbo/*` rules, so a whole-file skip would let a real read
    // silently miss the turbo cache key with nothing to catch it.
    const documentationSurface = DOCUMENTATION_SURFACES[0];
    const sourceWithBoth = [
      'const SNIPPET = `const c = process.env.SNIPPET_ONLY_VAR;`;',
      'export const real = process.env.GENUINE_READ_VAR;',
    ].join('\n');

    const scanned = scanSourceForTests(sourceWithBoth, `${documentationSurface}probe.ts`);

    expect(scanned.has('SNIPPET_ONLY_VAR'), 'a name inside a rendered snippet must NOT register').toBe(false);
    expect(scanned.has('GENUINE_READ_VAR'), 'a real member expression MUST still register').toBe(true);
  });

  it('excludes directories only, so the skip can never widen to a single file', () => {
    for (const dir of DOCUMENTATION_SURFACES) {
      expect(dir.endsWith('/'), `${dir} must be a directory prefix, not a file`).toBe(true);
    }
  });

  it('still detects the bracket form of a genuine read', () => {
    // `packages/applications/src/common/authenticateJwt.ts` reads
    // `process.env['JWT_SECRET_KEY']`. Stripping string literals wholesale to
    // hide the doc snippets would lose this — the exclusion is scoped to
    // documentation trees precisely so it cannot.
    expect(scanTypeScriptReads().has('JWT_SECRET_KEY')).toBe(true);
  });
});

/**
 * TASK-940 Lane 1a — `ConfigService` reads are reads.
 *
 * `LiveDocumentationService` read 18 distinct env names through
 * `this.configService.get('NAME')` and through two local helpers that take the
 * key as their SECOND argument. Neither shape contains the token `process.env`,
 * so the scanner could not see any of them and `turbo.json#globalEnv` declared
 * none of them — while `env:sync --check` reported OK. A gate that cannot fail
 * is the defect; these tests are what make it able to fail.
 */
describe('env:sync — ConfigService reads (TASK-940)', () => {
  it('detects `configService.get(\'NAME\')`, with or without a type argument', () => {
    const source = [
      "const a = this.configService.get('LIVE_DOC_PROBE_PLAIN');",
      "const b = this.configService.get<string>('LIVE_DOC_PROBE_TYPED');",
      "const c = configService.get('LIVE_DOC_PROBE_BARE');",
    ].join('\n');

    const found = scanSourceForTests(source, 'packages/applications/src/probe.ts');

    expect(found.has('LIVE_DOC_PROBE_PLAIN')).toBe(true);
    expect(found.has('LIVE_DOC_PROBE_TYPED')).toBe(true);
    expect(found.has('LIVE_DOC_PROBE_BARE')).toBe(true);
  });

  it('detects a read through a helper that takes the key as its SECOND argument', () => {
    // `readNumericEnv(this.configService, 'LIVE_DOC_SEGMENT_THRESHOLD')` — the
    // existing TS_ENV_HELPERS list only matched the key as the FIRST argument,
    // which is why these seven stayed invisible.
    const source = [
      "this.a = readNumericEnv(this.configService, 'LIVE_DOC_PROBE_NUMERIC');",
      "this.b = readBooleanEnv(this.configService, 'LIVE_DOC_PROBE_BOOLEAN');",
    ].join('\n');

    const found = scanSourceForTests(source, 'packages/applications/src/probe.ts');

    expect(found.has('LIVE_DOC_PROBE_NUMERIC')).toBe(true);
    expect(found.has('LIVE_DOC_PROBE_BOOLEAN')).toBe(true);
  });

  it('does NOT mistake a dotted settings key for an env name', () => {
    // The settings registry's own keys flow through the same `.get()`-shaped
    // calls in places. An env name is SCREAMING_SNAKE by construction, so the
    // `[A-Z][A-Z0-9_]+` filter is what keeps a control-plane key out of the
    // turbo cache key.
    const source = [
      "const a = this.effectiveSettings.get('agentic.context.liveFlush.idleMs');",
      "const b = this.configService.get('agentic.context.transcript.mode');",
    ].join('\n');

    expect([...scanSourceForTests(source, 'packages/applications/src/probe.ts')]).toEqual([]);
  });

  it('does NOT treat an unrelated `.get()` receiver as a config read', () => {
    // A Map/cache/Redis `.get('SOME_KEY')` is not a configuration input, and
    // declaring one would hash an unrelated value into every task's cache key.
    const source = [
      "const a = this.sessions.get('NOT_A_CONFIG_KEY');",
      "const b = cache.get('ALSO_NOT_CONFIG');",
      "const c = headers.get('X_REQUEST_ID');",
    ].join('\n');

    expect([...scanSourceForTests(source, 'packages/applications/src/probe.ts')]).toEqual([]);
  });

  it('sees the real live-documentation reads in the repo, by both shapes', () => {
    const found = scanTypeScriptReads();
    // direct `.get()` — the two surviving members of that shape. Lane 3 moved the
    // rest onto the helper shape below and retired `LIVE_DOC_HEARTBEAT_MS` /
    // `LIVE_DOC_STATS_TTL_SEC` outright.
    for (const name of ['LIVE_DOC_ENABLED', 'AGENTIC_CONTEXT_TRANSCRIPT_MODE']) {
      expect(found.has(name), `${name} must be detected`).toBe(true);
    }
    // … and second-argument helper indirection, which is most of them.
    for (const name of ['LIVE_DOC_SEGMENT_THRESHOLD', 'LIVE_DOC_DEBOUNCE_MS', 'LIVE_DOC_MIN_INTERVAL_MS', 'LIVE_DOC_TEXT_MAX_TOKENS', 'LIVE_DOC_DURABLE_SNAPSHOT_MS', 'LIVE_DOC_GROUNDEDNESS_TIMEOUT_MS']) {
      expect(found.has(name), `${name} must be detected`).toBe(true);
    }
  });

  it('no longer sees the names TASK-940 retired — the scanner tracks reality, not history', () => {
    // The complement, and the assertion that would catch a revert: a retired name
    // reappearing in `globalEnv` means a read came back.
    const found = scanTypeScriptReads();
    for (const name of ['LIVE_DOC_TEXT_PROVIDER', 'LIVE_DOC_TEXT_MODEL', 'LIVE_DOC_HEARTBEAT_MS', 'LIVE_DOC_STATS_TTL_SEC']) {
      expect(found.has(name), `${name} was retired — nothing should read it`).toBe(false);
    }
  });

  it('sees the three undeclared reads that were NOT in live-documentation', () => {
    // The generator's blindness spanned three unrelated subsystems, not one
    // service. `HARNESS_BASE_URL` is the proof it hid ordinary topology too,
    // not only control-plane knobs that arguably should not be env at all.
    const found = scanTypeScriptReads();
    expect(found.has('HARNESS_BASE_URL')).toBe(true);
    expect(found.has('TENANT_IDP_GOOGLE_DIRECTORY_ENABLED')).toBe(true);
    expect(found.has('TENANT_IDP_MS_GRAPH_ENABLED')).toBe(true);
  });

  it('registers every one of them in turbo.json#globalEnv', () => {
    const globalEnv: string[] = JSON.parse(artifact('turbo.json')).globalEnv;
    const missing = [...scanTypeScriptReads()].filter((name) => !globalEnv.includes(name));
    expect(missing, 'a detected read that reaches no cache key is the original defect').toEqual([]);
  });
});

/**
 * TASK-940 Lane 1b — a governed key's legacy env OVERRIDE is a declared fact.
 *
 * Eight live-documentation names were already governed by a registry descriptor
 * with env deliberately kept as an override. None reached `globalEnv` anyway,
 * because the generator folds only `ENV_SUPPLIED_TIERS` ({env, vault-kv}) into
 * the declared surface and all eight descriptors are `global-kv` — correctly so,
 * since rendering a control-plane key into `.env.sample` is the drift this
 * generator exists to remove.
 *
 * `envOverride` closes that without re-opening it: the name reaches the turbo
 * cache key (it IS read, so its value changes behaviour) and stays out of every
 * operator-facing env file (its home is the control plane). It also makes the
 * pairing queryable, which is what lets the override be RETIRED on purpose
 * later — today the pairing exists only as a comment in a constructor.
 */
describe('env:sync — descriptor envOverride (TASK-940)', () => {
  const overridesInRegistry = HOPE_SETTINGS_REGISTRY.list().flatMap((d) => [...(d.envOverride ?? [])]);

  it('declares the live-documentation overrides on their governing descriptors', () => {
    expect(overridesInRegistry.length).toBeGreaterThan(0);
    for (const name of [
      'LIVE_DOC_SEGMENT_THRESHOLD',
      'LIVE_DOC_DEBOUNCE_MS',
      'LIVE_DOC_MIN_INTERVAL_MS',
      'AGENTIC_CONTEXT_LIVE_DELTA_MAX_CHARS',
      'AGENTIC_CONTEXT_TOKEN_BUDGET_PER_RUN',
      'AGENTIC_CONTEXT_TRANSCRIPT_MODE',
      'LIVE_DOC_TEXT_TIMEOUT_MS',
      'LIVE_DOC_GROUNDEDNESS_ENABLED',
    ]) {
      expect(overridesInRegistry, `${name} must be declared as an envOverride`).toContain(name);
    }
  });

  it('folds every envOverride into turbo.json#globalEnv regardless of tier', () => {
    const globalEnv: string[] = JSON.parse(artifact('turbo.json')).globalEnv;
    const missing = overridesInRegistry.filter((name) => !globalEnv.includes(name));
    expect(missing, 'an override that is read but hashed into no cache key').toEqual([]);
  });

  it('keeps every envOverride OUT of the operator-facing env files', () => {
    // The value's home is the control plane. Rendering it as an env line would
    // invite an operator to set a value the registry then overrules.
    for (const path of GENERATED_ENV_ARTIFACTS) {
      const declared = new Set(keysOf(artifact(path)));
      const leaked = overridesInRegistry.filter((name) => declared.has(name));
      expect(leaked, `${path} must not declare a control-plane override`).toEqual([]);
    }
  });

  it('never declares an override on a descriptor that is already env-tier', () => {
    // An `env`-tier key's name IS its declaration — a second one would be two
    // spellings of the same fact, and the drift this generator removes.
    const contradictory = HOPE_SETTINGS_REGISTRY.list().filter((d) => (d.envOverride?.length ?? 0) > 0 && (d.tier === 'env' || d.tier === 'vault-kv')).map((d) => d.key);
    expect(contradictory).toEqual([]);
  });
});

describe('env:sync — dead keys stay dead', () => {
  // Verified 2026-07-25: no reader in any TS/Python/shell/compose source.
  //   TENANT_IDP_ENABLED — no reader at all (see feature-flags.descriptors.ts)
  //   AZURE_OPENAI_API_KEY — only an TEXT e2e conftest fixture; the real key is TEXT_AZURE_API_KEY
  //   TEXT_OPENAI_COMPAT_ENABLED — TEXT gates providers by config presence, it has no `enabled` field
  //   TEXT_V2_* / STT_V2_URL — the retired rename shims
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
  it('declares at most ~149 distinct keys', () => {
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
    // Bumped 145 -> 147 for 2 legitimate additions ( exposure-plane
    // kill-switches — verified via `pnpm env:sync --check`, no drift):
    // WORKFLOW_EXPOSURE_ENABLED, WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS.
    // Bumped 147 -> 148 for 1 legitimate addition ( dedicated
    // webhook-signing encryption key, deliberately NOT reusing API_KEY_PEPPER
    // — verified via `pnpm env:sync`, no drift): WEBHOOK_SECRET_PEPPER.
    // Bumped 148 -> 149 for 1 legitimate addition (owner decision D-D,
    // 2026-08-17: THE one shared internal service-to-service token, which
    // RETIRES the per-service `*_SERVICE_TOKEN` family rather than adding to
    // it — verified via `pnpm env:sync --check`, no drift): INTERNAL_ACCESS_TOKEN.
    // Bumped 149 -> 155. NET +6, but the churn is +20/-14 and both halves are
    // deliberate, so the net alone would be misleading:
    //   +20 OBSERVABILITY transport (the Loki/Tempo/OTel stack is deployed now):
    //     AGENTIC_HIGHLIGHT_PROJECT_ID, HIGHLIGHT_BACKEND_URL,
    //     HIGHLIGHT_OTLP_ENDPOINT, HIGHLIGHT_PROJECT_ID, LOG_CONSOLE_COLORIZE,
    //     LOG_CONSOLE_ENABLED, LOG_CONSOLE_JSON, LOG_CONSOLE_PRETTY,
    //     LOKI_BASIC_AUTH, LOKI_BATCH_INTERVAL, LOKI_BATCH_SIZE, LOKI_TIMEOUT,
    //     MINIO_CERT_CHECK, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    //     OTEL_EXPORTER_OTLP_PROTOCOL, OTEL_INJECT_TRACE_CONTEXT,
    //     OTEL_LOGS_ENABLED, OTEL_LOG_BRIDGE, OTEL_RESOURCE_ATTRIBUTES,
    //     SERVICE_VERSION. `OTEL_*` is named as env-tier by
    //     09-infrastructure-devops.md; SERVICE_VERSION is a LOG LABEL only —
    //     its descriptor says build identity comes from the image's
    // build-info.json, never from env, so it does not reopen.
    //   -14 vendor credentials/endpoints that moved OFF env to the BYOK
    //     db-config/vault tier, which is the direction the config rules want:
    //     AZURE_FOUNDRY_API_KEY, GUARDRAIL_VLLM_API_KEY,
    //     HARNESS_JUDGE_OPENAI_COMPAT_API_KEY, OIDC_CLIENT_SECRET,
    //     TEXT_ANTHROPIC_BASE_URL, TEXT_ANTHROPIC_DEFAULT_MODEL,
    //     TEXT_EXTERNAL_GUARDRAIL_ENABLED, TEXT_OPENAI_BASE_URL,
    //     TEXT_OPENAI_DEFAULT_MODEL, TEXT_OPENAI_ORGANIZATION,
    //     TEXT_VERTEX_DEFAULT_MODEL, TEXT_VERTEX_LOCATION, TEXT_VERTEX_PROJECT,
    //     WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS.
    // Verified via `pnpm env:sync --check`: OK, 155 TS keys, no drift.
    const declared = declaredTsSurfaceKeys();
    expect(declared.size).toBeLessThanOrEqual(155);
  });
});

describe('env:sync — no drift on disk', () => {
  for (const { path } of artifacts) {
    it(`${path} matches the generator`, () => {
      expect(readFileSync(join(ROOT, path), 'utf8'), `run \`pnpm env:sync\``).toBe(artifact(path));
    });
  }
});

/**
 * The guard that was missing when `INTERNAL_ACCESS_TOKEN` shipped as a live `CHANGE_ME`.
 *
 * `env-sync.mts` writes `CHANGE_ME` for every secret; `generate-env-file.sh` then either
 * generates a real value or leaves the placeholder for the operator. Nothing checked that those
 * two sets ADD UP, so a secret could fall between them: never generated, never declared
 * external, and reported to the developer as an optional provider key. `INTERNAL_ACCESS_TOKEN`
 * sat in that gap while all six of its own legacy fallbacks were generated — so a fresh dev box
 * got a real value for every token EXCEPT the canonical one, and each service then presented
 * the literal string `CHANGE_ME` on every internal hop.
 *
 * This asserts the partition is total: declared-secret ⊆ generated ∪ external ∪ minted-later.
 */
describe('generate-env-file.sh — every declared secret is accounted for', () => {
  const script = readFileSync(join(ROOT, 'scripts/generate-env-file.sh'), 'utf8');

  /** Keys in a `_NAME=( ...)` bash array literal. */
  function bashArray(name: string): Set<string> {
    const body = new RegExp(`${name}=\\(([^)]*)\\)`, 's').exec(script);
    if (!body) throw new Error(`${name} not found in generate-env-file.sh`);
    return new Set(body[1].split(/\s+/).filter((token) => /^[A-Z][A-Z0-9_]*$/.test(token)));
  }

  /**
   * Every key the generated-secrets function fills — from BOTH of its halves.
   * The independent random secrets live in the `_GENERATED_SECRET_KEYS` array
   * (named so `_CARRY_FORWARD_KEYS` can reuse it verbatim: a secret generated
   * but not carried is re-minted on every rebuild). The storage group is still
   * filled inline in the function body, because those keys are not independent
   * — one access/secret pair is propagated across MinIO, S3 and the harness
   * claim-check store — so it is scraped from the body as before.
   */
  function generatedKeys(): Set<string> {
    const start = script.indexOf('_fill_generated_secrets()');
    const end = script.indexOf('# Report any CHANGE_ME');
    const body = script.slice(start, end);
    const inline = [...body.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map((m) => m[1]).filter((k) => k !== 'CHANGE_ME');
    return new Set([...bashArray('_GENERATED_SECRET_KEYS'), ...inline]);
  }

  /** Every secret `env-sync` marks unfilled in the consolidated sample. */
  function declaredSecrets(): string[] {
    const sample = readFileSync(join(ROOT, '.env.sample'), 'utf8');
    return [...new Set([...sample.matchAll(/^([A-Z][A-Z0-9_]*)=CHANGE_ME\s*$/gm)].map((m) => m[1]))].sort();
  }

  it('leaves no secret unclassified (generated, external, minted later, or superseded)', () => {
    const generated = generatedKeys();
    const external = bashArray('_EXTERNAL_SECRET_KEYS');
    const minted = bashArray('_MINTED_LATER_KEYS');
    // a fourth category. The legacy per-service tokens are SUPERSEDED
    // by the one shared INTERNAL_ACCESS_TOKEN (owner decision D-D), so a fresh
    // environment must leave them unset — `generate-env-file.sh` blanks them.
    // They are neither generated, nor external, nor minted: telling a developer
    // to paste a value would be instructing them to undo the migration.
    const superseded = bashArray('_SUPERSEDED_KEYS');
    // a FIFTH category. VAULT_WRAPPED_SECRET_ID is the PRODUCTION AppRole path;
    // dev and test both take the raw one, so every mint step blanks it. It is not
    // "minted later" in these two files — it must end up EMPTY, and CHANGE_ME is
    // worse than unset there: VaultSecretsProvider branches on truthiness, so the
    // placeholder selects the wrapped path and unwrapping "CHANGE_ME" fails at boot.
    const prodOnlyBlank = bashArray('_PROD_ONLY_BLANK_KEYS');

    const unclassified = declaredSecrets().filter(
      (key) => !generated.has(key) && !external.has(key) && !minted.has(key) && !superseded.has(key) && !prodOnlyBlank.has(key),
    );

    expect(
      unclassified,
      'Each key above is written as CHANGE_ME by env-sync but is neither generated by ' +
        'generate-env-file.sh nor declared as an external/minted-later credential, so a fresh ' +
        '.env.dev ships it as the literal string CHANGE_ME — which every consumer then treats ' +
        'as a real value. Add it to _fill_generated_secrets, _EXTERNAL_SECRET_KEYS, or ' +
        '_MINTED_LATER_KEYS, or _SUPERSEDED_KEYS.',
    ).toEqual([]);
  });

  it('generates the canonical internal token, not just its legacy fallbacks', () => {
    // The specific regression: every `*_SERVICE_TOKEN` was generated while the token that
    // supersedes them was not.
    const generated = generatedKeys();
    expect(generated.has('INTERNAL_ACCESS_TOKEN')).toBe(true);
    // `TTS_SERVICE_TOKEN` left this list with TASK-879/880 and `TEXT_SERVICE_TOKEN` with
    // TASK-888: each one's last reader is gone and the descriptor with it, so generating
    // it would seed a value nothing reads.
    for (const legacy of ['NLP_SERVICE_TOKEN', 'GUARDRAIL_SERVICE_TOKEN', 'HARNESS_SERVICE_TOKEN']) {
      expect(generated.has(legacy), `${legacy} should still be generated as a fallback`).toBe(true);
    }
  });

  it('never generates a value for a credential only a vendor can issue', () => {
    // The opposite failure: synthesising an Azure/OIDC key would make an unconfigured provider
    // look configured — the exact thing vault-seed-secrets.sh refuses to do.
    const generated = generatedKeys();
    for (const external of bashArray('_EXTERNAL_SECRET_KEYS')) {
      expect(generated.has(external), `${external} must stay operator-supplied`).toBe(false);
    }
  });
});
