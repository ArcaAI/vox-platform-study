/**
 * TASK-951 TDD items 1–2 — the OPEN-TIME markers (`department`, `visitType`, `externalRef`,
 * `materializeAs`, `streamContext`) and the one derivation that reads all of them.
 *
 * TASK-950 established the grammar with `userIdentity`; this file holds its four siblings to
 * exactly the same bar, because the failure they all guard against is the same one: a mapping
 * the AUTHOR could have fixed becoming a fault a live consultation discovers. Concretely —
 *
 *  - a marker only makes sense on a STRUCTURED kind with cardinality ONE (there is otherwise no
 *    single property table to read a value out of);
 *  - the named field has to EXIST and be a `string`, and for `visitType` its `enum` has to be
 *    visit types the catalogue actually knows;
 *  - `materializeAs: 'CASE_NOTE'` is a promise about the PAYLOAD's shape, so the shape is
 *    checked at publish rather than trusted at `open`;
 *  - five of the six name a ROLE only one kind may hold, which is a DEFINITION-level fact.
 *
 * The second half pins two ABSENCES the freeze sites depend on and which no amount of careful
 * code review keeps true on its own: {@link payloadSchemaFromDefinition} is byte-identical with
 * and without every marker, and `classifyDefinitionChange` treats adding / moving / removing one
 * as ADDITIVE. Both hold TODAY with no code in either module — that is the point of testing
 * them rather than an argument against it. Without these, a later change could quietly start
 * moving frozen checksums or demanding `allowBreakingChange` for a mapping edit, and nothing
 * would say so.
 */
import { describe, expect, it } from 'vitest';
import {
  contextSchemaDefinitionProblems,
  openBindingsFromDefinition,
  payloadSchemaFromDefinition,
  userIdentityBindingFromDefinition,
} from '../context-schema-definition';
import { classifyDefinitionChange } from '../definition-diff';
import { CONSULTATION_VISIT_TYPES_DEFAULT } from '../../consultation/visit-type/visit-type.catalogue';

/**
 * `CONTEXT_SCHEMA_DEFINITION_VERSION`. Spelt out rather than imported so a change to the
 * platform's own version string surfaces here as a deliberate edit.
 */
const SCHEMA_VERSION = '1.0';

function definition(...kinds: Record<string, unknown>[]): Record<string, unknown> {
  return { schemaVersion: SCHEMA_VERSION, kinds };
}

/** A STRUCTURED / ONE kind carrying one property of every type a marker might name. */
function host(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'encounter',
    label: 'Encounter',
    primitive: 'STRUCTURED',
    phiClass: 'NON_PHI',
    cardinality: 'ONE',
    lifecycle: 'PRE',
    producedBy: ['CLIENT'],
    fields: {
      type: 'object',
      properties: {
        doctor_id: { type: 'string' },
        event_id: { type: 'string' },
        department_code: { type: 'string' },
        department_name: { type: 'string' },
        visit_type: { type: 'string', enum: ['new-visit', 'revisit'] },
        attachment_count: { type: 'number' },
      },
    },
    ...overrides,
  };
}

/** The `previous_case_notes` shape `materializeAs: 'CASE_NOTE'` requires. */
function notesKind(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'previous_case_notes',
    label: 'Previous case notes',
    primitive: 'STRUCTURED',
    phiClass: 'PHI',
    cardinality: 'ONE',
    lifecycle: 'PRE',
    producedBy: ['CLIENT'],
    fields: {
      type: 'object',
      properties: {
        notes: {
          type: 'array',
          items: {
            type: 'object',
            properties: { date: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' } },
            required: ['text'],
          },
        },
      },
      required: ['notes'],
    },
    materializeAs: 'CASE_NOTE',
    ...overrides,
  };
}

const ALL_MARKERS: Record<string, unknown> = {
  userIdentity: { field: 'doctor_id' },
  department: { field: 'department_code', by: 'code' },
  visitType: { field: 'visit_type' },
  externalRef: { field: 'event_id' },
  streamContext: true,
};

/** Each `{ field }`-shaped marker, on its own, for the table-driven cases below. */
const FIELD_MARKERS: [string, Record<string, unknown>][] = [
  ['userIdentity', { field: 'doctor_id' }],
  ['department', { field: 'department_code', by: 'code' }],
  ['visitType', { field: 'visit_type' }],
  ['externalRef', { field: 'event_id' }],
];

/** Those four plus `streamContext` — the five roles only ONE kind may hold. */
const SINGLETON_MARKERS: [string, unknown][] = [...FIELD_MARKERS, ['streamContext', true]];

const DEPARTMENT_BY_CODE = { field: 'department_code', by: 'code' };
const DEPARTMENT_BY_NAME = { field: 'department_code', by: 'name' };

/** The unmarked audio kind both ArcaAI schemas open with. */
const AUDIO_STREAM_KIND = {
  key: 'audio_stream',
  label: 'Audio stream',
  primitive: 'STREAM_AUDIO',
  phiClass: 'PHI',
  cardinality: 'ONE',
  lifecycle: 'DURING',
  producedBy: ['CLIENT'],
};

// ============================================================
// Item 1 — the grammar
// ============================================================

describe('contextSchemaDefinitionProblems — the open-time markers publish cleanly', () => {
  it('accepts all five role markers plus materializeAs across two kinds', () => {
    expect(contextSchemaDefinitionProblems(definition(host(ALL_MARKERS), notesKind()))).toEqual([]);
  });

  it.each(FIELD_MARKERS)('accepts `%s` on its own', (marker, value) => {
    expect(contextSchemaDefinitionProblems(definition(host({ [marker]: value })))).toEqual([]);
  });
});

describe('contextSchemaDefinitionProblems — a marker only sits on a STRUCTURED kind with cardinality ONE', () => {
  const nonStructured = {
    key: 'audio_stream',
    label: 'Audio',
    primitive: 'STREAM_AUDIO',
    phiClass: 'PHI',
    cardinality: 'ONE',
    lifecycle: 'DURING',
    producedBy: ['CLIENT'],
  };

  it.each(FIELD_MARKERS)('refuses `%s` on a non-STRUCTURED kind', (marker, value) => {
    const problems = contextSchemaDefinitionProblems(definition({ ...nonStructured, [marker]: value })).join(' ');
    expect(problems).toMatch(new RegExp(`${marker}[^]*STRUCTURED`));
  });

  it.each(FIELD_MARKERS)('refuses `%s` on a kind with cardinality MANY', (marker, value) => {
    const problems = contextSchemaDefinitionProblems(definition(host({ cardinality: 'MANY', [marker]: value }))).join(' ');
    expect(problems).toMatch(new RegExp(`${marker}[^]*cardinality ONE`));
  });

  it('refuses `streamContext` and `materializeAs` on the same two grounds', () => {
    const stream = contextSchemaDefinitionProblems(definition({ ...nonStructured, streamContext: true })).join(' ');
    expect(stream).toMatch(/streamContext[^]*STRUCTURED/);

    const materialize = contextSchemaDefinitionProblems(definition(notesKind({ cardinality: 'MANY' }))).join(' ');
    expect(materialize).toMatch(/materializeAs[^]*cardinality ONE/);
  });
});

describe('contextSchemaDefinitionProblems — the named field must exist and be a string', () => {
  it.each(FIELD_MARKERS)('refuses `%s` naming a property the kind does not declare', (marker, value) => {
    const problems = contextSchemaDefinitionProblems(definition(host({ [marker]: { ...value, field: 'no_such_property' } }))).join(' ');
    expect(problems).toMatch(/does not declare/);
  });

  it.each(FIELD_MARKERS)('refuses `%s` naming a non-string property', (marker, value) => {
    const problems = contextSchemaDefinitionProblems(definition(host({ [marker]: { ...value, field: 'attachment_count' } }))).join(' ');
    expect(problems).toMatch(/must name a property of type `string`/);
  });

  it.each(FIELD_MARKERS)('refuses `%s` with a missing, blank or non-string field', (marker, value) => {
    for (const field of [undefined, '   ', 7]) {
      const problems = contextSchemaDefinitionProblems(definition(host({ [marker]: { ...value, field } }))).join(' ');
      expect(problems).toMatch(new RegExp(`${marker}\\.field`));
    }
  });

  it.each(FIELD_MARKERS)('refuses `%s` that is not an object, or that carries an unknown key', (marker, value) => {
    expect(contextSchemaDefinitionProblems(definition(host({ [marker]: 'doctor_id' }))).join(' ')).toMatch(new RegExp(marker));
    const extra = contextSchemaDefinitionProblems(definition(host({ [marker]: { ...value, tenantScoped: true } }))).join(' ');
    expect(extra).toMatch(/unknown key `tenantScoped`/);
  });
});

describe('contextSchemaDefinitionProblems — `department.by`', () => {
  it('accepts `code` and `name`', () => {
    for (const by of ['code', 'name']) {
      expect(contextSchemaDefinitionProblems(definition(host({ department: { field: 'department_code', by } })))).toEqual([]);
    }
  });

  it('REQUIRES it — an unstated lookup rule is not a default anyone wrote down', () => {
    const problems = contextSchemaDefinitionProblems(definition(host({ department: { field: 'department_code' } }))).join(' ');
    expect(problems).toMatch(/department\.by is required/);
  });

  it('refuses anything else', () => {
    const problems = contextSchemaDefinitionProblems(definition(host({ department: { field: 'department_code', by: 'uuid' } }))).join(' ');
    expect(problems).toMatch(/department\.by[^]*code \| name/);
  });
});

describe('contextSchemaDefinitionProblems — `visitType` and the catalogue', () => {
  it('MIRRORS the catalogue keys — the hard pin in the grammar and the catalogue agree', () => {
    // The grammar deliberately hard-pins `['new-visit','revisit']` rather than importing the
    // consultation catalogue (a publish-time grammar must not depend on the consultation
    // service tree). This is the test that makes the mirror safe: add a visit type to
    // `visit-type.catalogue.ts` and this fails until the grammar learns it too.
    expect(CONSULTATION_VISIT_TYPES_DEFAULT.map((entry) => entry.key).sort()).toEqual(['new-visit', 'revisit']);
  });

  it('requires the named property to declare a non-empty enum', () => {
    const noEnum = host({ visitType: { field: 'department_code' } });
    expect(contextSchemaDefinitionProblems(definition(noEnum)).join(' ')).toMatch(/visitType\.field[^]*enum/);

    const emptyEnum = host({
      fields: { type: 'object', properties: { visit_type: { type: 'string', enum: [] } } },
      visitType: { field: 'visit_type' },
    });
    expect(contextSchemaDefinitionProblems(definition(emptyEnum)).join(' ')).toMatch(/visitType\.field[^]*enum/);
  });

  it('refuses an enum value the catalogue has never heard of, naming it', () => {
    const strange = host({
      fields: { type: 'object', properties: { visit_type: { type: 'string', enum: ['new-visit', 'third-visit'] } } },
      visitType: { field: 'visit_type' },
    });
    const problems = contextSchemaDefinitionProblems(definition(strange)).join(' ');
    expect(problems).toMatch(/`third-visit`/);
    expect(problems).not.toMatch(/`new-visit`.*are not visit types/);
  });

  it('refuses the ALIASES too — a schema declares canonical keys; matching aliases is a runtime concern', () => {
    const aliased = host({
      fields: { type: 'object', properties: { visit_type: { type: 'string', enum: ['new-patient', 'follow-up'] } } },
      visitType: { field: 'visit_type' },
    });
    expect(contextSchemaDefinitionProblems(definition(aliased)).join(' ')).toMatch(/are not visit types/);
  });

  it('accepts a NARROWER enum — one visit type is a legitimate schema', () => {
    const onlyNew = host({
      fields: { type: 'object', properties: { visit_type: { type: 'string', enum: ['new-visit'] } } },
      visitType: { field: 'visit_type' },
    });
    expect(contextSchemaDefinitionProblems(definition(onlyNew))).toEqual([]);
  });
});

describe('contextSchemaDefinitionProblems — `materializeAs: CASE_NOTE` demands the shape it promises', () => {
  it('refuses a target that is not CASE_NOTE', () => {
    expect(contextSchemaDefinitionProblems(definition(notesKind({ materializeAs: 'WORK_NOTE' }))).join(' ')).toMatch(
      /materializeAs must be one of CASE_NOTE/,
    );
    expect(contextSchemaDefinitionProblems(definition(notesKind({ materializeAs: true }))).join(' ')).toMatch(/materializeAs must be one of/);
  });

  it('refuses a kind with no `notes` array', () => {
    const flat = notesKind({ fields: { type: 'object', properties: { text: { type: 'string' } } } });
    expect(contextSchemaDefinitionProblems(definition(flat)).join(' ')).toMatch(/fields\.properties\.notes` to be an array/);
  });

  it('refuses `notes` whose items are not objects carrying a string `text`', () => {
    const stringItems = notesKind({ fields: { type: 'object', properties: { notes: { type: 'array', items: { type: 'string' } } } } });
    expect(contextSchemaDefinitionProblems(definition(stringItems)).join(' ')).toMatch(/notes\.items` to be an object schema/);

    const titleOnlyItems = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    };
    const noText = notesKind({ fields: { type: 'object', properties: { notes: { type: 'array', items: titleOnlyItems } } } });
    expect(contextSchemaDefinitionProblems(definition(noText)).join(' ')).toMatch(/items\.properties\.text/);
  });

  it('refuses `notes` items whose `text` is not REQUIRED — an optional body materialises to nothing', () => {
    const optionalText = notesKind({
      fields: { type: 'object', properties: { notes: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } } } } } },
    });
    expect(contextSchemaDefinitionProblems(definition(optionalText)).join(' ')).toMatch(/items\.required` to include `text`/);
  });
});

describe('contextSchemaDefinitionProblems — `streamContext` is literally true', () => {
  it('accepts `true`', () => {
    expect(contextSchemaDefinitionProblems(definition(host({ streamContext: true })))).toEqual([]);
  });

  it('refuses `false`, a string and an object — one spelling, one meaning', () => {
    for (const value of [false, 'true', {}, { enabled: true }]) {
      expect(contextSchemaDefinitionProblems(definition(host({ streamContext: value }))).join(' ')).toMatch(/streamContext must be `true`/);
    }
  });
});

describe('contextSchemaDefinitionProblems — at most ONE kind per ROLE', () => {
  it.each(SINGLETON_MARKERS)('reports ONE definition-level problem for a duplicated `%s`, naming both kinds', (marker, value) => {
    const second = host({ key: 'intake', label: 'Intake', [marker]: value });
    const problems = contextSchemaDefinitionProblems(definition(host({ [marker]: value }), second));

    const definitionLevel = problems.filter((problem) => problem.startsWith('definition: at most one kind'));
    expect(definitionLevel).toHaveLength(1);
    expect(definitionLevel[0]).toMatch(new RegExp(`\`${marker}\``));
    expect(definitionLevel[0]).toMatch(/`encounter`/);
    expect(definitionLevel[0]).toMatch(/`intake`/);
  });

  it('reports the roles INDEPENDENTLY — two duplicated roles are two problems', () => {
    const second = host({ key: 'intake', label: 'Intake', department: { field: 'department_code', by: 'code' }, visitType: { field: 'visit_type' } });
    const first = host({ department: { field: 'department_code', by: 'code' }, visitType: { field: 'visit_type' } });

    const problems = contextSchemaDefinitionProblems(definition(first, second));
    const definitionLevel = problems.filter((problem) => problem.startsWith('definition: at most one kind'));
    expect(definitionLevel).toHaveLength(2);
    expect(definitionLevel.join(' ')).toMatch(/`department`/);
    expect(definitionLevel.join(' ')).toMatch(/`visitType`/);
  });

  it('permits SEVERAL kinds to declare `materializeAs` — it names a payload property, not a role', () => {
    const second = notesKind({ key: 'referral_notes', label: 'Referral notes' });
    expect(contextSchemaDefinitionProblems(definition(notesKind(), second))).toEqual([]);
  });

  it('is silent when each role sits on exactly one kind, even spread across kinds', () => {
    const identity = host({ key: 'staff', label: 'Staff', userIdentity: { field: 'doctor_id' } });
    const routing = host({ key: 'routing', label: 'Routing', department: DEPARTMENT_BY_CODE, visitType: { field: 'visit_type' } });
    expect(contextSchemaDefinitionProblems(definition(identity, routing))).toEqual([]);
  });
});

// ============================================================
// Item 2 — the derivation
// ============================================================

/**
 * The plan's Schema 2 (`arcaai_consultation_scribe`), trimmed to the kinds that carry markers
 * plus the two that do not, and corrected in one place: the plan writes `"schemaVersion": 1`
 * where the platform's only understood value is the STRING `'1.0'`.
 *
 * `vitals` is deliberately present and deliberately unmarked — lane A owns its payload shape,
 * and this fixture must not pin it. What it pins is that an unmarked kind contributes nothing
 * to the bindings.
 */
const SCRIBE_SCHEMA: Record<string, unknown> = {
  schemaVersion: SCHEMA_VERSION,
  kinds: [
    AUDIO_STREAM_KIND,
    {
      key: 'encounter',
      label: 'Encounter',
      primitive: 'STRUCTURED',
      phiClass: 'NON_PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      required: true,
      fields: {
        type: 'object',
        properties: {
          doctor_id: { type: 'string', minLength: 1 },
          event_id: { type: 'string', minLength: 1 },
          department_code: { type: 'string', minLength: 1 },
          department_name: { type: 'string' },
          visit_type: { type: 'string', enum: ['new-visit', 'revisit'] },
        },
        required: ['doctor_id', 'event_id', 'department_code', 'visit_type'],
      },
      userIdentity: { field: 'doctor_id' },
      department: { field: 'department_code', by: 'code' },
      visitType: { field: 'visit_type' },
      externalRef: { field: 'event_id' },
    },
    {
      key: 'vitals',
      label: 'Vitals',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      fields: {
        type: 'object',
        properties: { observations: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } },
      },
    },
    notesKind(),
    { key: 'work_note', label: 'Work note', primitive: 'TEXT', phiClass: 'PHI', cardinality: 'MANY', lifecycle: 'ANY', producedBy: ['CLIENT'] },
  ],
  outputs: [{ key: 'case_note', label: 'Case note', primitive: 'TEXT' }],
};

/** The plan's Schema 1 (`arcaai_realtime_transcription`), same correction. */
const TRANSCRIPTION_SCHEMA: Record<string, unknown> = {
  schemaVersion: SCHEMA_VERSION,
  kinds: [
    AUDIO_STREAM_KIND,
    {
      key: 'stream',
      label: 'Stream Metadata',
      primitive: 'STRUCTURED',
      phiClass: 'NON_PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      description: 'Client-owned identification of this audio stream.',
      fields: {
        type: 'object',
        properties: {
          mic_id: { type: 'string', minLength: 1 },
          speaker_label: { type: 'string' },
          channel: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['mic_id'],
        additionalProperties: true,
      },
      streamContext: true,
    },
  ],
};

describe('openBindingsFromDefinition — the two ArcaAI schemas', () => {
  it('publishes both fixtures cleanly — the derivation is tested on definitions the gate accepts', () => {
    expect(contextSchemaDefinitionProblems(SCRIBE_SCHEMA)).toEqual([]);
    expect(contextSchemaDefinitionProblems(TRANSCRIPTION_SCHEMA)).toEqual([]);
  });

  it('derives EXACTLY the scribe schema’s five mappings', () => {
    expect(openBindingsFromDefinition(SCRIBE_SCHEMA)).toEqual({
      userIdentity: { kindKey: 'encounter', field: 'doctor_id' },
      department: { kindKey: 'encounter', field: 'department_code', by: 'code' },
      visitType: { kindKey: 'encounter', field: 'visit_type' },
      externalRef: { kindKey: 'encounter', field: 'event_id' },
      materialize: [{ kindKey: 'previous_case_notes', as: 'CASE_NOTE' }],
    });
  });

  it('derives the transcription schema’s single stream binding, and nothing else', () => {
    expect(openBindingsFromDefinition(TRANSCRIPTION_SCHEMA)).toEqual({ streamContext: { kindKey: 'stream' } });
  });

  it('agrees with `userIdentityBindingFromDefinition` — one marker, two accessors, one answer', () => {
    // The older accessor answers `null` where this one omits the key; on a schema that DOES
    // declare the marker they must never disagree about which field it is.
    expect(openBindingsFromDefinition(SCRIBE_SCHEMA).userIdentity).toEqual(userIdentityBindingFromDefinition(SCRIBE_SCHEMA));
    expect(openBindingsFromDefinition(TRANSCRIPTION_SCHEMA).userIdentity).toBeUndefined();
    expect(userIdentityBindingFromDefinition(TRANSCRIPTION_SCHEMA)).toBeNull();
  });
});

describe('openBindingsFromDefinition — absence is absence', () => {
  it('returns `{}` for a definition that declares no markers', () => {
    expect(openBindingsFromDefinition(definition(host()))).toEqual({});
  });

  it('OMITS every unset key — never null, never an empty array', () => {
    const bindings = openBindingsFromDefinition(definition(host({ department: { field: 'department_code', by: 'name' } })));

    expect(Object.keys(bindings)).toEqual(['department']);
    expect(bindings).not.toHaveProperty('materialize');
    expect(bindings).not.toHaveProperty('userIdentity');
    expect(bindings.department).toEqual({ kindKey: 'encounter', field: 'department_code', by: 'name' });
  });

  it('is TOTAL — malformed input yields `{}` rather than throwing', () => {
    for (const input of [null, undefined, 42, 'schema', [], {}, { kinds: 'nope' }, { kinds: [null, 3] }]) {
      expect(openBindingsFromDefinition(input)).toEqual({});
    }
  });

  it('skips a marker the publish gate would have refused, rather than inventing a rule for it', () => {
    // A `department` with no usable `by` cannot be resolved without HOPE choosing a lookup rule
    // the author never wrote. Skipping it is the honest answer; the gate is what stops such a
    // definition existing in the first place.
    expect(openBindingsFromDefinition(definition(host({ department: { field: 'department_code' } })))).toEqual({});
    expect(openBindingsFromDefinition(definition(host({ department: { field: 'department_code', by: 'uuid' } })))).toEqual({});
    expect(openBindingsFromDefinition(definition(host({ userIdentity: { field: '' } })))).toEqual({});
    expect(openBindingsFromDefinition(definition(host({ streamContext: 'yes' })))).toEqual({});
    expect(openBindingsFromDefinition(definition(notesKind({ materializeAs: 'WORK_NOTE' })))).toEqual({});
  });
});

describe('openBindingsFromDefinition — several kinds', () => {
  it('finds each role on whichever kind carries it', () => {
    const staff = host({ key: 'staff', label: 'Staff', userIdentity: { field: 'doctor_id' } });
    const routing = host({ key: 'routing', label: 'Routing', department: DEPARTMENT_BY_NAME, externalRef: { field: 'event_id' } });

    expect(openBindingsFromDefinition(definition(staff, routing))).toEqual({
      userIdentity: { kindKey: 'staff', field: 'doctor_id' },
      department: { kindKey: 'routing', field: 'department_code', by: 'name' },
      externalRef: { kindKey: 'routing', field: 'event_id' },
    });
  });

  it('lists EVERY materialising kind, in declaration order', () => {
    const referral = notesKind({ key: 'referral_notes', label: 'Referral notes' });
    expect(openBindingsFromDefinition(definition(referral, notesKind())).materialize).toEqual([
      { kindKey: 'referral_notes', as: 'CASE_NOTE' },
      { kindKey: 'previous_case_notes', as: 'CASE_NOTE' },
    ]);
  });
});

// ============================================================
// The two absences the freeze sites depend on
// ============================================================

describe('the markers change no payload contract', () => {
  it('leaves the derived payload schema BYTE-IDENTICAL — no frozen checksum moves', () => {
    const without = payloadSchemaFromDefinition(definition(host(), notesKind({ materializeAs: undefined })));
    const with_ = payloadSchemaFromDefinition(definition(host(ALL_MARKERS), notesKind()));

    expect(JSON.stringify(with_)).toBe(JSON.stringify(without));
  });
});

describe('classifyDefinitionChange — editing an open-time marker is ADDITIVE, always', () => {
  it.each(SINGLETON_MARKERS)('ADDING, MOVING and REMOVING `%s` never demands `allowBreakingChange`', (marker, value) => {
    const plain = () => definition(host(), host({ key: 'intake', label: 'Intake' }));
    const onFirst = () => definition(host({ [marker]: value }), host({ key: 'intake', label: 'Intake' }));
    const onSecond = () => definition(host(), host({ key: 'intake', label: 'Intake', [marker]: value }));

    for (const [before, after] of [
      [plain(), onFirst()],
      [onFirst(), onSecond()],
      [onFirst(), plain()],
    ]) {
      const result = classifyDefinitionChange(before, after);
      expect(result.classification).toBe('ADDITIVE');
      expect(result.breakingChanges).toEqual([]);
    }

    expect(classifyDefinitionChange(onFirst(), onFirst()).classification).toBe('IDENTICAL');
  });

  it('treats `materializeAs` the same way', () => {
    const without = () => definition(notesKind({ materializeAs: undefined }));
    const withIt = () => definition(notesKind());

    expect(classifyDefinitionChange(without(), withIt()).classification).toBe('ADDITIVE');
    expect(classifyDefinitionChange(withIt(), without()).classification).toBe('ADDITIVE');
  });

  it('still BREAKING when the marked PROPERTY is removed — a marker never masks a real break', () => {
    const before = definition(host({ department: { field: 'department_code', by: 'code' } }));
    const after = definition(
      host({
        fields: { type: 'object', properties: { department_name: { type: 'string' } } },
        department: { field: 'department_name', by: 'name' },
      }),
    );

    const result = classifyDefinitionChange(before, after);
    expect(result.classification).toBe('BREAKING');
    expect(result.breakingChanges.join(' ')).toMatch(/department_code/);
  });
});
