/**
 * item 3 — the `enabled` toggle renders as a CONTROL, with no Studio code change.
 *
 * The claim the ticket rests on is that declaring `enabled` on the node config schemas is
 * sufficient: the inspector builds its form from `Object.entries(schema.properties)` alone
 * (`inspector-panel.tsx` -> `toFieldDescriptors`), and `field-renderers.tsx` already maps a
 * `boolean` descriptor to a shadcn `<Switch>`. This file is what makes that claim checkable
 * rather than asserted — the same reason `eval-gate-toggle.task815.test.ts` exists for OD-11's
 * gate.
 *
 * It also pins the NEGATIVE half, which is the one that matters clinically: a mandatory node
 * must have NO disable control anywhere in the generated form. A `raw-json` fallback would
 * technically satisfy "the schema has no `enabled`" while still handing an admin a free-text
 * editor, so the assertion is on the whole descriptor list, not just on a missing field.
 */
import { NODE_CONFIG_SCHEMAS } from '@arcaai/workflow-contract';
import { describe, expect, it } from 'vitest';
import { toFieldDescriptors, type FieldDescriptor } from '../schema-form';

function findField(fields: FieldDescriptor[], path: string): FieldDescriptor | undefined {
  for (const field of fields) {
    if (field.path === path) return field;
    if (field.kind === 'group') {
      const nested = findField(field.fields, path);
      if (nested) return nested;
    }
  }
  return undefined;
}

const TOGGLEABLE_NODE_KEYS = [
  'consultation.realtimeSummary',
  'consultation.extractEntities',
  'consultation.sensors',
  'consultation.suggestions',
  'agent.important_findings',
] as const;

const MANDATORY_NODE_KEYS = [
  'consultation.consentGate',
  'consultation.captureBinding',
  'consultation.phiHop',
  'consultation.persistDraft',
  'consultation.finalizeAssurance',
  'consultation.hitlGate',
] as const;

describe('the per-node enable/disable toggle is an authorable control in the node inspector', () => {
  it.each(TOGGLEABLE_NODE_KEYS)('%s renders `enabled` as a boolean field, defaulting to on', (key) => {
    const enabled = findField(toFieldDescriptors(NODE_CONFIG_SCHEMAS[key]), 'enabled');

    expect(enabled).toBeDefined();
    // `boolean` is what `field-renderers.tsx` draws as a `<Switch>`; `raw-json` would be
    // "an admin can hand-write JSON", which is not a toggle.
    expect(enabled?.kind).toBe('boolean');
    expect(enabled?.kind === 'boolean' ? enabled.default : undefined).toBe(true);
    expect(enabled?.required).toBe(false);
  });
});

describe('a mandatory node offers no way to switch it off', () => {
  it.each(MANDATORY_NODE_KEYS)('%s has no `enabled` field and no raw-JSON escape hatch', (key) => {
    const fields = toFieldDescriptors(NODE_CONFIG_SCHEMAS[key]);

    expect(findField(fields, 'enabled')).toBeUndefined();
    expect(fields.filter((field) => field.kind === 'raw-json')).toEqual([]);
  });
});
