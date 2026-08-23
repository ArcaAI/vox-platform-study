/**
 * TASK-797 W2 — intelligent suggestions.
 *
 * The harness node's own system prompt constrains these to "next questions, checks or
 * omissions to consider", grounded in the supplied text, never a diagnosis stated as fact.
 * The surface must read as prompts to a clinician, not as findings, and must never write
 * into the note.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it } from 'vitest';
import { ClinicalSuggestionsPanel } from '../clinical-suggestions-panel';
import type { ClinicalSuggestionSet } from '../../../api/pending-contracts';

afterEach(cleanup);

const SET: ClinicalSuggestionSet = {
  suggestions: [
    { text: 'Ask about orthopnoea and ankle swelling.', category: 'history' },
    { text: 'Consider checking renal function before increasing the ACE inhibitor.', category: 'investigation' },
  ],
  count: 2,
  provider: 'lmstudio',
  model: 'hope-scribe',
};

describe('ClinicalSuggestionsPanel (TASK-797 W2)', () => {
  it('lists every suggestion', () => {
    render(<ClinicalSuggestionsPanel suggestionSet={SET} />);
    expect(screen.getByText('Ask about orthopnoea and ankle swelling.')).toBeTruthy();
    expect(screen.getByText(/Consider checking renal function/)).toBeTruthy();
  });

  it('marks the list as AI-generated', () => {
    render(<ClinicalSuggestionsPanel suggestionSet={SET} />);
    expect(screen.getByText('AI')).toBeTruthy();
  });

  it('frames them as prompts to consider, not as findings', () => {
    render(<ClinicalSuggestionsPanel suggestionSet={SET} />);
    // The disclaimer, specifically — the section heading also says "to consider".
    expect(screen.getByText(/not clinical advice, and not part of the note/i)).toBeTruthy();
  });

  it('shows the category for each suggestion when one is given', () => {
    render(<ClinicalSuggestionsPanel suggestionSet={SET} />);
    expect(screen.getByText('history')).toBeTruthy();
    expect(screen.getByText('investigation')).toBeTruthy();
  });

  it('attributes the set to the model that produced it', () => {
    render(<ClinicalSuggestionsPanel suggestionSet={SET} />);
    expect(screen.getByText(/lmstudio:hope-scribe|lmstudio · hope-scribe/)).toBeTruthy();
  });

  it('lets the clinician dismiss a suggestion', () => {
    render(<ClinicalSuggestionsPanel suggestionSet={SET} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss suggestion: ask about orthopnoea/i }));
    expect(screen.queryByText('Ask about orthopnoea and ankle swelling.')).toBeNull();
  });

  it('offers no affordance that writes into the note', () => {
    render(<ClinicalSuggestionsPanel suggestionSet={SET} />);
    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('aria-label')).toMatch(/^Dismiss suggestion:/);
    }
  });

  it('renders nothing when there is no set', () => {
    const { container } = render(<ClinicalSuggestionsPanel suggestionSet={null} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing when the set is empty — the node returns an empty list when it has nothing useful', () => {
    const { container } = render(<ClinicalSuggestionsPanel suggestionSet={{ suggestions: [], count: 0 }} />);
    expect(container.textContent).toBe('');
  });

  it('0 axe violations', async () => {
    const { container } = render(<ClinicalSuggestionsPanel suggestionSet={SET} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
