/**
 * VISIT TYPE AS THE PROMPT-COMPOSITION IDENTIFIER (owner directive, quoted in
 * TASK-815 §15e).
 *
 * > "Visit type is an identifier where the hope platform configure and compose
 * > the instructions and consultation context as prompt for agent to work on:
 * > pre-summarization OR summarization OR any text generation task."
 *
 * Lane B made the visit type tenant-configured DATA. It was still only a
 * two-column pointer: a catalogue entry could say which of `Department`'s two
 * prompt columns it read, and nothing else, for one task (finalize). A tenant
 * that defined a third visit type had to borrow one of the two slots, and the
 * PRE-SUMMARY chain had no visit-type axis at all.
 *
 * These tests pin the generalisation: a catalogue entry carries a binding PER
 * TEXT-GENERATION TASK, so `(task, visitType)` is what selects the instructions
 * and the context composition — through the same tenant → SYSTEM cascade, with
 * no second resolver and no new settings key.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSULTATION_VISIT_TYPES_DEFAULT,
  VISIT_TYPE_PROMPT_TASKS,
  matchVisitType,
  visitTypeCatalogueProblem,
  visitTypePromptBinding,
  type VisitTypeDefinition,
} from '../visit-type.catalogue';

const NEW_PATIENT: VisitTypeDefinition = {
  key: 'new-patient',
  label: 'New patient',
  aliases: ['new-visit', 'referral'],
  promptSlot: 'new-patient',
};

const REVISIT: VisitTypeDefinition = {
  key: 'revisit',
  label: 'Revisit',
  aliases: ['follow-up', 're-visit'],
  promptSlot: 'revisit',
};

describe('the owner’s own spellings all resolve', () => {
  it('matches every term in "New visit/Referral OR Follow-up/Re-visit"', () => {
    const at = (raw: string) => matchVisitType(CONSULTATION_VISIT_TYPES_DEFAULT, raw)?.key;
    expect(at('New visit')).toBe('new-patient');
    expect(at('Referral')).toBe('new-patient');
    expect(at('Follow-up')).toBe('revisit');
    // The hyphenated spelling the owner wrote verbatim. It did NOT resolve
    // before: the key folds to `revisit`, and no alias folded to `re-visit`.
    expect(at('Re-visit')).toBe('revisit');
    expect(at('re-visit')).toBe('revisit');
  });
});

describe('the (task, visitType) prompt binding', () => {
  it('names the three text-generation tasks the platform ships', () => {
    expect([...VISIT_TYPE_PROMPT_TASKS]).toEqual(['summary', 'pre-summary', 'live']);
  });

  it('is absent on the shipped default — zero configured tenants change behaviour', () => {
    for (const entry of CONSULTATION_VISIT_TYPES_DEFAULT) {
      for (const task of VISIT_TYPE_PROMPT_TASKS) {
        expect(visitTypePromptBinding(entry, task)).toBeNull();
      }
    }
  });

  it('returns the binding a tenant configured for that exact task', () => {
    const entry: VisitTypeDefinition = {
      ...REVISIT,
      prompts: {
        'pre-summary': { promptTemplateId: 'tpl-presummary-revisit', promptVersionNumber: 3 },
        summary: { promptTemplateId: 'tpl-summary-revisit', contextVariables: { tone: 'brief' } },
      },
    };

    expect(visitTypePromptBinding(entry, 'pre-summary')).toEqual({ promptTemplateId: 'tpl-presummary-revisit', promptVersionNumber: 3 });
    expect(visitTypePromptBinding(entry, 'summary')?.contextVariables).toEqual({ tone: 'brief' });
    // A task the tenant said nothing about is a MISS, never a neighbour's
    // binding — a pre-summary prompt served for a live flush is the same
    // wrong-prompt class the capability split exists to kill.
    expect(visitTypePromptBinding(entry, 'live')).toBeNull();
  });

  it('folds task keys the same way it folds visit-type spellings', () => {
    const entry: VisitTypeDefinition = { ...REVISIT, prompts: { Pre_Summary: { promptTemplateId: 'tpl' } } };
    expect(visitTypePromptBinding(entry, 'pre-summary')?.promptTemplateId).toBe('tpl');
  });

  it('accepts a task key the platform does not ship — "any text generation task"', () => {
    const entry: VisitTypeDefinition = { ...REVISIT, prompts: { 'text.discharge-letter': { promptTemplateId: 'tpl-discharge' } } };
    expect(visitTypeCatalogueProblem([NEW_PATIENT, entry])).toBeUndefined();
    expect(visitTypePromptBinding(entry, 'text.discharge-letter')?.promptTemplateId).toBe('tpl-discharge');
  });
});

describe('what a tenant may NOT save', () => {
  const withPrompts = (prompts: unknown) => visitTypeCatalogueProblem([NEW_PATIENT, { ...REVISIT, prompts } as VisitTypeDefinition]);

  it('accepts an omitted binding map', () => {
    expect(visitTypeCatalogueProblem([NEW_PATIENT, REVISIT])).toBeUndefined();
  });

  it('refuses a non-object binding map', () => {
    expect(withPrompts([{ promptTemplateId: 'tpl' }])).toMatch(/'prompts'/);
  });

  it('refuses an empty task key', () => {
    expect(withPrompts({ '  ': { promptTemplateId: 'tpl' } })).toMatch(/task key/i);
  });

  it('refuses two task keys that fold onto one token', () => {
    expect(withPrompts({ 'pre-summary': { promptTemplateId: 'a' }, pre_summary: { promptTemplateId: 'b' } })).toMatch(/more than once/);
  });

  it('refuses a binding with no prompt template', () => {
    expect(withPrompts({ summary: { promptVersionNumber: 2 } })).toMatch(/promptTemplateId/);
  });

  it('refuses a non-integer / non-positive version pin', () => {
    expect(withPrompts({ summary: { promptTemplateId: 'tpl', promptVersionNumber: 0 } })).toMatch(/promptVersionNumber/);
    expect(withPrompts({ summary: { promptTemplateId: 'tpl', promptVersionNumber: 1.5 } })).toMatch(/promptVersionNumber/);
  });

  it('refuses non-object context variables', () => {
    expect(withPrompts({ summary: { promptTemplateId: 'tpl', contextVariables: ['a'] } })).toMatch(/contextVariables/);
  });
});
