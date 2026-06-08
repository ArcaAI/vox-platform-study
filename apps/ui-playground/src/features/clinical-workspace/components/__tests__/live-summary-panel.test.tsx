/**
 * LiveSummaryPanel render test (TASK-330 P3, WS4; structured S/O/A/P — TASK-339 FU1).
 *
 * Verifies the SSE-driven panel renders the running summary as four labeled
 * S/O/A/P sections, highlights each recognised entity WITHIN its section at the
 * exact character offsets the panel renders, annotates confidence, shows a
 * skeleton placeholder for sections not yet populated, and shows the right
 * status / empty / skeleton / error states. `@arcaai/ui/*` primitives are
 * stubbed (the ui-playground vitest config blanks the package); the panel's own
 * section + highlight logic drives.
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardHeader: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardTitle: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children, ...p }: any) => <span {...p}>{children}</span> }));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: (p: any) => <div data-testid="skeleton" {...p} /> }));
vi.mock('@arcaai/ui/scroll-area', () => ({ ScrollArea: ({ children, ...p }: any) => <div {...p}>{children}</div> }));

import { LiveSummaryPanel } from '../live-summary-panel';
import type { LiveSummaryEvent } from '../../types';

const subjective = 'Patient reports chest pain.';
const plan = 'Start metformin 500mg now.';
const runningSummary = `${subjective}\n\n${plan}`;

const chestStart = runningSummary.indexOf('chest pain');
const metStart = runningSummary.indexOf('metformin');
const doseStart = runningSummary.indexOf('500mg');

const event: LiveSummaryEvent = {
  consultationId: 'c1',
  runningSummary,
  sections: [
    { title: 'Subjective', content: subjective },
    { title: 'Objective', content: '' },
    { title: 'Assessment', content: '' },
    { title: 'Plan', content: plan },
  ],
  entities: [
    { text: 'chest pain', type: 'PROBLEM', confidence: 0.88, start: chestStart, end: chestStart + 'chest pain'.length },
    { text: 'metformin', type: 'MEDICATION', confidence: 0.91, start: metStart, end: metStart + 'metformin'.length },
    { text: '500mg', type: 'DOSAGE', confidence: 0.7, start: doseStart, end: doseStart + '500mg'.length },
  ],
  updatedAt: '2026-06-08T00:00:00.000Z',
};

describe('LiveSummaryPanel — structured S/O/A/P sections', () => {
  it('renders the four labeled sections in order', () => {
    render(<LiveSummaryPanel event={event} status="open" />);
    const sections = screen.getAllByTestId('live-summary-section');
    expect(sections.map((s) => s.getAttribute('data-section-title'))).toEqual(['Subjective', 'Objective', 'Assessment', 'Plan']);
  });

  it('highlights each entity WITHIN its section at offsets valid against the rendered section text', () => {
    render(<LiveSummaryPanel event={event} status="open" />);

    const subj = screen.getByText('Subjective').closest('[data-testid="live-summary-section"]') as HTMLElement;
    const planSection = screen.getByText('Plan').closest('[data-testid="live-summary-section"]') as HTMLElement;

    // Subjective: only the PROBLEM entity, at offsets local to the subjective text.
    const subjMarks = within(subj).getAllByTestId('entity-highlight');
    expect(subjMarks).toHaveLength(1);
    expect(subjMarks[0].textContent).toBe('chest pain');
    const ss = Number(subjMarks[0].getAttribute('data-entity-start'));
    const se = Number(subjMarks[0].getAttribute('data-entity-end'));
    expect(subjective.slice(ss, se)).toBe('chest pain');
    expect(subjMarks[0].getAttribute('title')).toContain('88%');

    // Plan: the MEDICATION + DOSAGE entities, each at plan-local offsets.
    const planMarks = within(planSection).getAllByTestId('entity-highlight');
    expect(planMarks.map((m) => m.textContent).sort()).toEqual(['500mg', 'metformin']);
    const med = planMarks.find((m) => m.getAttribute('data-entity-type') === 'MEDICATION')!;
    expect(plan.slice(Number(med.getAttribute('data-entity-start')), Number(med.getAttribute('data-entity-end')))).toBe('metformin');

    // Each section's text reconstructs exactly (highlighted + plain together).
    expect(within(subj).getByTestId('section-content').textContent).toBe(subjective);
    expect(within(planSection).getByTestId('section-content').textContent).toBe(plan);
  });

  it('shows a skeleton placeholder for sections not yet populated', () => {
    render(<LiveSummaryPanel event={event} status="open" />);
    const objective = screen.getByText('Objective').closest('[data-testid="live-summary-section"]') as HTMLElement;
    expect(within(objective).getByTestId('section-empty')).toBeInTheDocument();
    expect(within(objective).queryByTestId('section-content')).toBeNull();
  });

  it('renders an entity-type legend and a live status badge', () => {
    render(<LiveSummaryPanel event={event} status="open" />);
    const legend = screen.getByTestId('entity-legend');
    expect(legend.textContent).toContain('MEDICATION');
    expect(legend.textContent).toContain('PROBLEM');
    expect(screen.getByTestId('live-summary-status').textContent).toBe('Live');
  });

  it('renders a single fallback section for unstructured output', () => {
    const fallback: LiveSummaryEvent = {
      consultationId: 'c1',
      runningSummary: 'Pt stable on aspirin.',
      sections: [{ title: 'Running Summary', content: 'Pt stable on aspirin.' }],
      entities: [{ text: 'aspirin', type: 'MEDICATION', confidence: 0.8, start: 'Pt stable on '.length, end: 'Pt stable on aspirin'.length }],
      updatedAt: '2026-06-08T00:00:00.000Z',
    };
    render(<LiveSummaryPanel event={fallback} status="open" />);
    const sections = screen.getAllByTestId('live-summary-section');
    expect(sections).toHaveLength(1);
    expect(sections[0].getAttribute('data-section-title')).toBe('Running Summary');
    expect(within(sections[0]).getByTestId('entity-highlight').textContent).toBe('aspirin');
  });

  it('shows the finalized badge on the terminal (closed) state', () => {
    render(<LiveSummaryPanel event={{ ...event, closed: true }} status="closed" />);
    expect(screen.getByTestId('live-summary-status').textContent).toBe('Finalized');
  });
});

describe('LiveSummaryPanel — non-data states', () => {
  it('shows a skeleton while connecting with no event yet', () => {
    render(<LiveSummaryPanel event={null} status="connecting" />);
    expect(screen.getByTestId('live-summary-skeleton')).toBeInTheDocument();
  });

  it('shows the listening empty state when idle with no summary', () => {
    render(<LiveSummaryPanel event={null} status="idle" />);
    expect(screen.getByTestId('live-summary-empty')).toBeInTheDocument();
  });

  it('shows an error state (never a misleading empty state) on disconnect', () => {
    render(<LiveSummaryPanel event={null} status="error" error="boom" />);
    expect(screen.getByTestId('live-summary-error').textContent).toContain('boom');
    expect(screen.queryByTestId('live-summary-empty')).toBeNull();
  });
});
