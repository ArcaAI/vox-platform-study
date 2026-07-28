import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';
import { Activity } from 'lucide-react';

import { StatCard } from '../stat-card';

expect.extend(axeMatchers);

function delta(container: HTMLElement) {
  return container.querySelector('[data-slot="stat-card-delta"]') as HTMLElement;
}

describe('StatCard (§3.2)', () => {
  it('renders the label, value and hint', () => {
    render(<StatCard label="Active tenants" value={27} hint="across all regions" icon={Activity} />);
    expect(screen.getByText('Active tenants')).toBeInTheDocument();
    expect(screen.getByText('27')).toBeInTheDocument();
    expect(screen.getByText('across all regions')).toBeInTheDocument();
  });

  it('renders the value with tabular-nums', () => {
    const { container } = render(<StatCard label="Sessions" value={14} />);
    expect(container.querySelector('[data-slot="stat-card-value"]')?.className).toContain('tabular-nums');
  });

  it('shows an up delta with a trending-up icon, + sign and success color (auto intent)', () => {
    const { container } = render(<StatCard label="Tenants" value={27} delta={{ value: 2, direction: 'up', label: 'this week' }} />);
    const d = delta(container);
    expect(d).toHaveAttribute('data-trend', 'up');
    expect(d.className).toContain('text-success');
    expect(d.querySelector('svg')).toBeTruthy();
    expect(d.textContent).toContain('+2');
    expect(d.textContent).toContain('this week');
  });

  it('shows a down delta with a − sign and destructive color (auto intent)', () => {
    const { container } = render(<StatCard label="Tenants" value={27} delta={{ value: 3, direction: 'down' }} />);
    const d = delta(container);
    expect(d).toHaveAttribute('data-trend', 'down');
    expect(d.className).toContain('text-destructive');
    expect(d.textContent).toContain('\u22123');
  });

  it('shows a neutral delta with muted color', () => {
    const { container } = render(<StatCard label="Tenants" value={27} delta={{ value: 0, direction: 'neutral' }} />);
    const d = delta(container);
    expect(d).toHaveAttribute('data-trend', 'neutral');
    expect(d.className).toContain('text-muted-foreground');
  });

  it('flips success/destructive mapping when deltaIntent="negative" (e.g. error rate)', () => {
    const { container, rerender } = render(
      <StatCard label="Error rate" value="0.42%" delta={{ value: 6, direction: 'up' }} deltaIntent="negative" />,
    );
    // up is BAD for an error rate → destructive (flipped from auto's success)
    expect(delta(container).className).toContain('text-destructive');
    rerender(<StatCard label="Error rate" value="0.30%" delta={{ value: 4, direction: 'down' }} deltaIntent="negative" />);
    // down is GOOD for an error rate → success
    expect(delta(container).className).toContain('text-success');
  });

  it('renders a skeleton while loading', () => {
    const { container } = render(<StatCard label="Tenants" value={27} isLoading />);
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
    expect(screen.queryByText('27')).not.toBeInTheDocument();
  });

  it('renders an em-dash for an empty value', () => {
    render(<StatCard label="Tenants" value={null} hint="no data yet" />);
    expect(screen.getByText('\u2014')).toBeInTheDocument();
  });

  it('renders the error state', () => {
    const { container } = render(
      <StatCard label="Tenants" value={27} error={new Error('boom')} errorState={(e) => <div role="alert">{e.message}</div>} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
    expect(container.querySelector('[data-slot="stat-card"]')).toBeInTheDocument();
  });

  it('reflects density via data-density', () => {
    const { container } = render(<StatCard label="Tenants" value={27} density="compact" />);
    expect(container.querySelector('[data-slot="stat-card"]')).toHaveAttribute('data-density', 'compact');
  });

  it('exposes an aria-label summarizing the value and delta', () => {
    const { container } = render(<StatCard label="Tenants" value={27} delta={{ value: 2, direction: 'up', label: 'this week' }} />);
    const label = container.querySelector('[data-slot="stat-card"]')?.getAttribute('aria-label') ?? '';
    expect(label).toContain('Tenants');
    expect(label).toContain('27');
    expect(label.toLowerCase()).toContain('up');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <StatCard
        label="Error rate"
        value="0.42%"
        delta={{ value: 6, direction: 'up', label: 'vs 1h' }}
        deltaIntent="negative"
        accent="warning"
        icon={Activity}
      />,
    );
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
