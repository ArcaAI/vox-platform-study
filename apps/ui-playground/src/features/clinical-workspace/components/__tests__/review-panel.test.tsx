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
}));

// Stub the reused review screen: capture the props (the mapped review data) and
// expose a minimal approve trigger so we can assert the sign-off wiring.
vi.mock('../review', () => ({
  ReviewScreen: (props: any) => {
    h.reviewScreenProps(props);
    return (
      <div data-testid="review-screen-stub">
        <button data-testid="rs-approve" onClick={() => void props.onApprove(props.data.noteContextItemId)}>
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

vi.mock('@arcaai/vox', () => ({
  useArcaStore: (selector: any) => selector({ apiClient: { __fake: true } }),
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
