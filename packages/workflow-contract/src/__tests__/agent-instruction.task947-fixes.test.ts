/**
 * TASK-947 — reviewer findings on the instruction reader (R1 #3/#6, R2 L-3).
 *
 * 1. `primaryTemplateRef` returns the REF of the pointer fragment, so a reader that needs the pin
 *    gets the pin of THAT fragment — `boundTemplateRefs(...).find(ref => ref.templateId === id)`
 *    found the first fragment binding the id, which need not be the unconditional one (ids may
 *    repeat across fragments; only keys are unique).
 * 2. `readPromptFragments` carries each fragment's RAW index, so a finding path built from its
 *    output names the same `instruction.fragments[i]` the validator names even when a non-object
 *    entry was dropped ahead of it.
 */
import { describe, expect, it } from 'vitest';
import { boundTemplateRefs, primaryTemplateId, primaryTemplateRef, readPromptFragments } from '../agent-instruction';

const T1 = '11111111-1111-1111-1111-111111111111';

describe('primaryTemplateRef — the pointer fragment WITH its pin', () => {
  it('returns the ref of the first UNCONDITIONAL template fragment, not the first fragment binding that id', () => {
    const instruction = {
      fragments: [
        { key: 'revisit', promptTemplateId: T1, promptVersionNumber: 9, when: "context.visit_type == 'revisit'" },
        { key: 'base', promptTemplateId: T1, promptVersionNumber: 3 },
      ],
    };
    expect(primaryTemplateRef(instruction)).toEqual({
      path: 'instruction.fragments[1]',
      templateId: T1,
      versionNumber: 3,
      fragmentIndex: 1,
      fragmentKey: 'base',
    });
    expect(primaryTemplateId(instruction)).toBe(T1);
    // The naive lookup is exactly the bug: it answers the CONDITIONAL fragment's pin.
    expect(boundTemplateRefs(instruction).find((ref) => ref.templateId === T1)?.versionNumber).toBe(9);
  });

  it('form 1: the single ref; form 2 / none / all-conditional: null', () => {
    expect(primaryTemplateRef({ promptTemplateId: T1, promptVersionNumber: 2 })).toEqual({
      path: 'instruction',
      templateId: T1,
      versionNumber: 2,
      fragmentIndex: null,
      fragmentKey: null,
    });
    expect(primaryTemplateRef({ systemPrompt: 'x' })).toBeNull();
    expect(primaryTemplateRef(null)).toBeNull();
    expect(primaryTemplateRef({ fragments: [{ key: 'a', promptTemplateId: T1, when: 'true' }] })).toBeNull();
  });

  it('accepts the compiled spelling of unconditional (`when: null`) like `primaryTemplateId` does', () => {
    expect(primaryTemplateRef({ fragments: [{ key: 'base', promptTemplateId: T1, promptVersionNumber: 4, when: null }] })?.versionNumber).toBe(4);
  });
});

describe('readPromptFragments — the raw index travels with the fragment', () => {
  it('keeps the position in the AUTHORED list when a non-object entry is dropped', () => {
    const fragments = readPromptFragments({
      fragments: ['junk', { key: 'base', promptTemplateId: T1 }, null, { key: 'peds', systemPrompt: 'P', when: 'x' }],
    });
    expect(fragments.map((fragment) => [fragment.key, fragment.index])).toEqual([
      ['base', 1],
      ['peds', 3],
    ]);
    // And it agrees with the validator's / the ref reader's index space.
    expect(boundTemplateRefs({ fragments: ['junk', { key: 'base', promptTemplateId: T1 }] })[0]?.fragmentIndex).toBe(1);
  });
});
