/**
 * TASK-797 W2 — the correction review surface, against TASK-796's brokered shape.
 *
 * Hard product constraint: a correction is a PROPOSAL. Explicit clinician action to accept,
 * never rendered as already applied, and rejecting as easy as accepting.
 *
 * The SHA-256 gate, id-keying and provenance rules are covered in `correction-contract-rules.test.tsx`.
 * This file covers presentation, rejection, and the offset-level staleness guard.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CorrectionProposalsPanel } from '../correction-proposals-panel';
import type { CorrectionProposal, CorrectionsEnvelope } from '../../../api/live-assist';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const TEXT = 'Patient started metfromin 500mg and lisinopril 10mg.';

function proposal(overrides: Partial<CorrectionProposal> = {}): CorrectionProposal {
  return {
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
    ...overrides,
  };
}

/** `textSha256` is deliberately a placeholder here — these tests never reach the gate. */
function envelope(proposals: CorrectionProposal[]): CorrectionsEnvelope {
  return { proposals, applied: false, appliedCount: 0, rejectedProposals: 0, textSha256: '0'.repeat(64) };
}

describe('CorrectionProposalsPanel (TASK-797 W2)', () => {
  it('shows the original and the proposed replacement for each proposal', () => {
    render(<CorrectionProposalsPanel corrections={envelope([proposal()])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.getByText('metfromin')).toBeTruthy();
    expect(screen.getByText('metformin')).toBeTruthy();
  });

  it('states that nothing has been applied — never renders a proposal as done', () => {
    render(<CorrectionProposalsPanel corrections={envelope([proposal()])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.getByText(/nothing has been changed in your note/i)).toBeTruthy();
  });

  it('offers BOTH accept and reject for every proposal, as equally reachable buttons', () => {
    render(<CorrectionProposalsPanel corrections={envelope([proposal()])} text={TEXT} onAccept={vi.fn()} />);
    expect((screen.getByRole('button', { name: /accept correction: metfromin/i }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: /reject correction: metfromin/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('rejecting removes the proposal and changes no text', () => {
    const onAccept = vi.fn();
    render(<CorrectionProposalsPanel corrections={envelope([proposal()])} text={TEXT} onAccept={onAccept} />);
    fireEvent.click(screen.getByRole('button', { name: /reject correction: metfromin/i }));

    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /accept correction: metfromin/i })).toBeNull();
  });

  it('does not offer a proposal whose offsets no longer slice out its own original', () => {
    render(<CorrectionProposalsPanel corrections={envelope([proposal({ start: 3, end: 12 })])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /accept correction/i })).toBeNull();
  });

  it('drops a stale proposal when the text changes underneath it', () => {
    const other = proposal({ proposalId: 'p2', start: 36, end: 46, original: 'lisinopril', proposed: 'Lisinopril', category: 'medicalTerm' });
    const { rerender } = render(<CorrectionProposalsPanel corrections={envelope([other])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.getByRole('button', { name: /accept correction: lisinopril/i })).toBeTruthy();

    rerender(<CorrectionProposalsPanel corrections={envelope([other])} text="Totally different note." onAccept={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /accept correction: lisinopril/i })).toBeNull();
  });

  it('names the category and the rationale in text', () => {
    render(<CorrectionProposalsPanel corrections={envelope([proposal()])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.getByText(/drug name/i)).toBeTruthy();
    expect(screen.getByText(/misspelling of metformin/)).toBeTruthy();
  });

  it('disables both actions when the note can no longer be edited', () => {
    render(<CorrectionProposalsPanel corrections={envelope([proposal()])} text={TEXT} onAccept={vi.fn()} disabledReason="This note is signed." />);
    expect((screen.getByRole('button', { name: /accept correction: metfromin/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /reject correction: metfromin/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('This note is signed.')).toBeTruthy();
  });

  it('renders nothing at all when there is no corrections envelope', () => {
    const { container } = render(<CorrectionProposalsPanel corrections={null} text={TEXT} onAccept={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing when every proposal has been decided', () => {
    const { container } = render(<CorrectionProposalsPanel corrections={envelope([])} text={TEXT} onAccept={vi.fn()} />);
    expect(container.textContent).toBe('');
  });
});
