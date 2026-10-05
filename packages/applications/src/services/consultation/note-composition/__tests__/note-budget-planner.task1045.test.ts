import { describe, expect, it } from 'vitest';

import { CHAT_OVERHEAD_TOKENS_PER_MESSAGE, MIN_CALL_OUTPUT_TOKENS, planNoteBudget, type BudgetPlanInput, type NoteBudgetSettings } from '../note-budget-planner';
import { NOTE_INPUT_EXCEEDS_CONTEXT } from '../note-plan.types';

const SETTINGS: NoteBudgetSettings = {
  singlePassRatio: 0.6,
  safetyTokens: 512,
  outputTokensPerSection: 384,
  outputOverheadTokens: 256,
  maxCallOutputTokens: 6144,
  maxSectionGroups: 10,
};

const SOAP = [
  { key: 'subjective', title: 'Subjective' },
  { key: 'objective', title: 'Objective' },
  { key: 'assessment', title: 'Assessment' },
  { key: 'plan', title: 'Plan' },
];

const DIRECTIVE_TOKENS = 20;

function input(overrides: Partial<BudgetPlanInput> = {}): BudgetPlanInput {
  return {
    contextWindow: 32768,
    settings: SETTINGS,
    systemTokens: 1000,
    fixed: { tokens: 2000, blocks: 2 },
    priorEncounters: [],
    sections: SOAP,
    directive: (sectionKeys) => ({ text: `Write ${sectionKeys.join(', ')}.`, tokens: DIRECTIVE_TOKENS }),
    tokenizer: { mode: 'exact', id: 'lm-studio:gemma-4-e2b-it-qat' },
    ...overrides,
  };
}

/** system + every block + one chat overhead per message (system, each block). */
function inputTokensOf(systemTokens: number, blockTokens: number, blocks: number): number {
  return systemTokens + blockTokens + (1 + blocks) * CHAT_OVERHEAD_TOKENS_PER_MESSAGE;
}

describe('planNoteBudget', () => {
  it('plans ONE call for everything when the inputs fit under the single-pass ratio', () => {
    const plan = planNoteBudget(input());
    if (!plan.ok) throw new Error(plan.reason);

    const inputTokens = inputTokensOf(1000, 2000, 2);
    expect(plan.budget).toEqual({
      contextWindow: 32768,
      singlePassRatio: 0.6,
      safetyTokens: 512,
      inputTokens,
      tokenizer: { mode: 'exact', id: 'lm-studio:gemma-4-e2b-it-qat' },
      strategy: 'single_pass',
      reductions: [],
    });
    expect(plan.reducedSeqs).toEqual([]);
    expect(plan.calls).toEqual([
      {
        callId: 'c1',
        sectionKeys: ['subjective', 'objective', 'assessment', 'plan'],
        directive: 'Write subjective, objective, assessment, plan.',
        // max(1024, 4 × 384 + 256)
        maxTokens: 1792,
        promptTokens: inputTokens + DIRECTIVE_TOKENS + CHAT_OVERHEAD_TOKENS_PER_MESSAGE,
      },
    ]);
  });

  it('floors a small call reserve at the minimum output budget', () => {
    const plan = planNoteBudget(input({ sections: [SOAP[3]] }));
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.calls[0].maxTokens).toBe(MIN_CALL_OUTPUT_TOKENS);
  });

  it('reduces EVERY prior encounter to ledger + cited segments when the verbatim inputs exceed the ratio, keeping the last verbatim', () => {
    const plan = planNoteBudget(
      input({
        // the last encounter (and results) live in `fixed`; two prior encounters are large
        fixed: { tokens: 6000, blocks: 3 },
        priorEncounters: [
          { seq: 1, verbatimTokens: 9000, verbatimBlocks: 1, reduced: { tokens: 1500, blocks: 2 } },
          { seq: 2, verbatimTokens: 7000, verbatimBlocks: 1, reduced: { tokens: 1200, blocks: 2 } },
        ],
      }),
    );
    if (!plan.ok) throw new Error(plan.reason);

    expect(plan.budget.strategy).toBe('ledger_prior');
    expect(plan.reducedSeqs).toEqual([1, 2]);
    expect(plan.budget.reductions).toEqual([
      { kind: 'prior_encounter_to_ledger', encounterSeq: 1, tokensBefore: 9000, tokensAfter: 1500 },
      { kind: 'prior_encounter_to_ledger', encounterSeq: 2, tokensBefore: 7000, tokensAfter: 1200 },
    ]);
    expect(plan.budget.inputTokens).toBe(inputTokensOf(1000, 6000 + 1500 + 1200, 3 + 2 + 2));
    expect(plan.calls).toHaveLength(1);
  });

  it('keeps a prior encounter verbatim when no current ledger exists, and reduces the ones that have one', () => {
    const plan = planNoteBudget(
      input({
        fixed: { tokens: 4000, blocks: 2 },
        priorEncounters: [
          { seq: 1, verbatimTokens: 4000, verbatimBlocks: 1, reduced: null },
          { seq: 2, verbatimTokens: 12000, verbatimBlocks: 1, reduced: { tokens: 2000, blocks: 2 } },
        ],
      }),
    );
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.budget.strategy).toBe('ledger_prior');
    expect(plan.reducedSeqs).toEqual([2]);
    expect(plan.budget.reductions.map((r) => r.encounterSeq)).toEqual([2]);
  });

  it('never replaces a transcript with a LARGER ledger', () => {
    const plan = planNoteBudget(
      input({
        fixed: { tokens: 15000, blocks: 2 },
        priorEncounters: [
          { seq: 1, verbatimTokens: 3000, verbatimBlocks: 1, reduced: { tokens: 3500, blocks: 2 } },
          { seq: 2, verbatimTokens: 4000, verbatimBlocks: 1, reduced: { tokens: 900, blocks: 2 } },
        ],
      }),
    );
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.reducedSeqs).toEqual([2]);
  });

  it('accepts a verbatim plan over the ratio when nothing can be reduced and it still fits the window', () => {
    const plan = planNoteBudget(input({ fixed: { tokens: 22000, blocks: 2 } }));
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.budget.strategy).toBe('single_pass');
    expect(plan.budget.reductions).toEqual([]);
  });

  it('splits a long template into contiguous section groups (≤ 10) sharing one prefix', () => {
    const sections = Array.from({ length: 40 }, (_, i) => ({ key: `s${i + 1}`, title: `Section ${i + 1}` }));
    const plan = planNoteBudget(input({ sections }));
    if (!plan.ok) throw new Error(plan.reason);

    expect(plan.budget.strategy).toBe('section_groups');
    // floor((6144 - 256) / 384) = 15 sections per call ⇒ 3 balanced groups 14/13/13
    expect(plan.calls.map((c) => c.callId)).toEqual(['g1', 'g2', 'g3']);
    expect(plan.calls.map((c) => c.sectionKeys.length)).toEqual([14, 13, 13]);
    expect(plan.calls.flatMap((c) => c.sectionKeys)).toEqual(sections.map((s) => s.key));
    for (const call of plan.calls) {
      expect(call.maxTokens).toBeLessThanOrEqual(SETTINGS.maxCallOutputTokens);
      // every group carries the identical prefix: only the directive differs
      expect(call.promptTokens).toBe(plan.budget.inputTokens + DIRECTIVE_TOKENS + CHAT_OVERHEAD_TOKENS_PER_MESSAGE);
    }
  });

  it('combines the ledger reduction with section groups', () => {
    const sections = Array.from({ length: 20 }, (_, i) => ({ key: `s${i + 1}`, title: `Section ${i + 1}` }));
    const plan = planNoteBudget(
      input({
        sections,
        fixed: { tokens: 8000, blocks: 3 },
        priorEncounters: [{ seq: 1, verbatimTokens: 14100, verbatimBlocks: 1, reduced: { tokens: 2210, blocks: 2 } }],
      }),
    );
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.budget.strategy).toBe('ledger_prior+section_groups');
    expect(plan.calls).toHaveLength(2);
    expect(plan.budget.reductions).toEqual([{ kind: 'prior_encounter_to_ledger', encounterSeq: 1, tokensBefore: 14100, tokensAfter: 2210 }]);
  });

  it('fails closed when the template needs more than the maximum number of section groups', () => {
    const sections = Array.from({ length: 200 }, (_, i) => ({ key: `s${i + 1}`, title: `Section ${i + 1}` }));
    const plan = planNoteBudget(input({ sections }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe(NOTE_INPUT_EXCEEDS_CONTEXT);
    expect(plan.reason).toMatch(/section groups/);
  });

  it('honours a lower group ceiling from the settings, never a higher one than the contract maximum', () => {
    const sections = Array.from({ length: 40 }, (_, i) => ({ key: `s${i + 1}`, title: `Section ${i + 1}` }));
    expect(planNoteBudget(input({ sections, settings: { ...SETTINGS, maxSectionGroups: 2 } })).ok).toBe(false);
    const big = Array.from({ length: 160 }, (_, i) => ({ key: `s${i + 1}`, title: `Section ${i + 1}` }));
    // 160 / 15 ⇒ 11 groups: over the contract's 10 even when the setting says 50
    expect(planNoteBudget(input({ sections: big, settings: { ...SETTINGS, maxSectionGroups: 50 } })).ok).toBe(false);
  });

  it('fails closed with NOTE_INPUT_EXCEEDS_CONTEXT when nothing can be reduced and the window is exceeded', () => {
    const plan = planNoteBudget(input({ fixed: { tokens: 31000, blocks: 2 } }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe(NOTE_INPUT_EXCEEDS_CONTEXT);
    expect(plan.contextWindow).toBe(32768);
    expect(plan.requiredTokens).toBeGreaterThan(32768);
  });

  it('fails closed when even the reduced inputs do not fit — it never truncates', () => {
    const plan = planNoteBudget(
      input({
        fixed: { tokens: 29000, blocks: 2 },
        priorEncounters: [{ seq: 1, verbatimTokens: 9000, verbatimBlocks: 1, reduced: { tokens: 3000, blocks: 2 } }],
      }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe(NOTE_INPUT_EXCEEDS_CONTEXT);
  });

  it('records the estimate tokenizer mode it was planned with', () => {
    const plan = planNoteBudget(input({ tokenizer: { mode: 'estimate', id: 'estimate:utf8-bytes/2' } }));
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.budget.tokenizer).toEqual({ mode: 'estimate', id: 'estimate:utf8-bytes/2' });
  });

  it('reserves the whole call budget when the template declares no sections', () => {
    const plan = planNoteBudget(input({ sections: [] }));
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.calls).toEqual([expect.objectContaining({ callId: 'c1', sectionKeys: [], maxTokens: SETTINGS.maxCallOutputTokens })]);
  });

  it('names a section-regenerate call r1', () => {
    const plan = planNoteBudget(input({ sections: [SOAP[3]], callIdPrefix: 'r' }));
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.calls.map((c) => c.callId)).toEqual(['r1']);
  });
});
