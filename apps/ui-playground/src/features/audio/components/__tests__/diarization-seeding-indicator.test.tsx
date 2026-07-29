/**
 * DiarizationSeedingIndicator Tests (TASK-329 P4 / D-3)
 *
 * Surfaces the streaming-session `voiceProfileSeeded` echo to the user:
 * - a positive Badge + one-time success toast when the caller's enrolled voice
 *   profile seeded diarization,
 * - a quiet neutral note when diarization ran without personalization,
 * - and nothing before a session has reported a value.
 */

import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('@arcaai/ui/badge', () => ({
  Badge: ({ children, variant, ...props }: React.PropsWithChildren<{ variant?: string } & Record<string, unknown>>) => (
    <span data-testid="badge" data-variant={variant} {...props}>
      {children}
    </span>
  ),
}));

vi.mock('lucide-react', () => ({
  Fingerprint: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon-fingerprint" {...props} />,
  Info: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon-info" {...props} />,
}));

const mockToastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { DiarizationSeedingIndicator } from '../diarization-seeding-indicator';

describe('DiarizationSeedingIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when seeded is null (no session reported yet)', () => {
    const { container } = render(<DiarizationSeedingIndicator seeded={null} />);
    expect(container.firstChild).toBeNull();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('shows a positive (default) badge and fires a success toast when seeded is true', () => {
    render(<DiarizationSeedingIndicator seeded={true} />);
    const badge = screen.getByText(/voice profile seeded/i);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('data-variant', 'default');
    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledWith('Voice profile seeded into diarization');
  });

  it('shows a neutral (secondary) note and no toast when seeded is false', () => {
    render(<DiarizationSeedingIndicator seeded={false} />);
    const badge = screen.getByText(/not personalized/i);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('data-variant', 'secondary');
    expect(screen.queryByText(/voice profile seeded/i)).not.toBeInTheDocument();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('announces seeding only once while seeded stays true across re-renders', () => {
    const { rerender } = render(<DiarizationSeedingIndicator seeded={true} />);
    rerender(<DiarizationSeedingIndicator seeded={true} />);
    rerender(<DiarizationSeedingIndicator seeded={true} />);
    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
  });
});
