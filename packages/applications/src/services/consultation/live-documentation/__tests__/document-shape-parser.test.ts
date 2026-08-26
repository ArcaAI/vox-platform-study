/**
 * TASK-810 — the template-driven replacement for the SOAP parser tests.
 *
 * Every case that used to be written against the four hardcoded SOAP headings
 * is preserved, now driven by the COMPILED platform SOAP template — so the same
 * behaviour is proven while the four titles are a row rather than a constant.
 * A second `describe` runs the identical assertions against a shape that has
 * nothing to do with SOAP, which is the property the old module could not have:
 * if a custom shape parses, custom shapes are no longer structurally excluded.
 */
import { describe, it, expect } from 'vitest';
import { buildRunningSummary, parseDocumentJson, parseDocumentSections, RUNNING_SUMMARY_TITLE } from '../document-shape-parser';
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
        { key: 'vitals', title: 'Vitals', form: 'STRUCTURED', required: true, fields: { type: 'object', properties: { pulse: { type: 'integer' } } } },
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
