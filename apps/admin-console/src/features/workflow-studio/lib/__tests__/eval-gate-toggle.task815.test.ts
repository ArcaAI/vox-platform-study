/**
 * / OD-11 — "Tenant admin will enable or disable if needed."
 *
 * The eval gate's binding moved off `DepartmentAgent.goldenSetId` onto the
 * workflow node that references the prompt template, and OD-11 requires the
 * tenant admin to be able to turn it off. That control has to be REACHABLE:
 * the node inspector builds its form from the config schema alone, so an
 * `evalGate` the generator cannot represent would leave the toggle with no UI
 * and the requirement unmet — while every unit test on the resolver side still
 * passed.
 *
 * This is the test that the control actually renders as a control.
 */
import { describe, expect, it } from 'vitest';
import { NODE_CONFIG_SCHEMAS } from '@arcaai/workflow-contract';
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

const GATED_NODE_KEYS = ['generate.text', 'consultation.synthesize', 'consultation.realtimeSummary'] as const;

describe('the eval gate is an authorable control in the node inspector', () => {
  it.each(GATED_NODE_KEYS)('%s renders evalGate as a group, not a raw-JSON escape hatch', (key) => {
    const fields = toFieldDescriptors(NODE_CONFIG_SCHEMAS[key]);
    const gate = findField(fields, 'evalGate');

    expect(gate).toBeDefined();
    // `raw-json` would technically let an admin edit the gate, but as free text
    // with no validation and no visible toggle — which is not "a tenant admin
    // can enable or disable it", it is "a tenant admin can hand-write JSON".
    expect(gate?.kind).toBe('group');
  });

  it.each(GATED_NODE_KEYS)('%s renders the enable/disable toggle as a boolean field', (key) => {
    const fields = toFieldDescriptors(NODE_CONFIG_SCHEMAS[key]);
    const enabled = findField(fields, 'evalGate.enabled');

    expect(enabled).toBeDefined();
    expect(enabled?.kind).toBe('boolean');
    expect(enabled?.required).toBe(true);
  });

  it.each(GATED_NODE_KEYS)('%s renders the golden-set binding as a string field', (key) => {
    const fields = toFieldDescriptors(NODE_CONFIG_SCHEMAS[key]);
    const goldenSetId = findField(fields, 'evalGate.goldenSetId');

    expect(goldenSetId).toBeDefined();
    expect(goldenSetId?.kind).toBe('string');
    expect(goldenSetId?.required).toBe(true);
  });
});
