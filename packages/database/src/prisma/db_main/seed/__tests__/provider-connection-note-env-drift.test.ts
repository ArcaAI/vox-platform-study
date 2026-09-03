// A seeded `metaData.note` is OPERATOR-FACING documentation: it ships in the
// row, and the admin console renders it beside the endpoint an operator is
// about to change. So a note that names an environment variable makes a
// promise — "set this var and the endpoint follows" — and that promise has to
// be true.
//
// It stopped being true. The self-host `AiProviderConnection` rows carried
// notes citing `TEXT_OLLAMA_BASE_URL` / `TEXT_VLLM_BASE_URL` /
// `TEXT_LLAMA_CPP_BASE_URL` as the "env-tier connection identity", but those
// variables were RETIRED with the per-engine `pydantic-settings` sub-configs:
// `apps/text/src/text/core/config.py` declares exactly two prefixes today
// (`TEXT_EXTERNAL_GUARDRAIL_` and `TEXT_`), neither of them per-engine, and
// `apps/text/src/text/tests/unit/test_task602_byok_credentials.py` PINS their
// absence by deleting them and asserting every adapter still registers. The
// endpoint's real home is this row's own `baseUrl` column — `db-config`, not
// `env` — which is the whole point of the tier split in
// `09-infrastructure-devops.md` §Configuration Tiers.
//
// The failure mode is quiet and expensive on day 1: an operator reads the note,
// exports the variable, restarts the service, and nothing moves — because
// nothing reads it. This guard makes that class of drift loud instead.
//
// The invariant is deliberately narrow: a note MAY cite an env var, but only one
// that `turbo.json#globalEnv` actually declares. `globalEnv` is the repo's own
// register of "this is a live runtime variable" (`00-project-context.md`
// Files), so a name missing from it is, by the repo's own
// definition, not a runtime variable at all.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYSTEM_AI_PROVIDER_CONNECTIONS } from '../17-ai-provider-connection';

/** From `packages/database/src/prisma/db_main/seed/__tests__` to the repo root. */
const REPO_ROOT = resolve(__dirname, '../../../../../../..');

/** Every name declared in `turbo.json#globalEnv`. */
function declaredGlobalEnv(): Set<string> {
  const turbo = JSON.parse(readFileSync(resolve(REPO_ROOT, 'turbo.json'), 'utf8')) as { globalEnv?: string[] };
  return new Set(turbo.globalEnv ?? []);
}

/**
 * SCREAMING_SNAKE tokens inside a note. Requires an underscore and a leading
 * letter so ordinary prose in caps ("NOT", "SYSTEM", "BYO") is never mistaken
 * for a variable name.
 */
const ENV_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

describe('seeded AiProviderConnection notes never cite a retired env var', () => {
  it('cites only names that `turbo.json#globalEnv` declares', () => {
    const declared = declaredGlobalEnv();

    const offenders = SYSTEM_AI_PROVIDER_CONNECTIONS.flatMap((connection) => {
      const note = (connection.metaData as { note?: unknown } | null | undefined)?.note;
      if (typeof note !== 'string') return [];
      return [...note.matchAll(ENV_TOKEN)]
        .map((match) => match[0])
        .filter((name) => !declared.has(name))
        .map((name) => `${connection.service}:${connection.provider} cites ${name}`);
    });

    expect(
      [...new Set(offenders)].sort(),
      'Each note above promises an operator that an environment variable drives this connection, ' +
        'but `turbo.json#globalEnv` does not declare it — so nothing reads it and setting it does nothing. ' +
        'The endpoint lives in the row’s own `baseUrl` (db-config tier). Fix the note, not this test.',
    ).toEqual([]);
  });

  it('reads a globalEnv register that is actually populated (guards the guard)', () => {
    // A typo'd path or a restructured turbo.json would make the assertion above
    // vacuously pass by declaring nothing and matching nothing.
    const declared = declaredGlobalEnv();
    expect(declared.size).toBeGreaterThan(50);
    expect(declared.has('DATABASE_URL')).toBe(true);
  });
});
