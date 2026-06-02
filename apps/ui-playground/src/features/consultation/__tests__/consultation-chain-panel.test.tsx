/**
 * ConsultationChainPanel smoke test (TASK-329 P2 — Chain tab)
 *
 * Verifies the multi-hop chain surface:
 *   - fetches the chain for the consultation on mount
 *   - "not linked" empty state when the chain has a single node
 *   - renders the ordered chain, marks the current node, and "Open" navigates
 *   - error state surfaces the message + retry
 *
 * The ui-playground vitest config stubs `@arcaai/ui/*` + `@arcaai/vox` with
 * `export default {}`, so each primitive/hook is mocked here (mirrors the
 * saved-summaries-panel test pattern).
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, ...p }: any) => <button {...p}>{children}</button>,
}));
vi.mock('@arcaai/ui/badge', () => ({
  Badge: ({ children, ...p }: any) => <span {...p}>{children}</span>,
}));
vi.mock('@arcaai/ui/skeleton', () => ({
  Skeleton: (p: any) => <div data-testid="skeleton" {...p} />,
}));

const state = vi.hoisted(() => ({
  chain: [] as Array<Record<string, unknown>>,
  isLoading: false,
  error: null as Error | null,
  fetchChain: vi.fn(),
}));

vi.mock('@arcaai/vox', () => ({
  useConsultationChain: () => ({
    chain: state.chain,
    isLoading: state.isLoading,
    error: state.error,
    fetchChain: state.fetchChain,
  }),
}));

import { ConsultationChainPanel } from '../components/consultation-chain-panel';

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  patientId: `patient-${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'OPEN',
  ...extra,
});

describe('ConsultationChainPanel (TASK-329 P2)', () => {
  beforeEach(() => {
    state.chain = [];
    state.isLoading = false;
    state.error = null;
    state.fetchChain = vi.fn().mockResolvedValue([]);
  });

  it('fetches the chain for the consultation on mount', () => {
    render(<ConsultationChainPanel consultationId="c-1" />);
    expect(state.fetchChain).toHaveBeenCalledWith('c-1');
  });

  it('shows the not-linked empty state for a single-node chain', () => {
    state.chain = [node('c-1')];
    render(<ConsultationChainPanel consultationId="c-1" />);
    expect(screen.getByText('No linked consultations')).toBeInTheDocument();
  });

  it('renders the ordered chain, marks the current node, and Open navigates', () => {
    state.chain = [node('A'), node('B'), node('c-1')];
    const onOpen = vi.fn();
    render(<ConsultationChainPanel consultationId="c-1" onOpen={onOpen} />);

    // count badge + current marker
    expect(screen.getByText('3 linked')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();

    // current node ("c-1") has no Open button; the other two do.
    const openButtons = screen.getAllByText('Open');
    expect(openButtons).toHaveLength(2);

    fireEvent.click(openButtons[0]!);
    expect(onOpen).toHaveBeenCalledWith('A');
  });

  it('surfaces the error state and retries on click', () => {
    state.error = new Error('chain blew up');
    render(<ConsultationChainPanel consultationId="c-1" />);

    expect(screen.getByText('chain blew up')).toBeInTheDocument();
    state.fetchChain.mockClear();
    fireEvent.click(screen.getByText('Retry'));
    expect(state.fetchChain).toHaveBeenCalledWith('c-1');
  });

  it('renders a loading skeleton while fetching an empty chain', () => {
    state.isLoading = true;
    render(<ConsultationChainPanel consultationId="c-1" />);
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
  });
});
