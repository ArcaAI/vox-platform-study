import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { ServiceStatusBar, ServiceStatusItem, type ServiceStatusItemProps } from '../service-status';

expect.extend(axeMatchers);

const SERVICES: ServiceStatusItemProps[] = [
  { name: 'API', status: 'healthy', p95Ms: 82, version: '1.4.0' },
  { name: 'STT', status: 'healthy', p95Ms: 240 },
  { name: 'SMR', status: 'degraded' },
  { name: 'NLP', status: 'unhealthy', error: 'timeout' },
];

function listScope(container: HTMLElement) {
  return container.querySelector('[data-slot="service-status-list"]') as HTMLElement;
}

describe('ServiceStatusItem (§3.2)', () => {
  it('maps each status to the correct dot color role and badge label', () => {
    const { container, rerender } = render(<ServiceStatusItem name="API" status="healthy" />);
    let item = container.querySelector('[data-slot="service-status-item"]')!;
    expect(item).toHaveAttribute('data-status', 'healthy');
    expect(item.querySelector('[data-slot="status-dot"]')).toHaveAttribute('data-color-role', 'success');
    expect(screen.getByText('Healthy')).toBeInTheDocument();

    rerender(<ServiceStatusItem name="SMR" status="degraded" />);
    expect(container.querySelector('[data-slot="status-dot"]')).toHaveAttribute('data-color-role', 'warning');
    expect(screen.getByText('Degraded')).toBeInTheDocument();

    rerender(<ServiceStatusItem name="NLP" status="unhealthy" />);
    expect(container.querySelector('[data-slot="status-dot"]')).toHaveAttribute('data-color-role', 'destructive');
    expect(screen.getByText('Unhealthy')).toBeInTheDocument();
  });

  it('shows the P95 cell only when p95Ms is provided', () => {
    const { container, rerender } = render(<ServiceStatusItem name="API" status="healthy" p95Ms={82} />);
    const p95 = container.querySelector('[data-slot="service-status-p95"]')!;
    expect(p95).toBeInTheDocument();
    expect(p95.className).toContain('tabular-nums');
    expect(p95.textContent).toContain('82');

    rerender(<ServiceStatusItem name="API" status="healthy" />);
    expect(container.querySelector('[data-slot="service-status-p95"]')).toBeNull();
  });

  it('renders the version in a monospace font', () => {
    const { container } = render(<ServiceStatusItem name="API" status="healthy" version="1.4.0" />);
    const version = container.querySelector('[data-slot="service-status-version"]')!;
    expect(version.className).toContain('font-mono');
    expect(version.textContent).toContain('1.4.0');
  });
});

describe('ServiceStatusBar (§3.2)', () => {
  it('is a polite live status region', () => {
    const { container } = render(<ServiceStatusBar services={SERVICES} />);
    const bar = container.querySelector('[data-slot="service-status-bar"]')!;
    expect(bar).toHaveAttribute('role', 'status');
    expect(bar).toHaveAttribute('aria-live', 'polite');
  });

  it('renders one item per service with dot + badge', () => {
    const { container } = render(<ServiceStatusBar services={SERVICES} />);
    const items = within(listScope(container)).getAllByText(/^(Healthy|Degraded|Unhealthy)$/);
    expect(items.length).toBe(4);
  });

  it('hides the P95 cell for services without p95Ms', () => {
    const { container } = render(<ServiceStatusBar services={SERVICES} />);
    // only API (82) and STT (240) carry p95Ms
    expect(listScope(container).querySelectorAll('[data-slot="service-status-p95"]')).toHaveLength(2);
  });

  it('renders session / job counts and the environment', () => {
    render(<ServiceStatusBar services={SERVICES} activeSessions={14} processingJobs={23} env="Production" />);
    expect(screen.getByText(/14 active session/i)).toBeInTheDocument();
    expect(screen.getByText(/23 processing/i)).toBeInTheDocument();
    expect(screen.getByText('Production')).toBeInTheDocument();
  });

  it('fires onRefresh from a real ≥44px button', () => {
    const onRefresh = vi.fn();
    render(<ServiceStatusBar services={SERVICES} onRefresh={onRefresh} />);
    const btn = screen.getByRole('button', { name: /refresh/i });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.className).toContain('min-h-11');
    fireEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('collapses to a summary chip ("2/4 healthy") on narrow widths', () => {
    const { container } = render(<ServiceStatusBar services={SERVICES} />);
    const summary = container.querySelector('[data-slot="service-status-summary"]') as HTMLElement;
    expect(summary).toBeTruthy();
    expect(summary.tagName).toBe('BUTTON');
    expect(summary.textContent).toMatch(/2\s*\/\s*4 healthy/i);
  });

  it('shows a skeleton while loading', () => {
    const { container } = render(<ServiceStatusBar services={[]} isLoading />);
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<ServiceStatusBar services={SERVICES} activeSessions={14} processingJobs={23} env="Production" onRefresh={vi.fn()} />);
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
