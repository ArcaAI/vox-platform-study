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
 * It also pins the NEGATIVE half. TASK-890 D-1 (owner decision, 2026-09-06) MOVED where that
 * half applies: a tenant MAY opt out of platform guardrail screening per agent / workflow / node,
 * so the seven clinical guard nodes now DO offer the toggle, with a publish WARNING
 * (`GUARDRAIL_OPTED_OUT`), a per-call ledger attribute and an observable
 * `SKIPPED(disabled_by_config)` step as the compensating controls. What still offers no disable
 * control anywhere in the generated form is:
 *
 *   - the two GRAPH BOUNDARIES (`core.trigger`, `core.output`) — a disabled entry is a graph that
 *     cannot start and a disabled exit one that cannot deliver, which is an unrunnable graph
 *     rather than a guardrail opinion;
 *   - `consultation.hitlGate`, the human sign-off, which carries no runtime knobs at all
 *     (TASK-859 invariant 5: the system never signs).
 *
 * A `raw-json` fallback would technically satisfy "the schema has no `enabled`" while still
 * handing an admin a free-text editor, so the assertion is on the whole descriptor list, not just
 * on a missing field.
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

/** D-1: the clinical guard nodes now OFFER the toggle — the opt-out is authorable, and recorded. */
const GUARD_NODE_KEYS = [
  'consultation.consentGate',
  'consultation.captureBinding',
  'consultation.phiHop',
  'consultation.persistDraft',
  'consultation.finalizeAssurance',
] as const;

/** What still offers NO way to switch it off. */
const UNDISABLEABLE_NODE_KEYS = ['core.trigger', 'core.output', 'consultation.hitlGate'] as const;

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

describe('a clinical guard node renders the toggle too, since D-1 (TASK-890)', () => {
  it.each(GUARD_NODE_KEYS)('%s renders `enabled` as a boolean field, defaulting to on', (key) => {
    const enabled = findField(toFieldDescriptors(NODE_CONFIG_SCHEMAS[key]), 'enabled');

    expect(enabled).toBeDefined();
    expect(enabled?.kind).toBe('boolean');
    // ABSENT MEANS ON is unchanged: opting out is a deliberate authoring act, never a default.
    expect(enabled?.kind === 'boolean' ? enabled.default : undefined).toBe(true);
  });
});

describe('a graph boundary and the human sign-off offer no way to switch them off', () => {
  it.each(UNDISABLEABLE_NODE_KEYS)('%s has no `enabled` field, and no raw-JSON editor over the whole config', (key) => {
    const fields = toFieldDescriptors(NODE_CONFIG_SCHEMAS[key]);

    expect(findField(fields, 'enabled')).toBeUndefined();
    // A raw-JSON descriptor over ONE typed-but-unrepresentable property (`core.trigger`'s
    // `sampleInput`) cannot reintroduce a disable switch — an object written there is that
    // property's value, not the node config. What would is a raw-JSON editor over the config
    // ITSELF, which is what this asserts is absent.
    expect(fields.filter((field) => field.kind === 'raw-json' && (field.path === '' || field.path === 'config'))).toEqual([]);
  });

  // `consultation.hitlGate` is stricter still: it sits in `RUNTIME_PROPERTY_EXCLUSIONS`, so it
  // offers NO runtime knob and no escape hatch of any kind (TASK-859 invariant 5).
  it('consultation.hitlGate offers no raw-JSON escape hatch at all', () => {
    const fields = toFieldDescriptors(NODE_CONFIG_SCHEMAS['consultation.hitlGate']);

    expect(fields.filter((field) => field.kind === 'raw-json')).toEqual([]);
  });
});
