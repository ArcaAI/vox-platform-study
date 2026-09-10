/**
 * TASK-950 W0-b (D-1/D-2/D-3) — the `userIdentity` MARKER: what may declare it, and what
 * it derives to.
 *
 * The marker is the one thing this ticket adds to the definition grammar, and it is a
 * MAPPING declaration: it names which already-declared property carries the tenant's staff
 * identifier so the gateway can resolve it to a `User` before a row is written. It
 * authorizes nobody, and it changes no payload contract — the last test in the first block
 * pins that `payloadSchemaFromDefinition` is byte-identical with and without it, which is
 * what keeps every frozen artifact's checksum stable.
 *
 * The publish gate is where a mis-declared marker has to be caught: a marker naming a
 * property that does not exist, or one on a kind with no single structured value to read,
 * is a defect the AUTHOR can fix and a live consultation cannot.
 */
import { describe, expect, it } from 'vitest';
import {
  contextSchemaDefinitionProblems,
  payloadSchemaFromDefinition,
  userIdentityBindingFromDefinition,
} from '../context-schema-definition';

/** The shape the seeded ArcaAI schemas use: ONE structured `context` kind with string properties. */
function structuredKind(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'context',
    label: 'Consultation Context',
    primitive: 'STRUCTURED',
    phiClass: 'NON_PHI',
    cardinality: 'ONE',
    lifecycle: 'PRE',
    producedBy: ['CLIENT'],
    fields: {
      type: 'object',
      properties: {
        consultant_id: { type: 'string' },
        visit_type: { type: 'string' },
        attachment_count: { type: 'number' },
      },
    },
    ...overrides,
  };
}

function definition(...kinds: Record<string, unknown>[]): Record<string, unknown> {
  return { schemaVersion: '1.0', kinds };
}

const MARKER = { field: 'consultant_id' };

describe('contextSchemaDefinitionProblems — the userIdentity marker (test 1)', () => {
  it('ACCEPTS the marker on a STRUCTURED / ONE kind naming a string property', () => {
    expect(contextSchemaDefinitionProblems(definition(structuredKind({ userIdentity: MARKER })))).toEqual([]);
  });

  it('accepts a definition with no marker at all — the marker is never required', () => {
    expect(contextSchemaDefinitionProblems(definition(structuredKind()))).toEqual([]);
  });
});

describe('contextSchemaDefinitionProblems — where the marker may NOT go (test 2)', () => {
  it('REJECTS the marker on a TEXT kind — there is no property table to name a field in', () => {
    const textKind = {
      key: 'case_note',
      label: 'Case Note',
      primitive: 'TEXT',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'ANY',
      producedBy: ['CLIENT'],
      userIdentity: MARKER,
    };
    const problems = contextSchemaDefinitionProblems(definition(textKind)).join(' ');
    expect(problems).toMatch(/userIdentity/);
    expect(problems).toMatch(/STRUCTURED/);
  });

  it('REJECTS the marker on a MANY kind — one identifier cannot come from a repeated value', () => {
    const problems = contextSchemaDefinitionProblems(definition(structuredKind({ cardinality: 'MANY', userIdentity: MARKER }))).join(' ');
    expect(problems).toMatch(/userIdentity/);
    expect(problems).toMatch(/cardinality ONE/);
  });
});

describe('contextSchemaDefinitionProblems — the named property (test 3)', () => {
  it('REJECTS a field the kind does not declare, NAMING the property', () => {
    const problems = contextSchemaDefinitionProblems(definition(structuredKind({ userIdentity: { field: 'staff_no' } }))).join(' ');
    expect(problems).toMatch(/staff_no/);
    expect(problems).toMatch(/fields\.properties/);
  });

  it('REJECTS a declared property that is not a string, NAMING the property', () => {
    const problems = contextSchemaDefinitionProblems(definition(structuredKind({ userIdentity: { field: 'attachment_count' } }))).join(' ');
    expect(problems).toMatch(/attachment_count/);
    expect(problems).toMatch(/string/);
  });

  it('REJECTS a missing / empty / non-string `field`', () => {
    expect(contextSchemaDefinitionProblems(definition(structuredKind({ userIdentity: {} }))).join(' ')).toMatch(/userIdentity\.field/);
    expect(contextSchemaDefinitionProblems(definition(structuredKind({ userIdentity: { field: '   ' } }))).join(' ')).toMatch(/userIdentity\.field/);
    expect(contextSchemaDefinitionProblems(definition(structuredKind({ userIdentity: { field: 7 } }))).join(' ')).toMatch(/userIdentity\.field/);
  });

  it('REJECTS a marker that is not a plain object, or that carries any key but `field`', () => {
    expect(contextSchemaDefinitionProblems(definition(structuredKind({ userIdentity: 'consultant_id' }))).join(' ')).toMatch(/userIdentity/);
    const extra = contextSchemaDefinitionProblems(definition(structuredKind({ userIdentity: { field: 'consultant_id', tenantScoped: true } }))).join(' ');
    expect(extra).toMatch(/tenantScoped/);
  });
});

describe('contextSchemaDefinitionProblems — at most ONE marker per definition (test 4)', () => {
  it('reports ONE definition-level problem naming BOTH kinds', () => {
    const second = structuredKind({ key: 'intake', label: 'Intake', userIdentity: { field: 'consultant_id' } });
    const problems = contextSchemaDefinitionProblems(definition(structuredKind({ userIdentity: MARKER }), second));

    const definitionLevel = problems.filter((problem) => problem.startsWith('definition: at most one kind'));
    expect(definitionLevel).toHaveLength(1);
    expect(definitionLevel[0]).toMatch(/`context`/);
    expect(definitionLevel[0]).toMatch(/`intake`/);
  });

  it('is silent when only one kind carries it, even beside several unmarked kinds', () => {
    const plain = structuredKind({ key: 'intake', label: 'Intake' });
    expect(contextSchemaDefinitionProblems(definition(structuredKind({ userIdentity: MARKER }), plain))).toEqual([]);
  });
});

describe('userIdentityBindingFromDefinition (test 5)', () => {
  it('returns the marked kind key and field', () => {
    expect(userIdentityBindingFromDefinition(definition(structuredKind({ userIdentity: MARKER })))).toEqual({
      kindKey: 'context',
      field: 'consultant_id',
    });
  });

  it('finds the marker whichever kind carries it', () => {
    const marked = structuredKind({ key: 'intake', label: 'Intake', userIdentity: MARKER });
    expect(userIdentityBindingFromDefinition(definition(structuredKind(), marked))).toEqual({ kindKey: 'intake', field: 'consultant_id' });
  });

  it('returns null when no kind declares one', () => {
    expect(userIdentityBindingFromDefinition(definition(structuredKind()))).toBeNull();
  });

  it('is TOTAL — malformed input yields null rather than throwing', () => {
    for (const input of [null, undefined, 42, 'schema', [], {}, { kinds: 'nope' }, { kinds: [null, 3] }]) {
      expect(userIdentityBindingFromDefinition(input)).toBeNull();
    }
    expect(userIdentityBindingFromDefinition(definition(structuredKind({ userIdentity: { field: '' } })))).toBeNull();
    expect(userIdentityBindingFromDefinition(definition(structuredKind({ userIdentity: 'consultant_id' })))).toBeNull();
  });

  it('leaves the derived payload schema BYTE-IDENTICAL — no frozen checksum moves', () => {
    const without = payloadSchemaFromDefinition(definition(structuredKind()));
    const with_ = payloadSchemaFromDefinition(definition(structuredKind({ userIdentity: MARKER })));

    expect(JSON.stringify(with_)).toBe(JSON.stringify(without));
  });
});
