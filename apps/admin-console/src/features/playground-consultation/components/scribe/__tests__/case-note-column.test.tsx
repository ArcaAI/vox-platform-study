/**
 * case-note column: the personalized draft, the folded-in
 * harness assurance envelope, and the safety-gated sign-off. Pure component.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
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
    // ICD-10 code chip renders when the entity carries one.
    expect(screen.getByText('I10')).toBeTruthy();
    // Vitals grid renders present values.
    expect(screen.getByText('138/88')).toBeTruthy();
    expect(screen.getByText('98%')).toBeTruthy();
  });

  it('shows a degraded indicator and freezes the prior content when textFailed is true ', () => {
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

  describe('D-18 — empty-first-flush contradiction and live-stream status/error', () => {
    it('never shows "showing last update" together with the loading skeleton on a first-flush failure', () => {
      render(
        <CaseNoteColumn
          {...baseProps({
            draft: null,
            isRecording: true,
            live: {
              consultationId: 'c-1',
              runningSummary: '',
              sections: [],
              entities: [],
              updatedAt: 'now',
              textFailed: true,
            },
          })}
        />,
      );
      // The header must not claim a stale update exists when there is none.
      expect(screen.queryByText(/showing last update/i)).toBeNull();
      // The body must not present this as an in-progress load — that hides the failure.
      expect(screen.queryByLabelText(/waiting for the first live summary/i)).toBeNull();
      expect(screen.getByText(/note assistant unavailable/i)).toBeTruthy();
    });

    it('keeps "showing last update" when textFailed is true but prior content survived', () => {
      render(
        <CaseNoteColumn
          {...baseProps({
            draft: null,
            isRecording: true,
            live: {
              consultationId: 'c-1',
              runningSummary: 'Pt on amlodipine for HTN.',
              sections: [],
              entities: [],
              updatedAt: 'now',
              textFailed: true,
            },
          })}
        />,
      );
      expect(screen.getByText(/showing last update/i)).toBeTruthy();
    });

    it('surfaces a distinct connection-error state from liveStatus/liveError (separate from a generation failure)', () => {
      render(
        <CaseNoteColumn
          {...baseProps({
            draft: null,
            isRecording: true,
            live: null,
            liveStatus: 'error',
            liveError: 'Live-summary SSE connection error',
          })}
        />,
      );
      expect(screen.getByText(/live update connection lost/i)).toBeTruthy();
      // Not the generation-failure copy — this is a transport problem, not a model failure.
      expect(screen.queryByText(/note assistant unavailable/i)).toBeNull();
    });
  });

  describe('DD-3 — N documents from the section.patch plane', () => {
    it('renders every document, each with a heading and its sections in order', () => {
      render(
        <CaseNoteColumn
          {...baseProps({
            draft: null,
            isRecording: true,
            documentSections: [
              {
                documentKey: 'soap_note',
                sections: [
                  { sectionKey: 'subjective', title: 'Subjective', idx: 0, revision: 1, state: 'confirmed', content: 'Patient reports feeling well.', annotations: [] },
                  { sectionKey: 'assessment', title: 'Assessment', idx: 1, revision: 1, state: 'provisional', content: 'Hypertension, well controlled.', annotations: [] },
                ],
              },
              {
                documentKey: 'discharge_summary',
                sections: [{ sectionKey: 'plan', title: 'Plan', idx: 0, revision: 1, state: 'empty', content: '', annotations: [] }],
              },
            ],
          })}
        />,
      );
      expect(screen.getByText(/soap note/i)).toBeTruthy();
      expect(screen.getByText(/discharge summary/i)).toBeTruthy();
      expect(screen.getByText('Subjective')).toBeTruthy();
      expect(screen.getByText(/patient reports feeling well/i)).toBeTruthy();
      expect(screen.getByText('Assessment')).toBeTruthy();
      expect(screen.getByText(/hypertension, well controlled/i)).toBeTruthy();
      expect(screen.getByText('Plan')).toBeTruthy();
    });

    it('shows a distinct state badge per section — provisional vs confirmed vs locked', () => {
      render(
        <CaseNoteColumn
          {...baseProps({
            draft: null,
            isRecording: true,
            documentSections: [
              {
                documentKey: 'soap_note',
                sections: [
                  { sectionKey: 'subjective', title: 'Subjective', idx: 0, revision: 2, state: 'confirmed', content: 'Patient is stable.', annotations: [] },
                  { sectionKey: 'assessment', title: 'Assessment', idx: 1, revision: 1, state: 'provisional', content: 'Likely viral.', annotations: [] },
                  { sectionKey: 'plan', title: 'Plan', idx: 2, revision: 1, state: 'locked', content: 'Discharge home.', annotations: [] },
                ],
              },
            ],
          })}
        />,
      );
      expect(screen.getByText(/^confirmed$/i)).toBeTruthy();
      expect(screen.getByText(/^provisional$/i)).toBeTruthy();
      expect(screen.getByText(/^locked$/i)).toBeTruthy();
    });

    it('renders an empty section as a skeleton, never an error', () => {
      render(
        <CaseNoteColumn
          {...baseProps({
            draft: null,
            isRecording: true,
            documentSections: [
              { documentKey: 'soap_note', sections: [{ sectionKey: 'plan', title: 'Plan', idx: 0, revision: 0, state: 'empty', content: '', annotations: [] }] },
            ],
          })}
        />,
      );
      expect(screen.queryByText(/error/i)).toBeNull();
      expect(document.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    });

    it('takes priority over the legacy single-section live view when both are present', () => {
      render(
        <CaseNoteColumn
          {...baseProps({
            draft: null,
            isRecording: true,
            live: {
              consultationId: 'c-1',
              runningSummary: 'legacy running summary text',
              sections: [{ title: 'Legacy Section', content: 'legacy content' }],
              entities: [],
              updatedAt: 'now',
            },
            documentSections: [
              { documentKey: 'soap_note', sections: [{ sectionKey: 'subjective', title: 'Subjective', idx: 0, revision: 1, state: 'provisional', content: 'multi-doc content', annotations: [] }] },
            ],
          })}
        />,
      );
      expect(screen.getByText(/multi-doc content/i)).toBeTruthy();
      expect(screen.queryByText('Legacy Section')).toBeNull();
    });

    it('falls back to the legacy single-section view when no document-section data has arrived', () => {
      render(
        <CaseNoteColumn
          {...baseProps({
            draft: null,
            isRecording: true,
            live: {
              consultationId: 'c-1',
              runningSummary: 'legacy running summary text',
              sections: [{ title: 'Legacy Section', content: 'legacy content' }],
              entities: [],
              updatedAt: 'now',
            },
            documentSections: [],
          })}
        />,
      );
      expect(screen.getByText('Legacy Section')).toBeTruthy();
    });
  });

  describe('R4/OD-5 — per-section Confirm checkpoint', () => {
    function withOneSection(state: 'provisional' | 'confirmed' | 'locked' | 'empty', overrides: Partial<React.ComponentProps<typeof CaseNoteColumn>> = {}) {
      return baseProps({
        draft: null,
        isRecording: true,
        documentSections: [
          { documentKey: 'soap_note', sections: [{ sectionKey: 'plan', title: 'Plan', idx: 0, revision: 1, state, content: state === 'empty' ? '' : 'Discharge home.', annotations: [] }] },
        ],
        ...overrides,
      });
    }

    it('shows Confirm only for a provisional section', () => {
      render(<CaseNoteColumn {...withOneSection('provisional', { onConfirmSection: vi.fn() })} />);
      expect(screen.getByRole('button', { name: /confirm/i })).toBeTruthy();
    });

    it.each(['confirmed', 'locked'] as const)('shows no Confirm control once a section is %s', (state) => {
      render(<CaseNoteColumn {...withOneSection(state, { onConfirmSection: vi.fn() })} />);
      expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull();
    });

    it('renders no Confirm control when the caller has not wired one (opt-in, mirrors `editor`)', () => {
      render(<CaseNoteColumn {...withOneSection('provisional')} />);
      expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull();
    });

    it('reports the documentKey and sectionKey on click', () => {
      const onConfirmSection = vi.fn();
      render(<CaseNoteColumn {...withOneSection('provisional', { onConfirmSection })} />);
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
      expect(onConfirmSection).toHaveBeenCalledWith('soap_note', 'plan');
    });

    it('disables Confirm while a confirm is already in flight', () => {
      render(<CaseNoteColumn {...withOneSection('provisional', { onConfirmSection: vi.fn(), confirmSectionPending: true })} />);
      expect((screen.getByRole('button', { name: /confirm/i }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('R4 — the appended-content highlight', () => {
    it('sets off the newly-appended tail when content ends with it', () => {
      render(
        <CaseNoteColumn
          {...baseProps({
            draft: null,
            isRecording: true,
            documentSections: [
              {
                documentKey: 'soap_note',
                sections: [{ sectionKey: 'plan', title: 'Plan', idx: 0, revision: 2, state: 'provisional', content: 'Discharge home tomorrow.', appended: ' tomorrow.', annotations: [] }],
              },
            ],
          })}
        />,
      );
      const mark = document.querySelector('mark');
      expect(mark?.textContent).toBe(' tomorrow.');
      // The prior text renders too — the highlight marks only the tail, not the whole section.
      expect(screen.getByText(/discharge home/i)).toBeTruthy();
    });

    it('never highlights when content does not end with the appended slice (out-of-order/replaced)', () => {
      render(
        <CaseNoteColumn
          {...baseProps({
            draft: null,
            isRecording: true,
            documentSections: [
              {
                documentKey: 'soap_note',
                sections: [{ sectionKey: 'plan', title: 'Plan', idx: 0, revision: 2, state: 'provisional', content: 'Fully rewritten.', appended: 'stale slice', annotations: [] }],
              },
            ],
          })}
        />,
      );
      expect(document.querySelector('mark')).toBeNull();
      expect(screen.getByText('Fully rewritten.')).toBeTruthy();
    });

    it('renders plainly when no patch has appended anything', () => {
      render(
        <CaseNoteColumn
          {...baseProps({
            draft: null,
            isRecording: true,
            documentSections: [{ documentKey: 'soap_note', sections: [{ sectionKey: 'plan', title: 'Plan', idx: 0, revision: 1, state: 'provisional', content: 'Discharge home.', annotations: [] }] }],
          })}
        />,
      );
      expect(document.querySelector('mark')).toBeNull();
    });
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

/**
 * W4 / R3 — the realtime-summary feed. event carries progress
 * metadata and NO text, so the UI must show progress and must not imply a
 * body it does not have.
 */
describe('CaseNoteColumn — loop activity (realtime summaries)', () => {
  const feed = [
    { kind: 'summary.interim', kindKey: 'soap.subjective', ordinal: 1, total: 4, chars: 210, publishedAt: 'a' },
    { kind: 'summary.interim', kindKey: 'soap.objective', ordinal: 2, total: 4, chars: 88, publishedAt: 'b' },
  ];

  it('renders interim-summary progress from metadata', () => {
    render(<CaseNoteColumn {...baseProps({ draft: null, isRecording: true, loopActivity: feed })} />);
    expect(screen.getByText(/assistant activity/i)).toBeTruthy();
    expect(screen.getByText(/soap.objective/i)).toBeTruthy();
    expect(screen.getByText(/2 of 4/i)).toBeTruthy();
  });

  it('renders nothing when the loop has produced no events', () => {
    render(<CaseNoteColumn {...baseProps({ draft: null, loopActivity: [] })} />);
    expect(screen.queryByText(/assistant activity/i)).toBeNull();
  });
});

describe(' accessibility — 0 axe violations on every new/changed state', () => {
  it('empty-first-flush failure state', async () => {
    const { container } = render(
      <CaseNoteColumn
        {...baseProps({
          draft: null,
          isRecording: true,
          live: { consultationId: 'c-1', runningSummary: '', sections: [], entities: [], updatedAt: 'now', textFailed: true },
        })}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('connection-error state (liveStatus === error)', async () => {
    const { container } = render(
      <CaseNoteColumn {...baseProps({ draft: null, isRecording: true, live: null, liveStatus: 'error', liveError: 'boom' })} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('N-document view with a mix of empty/provisional/confirmed/locked sections', async () => {
    const { container } = render(
      <CaseNoteColumn
        {...baseProps({
          draft: null,
          isRecording: true,
          documentSections: [
            {
              documentKey: 'soap_note',
              sections: [
                { sectionKey: 'subjective', title: 'Subjective', idx: 0, revision: 2, state: 'confirmed', content: 'Patient is stable.', annotations: [] },
                { sectionKey: 'assessment', title: 'Assessment', idx: 1, revision: 1, state: 'provisional', content: 'Likely viral.', annotations: [] },
              ],
            },
            { documentKey: 'discharge_summary', sections: [{ sectionKey: 'plan', title: 'Plan', idx: 0, revision: 0, state: 'empty', content: '', annotations: [] }] },
          ],
        })}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * TASK-932 D-9 — the WARM-START panel.
 *
 * The pre-summary is generated in parallel with the microphone opening, so this panel is on
 * screen before it has anything in it. All three states must therefore be DRAWN differently —
 * which is the lesson of TASK-891 B5, where an unpopulated section and a failed one rendered the
 * same `<Skeleton />` forever ("The owner watched that skeleton for ten minutes").
 *
 * The other rule is that a lane authoring NO warm start must leave no empty labelled box on the
 * screen (rule 11 §4), which is why the whole panel is absent until an event arrives.
 */
describe('CaseNoteColumn — TASK-932 pre-summary panel', () => {
  const panel = () => screen.queryByTestId('pre-summary-panel');

  it('renders nothing at all before an event arrives — absence is not an empty box', () => {
    render(<CaseNoteColumn {...baseProps()} />);
    expect(panel()).toBeNull();
  });

  it('while RUNNING, shows a skeleton and says what it is doing', () => {
    render(<CaseNoteColumn {...baseProps({ preSummary: { status: 'running', content: null, error: null, agentSlug: null, updatedAt: null } })} />);
    expect(panel()?.getAttribute('data-status')).toBe('running');
    expect(screen.getByText(/reading the previous case notes/i)).toBeTruthy();
    // A skeleton is correct HERE and only here: content is genuinely on its way.
    expect(panel()!.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('when READY, shows the pre-summary text and badges it as AI-generated', () => {
    render(
      <CaseNoteColumn
        {...baseProps({
          preSummary: { status: 'ready', content: '- Diabetes (recorded 11-Aug-2026)', error: null, agentSlug: 'case-notes-pre-summary', updatedAt: null },
        })}
      />,
    );
    expect(panel()?.getAttribute('data-status')).toBe('ready');
    expect(screen.getByText('- Diabetes (recorded 11-Aug-2026)')).toBeTruthy();
    // Rule 11 §7 — AI-generated content carries an AI badge.
    expect(screen.getByText('AI')).toBeTruthy();
    expect(panel()!.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
  });

  it('`no_case_notes` reads as a FACT about the patient, not as an error', () => {
    render(<CaseNoteColumn {...baseProps({ preSummary: { status: 'degraded', content: null, error: 'no_case_notes', agentSlug: null, updatedAt: null } })} />);
    // The badge and the sentence both say it, which is the point — one for the glance, one for
    // the read — so match the count rather than assuming a single node.
    expect(screen.getAllByText(/nothing to summarise/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/no previous case notes were available/i)).toBeTruthy();
    // Not styled as a failure: a first-ever visit has no prior record, and that is normal.
    expect(screen.queryByText(/^unavailable$/i)).toBeNull();
  });

  it('a real failure says so, and never leaves the clinician looking at a skeleton', () => {
    render(
      <CaseNoteColumn {...baseProps({ preSummary: { status: 'degraded', content: null, error: 'warm_start_unwired', agentSlug: null, updatedAt: null } })} />,
    );
    expect(screen.getByText(/^unavailable$/i)).toBeTruthy();
    expect(screen.getByText(/not available in this environment/i)).toBeTruthy();
    expect(panel()!.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
  });

  it('an unrecognised reason code still resolves the panel rather than showing the raw code', () => {
    render(
      <CaseNoteColumn {...baseProps({ preSummary: { status: 'degraded', content: null, error: 'AxiosError', agentSlug: null, updatedAt: null } })} />,
    );
    expect(screen.getByText(/could not be produced for this consultation/i)).toBeTruthy();
    expect(screen.queryByText('AxiosError')).toBeNull();
  });

  it('has no axe violations in any of the three states', async () => {
    for (const preSummary of [
      { status: 'running' as const, content: null, error: null, agentSlug: null, updatedAt: null },
      { status: 'ready' as const, content: 'x', error: null, agentSlug: null, updatedAt: null },
      { status: 'degraded' as const, content: null, error: 'no_case_notes', agentSlug: null, updatedAt: null },
    ]) {
      const { container, unmount } = render(<CaseNoteColumn {...baseProps({ preSummary })} />);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
