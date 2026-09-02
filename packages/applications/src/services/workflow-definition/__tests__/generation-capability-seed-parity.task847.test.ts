/**
 * TASK-847 finding F-32 — the seeded capability declarations must speak the CONTRACT's vocabulary.
 *
 * `AiModel._metadata.supportedGenerationParams` is data, and the gate compares it by string
 * equality against the keys a node authored under `generation`. So a seeded row that says
 * `"max_tokens"` where the contract says `"maxTokens"`, or that invents a parameter the node
 * schema does not offer, silently turns a supported knob into a publish-blocking ERROR — the
 * exact failure mode this gate exists to prevent, inverted.
 *
 * That coupling is invisible at both ends: the seed module is a database-package leaf that cannot
 * import the workflow contract, and the contract is a pure package that knows nothing about seeds.
 * `packages/applications` depends on both, so the guard lives here — following the deep-seed-import
 * precedent already set by `authorization/__tests__/tenant-ability.regression.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { GENERATION_HYPERPARAMETERS } from '@arcaai/workflow-contract';
// The generation plane's own rows, imported from the pure data module rather than from
// `06-stt.ts`'s `DEFAULT_AI_MODELS` aggregate — that file also carries the seeding routine and
// its Prisma imports, which a unit test has no business loading.
import { LLM_AI_MODELS } from '../../../../../database/src/prisma/db_main/seed/ai-models/llm';

/** Every seeded row that declares a capability set, with the set it declares. */
function declaredSets(): { slug: string; params: readonly string[] }[] {
  return LLM_AI_MODELS.flatMap((model) => {
    const params = model.metaData?.supportedGenerationParams;
    return Array.isArray(params) ? [{ slug: model.slug, params }] : [];
  });
}

describe('F-32 — seeded supportedGenerationParams speak the contract vocabulary', () => {
  it('the platform actually seeds capability declarations (the gate has something to bite on)', () => {
    // Without this, every assertion below passes vacuously and the gate degrades to
    // "everything is UNKNOWN", which is a silently disabled gate rather than a failing one.
    expect(declaredSets().length).toBeGreaterThan(0);
  });

  it('every declared parameter is a member of GENERATION_HYPERPARAMETERS', () => {
    const vocabulary = new Set<string>(GENERATION_HYPERPARAMETERS);

    const unknown = declaredSets().flatMap(({ slug, params }) =>
      params.filter((param) => !vocabulary.has(param)).map((param) => `${slug}: ${param}`),
    );

    // A parameter outside the vocabulary can never match an authored key, so it is dead weight at
    // best and a mis-spelling of a real one at worst.
    expect(unknown).toEqual([]);
  });

  it('no row declares the same parameter twice', () => {
    const duplicated = declaredSets()
      .filter(({ params }) => new Set(params).size !== params.length)
      .map(({ slug }) => slug);

    expect(duplicated).toEqual([]);
  });
});
