/**
 * TASK-947 — the ONE reader of a TEXT_GENERATION instruction's SHAPE.
 *
 * Seven call sites used to read `instruction.promptTemplateId` by hand (publish, clone, bundle
 * export/import, promotion, the reference-set seed, the tag-selected prompt tier). With a third
 * form — `fragments[]`, each fragment optionally template-bound — every one of them would have
 * to learn the traversal, and the one that forgot a fragment would export a bundle that imports
 * half an agent. So the traversal lives here, once, and the seven sites map over it.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_PROMPT_FRAGMENT_KEY_PATTERN,
  AGENT_PROMPT_FRAGMENT_MAX,
  agentInstructionForm,
  boundTemplateRefs,
  isCompositeInstruction,
  mapBoundTemplateRefs,
  primaryTemplateId,
  readPromptFragments,
} from '../agent-instruction';

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const T3 = '33333333-3333-3333-3333-333333333333';

const composite = {
  fragments: [
    { key: 'peds', systemPrompt: 'The patient is a minor.', when: 'has(context.patient_age) && context.patient_age < 18' },
    { key: 'base', promptTemplateId: T1, promptVersionNumber: 3 },
    { key: 'revisit', promptTemplateId: T2, when: "context.visit_type == 'revisit'" },
    { key: 'closing', promptTemplateId: T3 },
  ],
  variables: { language: { path: 'context.language' } },
};

describe('agentInstructionForm — shape, not validity', () => {
  it('names the three forms and the absence of one', () => {
    expect(agentInstructionForm({ promptTemplateId: T1 })).toBe('template');
    expect(agentInstructionForm({ systemPrompt: 'Be brief.' })).toBe('inline');
    expect(agentInstructionForm(composite)).toBe('composite');
    expect(agentInstructionForm({})).toBe('none');
    expect(agentInstructionForm(null)).toBe('none');
    expect(agentInstructionForm('promptTemplateId')).toBe('none');
  });

  it('reads `fragments` as composite even when the list is malformed — the validator says why, the reader says what', () => {
    expect(agentInstructionForm({ fragments: [] })).toBe('composite');
    expect(agentInstructionForm({ fragments: ['not-an-object'] })).toBe('composite');
    expect(isCompositeInstruction({ fragments: [] })).toBe(true);
    expect(isCompositeInstruction({ promptTemplateId: T1 })).toBe(false);
  });

  it('pins the fragment limits every other package reads from here', () => {
    expect(AGENT_PROMPT_FRAGMENT_MAX).toBe(16);
    expect(new RegExp(AGENT_PROMPT_FRAGMENT_KEY_PATTERN).test('base')).toBe(true);
    expect(new RegExp(AGENT_PROMPT_FRAGMENT_KEY_PATTERN).test('Base')).toBe(false);
    expect(new RegExp(AGENT_PROMPT_FRAGMENT_KEY_PATTERN).test('a')).toBe(false);
  });
});

describe('readPromptFragments', () => {
  it('returns the fragments of a composite instruction with their fields typed', () => {
    const fragments = readPromptFragments(composite);
    expect(fragments).toHaveLength(4);
    expect(fragments[1]).toEqual({ key: 'base', promptTemplateId: T1, promptVersionNumber: 3 });
    expect(fragments[0]?.when).toContain('has(');
  });

  it('is empty for the other two forms and for garbage', () => {
    expect(readPromptFragments({ promptTemplateId: T1 })).toEqual([]);
    expect(readPromptFragments({ systemPrompt: 'x' })).toEqual([]);
    expect(readPromptFragments(undefined)).toEqual([]);
  });

  it('drops non-object entries and coerces missing fields rather than throwing', () => {
    const fragments = readPromptFragments({
      fragments: [{ key: 'ok', systemPrompt: 'x' }, 'junk', { promptTemplateId: T1, promptVersionNumber: '3' }],
    });
    expect(fragments).toEqual([
      { key: 'ok', systemPrompt: 'x' },
      { key: '', promptTemplateId: T1 },
    ]);
  });
});

describe('boundTemplateRefs — every template the instruction binds, with its path', () => {
  it('form 1: one ref at `instruction`', () => {
    expect(boundTemplateRefs({ promptTemplateId: T1, promptVersionNumber: 2 })).toEqual([
      { path: 'instruction', templateId: T1, versionNumber: 2, fragmentIndex: null, fragmentKey: null },
    ]);
    expect(boundTemplateRefs({ promptTemplateId: T1 })[0]?.versionNumber).toBeNull();
  });

  it('form 2 and none: no refs', () => {
    expect(boundTemplateRefs({ systemPrompt: 'x' })).toEqual([]);
    expect(boundTemplateRefs(null)).toEqual([]);
  });

  it('form 3: one ref per TEMPLATE fragment, in order, indexed; inline fragments contribute none', () => {
    expect(boundTemplateRefs(composite)).toEqual([
      { path: 'instruction.fragments[1]', templateId: T1, versionNumber: 3, fragmentIndex: 1, fragmentKey: 'base' },
      { path: 'instruction.fragments[2]', templateId: T2, versionNumber: null, fragmentIndex: 2, fragmentKey: 'revisit' },
      { path: 'instruction.fragments[3]', templateId: T3, versionNumber: null, fragmentIndex: 3, fragmentKey: 'closing' },
    ]);
  });
});

describe('primaryTemplateId — the pointer the prompt-resolution tiers read (OD-9)', () => {
  it('form 1: the bound template', () => {
    expect(primaryTemplateId({ promptTemplateId: T1 })).toBe(T1);
  });

  it('form 3: the FIRST unconditional TEMPLATE fragment — an unconditional inline fragment ahead of it does not count', () => {
    expect(primaryTemplateId(composite)).toBe(T1);
    expect(
      primaryTemplateId({
        fragments: [
          { key: 'a', systemPrompt: 'x' },
          { key: 'b', promptTemplateId: T2 },
        ],
      }),
    ).toBe(T2);
  });

  it('treats a COMPILED fragment list (`when: null`) exactly like an authored one (`when` absent) — Lane B found the edge', () => {
    // The authored schema never carries `when: null` (it is `string` or absent), but the compiled
    // artifact ALWAYS does (`when: string | null`); a caller handing either shape to the pointer
    // reader must get the same base fragment back.
    const compiledShaped = {
      fragments: [
        { key: 'peds', systemPrompt: 'x', when: 'has(context.patient_age)' },
        { key: 'base', promptTemplateId: T1, when: null },
        { key: 'closing', promptTemplateId: T2, when: null },
      ],
    };
    expect(primaryTemplateId(compiledShaped)).toBe(T1);
    expect(boundTemplateRefs(compiledShaped).map((ref) => ref.templateId)).toEqual([T1, T2]);
  });

  it('form 3 with only conditional template fragments, form 2, none: null — the tier falls through', () => {
    expect(
      primaryTemplateId({
        fragments: [
          { key: 'a', promptTemplateId: T1, when: 'true' },
          { key: 'b', systemPrompt: 'x' },
        ],
      }),
    ).toBeNull();
    expect(primaryTemplateId({ systemPrompt: 'x' })).toBeNull();
    expect(primaryTemplateId(null)).toBeNull();
  });
});

describe('mapBoundTemplateRefs — the rewrite every portability site goes through (OD-10)', () => {
  it('form 1: rewrites the id; `versionNumber: null` DELETES the pin, `undefined` keeps it', () => {
    const source = { promptTemplateId: T1, promptVersionNumber: 4, variables: { a: { value: 'x' } } };
    expect(mapBoundTemplateRefs(source, () => ({ templateId: T2 }))).toEqual({ ...source, promptTemplateId: T2 });
    expect(mapBoundTemplateRefs(source, () => ({ templateId: T2, versionNumber: null }))).toEqual({
      promptTemplateId: T2,
      variables: { a: { value: 'x' } },
    });
    expect(mapBoundTemplateRefs(source, () => ({ templateId: T2, versionNumber: 1 }))).toEqual({
      ...source,
      promptTemplateId: T2,
      promptVersionNumber: 1,
    });
  });

  it('form 3: rewrites each template fragment through the callback, leaves inline fragments and every other field alone', () => {
    const next = mapBoundTemplateRefs(composite, (ref) =>
      ref.fragmentKey === 'revisit' ? { templateId: T3, versionNumber: 7 } : { templateId: `${ref.templateId}-x`, versionNumber: null },
    );
    expect(next?.fragments).toEqual([
      composite.fragments[0],
      { key: 'base', promptTemplateId: `${T1}-x` },
      { key: 'revisit', promptTemplateId: T3, promptVersionNumber: 7, when: "context.visit_type == 'revisit'" },
      { key: 'closing', promptTemplateId: `${T3}-x` },
    ]);
    expect(next?.variables).toEqual(composite.variables);
  });

  it('a `null` from the callback leaves that ref untouched', () => {
    expect(mapBoundTemplateRefs({ promptTemplateId: T1, promptVersionNumber: 2 }, () => null)).toEqual({
      promptTemplateId: T1,
      promptVersionNumber: 2,
    });
    const next = mapBoundTemplateRefs(composite, (ref) => (ref.fragmentKey === 'base' ? { templateId: T2 } : null));
    expect(next?.fragments).toEqual([
      composite.fragments[0],
      { key: 'base', promptTemplateId: T2, promptVersionNumber: 3 },
      composite.fragments[2],
      composite.fragments[3],
    ]);
  });

  it('never mutates its input and answers null for a non-object', () => {
    const frozen = JSON.parse(JSON.stringify(composite)) as Record<string, unknown>;
    mapBoundTemplateRefs(frozen, () => ({ templateId: T2, versionNumber: null }));
    expect(frozen).toEqual(composite);
    expect(mapBoundTemplateRefs(null, () => ({ templateId: T2 }))).toBeNull();
    expect(mapBoundTemplateRefs({ systemPrompt: 'x' }, () => ({ templateId: T2 }))).toEqual({ systemPrompt: 'x' });
  });
});
