/**
 * TASK-947 (OD-10) — phase 26 re-points EVERY template an agent binds at the tenant's clone,
 * which since this ticket means each template FRAGMENT of a composite instruction, not only the
 * single `promptTemplateId` of form 1. The traversal is this package's deliberate twin of
 * `boundTemplateRefs` / `mapBoundTemplateRefs` in `@arcaai/workflow-contract` (no contract
 * dependency here); these cases pin the same semantics the contract's own suite pins.
 */
import { describe, expect, it } from 'vitest';

import { boundTemplateIdsOf, repointInstructionTemplates, type PromptTemplateClone } from '../26-tenant-reference-set';

const S1 = '71000000-0000-0000-0001-000000000001';
const S2 = '71000000-0000-0000-0001-000000000002';
const S3 = '71000000-0000-0000-0001-000000000003';

const clones = new Map<string, PromptTemplateClone>([
  [S1, { id: 'clone-1', approvedVersionNumber: 1 }],
  [S2, { id: 'clone-2', approvedVersionNumber: null }],
]);

const composite = {
  fragments: [
    { key: 'peds', systemPrompt: 'The patient is a minor.', when: 'has(context.patient_age) && context.patient_age < 18' },
    { key: 'base', promptTemplateId: S1, promptVersionNumber: 4 },
    { key: 'revisit', promptTemplateId: S2, promptVersionNumber: 2, when: "context.visit_type == 'revisit'" },
    { key: 'unknown', promptTemplateId: S3 },
    { key: 'again', promptTemplateId: S1 },
  ],
  variables: { language: { path: 'context.language' } },
};

describe('boundTemplateIdsOf', () => {
  it('form 1: the single bound id; form 2 and null: nothing', () => {
    expect(boundTemplateIdsOf({ promptTemplateId: S1, promptVersionNumber: 2 })).toEqual([S1]);
    expect(boundTemplateIdsOf({ systemPrompt: 'Be brief.' })).toEqual([]);
    expect(boundTemplateIdsOf(null)).toEqual([]);
  });

  it('form 3: each TEMPLATE fragment`s id, in order, de-duplicated; inline fragments contribute none', () => {
    expect(boundTemplateIdsOf(composite)).toEqual([S1, S2, S3]);
  });
});

describe('repointInstructionTemplates', () => {
  it('form 1: re-points at the clone; the pin follows the clone`s approved version, or is dropped when it has none', () => {
    expect(repointInstructionTemplates({ promptTemplateId: S1, promptVersionNumber: 4 }, clones)).toEqual({
      promptTemplateId: 'clone-1',
      promptVersionNumber: 1,
    });
    expect(repointInstructionTemplates({ promptTemplateId: S2, promptVersionNumber: 4 }, clones)).toEqual({ promptTemplateId: 'clone-2' });
    expect(repointInstructionTemplates({ promptTemplateId: S3, promptVersionNumber: 4 }, clones)).toEqual({
      promptTemplateId: S3,
      promptVersionNumber: 4,
    });
  });

  it('form 3: re-points every template fragment with a clone, leaves inline and unknown ones verbatim, keeps every other field', () => {
    const next = repointInstructionTemplates(composite, clones);
    expect(next).toEqual({
      fragments: [
        composite.fragments[0],
        { key: 'base', promptTemplateId: 'clone-1', promptVersionNumber: 1 },
        { key: 'revisit', promptTemplateId: 'clone-2', when: "context.visit_type == 'revisit'" },
        { key: 'unknown', promptTemplateId: S3 },
        { key: 'again', promptTemplateId: 'clone-1', promptVersionNumber: 1 },
      ],
      variables: { language: { path: 'context.language' } },
    });
  });

  it('form 2 and null pass through; the input is never mutated', () => {
    expect(repointInstructionTemplates({ systemPrompt: 'x' }, clones)).toEqual({ systemPrompt: 'x' });
    expect(repointInstructionTemplates(null, clones)).toBeNull();
    const frozen = JSON.parse(JSON.stringify(composite)) as typeof composite;
    repointInstructionTemplates(frozen, clones);
    expect(frozen).toEqual(composite);
  });
});
