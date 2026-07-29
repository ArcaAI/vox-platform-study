/**
 * PromptTestPanel — smoke tests (TASK-328 A4)
 *
 * Pins the prompt quality/score Test panel contract: an admin clicks
 * "Run Test", the panel fires the OCC-guarded test mutation (passing the
 * row `expectedVersion`), shows a loading skeleton while pending, then
 * renders the numeric score + generated output and a success toast.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ── toast spy ───────────────────────────────────────────────────────
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

// ── api/prompts mock — control the test mutation ────────────────────
const mutate = vi.fn();
let isPending = false;
vi.mock('../../api/prompts', () => ({
  useTestPrompt: () => ({ mutate, isPending }),
}));

// ── minimal @arcaai/ui primitive stubs (avoid Radix portals) ────────
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, onClick, disabled }: any) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock('@arcaai/ui/badge', () => ({
  Badge: ({ children }: any) => <span data-testid="badge">{children}</span>,
}));
vi.mock('@arcaai/ui/skeleton', () => ({
  Skeleton: (props: any) => <div data-testid="skeleton" {...props} />,
}));

const { PromptTestPanel } = await import('../prompt-test-panel');

const basePrompt: any = {
  id: 'pt-1',
  name: 'Greeting',
  category: 'CUSTOM',
  content: 'Hello {{name}}',
  currentVersionNumber: 3,
  version: 5,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  mutate.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  isPending = false;
});

describe('PromptTestPanel (TASK-328 A4)', () => {
  it('renders a Run Test button and an empty state before any test run', () => {
    render(<PromptTestPanel tenantId="t1" prompt={basePrompt} />);
    expect(screen.getByRole('button', { name: /run test/i })).toBeTruthy();
    expect(screen.getByText(/no test/i)).toBeTruthy();
  });

  it('fires the test mutation with the prompt id + expectedVersion (OCC) on click', () => {
    render(<PromptTestPanel tenantId="t1" prompt={basePrompt} />);
    fireEvent.click(screen.getByRole('button', { name: /run test/i }));

    expect(mutate).toHaveBeenCalledTimes(1);
    const [vars] = mutate.mock.calls[0];
    expect(vars).toMatchObject({ id: 'pt-1', expectedVersion: 5 });
  });

  it('shows the score + output and a success toast after a successful run', () => {
    mutate.mockImplementation((_vars: unknown, opts: any) => {
      opts?.onSuccess?.({ id: 'pt-1', score: 0.92, output: 'A substantive generated answer.', testedAt: '2026-06-02T10:00:00.000Z', version: 6 });
    });
    render(<PromptTestPanel tenantId="t1" prompt={basePrompt} />);

    fireEvent.click(screen.getByRole('button', { name: /run test/i }));

    expect(screen.getByText(/A substantive generated answer\./)).toBeTruthy();
    // score rendered as a percentage
    expect(screen.getByText(/92%/)).toBeTruthy();
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error toast when the test fails', () => {
    mutate.mockImplementation((_vars: unknown, opts: any) => {
      opts?.onError?.(new Error('SMR unavailable'));
    });
    render(<PromptTestPanel tenantId="t1" prompt={basePrompt} />);

    fireEvent.click(screen.getByRole('button', { name: /run test/i }));

    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('shows a loading skeleton while the test is pending', () => {
    isPending = true;
    render(<PromptTestPanel tenantId="t1" prompt={basePrompt} />);
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
  });

  it('pre-fills the last persisted score/output when present', () => {
    render(
      <PromptTestPanel
        tenantId="t1"
        prompt={{ ...basePrompt, lastTestScore: 0.5, lastTestOutput: 'Previously generated.', lastTestAt: '2026-05-01T00:00:00.000Z' }}
      />,
    );
    expect(screen.getByText(/Previously generated\./)).toBeTruthy();
    expect(screen.getByText(/50%/)).toBeTruthy();
  });
});
