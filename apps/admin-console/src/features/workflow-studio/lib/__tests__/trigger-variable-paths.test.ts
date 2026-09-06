/**
 * TASK-890 black-box J4-F5 — the concrete `{{trigger.…}}` paths a workflow actually offers.
 *
 * The prompt-variable chips offered the four namespace ROOTS only (`trigger.`, `context.`,
 * `vars.`, `nodes.`), so an admin was left to guess the rest — and the guess is wrong in a way
 * nothing catches: a trigger payload is keyed by the context schema's KIND KEY, so the path is
 * `{{trigger.<kindKey>.<field>}}`, never `{{trigger.<field>}}`.
 *
 * This derives those paths from whatever the trigger is bound to, mirroring
 * `payloadSchemaFromDefinition` (`@arcaai/applications` — a SERVER package the console cannot
 * import): one property per declared kind, and a STRUCTURED kind additionally contributes its own
 * declared fields. An inline schema is already in payload shape, so it is read directly.
 */
import { describe, expect, it } from 'vitest';
import { triggerVariablePaths } from '../trigger-variable-paths';

const DEFINITION = {
  schemaVersion: '1.0',
  kinds: [
    { key: 'consultation_note', label: 'Note', primitive: 'TEXT' },
    {
      key: 'intake_form',
      label: 'Intake',
      primitive: 'STRUCTURED',
      fields: { type: 'object', properties: { chiefComplaint: { type: 'string' }, allergies: { type: 'string' } } },
    },
  ],
  outputs: [{ key: 'discharge_letter', primitive: 'DOCUMENT' }],
};

describe('triggerVariablePaths', () => {
  it('names one path per declared kind, plus each field of a STRUCTURED kind', () => {
    expect(triggerVariablePaths({ definition: DEFINITION })).toEqual([
      'trigger.consultation_note',
      'trigger.intake_form',
      'trigger.intake_form.chiefComplaint',
      'trigger.intake_form.allergies',
    ]);
  });

  it('ignores outputs — an output is produced BY the run, never supplied to it', () => {
    expect(triggerVariablePaths({ definition: DEFINITION })).not.toContain('trigger.discharge_letter');
  });

  it('reads an inline schema, which is already in payload shape', () => {
    const inline = {
      type: 'object',
      properties: { patientId: { type: 'string' }, vitals: { type: 'object', properties: { bp: { type: 'string' } } } },
    };
    expect(triggerVariablePaths({ inline })).toEqual(['trigger.patientId', 'trigger.vitals', 'trigger.vitals.bp']);
  });

  it('answers an empty list for an unbound / unreadable trigger rather than inventing paths', () => {
    expect(triggerVariablePaths({})).toEqual([]);
    expect(triggerVariablePaths({ definition: null, inline: null })).toEqual([]);
    expect(triggerVariablePaths({ definition: { kinds: 'nope' } })).toEqual([]);
  });
});
