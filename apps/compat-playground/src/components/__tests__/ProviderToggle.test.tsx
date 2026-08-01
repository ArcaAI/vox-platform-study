import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Control exactly what `useArcaSttProvider` returns per test — the point of
// this suite is the presentation logic in `ProviderToggle.tsx`, not the hook
// itself (R7 says the hook is already correct and must not be touched).
let mockReturn: {
  activeProvider: { pipelineId: string; name?: string; isFallback: boolean } | null;
  fallbackAvailable: boolean;
  isFallbackActive: boolean;
  usePipeline: boolean;
  switchStatus: 'idle' | 'switching' | 'switched' | 'failed';
};

vi.mock('@arcaai/vox/compat', () => ({
  useArcaSttProvider: () => mockReturn,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Import AFTER the mocks are registered.
import { ProviderToggle } from '../ProviderToggle';

describe('ProviderToggle', () => {
  it('shows "pending" (not "switched") for a pre-session selection with no live provider yet', () => {
    // Mirrors `useArcaSttProvider.switchTo()` before any capture session
    // exists: it records `pendingSttProvider` and reports `switched` for read
    // consistency, but `activeProvider` stays null because no backend session
    // is transcribing yet.
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
});
