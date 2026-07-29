/**
 * Unit tests for the live-summary pure helpers (TASK-330 P3, WS4).
 */
import { describe, it, expect } from 'vitest';
import {
  buildEntityHighlights,
  buildSoapSectionViews,
  reduceLiveSummaryMessage,
  normalizeLiveSummaryEvent,
  SOAP_SECTION_TITLES,
} from '../live-summary';
import type { LiveSummaryEntity, LiveSummarySection } from '../../types';

const entity = (over: Partial<LiveSummaryEntity>): LiveSummaryEntity => ({
  text: 'x',
  type: 'PROBLEM',
  confidence: 0.9,
  start: 0,
  end: 1,
  ...over,
});

describe('buildEntityHighlights', () => {
  it('wraps an entity at its exact character offsets and reconstructs the text', () => {
    const text = 'Patient has hypertension today';
    const start = text.indexOf('hypertension');
    const end = start + 'hypertension'.length;
    const segments = buildEntityHighlights(text, [entity({ text: 'hypertension', start, end, type: 'PROBLEM' })]);

    expect(segments).toEqual([
      { text: 'Patient has ', entity: null },
      { text: 'hypertension', entity: expect.objectContaining({ type: 'PROBLEM', start, end }) },
      { text: ' today', entity: null },
    ]);
    // The highlighted slice maps exactly to the offsets.
    expect(text.slice(start, end)).toBe('hypertension');
    expect(segments.map((s) => s.text).join('')).toBe(text);
  });

  it('orders multiple entities and leaves plain gaps between them', () => {
    const text = 'aspirin and lisinopril';
    const a = { start: 0, end: 7 }; // aspirin
    const b = { start: 12, end: 22 }; // lisinopril
    const segments = buildEntityHighlights(text, [
      entity({ text: 'lisinopril', ...b, type: 'MEDICATION' }),
      entity({ text: 'aspirin', ...a, type: 'MEDICATION' }),
    ]);

    expect(segments.map((s) => ({ text: s.text, hl: s.entity !== null }))).toEqual([
      { text: 'aspirin', hl: true },
      { text: ' and ', hl: false },
      { text: 'lisinopril', hl: true },
    ]);
  });

  it('skips overlapping and out-of-range spans without corrupting the text', () => {
    const text = 'short';
    const segments = buildEntityHighlights(text, [
      entity({ start: 0, end: 3 }),
      entity({ start: 1, end: 4 }), // overlaps the first → dropped
      entity({ start: 2, end: 99 }), // out of range → dropped
      entity({ start: 5, end: 2 }), // inverted → dropped
    ]);
    expect(segments.map((s) => s.text).join('')).toBe(text);
    expect(segments.filter((s) => s.entity).length).toBe(1);
  });

  it('returns an empty array for empty text', () => {
    expect(buildEntityHighlights('', [entity({})])).toEqual([]);
  });
});

describe('buildSoapSectionViews', () => {
  const subjective = 'Patient reports chest pain.';
  const plan = 'Start metformin 500mg.';
  const runningSummary = `${subjective}\n\n${plan}`;
  const chestStart = runningSummary.indexOf('chest pain');
  const metStart = runningSummary.indexOf('metformin');
  const entities: LiveSummaryEntity[] = [
    { text: 'chest pain', type: 'PROBLEM', confidence: 0.9, start: chestStart, end: chestStart + 'chest pain'.length },
    { text: 'metformin', type: 'MEDICATION', confidence: 0.95, start: metStart, end: metStart + 'metformin'.length },
  ];
  const soapSections: LiveSummarySection[] = [
    { title: 'Subjective', content: subjective },
    { title: 'Objective', content: '' },
    { title: 'Assessment', content: '' },
    { title: 'Plan', content: plan },
  ];

  it('returns the four ordered SOAP slots, mapping each entity into its section at LOCAL offsets', () => {
    const views = buildSoapSectionViews(runningSummary, soapSections, entities);

    expect(views.map((v) => v.title)).toEqual(SOAP_SECTION_TITLES as unknown as string[]);

    const subj = views[0];
    expect(subj.populated).toBe(true);
    expect(subj.segments.map((s) => s.text).join('')).toBe(subjective);
    const subjHl = subj.segments.find((s) => s.entity)!;
    expect(subjHl.text).toBe('chest pain');
    // The highlight's offsets are valid against the SECTION text the panel renders.
    expect(subjective.slice(subjHl.entity!.start, subjHl.entity!.end)).toBe('chest pain');

    expect(views[1].populated).toBe(false);
    expect(views[1].segments).toEqual([]);
    expect(views[2].populated).toBe(false);

    const planView = views[3];
    expect(planView.populated).toBe(true);
    const planHl = planView.segments.find((s) => s.entity)!;
    expect(planHl.text).toBe('metformin');
    expect(plan.slice(planHl.entity!.start, planHl.entity!.end)).toBe('metformin');
  });

  it('never lets an entity bleed across section boundaries', () => {
    const views = buildSoapSectionViews(runningSummary, soapSections, entities);
    // The Subjective section must not contain the Plan entity and vice-versa.
    expect(views[0].segments.some((s) => s.entity?.text === 'metformin')).toBe(false);
    expect(views[3].segments.some((s) => s.entity?.text === 'chest pain')).toBe(false);
  });

  it('passes through a non-SOAP fallback section and still highlights within it', () => {
    const text = 'Pt started on aspirin today.';
    const aspStart = text.indexOf('aspirin');
    const views = buildSoapSectionViews(
      text,
      [{ title: 'Running Summary', content: text }],
      [{ text: 'aspirin', type: 'MEDICATION', confidence: 0.8, start: aspStart, end: aspStart + 'aspirin'.length }],
    );
    expect(views).toHaveLength(1);
    expect(views[0].title).toBe('Running Summary');
    expect(views[0].segments.find((s) => s.entity)?.text).toBe('aspirin');
  });

  it('renders section content with no highlights when it is absent from runningSummary', () => {
    const views = buildSoapSectionViews(
      'totally different text',
      [{ title: 'Plan', content: 'Detached plan note.' }],
      [{ text: 'Detached', type: 'PROBLEM', confidence: 0.5, start: 0, end: 8 }],
    );
    expect(views[3].content).toBe('Detached plan note.');
    expect(views[3].segments.every((s) => s.entity === null)).toBe(true);
  });
});

describe('reduceLiveSummaryMessage', () => {
  it('classifies a normal summary event', () => {
    const result = reduceLiveSummaryMessage(
      JSON.stringify({ consultationId: 'c1', runningSummary: 'S', sections: [{ title: 'Subjective', content: 'x' }], entities: [], updatedAt: 't' }),
    );
    expect(result.kind).toBe('event');
    if (result.kind === 'event') {
      expect(result.event.runningSummary).toBe('S');
      expect(result.event.sections).toHaveLength(1);
    }
  });

  it('classifies the terminal closed event', () => {
    const result = reduceLiveSummaryMessage(
      JSON.stringify({ consultationId: 'c1', runningSummary: 'final', entities: [], closed: true, updatedAt: 't' }),
    );
    expect(result.kind).toBe('closed');
  });

  it('treats empty data and bare heartbeats as heartbeats', () => {
    expect(reduceLiveSummaryMessage('').kind).toBe('heartbeat');
    expect(reduceLiveSummaryMessage('   ').kind).toBe('heartbeat');
    expect(reduceLiveSummaryMessage('{}').kind).toBe('heartbeat');
    expect(reduceLiveSummaryMessage(JSON.stringify({ type: 'heartbeat' })).kind).toBe('heartbeat');
  });

  it('returns invalid for non-JSON payloads', () => {
    expect(reduceLiveSummaryMessage('not json').kind).toBe('invalid');
  });
});

describe('normalizeLiveSummaryEvent', () => {
  it('drops malformed entities/sections and defaults missing fields', () => {
    const event = normalizeLiveSummaryEvent({
      runningSummary: 'S',
      entities: [{ text: 'ok', type: 'PROBLEM', confidence: 0.5, start: 0, end: 2 }, { type: 'bad' }],
      sections: [{ title: 'Subjective', content: 'c' }, { content: 'no title' }],
    });
    expect(event.entities).toHaveLength(1);
    expect(event.sections).toHaveLength(1);
    expect(event.consultationId).toBe('');
    expect(typeof event.updatedAt).toBe('string');
  });
});
