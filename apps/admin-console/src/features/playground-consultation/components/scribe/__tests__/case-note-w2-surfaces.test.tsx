/**
 * TASK-797 W2 — the three clinician surfaces, wired into the case note.
 *
 * Corrections write through the clinician's OWN edit buffer (`editor.change`), so the
 * two-writer contract in `use-note-editor.ts` is untouched: an accepted correction is a
 * clinician edit, not a machine write, and it can only happen while the clinician is editing.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { CaseNoteColumn } from '../case-note-column';
import type { UseNoteEditorResult } from '../../../hooks/use-note-editor';
import type { ClinicalSuggestion, CorrectionsEnvelope } from '../../../api/live-assist';
import { sha256Hex } from '../../../lib/text-digest';
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

async function corrections(): Promise<CorrectionsEnvelope> {
  return {
  applied: false,
  appliedCount: 0,
  textSha256: await sha256Hex(NOTE),
  proposals: [
    {
      proposalId: 'p1',
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
}

const SUGGESTIONS: ClinicalSuggestion[] = [{ suggestionId: 's1', text: 'Ask about ankle swelling.', category: 'history', status: 'PROPOSED' }];

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
  it('shows correction proposals while the clinician is editing', async () => {
    render(<CaseNoteColumn {...props({ editor: editor(), correctionProposals: await corrections() })} />);
    expect(screen.getByRole('button', { name: /accept correction: metfromin/i })).toBeTruthy();
  });

  it('an accepted correction goes through the clinician edit buffer, never around it', async () => {
    const change = vi.fn();
    render(<CaseNoteColumn {...props({ editor: editor({ change }), correctionProposals: await corrections() })} />);
    fireEvent.click(screen.getByRole('button', { name: /accept correction: metfromin/i }));

    // The SHA-256 gate (796 rule 2) runs first, so the write lands on a later tick.
    await waitFor(() => expect(change).toHaveBeenCalledWith('Patient started metformin 500mg.'));
  });

  it('offers corrections read-only, with a stated reason, when not editing', async () => {
    render(<CaseNoteColumn {...props({ editor: editor({ isEditing: false }), correctionProposals: await corrections() })} />);
    expect((screen.getByRole('button', { name: /accept correction: metfromin/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Choose "Edit note" to accept or reject a correction.')).toBeTruthy();
  });

  it('blocks corrections on a signed note', async () => {
    render(<CaseNoteColumn {...props({ approved: true, editor: editor({ isEditing: false }), correctionProposals: await corrections() })} />);
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
      <CaseNoteColumn {...props({ live: LIVE, isRecording: true, editor: editor(), correctionProposals: await corrections(), suggestions: SUGGESTIONS })} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('0 axe violations across the live-session surfaces (running summary, assistant activity, vitals, detected entities)', async () => {
    const { container } = render(
      <CaseNoteColumn
        {...props({
          draft: null,
          live: {
            ...LIVE,
            entities: [{ text: 'chest pain', type: 'symptom', icd10: 'R07.9' }],
            vitals: { systolic: 120, diastolic: 80, heartRate: 72, spo2: 98, temperatureC: 37, weightKg: 70 },
          },
          isRecording: true,
          loopActivity: [
            {
              kind: 'note.thinking',
              kindKey: 'note.thinking',
              label: 'Drafting subjective',
              publishedAt: '2026-08-23T10:00:00.000Z',
              ordinal: 1,
              total: 3,
              chars: 120,
            },
          ],
          namedEntities: {
            consultationId: 'c-1',
            scope: 'consultation',
            entities: { Symptom: [{ text: 'chest pain', displayText: 'Chest pain' }] },
            totalCount: 1,
            countByClass: { Symptom: 1 },
            sources: [],
          },
        })}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
