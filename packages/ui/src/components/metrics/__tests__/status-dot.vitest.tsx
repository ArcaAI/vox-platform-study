import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { StatusDot } from '../status-dot';

expect.extend(axeMatchers);

function root(container: HTMLElement) {
  return container.querySelector('[data-slot="status-dot"]') as HTMLElement;
}
function indicator(container: HTMLElement) {
  return container.querySelector('[data-slot="status-dot-indicator"]') as HTMLElement;
}

describe('StatusDot', () => {
  it('maps each color role to its semantic background token', () => {
    const { container, rerender } = render(<StatusDot colorRole="success" aria-label="Healthy" />);
    expect(root(container)).toHaveAttribute('data-color-role', 'success');
    expect(indicator(container).className).toContain('bg-success');

    rerender(<StatusDot colorRole="destructive" aria-label="Down" />);
    expect(root(container)).toHaveAttribute('data-color-role', 'destructive');
    expect(indicator(container).className).toContain('bg-destructive');

    rerender(<StatusDot colorRole="warning" aria-label="Degraded" />);
    expect(indicator(container).className).toContain('bg-warning');
  });

  it('reflects the size variant via data-size', () => {
    const { container, rerender } = render(<StatusDot colorRole="success" size="sm" aria-label="ok" />);
    expect(root(container)).toHaveAttribute('data-size', 'sm');
    rerender(<StatusDot colorRole="success" aria-label="ok" />);
    expect(root(container)).toHaveAttribute('data-size', 'md');
  });

  it('is labelled (text) with a decorative dot when `label` is given', () => {
    const { container } = render(<StatusDot colorRole="success" label="Healthy" />);
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    // The glyph is decorative; the text carries the meaning.
    expect(root(container)).not.toHaveAttribute('role', 'img');
    const glyph = container.querySelector('[data-slot="status-dot-glyph"]')!;
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
  });

  it('exposes a standalone accessible name via role="img" + aria-label', () => {
    const { container } = render(<StatusDot colorRole="destructive" aria-label="Service down" />);
    const el = root(container);
    expect(el).toHaveAttribute('role', 'img');
    expect(el).toHaveAttribute('aria-label', 'Service down');
  });

  it('is purely decorative (aria-hidden) when neither label nor aria-label is provided', () => {
    const { container } = render(<StatusDot colorRole="neutral" />);
    expect(root(container)).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders a pulse layer gated by prefers-reduced-motion only when pulse is set', () => {
    const { container, rerender } = render(<StatusDot colorRole="success" pulse aria-label="Live" />);
    const pulse = container.querySelector('[data-slot="status-dot-pulse"]') as HTMLElement;
    expect(pulse).toBeTruthy();
    expect(pulse.className).toContain('motion-reduce:hidden');
    expect(pulse.className).toContain('motion-safe:animate-ping');

    rerender(<StatusDot colorRole="success" aria-label="Live" />);
    expect(container.querySelector('[data-slot="status-dot-pulse"]')).toBeNull();
  });

  it('has no axe violations (labelled and standalone)', async () => {
    const { container } = render(
      <div>
        <StatusDot colorRole="success" label="Healthy" />
        <StatusDot colorRole="destructive" aria-label="Service down" />
      </div>,
    );
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
