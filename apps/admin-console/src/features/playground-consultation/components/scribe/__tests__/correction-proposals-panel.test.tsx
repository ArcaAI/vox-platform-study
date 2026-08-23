/**
 * TASK-797 W2 — the correction review surface.
 *
 * Hard product constraint: a correction is a PROPOSAL. The UI must require an explicit
 * clinician action to accept one, must never render a proposal as though it were already
 * applied, and rejecting must be as easy as accepting.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CorrectionProposalsPanel } from '../correction-proposals-panel';
import type { CorrectionProposal, CorrectionProposalSet } from '../../../api/pending-contracts';

afterEach(cleanup);

const TEXT = 'Patient started metfromin 500mg and lisinopril 10mg.';

function proposal(overrides: Partial<CorrectionProposal> = {}): CorrectionProposal {
  return {
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

function set(proposals: CorrectionProposal[]): CorrectionProposalSet {
  return { text: TEXT, proposals, applied: false, appliedCount: 0, provider: 'lmstudio', model: 'hope-scribe' };
}

describe('CorrectionProposalsPanel (TASK-797 W2)', () => {
  it('shows the original and the proposed replacement for each proposal', () => {
    render(<CorrectionProposalsPanel proposalSet={set([proposal()])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.getByText('metfromin')).toBeTruthy();
    expect(screen.getByText('metformin')).toBeTruthy();
  });

  it('states that nothing has been applied — never renders a proposal as done', () => {
    render(<CorrectionProposalsPanel proposalSet={set([proposal()])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.getByText(/nothing has been changed|not been applied/i)).toBeTruthy();
    expect(screen.queryByText(/applied/i)?.textContent ?? '').not.toMatch(/^Applied$/);
  });

  it('offers BOTH accept and reject for every proposal, as equally reachable buttons', () => {
    render(<CorrectionProposalsPanel proposalSet={set([proposal()])} text={TEXT} onAccept={vi.fn()} />);
    const accept = screen.getByRole('button', { name: /accept correction: metfromin/i }) as HTMLButtonElement;
    const reject = screen.getByRole('button', { name: /reject correction: metfromin/i }) as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
    expect(reject.disabled).toBe(false);
  });

  it('accepting hands the caller the corrected text — it never mutates anything itself', () => {
    const onAccept = vi.fn();
    render(<CorrectionProposalsPanel proposalSet={set([proposal()])} text={TEXT} onAccept={onAccept} />);
    fireEvent.click(screen.getByRole('button', { name: /accept correction: metfromin/i }));

    expect(onAccept).toHaveBeenCalledWith('Patient started metformin 500mg and lisinopril 10mg.');
  });

  it('rejecting removes the proposal and changes no text', () => {
    const onAccept = vi.fn();
    render(<CorrectionProposalsPanel proposalSet={set([proposal()])} text={TEXT} onAccept={onAccept} />);
    fireEvent.click(screen.getByRole('button', { name: /reject correction: metfromin/i }));

    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /accept correction: metfromin/i })).toBeNull();
  });

  it('does not offer a proposal whose offsets no longer match the text', () => {
    const stale = proposal({ start: 3, end: 12 });
    render(<CorrectionProposalsPanel proposalSet={set([stale])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /accept correction/i })).toBeNull();
  });

  it('drops a stale proposal when the text changes underneath it', () => {
    const other = proposal({ start: 36, end: 46, original: 'lisinopril', proposed: 'Lisinopril', category: 'medicalTerm' });
    const { rerender } = render(<CorrectionProposalsPanel proposalSet={set([other])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.getByRole('button', { name: /accept correction: lisinopril/i })).toBeTruthy();

    // The clinician typed; the offsets no longer describe this text.
    rerender(<CorrectionProposalsPanel proposalSet={set([other])} text="Totally different note." onAccept={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /accept correction: lisinopril/i })).toBeNull();
  });

  it('attributes each proposal to the detector AND the model that proposed it', () => {
    render(<CorrectionProposalsPanel proposalSet={set([proposal()])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.getByText(/nlp\.ner/)).toBeTruthy();
    expect(screen.getByText(/lmstudio:hope-scribe/)).toBeTruthy();
  });

  it('names the category and the rationale in text', () => {
    render(<CorrectionProposalsPanel proposalSet={set([proposal()])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.getByText(/drug name/i)).toBeTruthy();
    expect(screen.getByText(/misspelling of metformin/)).toBeTruthy();
  });

  it('disables both actions when the note can no longer be edited', () => {
    render(<CorrectionProposalsPanel proposalSet={set([proposal()])} text={TEXT} onAccept={vi.fn()} disabledReason="This note is signed." />);
    expect((screen.getByRole('button', { name: /accept correction: metfromin/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /reject correction: metfromin/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('This note is signed.')).toBeTruthy();
  });

  it('renders nothing at all when there is no proposal set', () => {
    const { container } = render(<CorrectionProposalsPanel proposalSet={null} text={TEXT} onAccept={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing when every proposal has been decided', () => {
    const { container } = render(<CorrectionProposalsPanel proposalSet={set([])} text={TEXT} onAccept={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('0 axe violations', async () => {
    const { container } = render(<CorrectionProposalsPanel proposalSet={set([proposal()])} text={TEXT} onAccept={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
