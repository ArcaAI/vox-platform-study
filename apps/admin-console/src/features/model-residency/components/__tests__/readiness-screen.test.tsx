import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { ModelResidencyReadiness } from '../../api/types';
import { makeReadiness } from './fixtures';

const q: { data?: ModelResidencyReadiness; isPending: boolean; isError: boolean; refetch: () => void } = {
  isPending: false,
  isError: false,
  refetch: vi.fn(),
};
vi.mock('../../api', () => ({ useModelResidencyReadiness: () => q }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ReadinessScreen } from '../readiness-screen';

beforeEach(() => {
  q.data = makeReadiness();
  q.isPending = false;
  q.isError = false;
});
afterEach(cleanup);

describe('ReadinessScreen', () => {
  it('renders progress, checks with sr text, shadow tiles and a disabled enforce button', () => {
    renderWithProviders(<ReadinessScreen />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('2');
    expect(screen.getByText(/1 of 2 passed/i)).toBeTruthy();
    expect(screen.getByText('Shadow review recorded')).toBeTruthy();
    expect(screen.getByText(/blocking/i)).toBeTruthy();
    expect(screen.getByText(/passed$/i, { selector: '.sr-only' })).toBeTruthy();
    expect(screen.getByText('41')).toBeTruthy();
    expect(screen.getByText('21')).toBeTruthy();
    expect(screen.getByText(/since gateway start/i)).toBeTruthy();
    expect(screen.getByText(/residency\.enforce/)).toBeTruthy();
    const enforce = screen.getByRole('button', { name: /turn on enforce/i }) as HTMLButtonElement;
    expect(enforce.disabled).toBe(true);
    expect(screen.getByText(/1 check blocks enforce mode/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /model residency/i }).getAttribute('href')).toBe('/model-residency');
  });

  it('shows a skeleton while loading', () => {
    q.data = undefined;
    q.isPending = true;
    renderWithProviders(<ReadinessScreen />);
    expect(screen.getByTestId('readiness-skeleton')).toBeTruthy();
  });

  it('shows an error state with retry', () => {
    q.data = undefined;
    q.isError = true;
    renderWithProviders(<ReadinessScreen />);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(<ReadinessScreen />);
    expect((await axe(container)).violations).toEqual([]);
  });
});
