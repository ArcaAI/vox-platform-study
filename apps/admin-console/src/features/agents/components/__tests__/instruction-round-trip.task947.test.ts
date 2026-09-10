/**
 * TASK-947 §4.5 item 2 — `instructionToBinding` (seeds the editor from `Agent.instruction`) and
 * `instructionFromBinding` (serializes the editor state back) are the ONE pair the create wizard
 * and the edit-draft form both use, so the two paths cannot drift. This proves the round trip is
 * the identity for all three TEXT_GENERATION instruction forms: instruction JSON → editor state
 * → instruction JSON.
 */
import { describe, expect, it } from 'vitest';
import { instructionFromBinding, instructionToBinding } from '../instruction-binding-form';

describe('instructionToBinding / instructionFromBinding — round trip', () => {
  it('form 1 (template): promptTemplateId + a pinned version + variables round-trips exactly', () => {
    const instruction = {
      promptTemplateId: 'tpl-1',
      promptVersionNumber: 3,
      variables: { language: { path: 'context.language' }, tone: { value: 'formal' } },
    };
    const binding = instructionToBinding(instruction, null, null);
    expect(binding.mode).toBe('template');
    expect(instructionFromBinding(binding)).toEqual(instruction);
  });

  it('form 1 (template): no version pin (follow approved) omits promptVersionNumber both ways', () => {
    const instruction = { promptTemplateId: 'tpl-1' };
    const binding = instructionToBinding(instruction, null, null);
    expect(binding.promptVersionNumber).toBeNull();
    expect(instructionFromBinding(binding)).toEqual(instruction);
  });

  it('form 2 (inline): systemPrompt round-trips exactly', () => {
    const instruction = { systemPrompt: 'You are a scribe. Write a SOAP note.' };
    const binding = instructionToBinding(instruction, null, null);
    expect(binding.mode).toBe('inline');
    expect(instructionFromBinding(binding)).toEqual(instruction);
  });

  it('form 3 (fragments): the §4.1 example — template + when, template + when, inline + when, agent-level variables — round-trips exactly, in order', () => {
    const instruction = {
      fragments: [
        { key: 'base', promptTemplateId: 'tpl-1', promptVersionNumber: 3 },
        { key: 'revisit', promptTemplateId: 'tpl-1', when: "has(context.visit_type) && context.visit_type == 'revisit'" },
        { key: 'peds', systemPrompt: 'The patient is a minor …', when: 'has(context.patient_age) && context.patient_age < 18' },
      ],
      variables: { language: { path: 'context.language' } },
    };
    const binding = instructionToBinding(instruction, null, null);
    expect(binding.mode).toBe('fragments');
    expect(binding.fragments).toHaveLength(3);
    expect(instructionFromBinding(binding)).toEqual(instruction);
  });

  it('form 3 (fragments): a template fragment with no version pin omits promptVersionNumber both ways', () => {
    const instruction = { fragments: [{ key: 'base', promptTemplateId: 'tpl-1' }] };
    expect(instructionFromBinding(instructionToBinding(instruction, null, null))).toEqual(instruction);
  });

  it('carries contextSchemaId/contextSchemaVersionNumber through unchanged (agent-level, not inside instruction)', () => {
    const binding = instructionToBinding({ systemPrompt: 'x' }, 'schema-1', 2);
    expect(binding.contextSchemaId).toBe('schema-1');
    expect(binding.contextSchemaVersionNumber).toBe(2);
  });

  it('defaults to template mode, with no template chosen, for a null/empty instruction', () => {
    const binding = instructionToBinding(null, null, null);
    expect(binding.mode).toBe('template');
    expect(binding.promptTemplateId).toBeNull();
    expect(instructionFromBinding(binding)).toBeUndefined();
  });
});
