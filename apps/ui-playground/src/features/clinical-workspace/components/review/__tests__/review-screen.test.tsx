/**
 * ReviewScreen (TASK-330 Phase 1, Lane J) — coordination/interaction test.
 *
 * Verifies the linked-evidence review wiring:
 *   - delegates to the SDK provenance utils and floats the "needs attention"
 *     claims (flagged above unverified, verified excluded) above the note
 *   - renders the draft note grouped into SOAP sections
 *   - selecting a claim highlights its transcript evidence (and warns when a
 *     claim has no provenance)
 *   - the Approve action calls the injected approve handler and surfaces the
 *     signed state
 *
 * The ui-playground vitest config stubs `@arcaai/vox` + `@arcaai/ui/*`, so the
 * SDK utils are mocked as spies with canned returns (the algorithms themselves
 * are unit-tested in @arcaai/vox) and the UI primitives are passthroughs.
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardHeader: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardTitle: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children, ...p }: any) => <span {...p}>{children}</span> }));
vi.mock('@arcaai/ui/button', () => ({ Button: ({ children, ...p }: any) => <button {...p}>{children}</button> }));
vi.mock('@arcaai/ui/scroll-area', () => ({ ScrollArea: ({ children, ...p }: any) => <div {...p}>{children}</div> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// TASK-344 — with a consultationId the transcript pane mounts the connected
// manual-highlight surface (when no claim is selected). Stub it so this screen
// test stays focused on claim→evidence wiring and doesn't pull the query hooks.
vi.mock('../../highlightable-surface', () => ({
  ManualHighlightSurface: (props: any) => (
    <div data-testid="manual-surface" data-target-kind={props.targetKind} data-source-id={props.sourceContextItemId} />
  ),
}));

vi.mock('@arcaai/vox', () => ({
  selectClaimsNeedingAttention: vi.fn(),
  groupClaimsBySection: vi.fn(),
  buildTranscriptHighlights: vi.fn(),
  confidencePercent: (c: number) => Math.round(c * 100),
  SOAP_SECTION_LABELS: { S: 'Subjective', O: 'Objective', A: 'Assessment', P: 'Plan' },
}));

import { ReviewScreen } from '../review-screen';
import {
  selectClaimsNeedingAttention,
  groupClaimsBySection,
  buildTranscriptHighlights,
  type ClinicalReviewData,
  type CitationClaim,
  type SummaryApprovalResponse,
} from '@arcaai/vox';
import { toast } from 'sonner';

const verified: CitationClaim = {
  id: 'v',
  text: 'Verified claim text',
  section: 'S',
  status: 'verified',
  confidence: 0.9,
  evidence: [{ transcriptContextItemId: 't1', startOffset: 0, endOffset: 4, quote: 'word' }],
  entityRefs: [],
  knowledgeChunkIds: [],
};
const unverified: CitationClaim = {
  id: 'u',
  text: 'Unverified claim text',
  section: 'O',
  status: 'unverified',
  confidence: 0.3,
  evidence: [],
  entityRefs: [],
  knowledgeChunkIds: [],
};
const flagged: CitationClaim = {
  id: 'f',
  text: 'Flagged claim text',
  section: 'P',
  status: 'flagged',
  confidence: 0.2,
  evidence: [{ transcriptContextItemId: 't1', startOffset: 5, endOffset: 10, quote: 'evid' }],
  entityRefs: [],
  knowledgeChunkIds: [],
};

const data: ClinicalReviewData = {
  consultationId: 'consult-1',
  noteContextItemId: 'note-1',
  modelName: 'test-model',
  status: 'PENDING_REVIEW',
  transcripts: [{ contextItemId: 't1', label: 'Transcript', text: 'word here evid more' }],
  citationsMap: { claims: [verified, unverified, flagged] },
};

const approvalResult: SummaryApprovalResponse = {
  contextItemId: 'note-1',
  approvalStatus: 'APPROVED',
  approvedBy: 'demo-clinician',
  approvedAt: '2026-06-06T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  (selectClaimsNeedingAttention as unknown as Mock).mockReturnValue([flagged, unverified]);
  (groupClaimsBySection as unknown as Mock).mockReturnValue([
    { section: 'S', label: 'Subjective', claims: [verified] },
    { section: 'O', label: 'Objective', claims: [unverified] },
    { section: 'A', label: 'Assessment', claims: [] },
    { section: 'P', label: 'Plan', claims: [flagged] },
  ]);
  (buildTranscriptHighlights as unknown as Mock).mockImplementation((text: string, spans: unknown[]) =>
    spans.length > 0 ? [{ text: 'HL', highlighted: true }] : [{ text, highlighted: false }],
  );
});

function renderScreen(onApprove = vi.fn().mockResolvedValue(approvalResult)) {
  render(<ReviewScreen data={data} onApprove={onApprove} />);
  return onApprove;
}

describe('ReviewScreen — needs-attention float-to-top', () => {
  it('floats flagged then unverified into the needs-attention panel and excludes verified', () => {
    renderScreen();

    expect(selectClaimsNeedingAttention).toHaveBeenCalledWith(data.citationsMap.claims);

    const needs = screen.getByTestId('needs-attention');
    const lines = needs.querySelectorAll('[data-claim-id]');
    expect(Array.from(lines).map((el) => el.getAttribute('data-claim-id'))).toEqual(['f', 'u']);
    expect(needs.querySelector('[data-claim-id="v"]')).toBeNull();
  });
});

describe('ReviewScreen — SOAP grouping', () => {
  it('renders the note grouped into the four SOAP sections', () => {
    renderScreen();
    const note = screen.getByTestId('soap-note');
    expect(note.querySelector('[data-section="S"]')).not.toBeNull();
    expect(note.querySelector('[data-section="O"]')).not.toBeNull();
    expect(note.querySelector('[data-section="A"]')).not.toBeNull();
    expect(note.querySelector('[data-section="P"]')).not.toBeNull();
    // empty section shows the placeholder
    expect(note.textContent).toContain('No claims drafted');
    // claims render under their section
    expect(note.querySelector('[data-section="S"]')?.textContent).toContain('Verified claim text');
    expect(note.querySelector('[data-section="P"]')?.textContent).toContain('Flagged claim text');
  });
});

describe('ReviewScreen — transcript highlight on selection', () => {
  it('shows no highlight until a claim is selected', () => {
    renderScreen();
    expect(screen.getByText(/select a claim to highlight/i)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-highlight="true"]')).toHaveLength(0);
  });

  it('highlights the evidence span of the selected claim', () => {
    renderScreen();
    const needs = screen.getByTestId('needs-attention');
    fireEvent.click(needs.querySelector('[data-claim-id="f"]')!);

    // builds highlights from the selected claim's evidence spans
    expect(buildTranscriptHighlights).toHaveBeenLastCalledWith('word here evid more', flagged.evidence);
    const pane = screen.getByTestId('transcript-pane');
    const marks = pane.querySelectorAll('[data-highlight="true"]');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('HL');
  });

  it('warns when the selected claim has no transcript provenance', () => {
    renderScreen();
    const needs = screen.getByTestId('needs-attention');
    fireEvent.click(needs.querySelector('[data-claim-id="u"]')!);

    const pane = screen.getByTestId('transcript-pane');
    expect(pane.textContent).toMatch(/no provenance/i);
    expect(pane.querySelectorAll('[data-highlight="true"]')).toHaveLength(0);
  });
});

describe('ReviewScreen — approve & sign', () => {
  it('calls the injected approve handler and surfaces the signed state', async () => {
    const onApprove = renderScreen();

    fireEvent.click(screen.getByTestId('approve-note-button'));
    expect(onApprove).toHaveBeenCalledWith('note-1');

    expect(await screen.findByTestId('note-signed-badge')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Note approved and signed');
    expect(screen.queryByTestId('approve-note-button')).toBeNull();
  });

  it('keeps the approve button and toasts on failure', async () => {
    const onApprove = vi.fn().mockRejectedValue(new Error('network down'));
    renderScreen(onApprove);

    fireEvent.click(screen.getByTestId('approve-note-button'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network down'));
    expect(screen.getByTestId('approve-note-button')).toBeInTheDocument();
    expect(screen.queryByTestId('note-signed-badge')).toBeNull();
  });
});

// TASK-355 Phase D Slice 6c — optimistic delivery: assurance runs concurrently
// with review. Q5 true-live per-claim counter; Q2a early-sign ENABLED + hint;
// Q4 one-click override to sign past a terminal safety FLAG.
describe('ReviewScreen — assurance pending + safety flag (TASK-355 Phase D)', () => {
  it('shows the pending banner with a live N-of-M counter and keeps sign enabled (Q5/Q2a)', () => {
    render(
      <ReviewScreen
        data={data}
        onApprove={vi.fn().mockResolvedValue(approvalResult)}
        assurance={{ pending: true, resolved: 1, total: 3, safetyFlag: false }}
      />,
    );

    expect(screen.getByTestId('assurance-pending-banner')).toBeInTheDocument();
    expect(screen.getByTestId('assurance-pending-banner').textContent).toMatch(/1 of 3/);

    // Q2a — approve stays ENABLED, with an informational early-sign hint.
    const approve = screen.getByTestId('approve-note-button') as HTMLButtonElement;
    expect(approve).toBeInTheDocument();
    expect(approve.disabled).toBe(false);
    expect(screen.getByTestId('assurance-early-sign-hint')).toBeInTheDocument();
  });

  it('on a terminal safety FLAG shows a destructive alert and a one-click override sign (Q4)', async () => {
    const onApprove = vi.fn().mockResolvedValue(approvalResult);
    render(<ReviewScreen data={data} onApprove={onApprove} assurance={{ pending: false, resolved: 3, total: 3, safetyFlag: true }} />);

    expect(screen.getByTestId('assurance-safety-flag')).toBeInTheDocument();
    const approve = screen.getByTestId('approve-note-button');
    expect(approve.textContent).toMatch(/acknowledge risk & sign/i);

    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledWith('note-1', { overrideSafetyFlag: true });
    expect(await screen.findByTestId('note-signed-badge')).toBeInTheDocument();
  });

  it('signs normally (no override) when assurance is clean', async () => {
    const onApprove = vi.fn().mockResolvedValue(approvalResult);
    render(<ReviewScreen data={data} onApprove={onApprove} assurance={{ pending: false, resolved: 3, total: 3, safetyFlag: false }} />);

    fireEvent.click(screen.getByTestId('approve-note-button'));
    expect(onApprove).toHaveBeenCalledWith('note-1');
  });
});
