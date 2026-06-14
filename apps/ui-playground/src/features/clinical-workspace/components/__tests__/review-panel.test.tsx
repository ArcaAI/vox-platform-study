/**
 * ReviewPanel integration test (TASK-330 P3, WS5).
 *
 * Verifies the playground's review wiring around the REUSED `ReviewScreen`:
 *   - fetched provenance (`citationsMap`) is mapped (real `mapProvenanceToReviewData`)
 *     into the `ClinicalReviewData` the review screen renders, with each claim's
 *     evidence offsets resolving to the correct transcript span — i.e. the data a
 *     clinician's CLICK-TO-INSPECT highlights (the click→highlight UI itself is
 *     covered by `review-screen.test.tsx`).
 *   - Approve & sign calls `POST …/approve` and invalidates the caches.
 *   - Edit persists via `PATCH …/summary/:id`.
 *   - empty / loading / error states render (never a misleading empty state).
 *
 * `ReviewScreen` is stubbed to capture the props it receives + expose approve, so
 * the test asserts the data pipeline rather than re-testing the screen internals.
 * `@arcaai/vox` + `@arcaai/ui/*` are blanked by the vitest config, so we re-mock
 * the bits ReviewPanel touches.
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  approveNote: vi.fn(),
  updateSummaryContent: vi.fn(),
  invalidateQueries: vi.fn(),
  reviewScreenProps: vi.fn(),
  provenanceState: { data: undefined as any, isLoading: false, isError: false, refetch: vi.fn() },
  // TASK-345 — live harness progress feed (hook stubbed; reducer covered in lib tests).
  progressState: { stages: [] as any[], total: undefined as number | undefined, closed: false, status: 'idle', error: null as string | null },
  useHarnessProgress: vi.fn(),
  // TASK-355 Phase D Slice 6c — live per-claim assurance feed (hook stubbed; reducer covered in lib tests).
  assuranceState: {
    claims: [] as any[],
    total: undefined as number | undefined,
    gateDecision: null as string | null,
    safetyFlag: false,
    reducedAssurance: false,
    postSignAlert: false,
    closed: false,
    status: 'idle',
    error: null as string | null,
  },
  useHarnessAssurance: vi.fn(),
}));

// Stub the reused review screen: capture the props (the mapped review data) and
// expose a minimal approve trigger so we can assert the sign-off wiring.
vi.mock('../review', () => ({
  ReviewScreen: (props: any) => {
    h.reviewScreenProps(props);
    // Mirror ReviewScreen's Q4 contract: a terminal safety FLAG turns approve into
    // a one-click override (sends overrideSafetyFlag); otherwise a plain sign.
    return (
      <div data-testid="review-screen-stub">
        <button
          data-testid="rs-approve"
          onClick={() => void props.onApprove(props.data.noteContextItemId, props.assurance?.safetyFlag ? { overrideSafetyFlag: true } : undefined)}
        >
          approve
        </button>
      </div>
    );
  },
}));

vi.mock('../../api/clinical-workspace.api', () => ({
  approveNote: h.approveNote,
  updateSummaryContent: h.updateSummaryContent,
}));

vi.mock('../../api/queries', () => ({
  clinicalWorkspaceKeys: {
    context: (id: string) => ['ctx', id],
    provenance: (id: string, noteId: string) => ['prov', id, noteId],
  },
  useProvenanceQuery: () => h.provenanceState,
}));

vi.mock('../../hooks/use-harness-progress', () => ({
  useHarnessProgress: (opts: any) => {
    h.useHarnessProgress(opts);
    return h.progressState;
  },
}));

vi.mock('../../hooks/use-harness-assurance', () => ({
  useHarnessAssurance: (opts: any) => {
    h.useHarnessAssurance(opts);
    return h.assuranceState;
  },
}));

vi.mock('@arcaai/vox', () => ({
  useArcaStore: (selector: any) => selector({ apiClient: { __fake: true } }),
}));

// TASK-344 — the drafted SOAP body is wrapped in a connected manual-highlight
// surface. Stub it so this test asserts the SUMMARY wiring without the
// `:id/highlights` React Query hooks.
vi.mock('../highlightable-surface', () => ({
  ManualHighlightSurface: (props: any) => (
    <div data-testid="summary-surface" data-target-kind={props.targetKind} data-source-id={props.sourceContextItemId} data-text={props.text} />
  ),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: h.invalidateQueries }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children, ...p }: any) => <span {...p}>{children}</span> }));
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, ...p }: any) => <button {...p}>{children}</button>,
}));
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/dialog', () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogTrigger: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/label', () => ({ Label: ({ children, ...p }: any) => <label {...p}>{children}</label> }));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: (p: any) => <div data-testid="skeleton" {...p} /> }));
vi.mock('@arcaai/ui/textarea', () => ({ Textarea: (p: any) => <textarea {...p} /> }));

import { ReviewPanel } from '../review-panel';
import { toast } from 'sonner';
import type { TranscriptSource } from '@arcaai/vox';
import type { SummaryProvenanceResponse } from '../../types';

const CONSULTATION_ID = 'consult-1';
const NOTE_ID = 'note-ctx-1';

const TRANSCRIPT = 'Patient reports chest pain radiating to the left arm since this morning. BP is 150 over 95.';
const span1 = 'chest pain radiating to the left arm';
const span2 = 'BP is 150 over 95';
const s1 = TRANSCRIPT.indexOf(span1);
const e1 = s1 + span1.length;
const s2 = TRANSCRIPT.indexOf(span2);
const e2 = s2 + span2.length;

const transcripts: TranscriptSource[] = [{ contextItemId: 'tx1', text: TRANSCRIPT, label: 'Live transcription' }];

// Server provenance with an opaque citationsMap (as it arrives over the wire).
const provenance: SummaryProvenanceResponse = {
  consultationId: CONSULTATION_ID,
  contextItemId: NOTE_ID,
  status: 'PENDING_REVIEW',
  modelName: 'demo-model',
  citationsMap: {
    claims: [
      {
        id: 'c1',
        text: 'Chest pain radiating to the left arm',
        section: 'S',
        status: 'flagged',
        confidence: 0.41,
        evidence: [{ transcriptContextItemId: 'tx1', startOffset: s1, endOffset: e1, quote: span1 }],
        entityRefs: [],
        knowledgeChunkIds: [],
      },
      {
        id: 'c2',
        text: 'Blood pressure 150/95',
        section: 'O',
        status: 'verified',
        confidence: 0.95,
        evidence: [{ transcriptContextItemId: 'tx1', startOffset: s2, endOffset: e2, quote: span2 }],
        entityRefs: [],
        knowledgeChunkIds: [],
      },
    ],
  },
  sensorScores: { entityFaithfulness: 0.8, coverage: 0.7, schemaValid: 1, citationPresence: 0.6, numericDose: 0.5 },
} as unknown as SummaryProvenanceResponse;

function renderPanel(overrides: Partial<React.ComponentProps<typeof ReviewPanel>> = {}) {
  return render(
    <ReviewPanel
      consultationId={CONSULTATION_ID}
      noteContextItemId={NOTE_ID}
      noteContent={'S: chest pain\nO: BP 150/95'}
      transcripts={transcripts}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.provenanceState = { data: provenance, isLoading: false, isError: false, refetch: vi.fn() };
  h.progressState = { stages: [], total: undefined, closed: false, status: 'idle', error: null };
  h.assuranceState = {
    claims: [],
    total: undefined,
    gateDecision: null,
    safetyFlag: false,
    reducedAssurance: false,
    postSignAlert: false,
    closed: false,
    status: 'idle',
    error: null,
  };
});

describe('ReviewPanel — provenance → click-to-inspect data', () => {
  it('maps each claim to a transcript span resolvable by its evidence offsets', () => {
    renderPanel();

    const data = h.reviewScreenProps.mock.calls.at(-1)![0].data;
    expect(data.consultationId).toBe(CONSULTATION_ID);
    expect(data.noteContextItemId).toBe(NOTE_ID);
    expect(data.citationsMap.claims).toHaveLength(2);

    // Each claim's evidence offsets resolve to the exact transcript span the
    // clinician would see highlighted on click-to-inspect.
    const source = data.transcripts.find((t: TranscriptSource) => t.contextItemId === 'tx1')!;
    const c1 = data.citationsMap.claims.find((c: any) => c.id === 'c1')!;
    const ev1 = c1.evidence[0];
    expect(source.text.slice(ev1.startOffset, ev1.endOffset)).toBe(span1);
    expect(ev1.quote).toBe(span1);

    const c2 = data.citationsMap.claims.find((c: any) => c.id === 'c2')!;
    const ev2 = c2.evidence[0];
    expect(source.text.slice(ev2.startOffset, ev2.endOffset)).toBe(span2);

    // Flagged/low-confidence claim is preserved so the screen can float it first.
    expect(c1.status).toBe('flagged');
    expect(data.status).toBe('PENDING_REVIEW');
  });

  it('drops malformed claims so a highlight can never index outside a transcript', () => {
    h.provenanceState = {
      data: {
        ...provenance,
        citationsMap: {
          claims: [
            { id: 'ok', text: 'fine', section: 'S', status: 'verified', confidence: 1, evidence: [], entityRefs: [], knowledgeChunkIds: [] },
            { id: 'bad', text: 123 }, // not a valid claim → dropped
            'nonsense',
          ],
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };

    renderPanel();
    const data = h.reviewScreenProps.mock.calls.at(-1)![0].data;
    expect(data.citationsMap.claims).toHaveLength(1);
    expect(data.citationsMap.claims[0].id).toBe('ok');
  });
});

describe('ReviewPanel — manual highlighting (TASK-344)', () => {
  it('wires the drafted SOAP body to a SUMMARY manual-highlight surface', () => {
    renderPanel();

    const surface = screen.getByTestId('summary-surface');
    expect(surface.getAttribute('data-target-kind')).toBe('SUMMARY');
    expect(surface.getAttribute('data-source-id')).toBe(NOTE_ID);
    expect(surface.getAttribute('data-text')).toBe('S: chest pain\nO: BP 150/95');
  });

  it('does not render the SOAP highlight surface before a draft exists', () => {
    renderPanel({ noteContextItemId: null });
    expect(screen.queryByTestId('summary-surface')).toBeNull();
  });
});

describe('ReviewPanel — sign-off + edit wiring', () => {
  it('approve calls POST …/approve and invalidates caches (never auto-signs)', async () => {
    h.approveNote.mockResolvedValue({ status: 'SIGNED_NOTE' });
    renderPanel();

    // Nothing is signed until the clinician acts.
    expect(h.approveNote).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('rs-approve'));

    await waitFor(() => expect(h.approveNote).toHaveBeenCalledTimes(1));
    expect(h.approveNote).toHaveBeenCalledWith(expect.objectContaining({ __fake: true }), CONSULTATION_ID, NOTE_ID);
    expect(h.invalidateQueries).toHaveBeenCalled();
  });

  it('edit persists the draft via PATCH …/summary/:id', async () => {
    renderPanel();

    const textarea = screen.getByTestId('review-edit-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'S: revised subjective' } });
    fireEvent.click(screen.getByTestId('review-edit-save'));

    await waitFor(() => expect(h.updateSummaryContent).toHaveBeenCalledTimes(1));
    expect(h.updateSummaryContent).toHaveBeenCalledWith(expect.objectContaining({ __fake: true }), CONSULTATION_ID, NOTE_ID, 'S: revised subjective');
    expect(toast.success).toHaveBeenCalled();
  });
});

describe('ReviewPanel — Phase D assurance wiring (TASK-355)', () => {
  it('subscribes to the assurance feed whenever a draft note exists', () => {
    renderPanel();
    expect(h.useHarnessAssurance).toHaveBeenCalledWith(expect.objectContaining({ consultationId: CONSULTATION_ID, enabled: true }));
  });

  it('renders the post-sign amendment alert when assurance reports postSignAlert (Q2b)', () => {
    h.assuranceState = { ...h.assuranceState, closed: true, postSignAlert: true };
    renderPanel();
    expect(screen.getByTestId('review-post-sign-alert')).toBeInTheDocument();
  });

  it('threads overrideSafetyFlag through approve when a terminal safety FLAG is present (Q4)', async () => {
    h.assuranceState = { ...h.assuranceState, closed: true, safetyFlag: true };
    h.approveNote.mockResolvedValue({ status: 'SIGNED_NOTE' });
    renderPanel();

    fireEvent.click(screen.getByTestId('rs-approve'));

    await waitFor(() => expect(h.approveNote).toHaveBeenCalledTimes(1));
    expect(h.approveNote).toHaveBeenCalledWith(expect.objectContaining({ __fake: true }), CONSULTATION_ID, NOTE_ID, { overrideSafetyFlag: true });
  });

  it('passes the live N-of-M + safety-flag state down to the review screen', () => {
    h.assuranceState = { ...h.assuranceState, claims: [{ claimId: 'a' }, { claimId: 'b' }], total: 3, closed: false };
    renderPanel();
    const props = h.reviewScreenProps.mock.calls.at(-1)![0];
    expect(props.assurance).toEqual(expect.objectContaining({ pending: true, resolved: 2, total: 3, safetyFlag: false }));
  });
});

describe('ReviewPanel — non-data states', () => {
  it('shows the empty state until the harness drafts a note', () => {
    renderPanel({ noteContextItemId: null });
    expect(screen.getByTestId('review-empty')).toBeInTheDocument();
    expect(h.reviewScreenProps).not.toHaveBeenCalled();
  });

  it('shows the "generating draft…" waiting state while polling after stop', () => {
    renderPanel({ noteContextItemId: null, draftStatus: 'generating' });
    expect(screen.getByTestId('review-generating')).toBeInTheDocument();
    expect(screen.queryByTestId('review-empty')).toBeNull();
    expect(h.reviewScreenProps).not.toHaveBeenCalled();
  });

  it('shows a timed-out state with a manual "check again" action (transcript exists, draft slow)', () => {
    const onRefreshDraft = vi.fn();
    renderPanel({ noteContextItemId: null, draftStatus: 'timed-out', onRefreshDraft });
    expect(screen.getByTestId('review-timeout')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('review-timeout-refresh'));
    expect(onRefreshDraft).toHaveBeenCalledTimes(1);
  });

  it('shows an explicit "no transcript captured" state with a retry when it times out with zero transcripts (TASK-342 R3)', () => {
    const onRefreshDraft = vi.fn();
    renderPanel({ noteContextItemId: null, draftStatus: 'timed-out', transcripts: [], onRefreshDraft });

    const panel = screen.getByTestId('review-no-transcript');
    expect(panel).toBeInTheDocument();
    expect(panel.textContent).toMatch(/no transcript/i);
    // Distinct from the "draft still generating" timeout, and recoverable (no spinner).
    expect(screen.queryByTestId('review-timeout')).toBeNull();
    fireEvent.click(screen.getByTestId('review-no-transcript-refresh'));
    expect(onRefreshDraft).toHaveBeenCalledTimes(1);
  });

  it('renders the live stage checklist instead of the static text when progress events arrive (TASK-345)', () => {
    h.progressState = {
      stages: [
        { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'completed', attempt: 1, at: 't1' },
        { stage: 'assembling_context', label: 'Assembling context', ordinal: 2, status: 'completed', attempt: 1, at: 't2' },
        { stage: 'drafting_note', label: 'Drafting the note', ordinal: 3, status: 'active', attempt: 2, at: 't3' },
      ],
      total: 5,
      closed: false,
      status: 'open',
      error: null,
    };
    renderPanel({ noteContextItemId: null, draftStatus: 'generating' });

    // The subscription is keyed by consultationId and active only while generating.
    expect(h.useHarnessProgress).toHaveBeenCalledWith(expect.objectContaining({ consultationId: CONSULTATION_ID, enabled: true }));

    const list = screen.getByTestId('review-progress-list');
    expect(list).toBeInTheDocument();
    // Live checklist replaces the static placeholder…
    expect(screen.queryByText('Generating the SOAP draft…')).toBeNull();

    const done = screen.getByTestId('review-progress-stage-extracting_information');
    expect(done.getAttribute('data-status')).toBe('completed');
    const active = screen.getByTestId('review-progress-stage-drafting_note');
    expect(active.getAttribute('data-status')).toBe('active');
    expect(active.textContent).toContain('Drafting the note');
    // Regen pass is communicated on the active stage.
    expect(active.textContent).toMatch(/pass 2/i);
  });

  it('keeps the static "Generating the SOAP draft…" fallback when no progress events arrive (TASK-345)', () => {
    renderPanel({ noteContextItemId: null, draftStatus: 'generating' });

    expect(screen.getByTestId('review-generating')).toBeInTheDocument();
    expect(screen.getByText('Generating the SOAP draft…')).toBeInTheDocument();
    expect(screen.queryByTestId('review-progress-list')).toBeNull();
  });

  it('falls back to the static block + "live progress unavailable" note when the stream dies, never a frozen checklist (TASK-348 MAJ-4)', () => {
    h.progressState = {
      stages: [
        { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'completed', attempt: 1, at: 't1' },
        { stage: 'drafting_note', label: 'Drafting the note', ordinal: 3, status: 'active', attempt: 1, at: 't3' },
      ],
      total: 5,
      closed: false,
      status: 'error',
      error: 'Harness progress stream disconnected',
    };
    renderPanel({ noteContextItemId: null, draftStatus: 'generating' });

    // Stale stages must NOT render as a live checklist…
    expect(screen.queryByTestId('review-progress-list')).toBeNull();
    // …the static generating block returns, with an explicit unavailability note.
    expect(screen.getByTestId('review-generating')).toBeInTheDocument();
    expect(screen.getByText('Generating the SOAP draft…')).toBeInTheDocument();
    expect(screen.getByTestId('review-progress-unavailable').textContent).toMatch(/live progress is unavailable/i);
  });

  it('keeps the live checklist during a transient reconnect (status connecting, TASK-348 MAJ-4)', () => {
    h.progressState = {
      stages: [{ stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'completed', attempt: 1, at: 't1' }],
      total: 5,
      closed: false,
      status: 'connecting',
      error: null,
    };
    renderPanel({ noteContextItemId: null, draftStatus: 'generating' });

    expect(screen.getByTestId('review-progress-list')).toBeInTheDocument();
    expect(screen.queryByTestId('review-progress-unavailable')).toBeNull();
  });

  it('renders the failed terminal state distinctly: failure note + failed stage marker (TASK-348 MAJ-1 contract)', () => {
    h.progressState = {
      stages: [
        { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'completed', attempt: 1, at: 't1' },
        { stage: 'assembling_context', label: 'Assembling context', ordinal: 2, status: 'completed', attempt: 1, at: 't2' },
        { stage: 'drafting_note', label: 'Drafting the note', ordinal: 3, status: 'pending', attempt: 1, at: '' },
        { stage: 'failed', label: 'Documentation generation failed', ordinal: 6, status: 'failed', attempt: 1, at: 't4' },
      ],
      total: 5,
      closed: true,
      status: 'closed',
      error: null,
    };
    renderPanel({ noteContextItemId: null, draftStatus: 'generating' });

    // Failure note (not the static "generating…" copy, not the error fallback).
    expect(screen.getByTestId('review-progress-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('review-progress-unavailable')).toBeNull();

    // The failed pseudo-stage renders with a distinct marker; completed stages stay completed.
    const failedRow = screen.getByTestId('review-progress-stage-failed');
    expect(failedRow.getAttribute('data-status')).toBe('failed');
    expect(failedRow.textContent).toContain('Documentation generation failed');
    expect(screen.getAllByRole('img', { name: 'failed' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('review-progress-stage-extracting_information').getAttribute('data-status')).toBe('completed');

    // Terminal: the region is no longer busy.
    expect(screen.getByTestId('review-progress-list').getAttribute('aria-busy')).toBe('false');
  });

  it('renders "Step N of total" and pre-renders placeholder rows up to total (TASK-348 MIN-9)', () => {
    h.progressState = {
      stages: [
        { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'completed', attempt: 1, at: 't1' },
        { stage: 'assembling_context', label: 'Assembling context', ordinal: 2, status: 'active', attempt: 1, at: 't2' },
      ],
      total: 5,
      closed: false,
      status: 'open',
      error: null,
    };
    renderPanel({ noteContextItemId: null, draftStatus: 'generating' });

    expect(screen.getByTestId('review-progress-step').textContent).toBe('Step 2 of 5');

    // The checklist doesn't grow one row at a time: 2 real + 3 placeholders.
    expect(screen.getAllByTestId('review-progress-placeholder')).toHaveLength(3);
    expect(screen.getByTestId('review-progress-list').querySelectorAll('li')).toHaveLength(5);
  });

  it('announces the checklist politely with accessible status icons (TASK-348 MIN-8)', () => {
    h.progressState = {
      stages: [
        { stage: 'extracting_information', label: 'Extracting key information', ordinal: 1, status: 'completed', attempt: 1, at: 't1' },
        { stage: 'drafting_note', label: 'Drafting the note', ordinal: 3, status: 'active', attempt: 1, at: 't3' },
      ],
      total: 3,
      closed: false,
      status: 'open',
      error: null,
    };
    renderPanel({ noteContextItemId: null, draftStatus: 'generating' });

    const list = screen.getByTestId('review-progress-list');
    expect(list.getAttribute('role')).toBe('status');
    expect(list.getAttribute('aria-live')).toBe('polite');
    expect(list.getAttribute('aria-busy')).toBe('true');

    // Status icons carry reliable accessible names (role="img" + label).
    expect(screen.getAllByRole('img', { name: 'completed' })).toHaveLength(1);
    expect(screen.getAllByRole('img', { name: 'in progress' })).toHaveLength(1);
    expect(screen.getAllByRole('img', { name: 'pending' })).toHaveLength(1); // the placeholder row
  });

  it('does not subscribe to harness progress outside the generating state (TASK-345)', () => {
    renderPanel({ noteContextItemId: null });
    expect(h.useHarnessProgress).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('shows a skeleton while provenance loads', () => {
    h.provenanceState = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    renderPanel();
    expect(screen.getByTestId('review-skeleton')).toBeInTheDocument();
  });

  it('shows an error state (not a misleading empty state) when provenance fails', () => {
    h.provenanceState = { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
    renderPanel();
    expect(screen.getByTestId('review-error')).toBeInTheDocument();
    expect(screen.queryByTestId('review-screen-stub')).toBeNull();
  });
});
