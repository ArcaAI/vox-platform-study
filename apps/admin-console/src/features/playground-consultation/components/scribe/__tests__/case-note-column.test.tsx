/**
 * case-note column: the personalized draft, the folded-in
 * harness assurance envelope, and the safety-gated sign-off. Pure component.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssuranceStrip, CaseNoteColumn } from '../case-note-column';
import type { HarnessAssuranceSnapshot, HarnessProgressSnapshot, SummaryResult } from '../../../api';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DRAFT: SummaryResult = {
  id: 'ctx-9',
  consultationId: 'c-1',
  type: 'summary',
  content: 'S: Follow-up for hypertension. Improving.',
  version: 1,
  structuredData: { llmProvider: 'lmstudio', modelName: 'hope-scribe-v2', processingTimeMs: 812 },
};

function progress(stagesDone: number, closed = false): HarnessProgressSnapshot {
  const labels = ['Extracting', 'Assembling', 'Drafting', 'Safety', 'Finalizing'];
  return {
    stages: labels.map((label, index) => ({
      stage: label.toLowerCase(),
      label,
      ordinal: index,
      status: index < stagesDone ? 'completed' : index === stagesDone && !closed ? 'active' : 'pending',
      attempt: 1,
      at: 'now',
    })),
    updatedAt: 'now',
    closed,
  };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof CaseNoteColumn>> = {}): React.ComponentProps<typeof CaseNoteColumn> {
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

afterEach(cleanup);

describe('AssuranceStrip', () => {
  it('renders nothing when the harness never ran (plain path)', () => {
    const { container } = render(<AssuranceStrip progress={null} assurance={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the active drafting stage while in flight', () => {
    render(<AssuranceStrip progress={progress(2)} assurance={null} />);
    expect(screen.getByText(/drafting…/i)).toBeTruthy();
    expect(screen.getByText(/2\/5 stages/i)).toBeTruthy();
  });

  it('shows the gate outcome once assurance lands', () => {
    render(
      <AssuranceStrip
        progress={progress(5, true)}
        assurance={{
          claims: [{ claimId: 'k1', sensor: 'groundedness', verdict: 'pass' }],
          gateDecision: 'pass',
          safetyFlag: false,
          updatedAt: 'now',
          closed: true,
        }}
      />,
    );
    expect(screen.getByText(/gate: pass/i)).toBeTruthy();
  });

  it('surfaces a safety flag', () => {
    const assurance: HarnessAssuranceSnapshot = { claims: [], safetyFlag: true, updatedAt: 'now', closed: true };
    render(<AssuranceStrip progress={null} assurance={assurance} />);
    expect(screen.getByText(/safety flag/i)).toBeTruthy();
  });
});

describe('CaseNoteColumn', () => {
  it('renders the personalized draft and provenance', () => {
    render(<CaseNoteColumn {...baseProps()} />);
    expect(screen.getByText(/follow-up for hypertension/i)).toBeTruthy();
    expect(screen.getByText(/hope-scribe-v2/)).toBeTruthy();
  });

  it('signs the note via onApprove', () => {
    const onApprove = vi.fn();
    render(<CaseNoteColumn {...baseProps({ onApprove })} />);
    fireEvent.click(screen.getByRole('button', { name: /sign & save/i }));
    expect(onApprove).toHaveBeenCalledWith({ overrideSafetyFlag: false });
  });

  it('blocks sign-off behind the safety override, then allows it', () => {
    const onApprove = vi.fn();
    const assurance: HarnessAssuranceSnapshot = { claims: [], safetyFlag: true, updatedAt: 'now', closed: true };
    render(<CaseNoteColumn {...baseProps({ onApprove, assurance })} />);

    const sign = screen.getByRole('button', { name: /sign & save/i }) as HTMLButtonElement;
    expect(sign.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/override safety flag/i));
    expect(sign.disabled).toBe(false);
    fireEvent.click(sign);
    expect(onApprove).toHaveBeenCalledWith({ overrideSafetyFlag: true });
  });

  it('hides the manual generate action when the harness owns drafting', () => {
    render(<CaseNoteColumn {...baseProps({ onGenerate: null })} />);
    expect(screen.queryByRole('button', { name: /generate note/i })).toBeNull();
  });

  it('shows the live running SOAP sections while recording with no persisted draft', () => {
    render(
      <CaseNoteColumn
        {...baseProps({
          draft: null,
          isRecording: true,
          live: {
            consultationId: 'c-1',
            runningSummary: '',
            sections: [{ title: 'Subjective', content: 'Reports headache.' }],
            entities: [
              { text: 'headache', type: 'SIGN_SYMPTOM' },
              { text: 'hypertension', type: 'DISEASE_DISORDER', icd10: 'I10' },
            ],
            vitals: { systolic: 138, diastolic: 88, heartRate: 78, spo2: 98 },
            updatedAt: 'now',
          },
        })}
      />,
    );
    expect(screen.getByText('Subjective')).toBeTruthy();
    expect(screen.getByText(/reports headache/i)).toBeTruthy();
    expect(screen.getByText('headache')).toBeTruthy();
    // ICD-10 code chip renders when the entity carries one (Phase C).
    expect(screen.getByText('I10')).toBeTruthy();
    // Vitals grid renders present values (Phase D).
    expect(screen.getByText('138/88')).toBeTruthy();
    expect(screen.getByText('98%')).toBeTruthy();
  });

  it('shows a degraded indicator and freezes the prior content when textFailed is true (TASK-703)', () => {
    render(
      <CaseNoteColumn
        {...baseProps({
          draft: null,
          isRecording: true,
          live: {
            consultationId: 'c-1',
            runningSummary: 'Pt on amlodipine for HTN.',
            sections: [{ title: 'Subjective', content: 'Pt on amlodipine for HTN.' }],
            entities: [],
            updatedAt: 'now',
            textFailed: true,
          },
        })}
      />,
    );
    expect(screen.getByText(/note assistant unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/note assistant drafting/i)).toBeNull();
    // Frozen prior content stays visible — not blanked/hidden by the degraded state.
    expect(screen.getByText(/pt on amlodipine for htn/i)).toBeTruthy();
  });

  // click-to-source evidence panel at sign-off.
  describe('citation evidence panel', () => {
    const SEGMENTS = [{ id: 'seg-1', idx: 0, t0Ms: 0, t1Ms: 3000, speaker: 'patient', charStart: 0, charEnd: 27 }];

    it('shows cited evidence for a persisted draft', () => {
      render(<CaseNoteColumn {...baseProps({ citedSegments: SEGMENTS, transcriptText: 'Patient reports chest pain. More.' })} />);
      expect(screen.getByText('Patient reports chest pain.')).toBeTruthy();
    });

    it('reports the clicked citation via onSelectCitation', () => {
      const onSelectCitation = vi.fn();
      render(<CaseNoteColumn {...baseProps({ citedSegments: SEGMENTS, transcriptText: 'Patient reports chest pain. More.', onSelectCitation })} />);
      fireEvent.click(screen.getByText('Patient reports chest pain.'));
      expect(onSelectCitation).toHaveBeenCalledWith(SEGMENTS[0]);
    });

    it('shows no evidence panel while only the live view is showing (no persisted draft yet)', () => {
      render(
        <CaseNoteColumn
          {...baseProps({
            draft: null,
            isRecording: true,
            citedSegments: SEGMENTS,
            transcriptText: 'Patient reports chest pain. More.',
            live: { consultationId: 'c-1', runningSummary: 'Running…', sections: [], entities: [], updatedAt: 'now' },
          })}
        />,
      );
      expect(screen.queryByLabelText(/cited transcript evidence/i)).toBeNull();
    });

    it('renders no evidence panel when nothing was cited', () => {
      render(<CaseNoteColumn {...baseProps()} />);
      expect(screen.queryByLabelText(/cited transcript evidence/i)).toBeNull();
    });
  });
});

/**
 * W5 / M-7 — the async summary path had zero call sites. It is now the manual
 * Generate path, so the column has to surface job progress and offer a cancel;
 * the sync mutation used to block for the whole generation with no feedback.
 */
describe('CaseNoteColumn — async generation progress', () => {
  it('shows the current step and a cancel action while a job is running', () => {
    const onCancelGenerate = vi.fn();
    render(
      <CaseNoteColumn
        {...baseProps({
          draft: null,
          generatePending: true,
          generateStatus: 'Summarizing transcript',
          onCancelGenerate,
        })}
      />,
    );

    expect(screen.getByText(/summarizing transcript/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /cancel generation/i }));
    expect(onCancelGenerate).toHaveBeenCalled();
  });

  it('offers no cancel action when nothing is generating', () => {
    render(<CaseNoteColumn {...baseProps({ draft: null, generatePending: false, onCancelGenerate: vi.fn() })} />);
    expect(screen.queryByRole('button', { name: /cancel generation/i })).toBeNull();
  });
});
