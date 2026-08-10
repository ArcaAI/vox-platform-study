import { describe, expect, it } from 'vitest';
import type { PreSummaryRequest } from '../dto/pre-summary.request';
import type { SessionDataDto } from '../dto/session-data.dto';
import { buildV1PreSummaryPrompt, buildV1SummaryPrompt, resolveV1SchemaDepartment, substituteV1Tokens, toStrictJsonSchema } from '../v1-summary-prompt.builder';
import { V1_SUMMARY_SYSTEM_PROMPT } from '../v1-wrapper';

function baseSession(overrides: Partial<SessionDataDto> = {}): SessionDataDto {
  return {
    session_id: 'sess-1',
    created_at: '2026-08-10T07:12:26.000Z',
    conversation_segments: [
      { speaker: 'provider', text: 'How is the knee?', timestamp: '2026-08-10T07:12:30.000Z' },
      { speaker: 'patient', text: 'Painful on stairs.', timestamp: '2026-08-10T07:12:40.000Z' },
    ],
    ...overrides,
  } as SessionDataDto;
}

/** The live reproduction case: Rheumatology follow-up, 10 template sections. */
const RHEUM_FOLLOWUP_SECTIONS = [
  'diagnosis',
  'disease_activity',
  'current_issues',
  'medication_review_rx',
  'review_on',
  'tests_to_do',
  'advice',
  'plan',
  'consultation_notes',
  'lab_reports',
];

describe('buildV1SummaryPrompt — template adherence', () => {
  it('derives the response schema from the department template sections', () => {
    const { responseSchema, resolvedDepartmentKey, resolvedVisitType } = buildV1SummaryPrompt(baseSession(), {
      department: 'Rheumatology',
      visitType: 'Follow-up',
    });

    expect(resolvedDepartmentKey).toBe('rheumatology');
    expect(resolvedVisitType).toBe('followup');
    expect(responseSchema.required).toEqual(RHEUM_FOLLOWUP_SECTIONS);
    expect(Object.keys(responseSchema.properties as object)).toEqual(RHEUM_FOLLOWUP_SECTIONS);
    // Strict-mode structured output: no extra keys, nothing optional.
    expect(responseSchema.additionalProperties).toBe(false);
  });

  it('embeds the SAME schema in the prompt that it constrains the response with', () => {
    const { user, responseSchema } = buildV1SummaryPrompt(baseSession(), { department: 'Rheumatology', visitType: 'Follow-up' });

    expect(user).toContain('Conform EXACTLY to this JSON schema');
    for (const section of responseSchema.required as string[]) {
      expect(user).toContain(`"${section}"`);
    }
  });

  it('places the governed instruction template as the user-prompt PREFACE, before the scaffold and the JSON rules', () => {
    const template = 'When the department is "Rheumatology" and the patient is a REVIEW, use these headings in order: 1. Diagnosis ...';
    const { user } = buildV1SummaryPrompt(baseSession(), {
      department: 'Rheumatology',
      visitType: 'Follow-up',
      governedInstruction: template,
    });

    expect(user.indexOf(template)).toBe(0);
    // Order is load-bearing: v1's scaffold carries a GENERIC SOAP example, and
    // the department schema must come after it to override that example.
    expect(user.indexOf('CONVERSATION TRANSCRIPT')).toBeGreaterThan(user.indexOf(template));
    expect(user.indexOf('Conform EXACTLY to this JSON schema')).toBeGreaterThan(user.indexOf('CONVERSATION TRANSCRIPT'));
  });

  it('falls back to v1 SOAP when the department is not one of v1’s eleven', () => {
    const { responseSchema, resolvedDepartmentKey } = buildV1SummaryPrompt(baseSession(), { department: 'Cardiology' });
    expect(resolvedDepartmentKey).toBeNull();
    expect(responseSchema.required).toEqual(['subjective', 'objective', 'assessment', 'plan']);
  });

  it('resolves the four schema-only departments v1 has no body template for', () => {
    expect(resolveV1SchemaDepartment('Dermatology')).toBe('dermatology');
    expect(resolveV1SchemaDepartment('Surgical Oncology')).toBe('surgical_oncology');
    expect(resolveV1SchemaDepartment('Nephrology')).toBe('nephrology');
    expect(resolveV1SchemaDepartment('Dietetics')).toBe('dietetics');
    // …without disturbing the seven body-carrying ones.
    expect(resolveV1SchemaDepartment('General Surgery')).toBe('surgery');
    expect(resolveV1SchemaDepartment('Cardiology')).toBeNull();
  });
});

describe('buildV1SummaryPrompt — v1 artifact fidelity', () => {
  it('uses v1’s system prompt verbatim', () => {
    expect(buildV1SummaryPrompt(baseSession()).system).toContain(V1_SUMMARY_SYSTEM_PROMPT);
  });

  it('substitutes every per-request token and leaves no literal braces from the scaffold', () => {
    const { user } = buildV1SummaryPrompt(
      baseSession({ patient_info: { name: 'A. Samuel', age: '65' } } as Partial<SessionDataDto>),
      { department: 'Rheumatology', visitType: 'Follow-up' },
    );

    for (const token of ['{session_id}', '{session_date}', '{patient_info}', '{conversation_text}', '{conversation_language}', '{schema_example}']) {
      expect(user).not.toContain(token);
    }
    expect(user).toContain('sess-1');
    expect(user).toContain('name: A. Samuel');
    expect(user).toContain('Painful on stairs.');
    // Python's `{{`/`}}` escapes must collapse, or the embedded JSON example
    // reaches the model malformed.
    expect(user).not.toContain('{{');
    expect(user).not.toContain('}}');
  });

  it('injects the pre-summary under v1’s PRIOR MEDICAL CONTEXT prefix only when enrichment is on', () => {
    const session = baseSession({ pre_summary_text: 'Known psoriatic arthritis.' } as Partial<SessionDataDto>);

    // NB: the rule block itself says "consult PRIOR MEDICAL CONTEXT", so the
    // absence check must target the injected CONTENT, not the phrase.
    const off = buildV1SummaryPrompt(session, { includePreSummary: false });
    expect(off.user).not.toContain('Known psoriatic arthritis.');

    const on = buildV1SummaryPrompt(session, { includePreSummary: true });
    expect(on.user).toContain('PRIOR MEDICAL CONTEXT (authoritative, use to fill missing details):\nKnown psoriatic arthritis.');
    // The rule block follows it, so "consult PRIOR MEDICAL CONTEXT" resolves.
    expect(on.user.indexOf('STRICT JSON RESPONSE FORMAT')).toBeGreaterThan(on.user.indexOf('PRIOR MEDICAL CONTEXT'));
  });

  it('carries the clinical context v1 folded into {patient_info}', () => {
    const { user } = buildV1SummaryPrompt(
      baseSession({
        test_results_text: '## Vitals\n• BP Systolic: 130',
        previous_visits_text: 'PSORIATIC ARTHRITIS, ESR 21',
      } as Partial<SessionDataDto>),
    );
    expect(user).toContain('BP Systolic: 130');
    expect(user).toContain('PSORIATIC ARTHRITIS');
  });
});

describe('buildV1SummaryPrompt — v2 carry-overs', () => {
  it('states the output language as English through v1’s own placeholder (TASK-650 R1)', () => {
    const { user } = buildV1SummaryPrompt(baseSession());
    expect(user).toContain('CONVERSATION LANGUAGE:\nEnglish');
    expect(user).toContain('Use the English for all values');
  });

  it('keeps the bilingual-transcript directive and renders both lines (TASK-651)', () => {
    const session = baseSession({
      conversation_segments: [
        { speaker: 'provider', text: 'Acetaminophen 100 mg', original_text: 'aceclofenac 100 mg PRN', timestamp: '2026-08-10T07:12:30.000Z' },
      ],
    } as Partial<SessionDataDto>);

    const { system, user } = buildV1SummaryPrompt(session);
    expect(system).toContain('take the value from the original line whenever the two disagree');
    expect(user).toContain('provider (original, untranslated): aceclofenac 100 mg PRN');
  });

  it('omits the bilingual directive for a monolingual transcript', () => {
    expect(buildV1SummaryPrompt(baseSession()).system).not.toContain('machine translation');
  });

  it('appends the DNA writing style to the system message without touching the schema (TASK-599)', () => {
    const { system, responseSchema } = buildV1SummaryPrompt(baseSession(), {
      department: 'Rheumatology',
      visitType: 'Follow-up',
      dnaStyleText: 'Terse, active voice.',
    });
    expect(system).toContain('Terse, active voice.');
    expect(responseSchema.required).toEqual(RHEUM_FOLLOWUP_SECTIONS);
  });
});

describe('substituteV1Tokens', () => {
  it('treats replacement values as literals, not regex replacement patterns', () => {
    expect(substituteV1Tokens('a {x} b', { x: '$& $1 $$' })).toBe('a $& $1 $$ b');
  });

  it('collapses doubled braces after substitution', () => {
    expect(substituteV1Tokens('{{ "k": {v} }}', { v: '1' })).toBe('{ "k": 1 }');
  });
});

describe('toStrictJsonSchema', () => {
  it('preserves v1 key order and requires every field', () => {
    const schema = toStrictJsonSchema({ b: 'string (markdown)', a: 'string (markdown)' }, 'T');
    expect(schema.required).toEqual(['b', 'a']);
    expect(schema.properties).toEqual({ b: { type: 'string' }, a: { type: 'string' } });
    expect(schema.title).toBe('T');
  });
});

describe('buildV1PreSummaryPrompt', () => {
  const req = { current_department: 'Rheumatology', visit_type: 'Follow-up' } as PreSummaryRequest;

  it('adds the adherence directive to the system message', () => {
    const { system } = buildV1PreSummaryPrompt(req);
    expect(system).toContain('Reproduce the section headers from its FORMAT block verbatim');
    expect(system).toContain('do not introduce headers of your own');
  });

  it('leaves the checksum-locked v1 body untouched', () => {
    const { user } = buildV1PreSummaryPrompt(req);
    // The FORMAT block the `PRE_SUMMARY_DISPLAY_TITLES` parser title-matches.
    expect(user).toContain('Pre-Summary of Medical History');
    expect(user).toContain('- Confirmed & Provisional Diagnoses:');
    expect(user).toContain('- Plan of Care (Latest Department Note):');
    expect(user).toContain('- Diagnostics & Trends:');
    // Placeholders still substituted at assembly time.
    expect(user).not.toContain('{current_department}');
    expect(user).toContain('Rheumatology');
  });

  it('still honours a governed pre-summary override', () => {
    const { user } = buildV1PreSummaryPrompt(req, { governedInstruction: 'Custom pre-summary for {current_department}.' });
    expect(user).toBe('Custom pre-summary for Rheumatology.');
  });
});
