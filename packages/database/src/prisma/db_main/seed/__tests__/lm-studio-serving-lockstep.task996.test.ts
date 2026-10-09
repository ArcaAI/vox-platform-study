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

  it('is served at 32768 — the value TASK-1045 lowered LMS_CONTEXT to, which this must not exceed', () => {
    expect(preloaded?.metaData?.serving?.contextLength).toBe(32768);
  });
});

describe('the JIT-loaded LM Studio rows', () => {
  it('lms-gemma-4-e4b declares NO context window: nothing carries one to a JIT load', () => {
    const e4b = LLM_AI_MODELS.find((model) => model.slug === 'lms-gemma-4-e4b');
    expect(e4b).toBeDefined();
    expect(e4b?.metaData?.contextLength).toBeUndefined();
  });
});

/**
 * TASK-1031 (owner, 2026-10-01) — the serving layout is a rule for the ROLE, and it REVERSES
 * the TASK-996 one (summarization was GPU 0, guardrail GPU 1):
 *
 *   summarization  32768 ctx (was 65536, TASK-1045) · 10 concurrent · GPU 1 · q4_0 KV
 *   guardrail      16384 ctx · 10 concurrent · GPU 1 · q8_0 KV
 *
 * TASK-1055 (owner, 2026-10-09) moved the guardrail role from GPU 0 to GPU 1, beside summarization:
 * GPU 0 is Medical NER + GLiGuard + Whisper ML-EN (`task-1055-default-gpu-alignment.test.ts`).
 */
describe('TASK-1031 — the owner serving layout', () => {
  const bySlug = (slug: string) => LLM_AI_MODELS.find((model) => model.slug === slug);

  it('serves the summarization model at 32768 x 10 on GPU 1 only, with a q4_0 KV cache (TASK-1045)', () => {
    expect(bySlug('lms-gemma-4-e2b-it-qat')?.metaData?.serving).toEqual({
      contextLength: 32768,
      parallel: 10,
      flashAttention: true,
      gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0] },
      kvCacheQuant: { k: 'q4_0', v: 'q4_0' },
    });
  });

  it('serves every guardrail/safety LM Studio model at 16384 x 10 on GPU 1 only, with a q8_0 KV cache (TASK-1055)', () => {
    const guardrail = LLM_AI_MODELS.filter(
      (model) => model.provider === 'lm-studio' && (model.tags ?? []).some((tag) => tag === 'guardrail' || tag === 'safety'),
    );
    expect(guardrail.map((model) => model.slug)).toEqual(['granite-guardian-4.1-8b']);
    for (const model of guardrail) {
      expect(model.metaData?.serving, model.slug).toEqual({
        contextLength: 16384,
        parallel: 10,
        // A quantized V-cache REQUIRES flash attention; declared so the row is coherent alone.
        flashAttention: true,
        gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0] },
        kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
      });
    }
  });

  it('leaves the other summarization-class LM Studio rows on the platform defaults (no placement of their own)', () => {
    expect(bySlug('lms-gemma-4-e4b')?.metaData?.serving).toBeUndefined();
  });
});
