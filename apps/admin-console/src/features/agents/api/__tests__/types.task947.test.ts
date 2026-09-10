/**
 * TASK-947 — pure helpers for the third TEXT_GENERATION instruction form: an ordered list of
 * prompt fragments (`instructionForm`, `readFragments`). No network; these are plain functions
 * over `Agent.instruction`'s raw JSON shape, deliberately hand-written rather than imported from
 * `@arcaai/workflow-contract` — that package's `agent-instruction.ts` helpers land in a later
 * lane (Lane 0) than this console feature (Lane D, §4.2 OD-13/OD-2).
 */
import { describe, expect, it } from 'vitest';
import { instructionForm, readFragments, type PromptFragment } from '../types';

describe('instructionForm', () => {
  it('is "none" for a null/absent/empty instruction', () => {
    expect(instructionForm(null)).toBe('none');
    expect(instructionForm(undefined)).toBe('none');
    expect(instructionForm({})).toBe('none');
  });

  it('is "template" for a promptTemplateId-bound instruction', () => {
    expect(instructionForm({ promptTemplateId: 'tpl-1' })).toBe('template');
  });

  it('is "inline" for a systemPrompt instruction', () => {
    expect(instructionForm({ systemPrompt: 'You are a scribe.' })).toBe('inline');
  });

  it('is "fragments" for a fragment-list instruction, even an empty one', () => {
    expect(instructionForm({ fragments: [] })).toBe('fragments');
    expect(instructionForm({ fragments: [{ key: 'base', promptTemplateId: 'tpl-1' }] })).toBe('fragments');
  });

  it('prefers "fragments" when a malformed instruction somehow carries both shapes', () => {
    expect(instructionForm({ fragments: [], promptTemplateId: 'tpl-1' })).toBe('fragments');
  });
});

describe('readFragments', () => {
  const FRAGMENTS: PromptFragment[] = [
    { key: 'base', promptTemplateId: 'tpl-1', promptVersionNumber: 3 },
    { key: 'revisit', promptTemplateId: 'tpl-2', when: "has(context.visit_type) && context.visit_type == 'revisit'" },
    { key: 'peds', systemPrompt: 'The patient is a minor.', when: 'has(context.patient_age) && context.patient_age < 18' },
  ];

  it('returns the fragment list of a composite instruction, in authored order', () => {
    expect(readFragments({ fragments: FRAGMENTS })).toEqual(FRAGMENTS);
  });

  it('returns [] for a template or inline instruction, or none at all', () => {
    expect(readFragments({ promptTemplateId: 'tpl-1' })).toEqual([]);
    expect(readFragments({ systemPrompt: 'x' })).toEqual([]);
    expect(readFragments(null)).toEqual([]);
  });

  it('drops a malformed entry (missing key) rather than throwing', () => {
    expect(readFragments({ fragments: [{ promptTemplateId: 'tpl-1' }, { key: 'ok', systemPrompt: 'x' }] })).toEqual([{ key: 'ok', systemPrompt: 'x' }]);
  });
});
