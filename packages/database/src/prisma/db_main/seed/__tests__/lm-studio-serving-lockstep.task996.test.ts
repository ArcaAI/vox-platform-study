/**
 * TASK-996 Phase 2a — the LOCKSTEP the LM Studio catalogue rows must satisfy,
 * inherited from TASK-995.
 *
 * Two numbers describe the same context window and they are not the same field:
 *
 *  - `_metadata.capabilities.contextLength` is what callers are TOLD they may
 *    use. The live lane budgets against it BEFORE it dispatches.
 *  - `_metadata.serving.contextLength` is what the engine is LOADED with
 *    (`lms load --context-length`, i.e. `LMS_CONTEXT` on the Deployment today).
 *
 * The invariant is ONE-DIRECTIONAL. Under-claiming only leaves headroom unused.
 * Over-claiming turns the pre-dispatch budget check into a pass and the engine
 * call into `exceed_context_size_error` — which is the exact failure the
 * declaration exists to prevent, so it must be impossible to seed, not merely
 * possible to notice.
 *
 * This file pins the seed rows. The CASCADE (a row with no `serving` block
 * inheriting `lmStudio.serving.*`) is pinned in `@arcaai/applications` —
 * `serving-profile.util.task996.test.ts` — because the platform tier lives in
 * the settings registry and a seed must not reach across into it.
 */
import { describe, expect, it } from 'vitest';
import { checkAiModelServingProfile, parseAiModelServingProfile } from '@arcaai/types';
import { LLM_AI_MODELS } from '../ai-models/llm';

/** Every seeded row that declares a serving profile, a declared window, or both. */
const rowsWithAContextOpinion = LLM_AI_MODELS.filter((model) => model.metaData?.serving || typeof model.metaData?.contextLength === 'number');

describe('LM Studio seed rows — declared vs served context window', () => {
  it('has at least one row to check, so a rename can never make this file vacuously green', () => {
    expect(rowsWithAContextOpinion.length).toBeGreaterThan(0);
  });

  it.each(rowsWithAContextOpinion.map((model) => [model.slug, model] as const))('%s: declares no more than it serves', (_slug, model) => {
    const { profile, rejected } = parseAiModelServingProfile(model.metaData?.serving);
    // A member the runtime would DROP is a member that silently stops guarding
    // anything, so a seeded profile must survive its own parser intact.
    expect(rejected).toEqual([]);
    expect(checkAiModelServingProfile(profile, { declaredContextLength: model.metaData?.contextLength ?? null })).toEqual([]);
  });
});

describe('the PRELOADED LM Studio row', () => {
  /**
   * The row named in `LMS_LOAD`. It is the only one `lms load --context-length`
   * is invoked for, which is why it is the only one that may safely declare a
   * window wider than LM Studio's JIT default.
   */
  const preloaded = LLM_AI_MODELS.find((model) => model.slug === 'lms-gemma-4-e2b-it-qat');

  it('exists and declares BOTH halves of the pair', () => {
    expect(preloaded).toBeDefined();
    expect(preloaded?.metaData?.contextLength).toEqual(expect.any(Number));
    expect(preloaded?.metaData?.serving?.contextLength).toEqual(expect.any(Number));
  });

  it('declares exactly what it serves — the two are one constant, so they cannot drift apart', () => {
    expect(preloaded?.metaData?.contextLength).toBe(preloaded?.metaData?.serving?.contextLength);
  });

  it('carries the decode-slot count too: residency is context x parallel, not context alone', () => {
    expect(preloaded?.metaData?.serving?.parallel).toEqual(expect.any(Number));
  });

  it('is served at 65536 — the value TASK-995 lowered LMS_CONTEXT to, which this must not exceed', () => {
    expect(preloaded?.metaData?.serving?.contextLength).toBe(65536);
  });
});

describe('the JIT-loaded LM Studio rows', () => {
  it('lms-gemma-4-e4b declares NO context window: nothing carries one to a JIT load', () => {
    const e4b = LLM_AI_MODELS.find((model) => model.slug === 'lms-gemma-4-e4b');
    expect(e4b).toBeDefined();
    expect(e4b?.metaData?.contextLength).toBeUndefined();
  });
});
