import { describe, it, expect } from 'vitest';
import { render, screen, renderHook } from '@testing-library/react';
import { DensityProvider, useDensity } from '../density-provider';
import { StatusBadge } from '../status-badge';

describe('useDensity', () => {
  it('falls back to comfortable with no provider and no override', () => {
    const { result } = renderHook(() => useDensity());
    expect(result.current).toBe('comfortable');
  });

  it('reads density from the provider', () => {
    const { result } = renderHook(() => useDensity(), {
      wrapper: ({ children }) => <DensityProvider density="compact">{children}</DensityProvider>,
    });
    expect(result.current).toBe('compact');
  });

  it('prefers an explicit override over the provider', () => {
    const { result } = renderHook(() => useDensity('comfortable'), {
      wrapper: ({ children }) => <DensityProvider density="compact">{children}</DensityProvider>,
    });
    expect(result.current).toBe('comfortable');
  });
});

describe('StatusBadge', () => {
  it('renders an icon AND a label (status is never color-only)', () => {
    render(<StatusBadge label="Active" colorRole="success" icon={<svg data-testid="dot" />} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByTestId('dot')).toBeInTheDocument();
  });

  it('applies a semantic token class for the color role (no hardcoded color)', () => {
    render(<StatusBadge label="Archived" colorRole="warning" />);
    const badge = screen.getByText('Archived').closest('[data-slot="status-badge"]');
    expect(badge?.className).toContain('text-warning');
  });
});
