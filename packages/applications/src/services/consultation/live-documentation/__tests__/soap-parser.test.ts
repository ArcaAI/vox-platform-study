/**
 * SOAP parser unit tests (TASK-339 follow-up 1 — structured live summary).
 *
 * `parseSoapSections` turns the SMR running-note text into the four canonical
 * S/O/A/P sections (in order); unstructured text falls back to a single
 * "Running Summary" section. `buildRunningSummary` reconstitutes the flat
 * `runningSummary` (the text NLP highlights are offset against) from sections.
 */
import { describe, it, expect } from 'vitest';
import { SOAP_SECTION_TITLES, buildRunningSummary, parseSoapSections } from '../soap-parser';

describe('parseSoapSections', () => {
  it('parses a well-formed SOAP note into the four canonical sections in order', () => {
    const raw = [
      'Subjective: Patient reports chest pain since this morning.',
      'Objective: BP 150/95, HR 88.',
      'Assessment: Likely hypertensive episode.',
      'Plan: Start amlodipine 5mg, follow up in one week.',
    ].join('\n');

    const sections = parseSoapSections(raw);

    expect(sections.map((s) => s.title)).toEqual(['Subjective', 'Objective', 'Assessment', 'Plan']);
    expect(sections[0].content).toBe('Patient reports chest pain since this morning.');
    expect(sections[1].content).toBe('BP 150/95, HR 88.');
    expect(sections[2].content).toBe('Likely hypertensive episode.');
    expect(sections[3].content).toBe('Start amlodipine 5mg, follow up in one week.');
  });

  it('handles multi-line section bodies and markdown/heading decoration', () => {
    const raw = [
      '## Subjective',
      'Cough for three days.',
      'No fever.',
      '',
      '**Objective:** Lungs clear.',
      'Assessment: Viral URI',
      'Plan:',
      '- Rest and fluids',
      '- Return if worse',
    ].join('\n');

    const sections = parseSoapSections(raw);

    expect(sections.map((s) => s.title)).toEqual(SOAP_SECTION_TITLES as unknown as string[]);
    expect(sections[0].content).toBe('Cough for three days.\nNo fever.');
    expect(sections[1].content).toBe('Lungs clear.');
    expect(sections[2].content).toBe('Viral URI');
    expect(sections[3].content).toBe('- Rest and fluids\n- Return if worse');
  });

  it('still returns the four ordered sections when some are absent (empty content)', () => {
    const raw = 'Subjective: Headache.\nPlan: Ibuprofen as needed.';
    const sections = parseSoapSections(raw);

    expect(sections.map((s) => s.title)).toEqual(['Subjective', 'Objective', 'Assessment', 'Plan']);
    expect(sections[0].content).toBe('Headache.');
    expect(sections[1].content).toBe('');
    expect(sections[2].content).toBe('');
    expect(sections[3].content).toBe('Ibuprofen as needed.');
  });

  it('falls back to a single "Running Summary" section for unstructured text', () => {
    const raw = 'Pt on amlodipine for HTN, doing well today.';
    expect(parseSoapSections(raw)).toEqual([{ title: 'Running Summary', content: raw }]);
  });

  it('treats a single stray header as unstructured (needs >= 2 SOAP headers)', () => {
    const raw = 'Plan: this is mostly free text with one header-like word.';
    expect(parseSoapSections(raw)).toEqual([{ title: 'Running Summary', content: raw }]);
  });

  it('returns an empty array for blank input', () => {
    expect(parseSoapSections('')).toEqual([]);
    expect(parseSoapSections('   \n  ')).toEqual([]);
  });
});

describe('buildRunningSummary', () => {
  it('joins non-empty section contents into a flat summary text', () => {
    const sections = [
      { title: 'Subjective', content: 'Chest pain.' },
      { title: 'Objective', content: '' },
      { title: 'Assessment', content: 'HTN.' },
      { title: 'Plan', content: 'Amlodipine.' },
    ];
    expect(buildRunningSummary(sections)).toBe('Chest pain.\n\nHTN.\n\nAmlodipine.');
  });

  it('round-trips so each section content is a locatable substring of the summary', () => {
    const sections = parseSoapSections('Subjective: A.\nObjective: B.\nAssessment: C.\nPlan: D.');
    const summary = buildRunningSummary(sections);
    for (const section of sections) {
      if (section.content) expect(summary.includes(section.content)).toBe(true);
    }
  });

  it('returns an empty string when there are no sections or all are empty', () => {
    expect(buildRunningSummary([])).toBe('');
    expect(buildRunningSummary([{ title: 'Subjective', content: '' }])).toBe('');
  });
});
