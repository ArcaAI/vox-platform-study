/**
 * TASK-797 W2 — interim summaries.
 *
 * TASK-796 routes interpreter-produced interim summaries onto the EXISTING live-summary plane
 * rather than inventing a channel, so there is no new consumer surface: the panel that already
 * renders `sections` renders these too. What the payload gains is PROVENANCE —
 * `source: "interpreter"`, `nodeType`, `ordinal`/`total`, and `metadata.stats.task_key` — and a
 * clinician should be able to tell an interpreter-produced interim summary from the ordinary
 * live flush, and see how far through the sequence it is.
 *
 * Section titles are the four canonical SOAP ones (`soap-parser.ts` hardcodes them); per-tenant
 * schema titles are deferred, so this is deliberately NOT a taxonomy-driven renderer.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { CaseNoteColumn } from '../case-note-column';
import type { LiveSummarySnapshot } from '../../../api';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

function live(overrides: Partial<LiveSummarySnapshot> = {}): LiveSummarySnapshot {
  return {
    consultationId: 'c-1',
    runningSummary: 'Cough for three days.',
    sections: [
      { title: 'Subjective', content: 'Cough for three days.' },
      { title: 'Plan', content: 'Review in one week.' },
    ],
    entities: [],
    updatedAt: '2026-08-23T10:00:00.000Z',
    ...overrides,
  };
}

function props(overrides: Partial<React.ComponentProps<typeof CaseNoteColumn>> = {}): React.ComponentProps<typeof CaseNoteColumn> {
  return {
    hasConsultation: true,
    isRecording: true,
    live: live(),
    draft: null,
    draftLoading: false,
    progress: null,
    assurance: null,
    onGenerate: vi.fn(),
    generatePending: false,
    onApprove: vi.fn(),
    approvePending: false,
    approved: false,
    ...overrides,
  };
}

const INTERIM = live({ source: 'interpreter', nodeType: 'consultation.realtimeSummary', ordinal: 2, total: 3 });

describe('CaseNoteColumn — interim summaries (TASK-797 W2)', () => {
  it('renders the SOAP sections, not a blob', () => {
    render(<CaseNoteColumn {...props({ live: INTERIM })} />);
    expect(screen.getByRole('heading', { name: 'Subjective' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeTruthy();
  });

  it('marks an interpreter-produced snapshot as an interim summary', () => {
    render(<CaseNoteColumn {...props({ live: INTERIM })} />);
    expect(screen.getByText(/interim/i)).toBeTruthy();
  });

  it('shows how far through the sequence it is', () => {
    render(<CaseNoteColumn {...props({ live: INTERIM })} />);
    expect(screen.getByText(/2 of 3/)).toBeTruthy();
  });

  it('says nothing about interim status for an ordinary live flush', () => {
    render(<CaseNoteColumn {...props({ live: live() })} />);
    expect(screen.queryByText(/interim/i)).toBeNull();
  });

  it('omits the position when the payload carries no ordinal', () => {
    render(<CaseNoteColumn {...props({ live: live({ source: 'interpreter', nodeType: 'consultation.realtimeSummary' }) })} />);
    expect(screen.getByText(/interim/i)).toBeTruthy();
    expect(screen.queryByText(/ of /)).toBeNull();
  });

  it('0 axe violations', async () => {
    const { container } = render(<CaseNoteColumn {...props({ live: INTERIM })} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
