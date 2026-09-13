/**
 * the template-driven replacement for the SOAP parser tests.
 *
 * Every case that used to be written against the four hardcoded SOAP headings
 * is preserved, now driven by the COMPILED platform SOAP template — so the same
 * behaviour is proven while the four titles are a row rather than a constant.
 * A second `describe` runs the identical assertions against a shape that has
 * nothing to do with SOAP, which is the property the old module could not have:
 * if a custom shape parses, custom shapes are no longer structurally excluded.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRunningSummary,
  buildStructuredSummary,
  cleanSectionBody,
  NOT_DOCUMENTED_MARKER,
  parseDocumentJson,
  parseDocumentSections,
  RUNNING_SUMMARY_TITLE,
} from '../document-shape-parser';
import { compileDocumentTemplate } from '../../../document-template/document-template-compiler';
import { SOAP_NOTE_SHAPE } from '../../../document-template/platform-document-shapes';

const SOAP = compileDocumentTemplate(SOAP_NOTE_SHAPE);

const DISCHARGE = compileDocumentTemplate({
  schemaVersion: '1.0',
  title: 'Discharge Summary',
  sections: [
    { key: 'admission_reason', title: 'Reason for Admission', form: 'PROSE', required: true },
    { key: 'hospital_course', title: 'Hospital Course', form: 'PROSE' },
    { key: 'follow_up', title: 'Follow-up', form: 'PROSE' },
  ],
});

describe('parseDocumentSections (prose fallback)', () => {
  it('parses inline "Title: content" headers into the template order', () => {
    const raw = ['Subjective: Chest pain for two days.', 'Objective: BP 150/95.', 'Assessment: Likely angina.', 'Plan: ECG, aspirin.'].join('\n');

    const sections = parseDocumentSections(raw, SOAP);

    expect(sections.map((s) => s.title)).toEqual(['Subjective', 'Objective', 'Assessment', 'Plan']);
    expect(sections[0].content).toBe('Chest pain for two days.');
    expect(sections[3].content).toBe('ECG, aspirin.');
  });

  it('parses markdown standalone headers and emphasis', () => {
    const raw = ['## Subjective', 'Headache.', '**Objective:** Afebrile.', '### Assessment', 'Tension headache.', '- Plan', 'Ibuprofen.'].join('\n');

    const sections = parseDocumentSections(raw, SOAP);

    expect(sections.map((s) => s.title)).toEqual(['Subjective', 'Objective', 'Assessment', 'Plan']);
    expect(sections[1].content).toBe('Afebrile.');
    expect(sections[3].content).toBe('Ibuprofen.');
  });

  it('emits every declared section even when the model wrote only some', () => {
    const raw = 'Subjective: Cough.\nPlan: Rest.';
    const sections = parseDocumentSections(raw, SOAP);

    expect(sections).toHaveLength(4);
    expect(sections[1].content).toBe('');
    expect(sections[2].content).toBe('');
  });

  it('degrades to a single Running Summary section for unstructured prose', () => {
    const raw = 'Patient reports a cough. Advised rest and fluids.';
    expect(parseDocumentSections(raw, SOAP)).toEqual([{ title: RUNNING_SUMMARY_TITLE, content: raw }]);
  });

  it('degrades when only ONE header matched (a sentence starting with a section word)', () => {
    const raw = 'Plan: nothing else here that looks like a note.';
    expect(parseDocumentSections(raw, SOAP)).toEqual([{ title: RUNNING_SUMMARY_TITLE, content: raw }]);
  });

  it('returns nothing for empty input', () => {
    expect(parseDocumentSections('', SOAP)).toEqual([]);
    expect(parseDocumentSections('   \n  ', SOAP)).toEqual([]);
  });

  it('parses a CUSTOM shape the old module could not express at all', () => {
    const raw = ['Reason for Admission: Chest pain.', 'Hospital Course: Improved on GTN.', 'Follow-up: Cardiology in two weeks.'].join('\n');

    const sections = parseDocumentSections(raw, DISCHARGE);

    expect(sections.map((s) => s.title)).toEqual(['Reason for Admission', 'Hospital Course', 'Follow-up']);
    expect(sections[2].content).toBe('Cardiology in two weeks.');
  });

  it('accepts the section KEY as a header as well as its title', () => {
    const raw = 'admission_reason: Chest pain.\nfollow_up: GP in a week.';
    const sections = parseDocumentSections(raw, DISCHARGE);
    expect(sections[0].content).toBe('Chest pain.');
    expect(sections[2].content).toBe('GP in a week.');
  });
});

describe('parseDocumentJson (deterministic json_schema parse)', () => {
  it('parses a strict-schema object into the template order', () => {
    const raw = JSON.stringify({ subjective: 'Chest pain.', objective: 'BP 150/95.', assessment: 'Angina.', plan: 'ECG.' });

    const sections = parseDocumentJson(raw, SOAP);

    expect(sections?.map((s) => s.title)).toEqual(['Subjective', 'Objective', 'Assessment', 'Plan']);
    expect(sections?.[0].content).toBe('Chest pain.');
  });

  it('strips a markdown code fence models often add', () => {
    const raw = '```json\n{ "subjective": "Cough.", "plan": "Rest." }\n```';
    const sections = parseDocumentJson(raw, SOAP);
    expect(sections?.[0].content).toBe('Cough.');
    expect(sections?.[3].content).toBe('Rest.');
  });

  it('is lenient on missing keys', () => {
    const sections = parseDocumentJson('{ "subjective": "Headache." }', SOAP);
    expect(sections).toHaveLength(4);
    expect(sections?.[1].content).toBe('');
  });

  it('returns null for prose or for an object with no recognised section key', () => {
    expect(parseDocumentJson('Subjective: Headache.\nPlan: Ibuprofen.', SOAP)).toBeNull();
    expect(parseDocumentJson('Pt on amlodipine for HTN.', SOAP)).toBeNull();
    expect(parseDocumentJson('{ "foo": "bar" }', SOAP)).toBeNull();
  });

  it('returns null for empty, blank or non-object input', () => {
    expect(parseDocumentJson('', SOAP)).toBeNull();
    expect(parseDocumentJson('   ', SOAP)).toBeNull();
    expect(parseDocumentJson('[1, 2, 3]', SOAP)).toBeNull();
  });

  it('renders a STRUCTURED section rather than dropping it', () => {
    const structured = compileDocumentTemplate({
      schemaVersion: '1.0',
      title: 'Vitals Note',
      sections: [
        {
          key: 'vitals',
          title: 'Vitals',
          form: 'STRUCTURED',
          required: true,
          fields: { type: 'object', properties: { pulse: { type: 'integer' } } },
        },
        { key: 'notes', title: 'Notes', form: 'PROSE' },
      ],
    });
    const sections = parseDocumentJson('{ "vitals": { "pulse": 72 }, "notes": "Well." }', structured);
    expect(sections?.[0].content).toContain('"pulse": 72');
  });
});

describe('D-21 — an explicit null is "not discussed", not an empty answer', () => {
  it('marks a null section as notDiscussed and keeps its content empty', () => {
    const raw = JSON.stringify({ subjective: 'Chest pain.', objective: null, assessment: 'Angina.', plan: 'ECG.' });

    const sections = parseDocumentJson(raw, SOAP);

    expect(sections?.[1]).toEqual({ title: 'Objective', content: '', notDiscussed: true });
  });

  it('does NOT mark an empty STRING as notDiscussed — the two facts are different', () => {
    // `""` is "I looked and there is nothing to write"; `null` is "this never
    // came up". Collapsing them would discard the only evidence that the model
    // declined to invent an examination it was never told about, which is the
    // entire reason the compiled schema makes the field nullable.
    const sections = parseDocumentJson(JSON.stringify({ subjective: 'x', objective: '', assessment: 'y', plan: 'z' }), SOAP);

    expect(sections?.[1]).toEqual({ title: 'Objective', content: '' });
    expect(sections?.[1].notDiscussed).toBeUndefined();
  });

  it('keeps a null section out of the flat running summary NLP offsets index', () => {
    const sections = parseDocumentJson(JSON.stringify({ subjective: 'Chest pain.', objective: null, assessment: null, plan: 'ECG.' }), SOAP)!;
    expect(buildRunningSummary(sections)).toBe('Chest pain.\n\nECG.');
  });
});

describe('buildRunningSummary', () => {
  it('joins non-empty section contents with a blank line, in order', () => {
    const sections = [
      { title: 'Subjective', content: 'Chest pain.' },
      { title: 'Objective', content: '' },
      { title: 'Assessment', content: 'HTN.' },
      { title: 'Plan', content: 'Amlodipine.' },
    ];
    expect(buildRunningSummary(sections)).toBe('Chest pain.\n\nHTN.\n\nAmlodipine.');
  });

  it('round-trips a parsed note back into offsettable text', () => {
    const sections = parseDocumentSections('Subjective: A.\nObjective: B.\nAssessment: C.\nPlan: D.', SOAP);
    const summary = buildRunningSummary(sections);
    expect(summary).toBe('A.\n\nB.\n\nC.\n\nD.');
    expect(summary.indexOf('C.')).toBeGreaterThan(summary.indexOf('B.'));
  });

  it('returns an empty string when there is nothing to render', () => {
    expect(buildRunningSummary([])).toBe('');
    expect(buildRunningSummary([{ title: 'Subjective', content: '' }])).toBe('');
  });
});

/**
 * A1 — the HEADED render the durable finalizer is handed.
 *
 * `buildRunningSummary` is the offset base and stays headings-free; this is the same sections with
 * their titles, written only to the `LIVE_SOAP_SNAPSHOT` row `harness.finalize` reads as
 * `preSummaryText`. The two must never converge — the first assertion below is what says so.
 */
describe('buildStructuredSummary', () => {
  it('renders `## <title>` + body for every NON-EMPTY section, in order', () => {
    const sections = [
      { title: 'Subjective', content: 'Chest pain.' },
      { title: 'Objective', content: 'BP 150/95.' },
      { title: 'Assessment', content: 'HTN.' },
      { title: 'Plan', content: 'Amlodipine.' },
    ];

    expect(buildStructuredSummary(sections)).toBe(
      ['## Subjective', 'Chest pain.', '', '## Objective', 'BP 150/95.', '', '## Assessment', 'HTN.', '', '## Plan', 'Amlodipine.'].join('\n'),
    );
  });

  it('OMITS an empty section rather than writing a heading over nothing', () => {
    const sections = [
      { title: 'Subjective', content: 'Cough.' },
      { title: 'Objective', content: '   ' },
      { title: 'Assessment', content: '' },
      { title: 'Plan', content: 'Rest.' },
    ];

    const rendered = buildStructuredSummary(sections);
    expect(rendered).toBe('## Subjective\nCough.\n\n## Plan\nRest.');
    expect(rendered).not.toContain('Objective');
  });

  it('is NOT `buildRunningSummary` — the offset base keeps its headings-free shape', () => {
    const sections = parseDocumentSections('Subjective: A.\nObjective: B.\nAssessment: C.\nPlan: D.', SOAP);

    expect(buildRunningSummary(sections)).toBe('A.\n\nB.\n\nC.\n\nD.');
    expect(buildStructuredSummary(sections)).toBe('## Subjective\nA.\n\n## Objective\nB.\n\n## Assessment\nC.\n\n## Plan\nD.');
  });

  it('orders by the compiled template when one is given, and never DROPS an unnamed section', () => {
    const sections = [
      { title: 'Follow-up', content: 'Clinic in two weeks.' },
      { title: 'Reason for Admission', content: 'Chest pain.' },
      { title: 'Hospital Course', content: 'Uneventful.' },
    ];

    expect(buildStructuredSummary(sections, DISCHARGE)).toBe(
      ['## Reason for Admission', 'Chest pain.', '', '## Hospital Course', 'Uneventful.', '', '## Follow-up', 'Clinic in two weeks.'].join('\n'),
    );
  });

  it("does NOT head the parser's unstructured fallback — an unparsed note degrades to exactly the flat text", () => {
    const unparsed = parseDocumentSections('Patient reports a cough. Advised rest and fluids.', SOAP);

    expect(unparsed).toEqual([{ title: RUNNING_SUMMARY_TITLE, content: 'Patient reports a cough. Advised rest and fluids.' }]);
    expect(buildStructuredSummary(unparsed, SOAP)).toBe('Patient reports a cough. Advised rest and fluids.');
    expect(buildStructuredSummary(unparsed, SOAP)).toBe(buildRunningSummary(unparsed));
  });

  it('returns an empty string when there is nothing to render and no template to complete', () => {
    expect(buildStructuredSummary([])).toBe('');
  });

  it('WITH a template, renders every template section — an untouched one under its heading with the marker', () => {
    // Reviewed 2026-09-13: the finalizer keeps the headings exactly as they appear in its
    // input, so a template section absent from the input is absent from the finished note.
    // The clinician reviews the note against the template; every heading must be there.
    const rendered = buildStructuredSummary([{ title: 'Subjective', content: 'Cough.' }], SOAP);
    expect(rendered).toBe(
      [
        '## Subjective',
        'Cough.',
        '',
        '## Objective',
        NOT_DOCUMENTED_MARKER,
        '',
        '## Assessment',
        NOT_DOCUMENTED_MARKER,
        '',
        '## Plan',
        NOT_DOCUMENTED_MARKER,
      ].join('\n'),
    );
    // Nothing at all, but a template: the template, complete, every section unrecorded.
    expect(buildStructuredSummary([{ title: 'Subjective', content: '' }], SOAP)).toContain(`## Subjective\n${NOT_DOCUMENTED_MARKER}`);
  });
});

describe('cleanSectionBody — the draft the finalizer reads is deduplicated and guidance-free (2026-09-13)', () => {
  const GUIDANCE =
    'Examination findings and vital signs measured at this visit — heart rate, blood pressure, temperature, respiratory rate, oxygen saturation. ' +
    'A historical value may be reported for comparison only where the clinician referred to it today, and its date must appear beside it. Do not complete a partial set from the record.';

  it('keeps each sentence once, at its first occurrence, across paragraphs (the restating-model pattern)', () => {
    const body = [
      'The clinician introduced the attending physician, Harris.',
      '',
      'The clinician introduced the attending physician, Harris. The clinician stated they would look at what was causing the headache and then do the general physical exam.',
      '',
      'The clinician introduced the attending physician, Harris. The clinician introduced the attending physician, Harris. The clinician stated they would look at what was causing the headache and then do the general physical exam.',
    ].join('\n');
    expect(cleanSectionBody(body)).toBe(
      'The clinician introduced the attending physician, Harris.\n\nThe clinician stated they would look at what was causing the headache and then do the general physical exam.',
    );
  });

  it("drops the section's own guidance sentences from the body and keeps the rest", () => {
    const body = `${GUIDANCE}\n\nNo examination findings or vital signs were recorded in the new transcript.`;
    expect(cleanSectionBody(body, GUIDANCE)).toBe('No examination findings or vital signs were recorded in the new transcript.');
    expect(cleanSectionBody(GUIDANCE, GUIDANCE)).toBe('');
  });

  it('preserves bullets and numbering, dropping a bullet emptied by the clean', () => {
    const body = '- Headache for three days.\n- Headache for three days.\n- Nothing has helped it.\n1. Rest advised.';
    expect(cleanSectionBody(body)).toBe('- Headache for three days.\n- Nothing has helped it.\n1. Rest advised.');
  });

  it('is case- and punctuation-insensitive for the repeat check and leaves an ordinary body untouched', () => {
    expect(cleanSectionBody('Pain 7/10. Pain 7/10')).toBe('Pain 7/10.');
    expect(cleanSectionBody('BP 120/80!  BP 120/80.')).toBe('BP 120/80!');
    expect(cleanSectionBody('Cough since Monday. Rest and fluids.')).toBe('Cough since Monday. Rest and fluids.');
  });

  it('feeds buildStructuredSummary: the snapshot the finalizer reads is cleaned, the running summary is not', () => {
    const compiled = {
      checklist: [{ key: 'exam', title: 'General Examination & Vitals', form: 'BULLETS', required: false, instruction: GUIDANCE }],
    } as never;
    const sections = [{ title: 'General Examination & Vitals', content: `${GUIDANCE}\n\nBP 120/80. BP 120/80.` }];
    expect(buildStructuredSummary(sections, compiled)).toBe('## General Examination & Vitals\nBP 120/80.');
    expect(buildRunningSummary(sections)).toContain(GUIDANCE);
  });
});
