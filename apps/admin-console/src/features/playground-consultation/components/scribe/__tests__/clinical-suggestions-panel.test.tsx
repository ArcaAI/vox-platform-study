/**
 * intelligent suggestions, against brokered shape.
 *
 * The harness node's system prompt constrains these to "next questions, checks or omissions to
 * consider", grounded in the supplied text, never a diagnosis stated as fact. The surface must
 * read as prompts to a clinician, not as findings, and must never write into the note.
 *
 * Identity and provenance rules (796 rules 3 and 4) are covered in `correction-contract-rules.test.tsx`.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it } from 'vitest';
import { ClinicalSuggestionsPanel } from '../clinical-suggestions-panel';
import type { ClinicalSuggestion } from '../../../api/live-assist';

afterEach(cleanup);

const SUGGESTIONS: ClinicalSuggestion[] = [
  { suggestionId: 's1', text: 'Ask about orthopnoea and ankle swelling.', category: 'history', status: 'PROPOSED', proposedBy: 'lm-studio:a-model' },
  { suggestionId: 's2', text: 'Consider checking renal function before increasing the ACE inhibitor.', category: 'investigation', status: 'PROPOSED' },
];

describe('ClinicalSuggestionsPanel (W2)', () => {
  it('lists every suggestion', () => {
    render(<ClinicalSuggestionsPanel suggestions={SUGGESTIONS} nodeType="consultation.suggestions" />);
    expect(screen.getByText('Ask about orthopnoea and ankle swelling.')).toBeTruthy();
    expect(screen.getByText(/Consider checking renal function/)).toBeTruthy();
  });

  it('marks the list as AI-generated', () => {
    render(<ClinicalSuggestionsPanel suggestions={SUGGESTIONS} />);
    expect(screen.getByText('AI')).toBeTruthy();
  });

  it('frames them as prompts to consider, not as findings', () => {
    render(<ClinicalSuggestionsPanel suggestions={SUGGESTIONS} />);
    expect(screen.getByText(/not clinical advice, and not part of the note/i)).toBeTruthy();
  });

  it('shows the category for each suggestion when one is given', () => {
    render(<ClinicalSuggestionsPanel suggestions={SUGGESTIONS} />);
    expect(screen.getByText('history')).toBeTruthy();
    expect(screen.getByText('investigation')).toBeTruthy();
  });

  it('names the interpreter node that produced them', () => {
    render(<ClinicalSuggestionsPanel suggestions={SUGGESTIONS} nodeType="consultation.suggestions" />);
    expect(screen.getByText('consultation.suggestions')).toBeTruthy();
  });

  it('lets the clinician dismiss a suggestion', () => {
    render(<ClinicalSuggestionsPanel suggestions={SUGGESTIONS} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss suggestion: ask about orthopnoea/i }));
    expect(screen.queryByText('Ask about orthopnoea and ankle swelling.')).toBeNull();
  });

  it('offers no affordance that writes into the note', () => {
    render(<ClinicalSuggestionsPanel suggestions={SUGGESTIONS} />);
    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('aria-label')).toMatch(/^Dismiss suggestion:/);
    }
  });

  it('renders nothing when there are no suggestions', () => {
    const { container } = render(<ClinicalSuggestionsPanel suggestions={null} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing for an empty list — the node returns one when it has nothing useful', () => {
    const { container } = render(<ClinicalSuggestionsPanel suggestions={[]} />);
    expect(container.textContent).toBe('');
  });

  it('0 axe violations', async () => {
    const { container } = render(<ClinicalSuggestionsPanel suggestions={SUGGESTIONS} nodeType="consultation.suggestions" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
