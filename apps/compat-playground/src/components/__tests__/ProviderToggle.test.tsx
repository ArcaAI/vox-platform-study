import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Control exactly what `useArcaSttProvider` returns per test — the point of
// this suite is the presentation logic in `ProviderToggle.tsx`, not the hook
// itself.
let mockReturn: {
  activeProvider: { pipelineId: string; name?: string; isFallback: boolean } | null;
  fallbackAvailable: boolean;
  isFallbackActive: boolean;
  usePipeline: boolean;
  switchStatus: 'idle' | 'switching' | 'switched' | 'failed';
};

/**
 * Capture phase from the console's own session context.
 *
 * "Is there a live session?" is answered by CAPTURE, not by `activeProvider`.
 * `activeProvider` is null for the whole session whenever capture started
 * without an explicit pipelineId, which made this card announce "no live
 * session yet — queued" in the middle of a recording.
*/
let mockPhase: 'idle' | 'starting' | 'recording' | 'stopping';

vi.mock('@arcaai/vox/compat', () => ({
  useArcaSttProvider: () => mockReturn,
}));

vi.mock('../../context/playground-session', () => ({
  usePlaygroundSession: () => ({ capture: { phase: mockPhase } }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Import AFTER the mocks are registered.
import { ProviderToggle } from '../ProviderToggle';

describe('ProviderToggle', () => {
  it('shows "pending" (not "switched") for a pre-session selection', () => {
    // Mirrors `useArcaSttProvider.switchTo()` before capture starts: it records
    // `pendingSttProvider` and reports `switched` for read consistency, but
    // nothing is transcribing yet.
    mockPhase = 'idle';
    mockReturn = {
      activeProvider: null,
      fallbackAvailable: false,
      isFallbackActive: true,
      usePipeline: false,
      switchStatus: 'switched',
    };

    render(<ProviderToggle />);

    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.queryByText('switched')).not.toBeInTheDocument();
    expect(screen.getAllByText(/queued/i).length).toBeGreaterThan(0);
    expect(screen.getByText('fallback queued')).toBeInTheDocument();
  });

  it('shows "switched" for an actual live engine switch once a session exists', () => {
    mockPhase = 'recording';
    mockReturn = {
      activeProvider: { pipelineId: 'p1', name: 'Tenant Default', isFallback: true },
      fallbackAvailable: true,
      isFallbackActive: true,
      usePipeline: false,
      switchStatus: 'switched',
    };

    render(<ProviderToggle />);

    expect(screen.getByText('switched')).toBeInTheDocument();
    expect(screen.queryByText('pending')).not.toBeInTheDocument();
    expect(screen.getByText(/mid-session, with no reconnect/i)).toBeInTheDocument();
    expect(screen.getByText('fallback active')).toBeInTheDocument();
  });

  it('does not relabel non-"switched" statuses (e.g. "switching") pre-session', () => {
    mockPhase = 'idle';
    mockReturn = {
      activeProvider: null,
      fallbackAvailable: false,
      isFallbackActive: false,
      usePipeline: true,
      switchStatus: 'switching',
    };

    render(<ProviderToggle />);

    expect(screen.getByText('switching')).toBeInTheDocument();
    expect(screen.queryByText('pending')).not.toBeInTheDocument();
  });

  // The case that motivated the change. A recording session whose
  // pipeline the client never named still has `activeProvider === null`; the old
  // gate showed "queued"/"not started" while audio was streaming.
  it('reports a LIVE session while recording even when the active pipeline is unknown', () => {
    mockPhase = 'recording';
    mockReturn = {
      activeProvider: null,
      fallbackAvailable: false,
      isFallbackActive: true,
      usePipeline: false,
      switchStatus: 'switched',
    };

    render(<ProviderToggle />);

    expect(screen.getByText('switched')).toBeInTheDocument();
    expect(screen.queryByText('pending')).not.toBeInTheDocument();
    expect(screen.queryByText(/no live session yet/i)).not.toBeInTheDocument();
    expect(screen.getByText('fallback active')).toBeInTheDocument();
  });
});
