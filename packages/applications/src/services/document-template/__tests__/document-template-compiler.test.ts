/**
 * + Task 9 — the template compiler, and D-21.
 *
 * Two separate claims are under test here and they are worth keeping apart:
 *
 *  - **The compiler is a pure, deterministic function of the shape**.
 *    A golden test on the SOAP shape is the anchor: if the emitted bytes move,
 *    every published version row's `compiled` artifact is now a different
 *    document, and `DOCUMENT_TEMPLATE_COMPILER_VERSION` must move with it.
 *  - **An undiscussed section is representable, so it is not confabulated**
 *    (Task 9 / D-21). That is a property of the emitted schema, not of the
 *    model — which is the point. A prompt asking nicely can be ignored; a
 *    decoder that has no way to express "absent" cannot be obeyed.
 */
import { describe, it, expect } from 'vitest';
import { compileDocumentTemplate, DOCUMENT_TEMPLATE_COMPILER_VERSION } from '../document-template-compiler';
import { documentTemplateShapeProblems, DocumentTemplateShape } from '../document-template-shape';
import { SOAP_NOTE_SHAPE } from '../platform-document-shapes';

/** A ten-section discharge summary — the shape that was impossible to author before. */
const DISCHARGE_SUMMARY: DocumentTemplateShape = {
  schemaVersion: '1.0',
  title: 'Discharge Summary',
  globalInstruction: 'Write for the receiving GP.',
  sections: [
    { key: 'admission_reason', title: 'Reason for Admission', form: 'PROSE', required: true },
    { key: 'hospital_course', title: 'Hospital Course', form: 'PROSE', required: true },
    { key: 'procedures', title: 'Procedures', form: 'BULLETS' },
    { key: 'complications', title: 'Complications', form: 'BULLETS' },
    { key: 'discharge_medications', title: 'Discharge Medications', form: 'BULLETS' },
    { key: 'follow_up', title: 'Follow-up', form: 'PROSE' },
    {
      key: 'discharge_vitals',
      title: 'Discharge Vitals',
      form: 'STRUCTURED',
      fields: { type: 'object', properties: { systolic: { type: 'integer' }, diastolic: { type: 'integer' } } },
    },
  ],
};

describe('documentTemplateShapeProblems', () => {
  it('accepts the platform SOAP shape and a ten-section discharge summary', () => {
    expect(documentTemplateShapeProblems(SOAP_NOTE_SHAPE)).toEqual([]);
    expect(documentTemplateShapeProblems(DISCHARGE_SUMMARY)).toEqual([]);
  });

  it('reports EVERY problem at once rather than throwing on the first', () => {
    const problems = documentTemplateShapeProblems({
      schemaVersion: '2.0',
      title: '',
      sections: [
        { key: 'Bad Key', title: 'x', form: 'HAIKU' },
        { key: 'dup', title: 'a', form: 'PROSE' },
        { key: 'dup', title: 'b', form: 'PROSE' },
        { key: 'structured_no_fields', title: 'c', form: 'STRUCTURED' },
      ],
      unknownTopLevel: true,
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('schemaVersion'),
        expect.stringContaining('title'),
        expect.stringContaining('unknownTopLevel'),
        expect.stringContaining('must match'),
        expect.stringContaining('HAIKU'),
        expect.stringContaining('duplicate key'),
        expect.stringContaining('fields is required for a STRUCTURED section'),
      ]),
    );
  });
});

describe('compileDocumentTemplate — golden output for the SOAP shape', () => {
  const compiled = compileDocumentTemplate(SOAP_NOTE_SHAPE);

  it('emits the exact artifacts a published version row freezes', () => {
    expect(compiled).toEqual({
      compilerVersion: DOCUMENT_TEMPLATE_COMPILER_VERSION,
      title: 'SOAP Note',
      sectionKeys: ['subjective', 'objective', 'assessment', 'plan'],
      responseFormat: {
        type: 'json_schema',
        strict: true,
        json_schema: {
          title: 'SOAP Note',
          type: 'object',
          additionalProperties: false,
          properties: {
            subjective: { type: ['string', 'null'], description: 'Patient-reported history and symptoms.' },
            objective: { type: ['string', 'null'], description: 'Exam findings, vitals, labs.' },
            assessment: { type: ['string', 'null'], description: 'Clinical impressions and diagnoses.' },
            plan: { type: ['string', 'null'], description: 'Next steps, medications, follow-up.' },
          },
          required: ['subjective', 'objective', 'assessment', 'plan'],
        },
      },
      checklist: [
        { key: 'subjective', title: 'Subjective', form: 'PROSE', required: false, instruction: 'Patient-reported history and symptoms.' },
        { key: 'objective', title: 'Objective', form: 'PROSE', required: false, instruction: 'Exam findings, vitals, labs.' },
        { key: 'assessment', title: 'Assessment', form: 'PROSE', required: false, instruction: 'Clinical impressions and diagnoses.' },
        { key: 'plan', title: 'Plan', form: 'PROSE', required: false, instruction: 'Next steps, medications, follow-up.' },
      ],
      sectionStates: {
        states: ['PENDING', 'NOT_DISCUSSED', 'DRAFTED', 'CONFIRMED'],
        initial: 'PENDING',
        terminal: ['CONFIRMED'],
        transitions: [
          { from: 'PENDING', to: 'DRAFTED', on: 'CONTENT_EMITTED' },
          { from: 'PENDING', to: 'NOT_DISCUSSED', on: 'EMITTED_NULL' },
          { from: 'NOT_DISCUSSED', to: 'DRAFTED', on: 'CONTENT_EMITTED' },
          { from: 'DRAFTED', to: 'DRAFTED', on: 'CONTENT_EMITTED' },
          { from: 'DRAFTED', to: 'NOT_DISCUSSED', on: 'EMITTED_NULL' },
          { from: 'DRAFTED', to: 'CONFIRMED', on: 'CLINICIAN_CONFIRMED' },
          { from: 'NOT_DISCUSSED', to: 'CONFIRMED', on: 'CLINICIAN_CONFIRMED' },
        ],
        sections: {
          subjective: { allowNotDiscussed: true },
          objective: { allowNotDiscussed: true },
          assessment: { allowNotDiscussed: true },
          plan: { allowNotDiscussed: true },
        },
      },
      promptInstruction: compiled.promptInstruction,
    });
  });

  it('emits a prose instruction that names the sentinel and refuses the near-misses', () => {
    expect(compiled.promptInstruction).toContain('"subjective" — Subjective (prose)');
    expect(compiled.promptInstruction).toContain('set its value to null');
    // A model told only "you may leave it out" writes "N/A" instead, which
    // reads to a downstream clinician as documented-negative rather than
    // never-asked. Naming the near-misses is what stops that.
    expect(compiled.promptInstruction).toContain('"N/A"');
    expect(compiled.promptInstruction).toContain('Be concise and faithful to the transcript; never fabricate findings.');
  });

  it('is deterministic — the same shape compiles to byte-identical artifacts', () => {
    expect(JSON.stringify(compileDocumentTemplate(SOAP_NOTE_SHAPE))).toBe(JSON.stringify(compiled));
  });
});

describe('D-21 — an undiscussed section must be representable, not invented', () => {
  const compiled = compileDocumentTemplate(DISCHARGE_SUMMARY);
  const schema = compiled.responseFormat.json_schema as {
    required: string[];
    properties: Record<string, { type?: unknown }>;
  };

  it('keeps strict decoding on — every key stays in `required`', () => {
    // Dropping a key from `required` under `strict: true` does not make the
    // section optional; strict modes reject the schema outright and fall back
    // to unconstrained generation. Strictness and optionality are carried by
    // DIFFERENT mechanisms on purpose.
    expect(compiled.responseFormat.strict).toBe(true);
    expect(schema.required).toEqual(compiled.sectionKeys);
    expect(schema.required).toHaveLength(7);
  });

  it('gives every OPTIONAL section a null branch — the "not discussed" sentinel', () => {
    for (const key of ['procedures', 'complications', 'discharge_medications', 'follow_up']) {
      expect(schema.properties[key].type, `${key} must be nullable`).toEqual(['string', 'null']);
    }
    // Including a STRUCTURED one: an absent vitals block is absent, not a
    // fabricated blood pressure.
    expect(schema.properties.discharge_vitals.type).toEqual(['object', 'null']);
  });

  it('does NOT give a required section a null branch', () => {
    expect(schema.properties.admission_reason.type).toBe('string');
    expect(schema.properties.hospital_course.type).toBe('string');
  });

  it('records which sections may legitimately rest in NOT_DISCUSSED', () => {
    expect(compiled.sectionStates.sections.admission_reason.allowNotDiscussed).toBe(false);
    expect(compiled.sectionStates.sections.procedures.allowNotDiscussed).toBe(true);
  });

  it('REGRESSION: the shape the old hardcoded SOAP format produced is no longer emitted', () => {
    // `LIVE_SOAP_RESPONSE_FORMAT` was `{ properties: { subjective: { type:
    // 'string' }, ... }, required: [all four] }` under `strict: true`. Under
    // strict decoding that leaves the model no way to say "nothing here", so it
    // writes something. This asserts the old bytes cannot come back by accident.
    const soap = compileDocumentTemplate(SOAP_NOTE_SHAPE).responseFormat.json_schema as { properties: Record<string, { type: unknown }> };
    for (const key of ['subjective', 'objective', 'assessment', 'plan']) {
      expect(soap.properties[key].type, `${key} regressed to a non-nullable string`).not.toBe('string');
    }
  });
});

describe('strict-decoding normalisation of a STRUCTURED section', () => {
  it('closes every authored object and lists all its properties in `required`', () => {
    const compiled = compileDocumentTemplate({
      schemaVersion: '1.0',
      title: 'Vitals',
      sections: [
        {
          key: 'vitals',
          title: 'Vitals',
          form: 'STRUCTURED',
          required: true,
          fields: {
            type: 'object',
            properties: {
              bp: { type: 'object', properties: { systolic: { type: 'integer' }, diastolic: { type: 'integer' } } },
              pulse: { type: 'integer' },
            },
          },
        },
      ],
    });
    const vitals = (compiled.responseFormat.json_schema as { properties: Record<string, any> }).properties.vitals;
    // A tenant authoring a perfectly valid open object would otherwise publish
    // fine and then fail on the first real consultation, because strict modes
    // reject an object that does not close. Normalising makes that impossible
    // rather than merely reported.
    expect(vitals.additionalProperties).toBe(false);
    expect(vitals.required).toEqual(['bp', 'pulse']);
    expect(vitals.properties.bp.additionalProperties).toBe(false);
    expect(vitals.properties.bp.required).toEqual(['systolic', 'diastolic']);
  });
});
