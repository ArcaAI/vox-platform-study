/**
 * TASK-797 W2 — the three clinician surfaces, wired into the case note.
 *
 * Corrections write through the clinician's OWN edit buffer (`editor.change`), so the
 * two-writer contract in `use-note-editor.ts` is untouched: an accepted correction is a
 * clinician edit, not a machine write, and it can only happen while the clinician is editing.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { CaseNoteColumn } from '../case-note-column';
import type { UseNoteEditorResult } from '../../../hooks/use-note-editor';
import type { CorrectionProposalSet, ClinicalSuggestionSet } from '../../../api/pending-contracts';
import type { LiveSummarySnapshot, SummaryResult } from '../../../api';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const NOTE = 'Patient started metfromin 500mg.';

const DRAFT: SummaryResult = { id: 'ctx-9', consultationId: 'c-1', type: 'summary', content: NOTE, version: 1 };

function editor(overrides: Partial<UseNoteEditorResult> = {}): UseNoteEditorResult {
  return {
    value: NOTE,
    isEditing: true,
    isDirty: false,
    saving: false,
    supersededBy: null,
    conflict: null,
    error: null,
    beginEdit: vi.fn(),
    change: vi.fn(),
    cancel: vi.fn(),
    save: vi.fn(),
    acceptIncoming: vi.fn(),
    keepMine: vi.fn(),
    overwriteConflict: vi.fn(),
    dismissError: vi.fn(),
    ...overrides,
  };
}

const CORRECTIONS: CorrectionProposalSet = {
  text: NOTE,
  applied: false,
  appliedCount: 0,
  proposals: [
    {
      start: 16,
      end: 25,
      original: 'metfromin',
      proposed: 'metformin',
      category: 'drugName',
      confidence: 0.93,
      rationale: 'misspelling of metformin',
      detectedBy: 'nlp.ner',
      proposedBy: 'lmstudio:hope-scribe',
      status: 'PROPOSED',
    },
  ],
};

const SUGGESTIONS: ClinicalSuggestionSet = { suggestions: [{ text: 'Ask about ankle swelling.', category: 'history' }], count: 1 };

const LIVE: LiveSummarySnapshot = {
  consultationId: 'c-1',
  runningSummary: 'running',
  sections: [
    { title: 'Subjective', content: 'Chest pain for two days.' },
    { title: 'Plan', content: 'Review in one week.' },
  ],
  entities: [],
  updatedAt: '2026-08-23T10:00:00.000Z',
};

function props(overrides: Partial<React.ComponentProps<typeof CaseNoteColumn>> = {}): React.ComponentProps<typeof CaseNoteColumn> {
  return {
    hasConsultation: true,
    isRecording: false,
    live: null,
    draft: DRAFT,
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

describe('CaseNoteColumn — W2 surfaces (TASK-797)', () => {
  it('shows correction proposals while the clinician is editing', () => {
    render(<CaseNoteColumn {...props({ editor: editor(), correctionProposals: CORRECTIONS })} />);
    expect(screen.getByRole('button', { name: /accept correction: metfromin/i })).toBeTruthy();
  });

  it('an accepted correction goes through the clinician edit buffer, never around it', () => {
    const change = vi.fn();
    render(<CaseNoteColumn {...props({ editor: editor({ change }), correctionProposals: CORRECTIONS })} />);
    fireEvent.click(screen.getByRole('button', { name: /accept correction: metfromin/i }));

    expect(change).toHaveBeenCalledWith('Patient started metformin 500mg.');
  });

  it('offers corrections read-only, with a stated reason, when not editing', () => {
    render(<CaseNoteColumn {...props({ editor: editor({ isEditing: false }), correctionProposals: CORRECTIONS })} />);
    expect((screen.getByRole('button', { name: /accept correction: metfromin/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Choose "Edit note" to accept or reject a correction.')).toBeTruthy();
  });

  it('blocks corrections on a signed note', () => {
    render(<CaseNoteColumn {...props({ approved: true, editor: editor({ isEditing: false }), correctionProposals: CORRECTIONS })} />);
    expect((screen.getByRole('button', { name: /accept correction: metfromin/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('This note is signed — corrections can no longer be applied.')).toBeTruthy();
  });

  it('shows suggestions', () => {
    render(<CaseNoteColumn {...props({ suggestions: SUGGESTIONS })} />);
    expect(screen.getByText('Ask about ankle swelling.')).toBeTruthy();
  });

  it('offers a SOAP autofill while editing when live sections exist', () => {
    render(<CaseNoteColumn {...props({ live: LIVE, isRecording: true, editor: editor() })} />);
    expect(screen.getByRole('button', { name: /fill from live summary/i })).toBeTruthy();
  });

  it('the autofill APPENDS the SOAP sections to the buffer, never replacing typed text', () => {
    const change = vi.fn();
    render(<CaseNoteColumn {...props({ live: LIVE, isRecording: true, editor: editor({ value: 'Seen with daughter.', isDirty: true, change }) })} />);
    fireEvent.click(screen.getByRole('button', { name: /fill from live summary/i }));

    expect(change).toHaveBeenCalledWith('Seen with daughter.\n\nSubjective:\nChest pain for two days.\n\nPlan:\nReview in one week.');
  });

  it('offers no autofill when not editing', () => {
    render(<CaseNoteColumn {...props({ live: LIVE, isRecording: true, editor: editor({ isEditing: false }) })} />);
    expect(screen.queryByRole('button', { name: /fill from live summary/i })).toBeNull();
  });

  it('offers no autofill when there is nothing in the live sections', () => {
    render(<CaseNoteColumn {...props({ live: { ...LIVE, sections: [] }, isRecording: true, editor: editor() })} />);
    expect(screen.queryByRole('button', { name: /fill from live summary/i })).toBeNull();
  });

  it('0 axe violations with all three surfaces present', async () => {
    const { container } = render(
      <CaseNoteColumn {...props({ live: LIVE, isRecording: true, editor: editor(), correctionProposals: CORRECTIONS, suggestions: SUGGESTIONS })} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
