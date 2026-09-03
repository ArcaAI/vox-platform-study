/**
 * the four rendering rules declared as SAFETY PROPERTIES.
 *
 * 1. Never auto-apply — status advances only on an explicit clinician action.
 * 2. Verify the local text's SHA-256 against `corrections.textSha256` BEFORE applying;
 *    on mismatch REFUSE and re-request.
 * 3. Key lists by `proposalId` / `suggestionId`, never array index.
 * 4. Show both provenance halves — `detectedBy` and `proposedBy`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CorrectionProposalsPanel } from '../correction-proposals-panel';
import { ClinicalSuggestionsPanel } from '../clinical-suggestions-panel';
import { sha256Hex } from '../../../lib/text-digest';
import type { ClinicalSuggestion, CorrectionProposal, CorrectionsEnvelope } from '../../../api/live-assist';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const TEXT = 'Patient started amoxicilin 500mg.';

function proposal(overrides: Partial<CorrectionProposal> = {}): CorrectionProposal {
  return {
    proposalId: 'def456',
    start: 16,
    end: 26,
    original: 'amoxicilin',
    proposed: 'amoxicillin',
    category: 'drugName',
    confidence: 0.96,
    rationale: 'misspelling',
    detectedBy: 'nlp.ner',
    proposedBy: 'lm-studio:a-model',
    status: 'PROPOSED',
    ...overrides,
  };
}

async function envelope(proposals: CorrectionProposal[], text = TEXT): Promise<CorrectionsEnvelope> {
  return { proposals, applied: false, appliedCount: 0, rejectedProposals: 0, textSha256: await sha256Hex(text) };
}

describe('Rule 2 — the SHA-256 gate', () => {
  it('applies when the local text hashes to `textSha256`', async () => {
    const onAccept = vi.fn();
    render(<CorrectionProposalsPanel corrections={await envelope([proposal()])} text={TEXT} onAccept={onAccept} />);
    fireEvent.click(screen.getByRole('button', { name: /accept correction/i }));

    await waitFor(() => expect(onAccept).toHaveBeenCalledWith('Patient started amoxicillin 500mg.'));
  });

  it('REFUSES to apply when the digest does not match, and does not touch the text', async () => {
    const onAccept = vi.fn();
    // The envelope was computed against a DIFFERENT revision of the note.
    const stale = await envelope([proposal()], 'Some entirely different note.');
    render(<CorrectionProposalsPanel corrections={stale} text={TEXT} onAccept={onAccept} />);
    fireEvent.click(screen.getByRole('button', { name: /accept correction/i }));

    await waitFor(() => expect(screen.getByText(/note has changed|no longer match/i)).toBeTruthy());
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('re-requests the proposals on a digest mismatch', async () => {
    const onStale = vi.fn();
    const stale = await envelope([proposal()], 'Some entirely different note.');
    render(<CorrectionProposalsPanel corrections={stale} text={TEXT} onAccept={vi.fn()} onStale={onStale} />);
    fireEvent.click(screen.getByRole('button', { name: /accept correction/i }));

    await waitFor(() => expect(onStale).toHaveBeenCalled());
  });

  it('withdraws every accept affordance once the set is known stale — not just the one clicked', async () => {
    const stale = await envelope([proposal(), proposal({ proposalId: 'other', start: 27, end: 32, original: '500mg', proposed: '500 mg' })], 'Different.');
    render(<CorrectionProposalsPanel corrections={stale} text={TEXT} onAccept={vi.fn()} />);
    fireEvent.click(screen.getAllByRole('button', { name: /accept correction/i })[0]);

    await waitFor(() => expect(screen.queryAllByRole('button', { name: /accept correction/i })).toHaveLength(0));
  });
});

describe(' — onProposalAccepted (promotion over the raw transcript, DD-8)', () => {
  it('fires alongside onAccept, with the proposal marked ACCEPTED, when the digest gate passes', async () => {
    const onAccept = vi.fn();
    const onProposalAccepted = vi.fn();
    render(<CorrectionProposalsPanel corrections={await envelope([proposal()])} text={TEXT} onAccept={onAccept} onProposalAccepted={onProposalAccepted} />);
    fireEvent.click(screen.getByRole('button', { name: /accept correction/i }));

    await waitFor(() => expect(onAccept).toHaveBeenCalled());
    expect(onProposalAccepted).toHaveBeenCalledWith(expect.objectContaining({ proposalId: 'def456', status: 'ACCEPTED' }));
  });

  it('does NOT fire on a digest mismatch — a refused accept promotes nothing', async () => {
    const onProposalAccepted = vi.fn();
    const stale = await envelope([proposal()], 'Some entirely different note.');
    render(<CorrectionProposalsPanel corrections={stale} text={TEXT} onAccept={vi.fn()} onProposalAccepted={onProposalAccepted} />);
    fireEvent.click(screen.getByRole('button', { name: /accept correction/i }));

    await waitFor(() => expect(screen.getByText(/note has changed|no longer match/i)).toBeTruthy());
    expect(onProposalAccepted).not.toHaveBeenCalled();
  });

  it('does NOT fire on Reject — a decline never promotes', async () => {
    const onProposalAccepted = vi.fn();
    render(<CorrectionProposalsPanel corrections={await envelope([proposal()])} text={TEXT} onAccept={vi.fn()} onProposalAccepted={onProposalAccepted} />);
    fireEvent.click(screen.getByRole('button', { name: /reject correction/i }));

    expect(onProposalAccepted).not.toHaveBeenCalled();
  });
});

describe('Rule 3 — identity is the id, never the array index', () => {
  it('keeps two byte-identical proposals distinct by id', async () => {
    const twin = proposal({ proposalId: 'twin', start: 16, end: 26 });
    render(<CorrectionProposalsPanel corrections={await envelope([proposal(), twin])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /reject correction/i })).toHaveLength(2);
  });

  it('a rejected proposal stays rejected when the envelope is re-delivered after a retry', async () => {
    const first = proposal();
    const second = proposal({ proposalId: 'other', start: 27, end: 32, original: '500mg', proposed: '500 mg' });
    const set = await envelope([first, second]);
    const { rerender } = render(<CorrectionProposalsPanel corrections={set} text={TEXT} onAccept={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: /reject correction/i })[0]);
    expect(screen.getAllByRole('button', { name: /reject correction/i })).toHaveLength(1);

    // Same content, re-delivered in the opposite order — a retry. Identity is the id.
    rerender(<CorrectionProposalsPanel corrections={{ ...set, proposals: [second, first] }} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /reject correction/i })).toHaveLength(1);
  });

  it('a dismissed suggestion stays dismissed across a re-delivery', () => {
    const a: ClinicalSuggestion = { suggestionId: 's1', text: 'Ask about penicillin allergy', category: 'history', status: 'PROPOSED' };
    const b: ClinicalSuggestion = { suggestionId: 's2', text: 'Check renal function', category: 'investigation', status: 'PROPOSED' };
    const { rerender } = render(<ClinicalSuggestionsPanel suggestions={[a, b]} nodeType="consultation.suggestions" />);

    fireEvent.click(screen.getByRole('button', { name: /dismiss suggestion: ask about penicillin allergy/i }));
    expect(screen.queryByText('Ask about penicillin allergy')).toBeNull();

    rerender(<ClinicalSuggestionsPanel suggestions={[b, a]} nodeType="consultation.suggestions" />);
    expect(screen.queryByText('Ask about penicillin allergy')).toBeNull();
  });
});

describe('Rules 1 and 4 — proposal framing and provenance', () => {
  it('never presents a proposal as applied', async () => {
    render(<CorrectionProposalsPanel corrections={await envelope([proposal()])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.getByText(/nothing has been changed/i)).toBeTruthy();
  });

  it('shows BOTH provenance halves', async () => {
    render(<CorrectionProposalsPanel corrections={await envelope([proposal()])} text={TEXT} onAccept={vi.fn()} />);
    expect(screen.getByText('nlp.ner')).toBeTruthy();
    expect(screen.getByText('lm-studio:a-model')).toBeTruthy();
  });

  it('shows the suggestion proposer', () => {
    render(
      <ClinicalSuggestionsPanel
        suggestions={[{ suggestionId: 's1', text: 'Ask about penicillin allergy', status: 'PROPOSED', proposedBy: 'lm-studio:a-model' }]}
        nodeType="consultation.suggestions"
      />,
    );
    expect(screen.getByText('lm-studio:a-model')).toBeTruthy();
  });

  it('0 axe violations', async () => {
    const { container } = render(<CorrectionProposalsPanel corrections={await envelope([proposal()])} text={TEXT} onAccept={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
