import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { MetricChart } from '../metric-chart';

expect.extend(axeMatchers);

// recharts' ResponsiveContainer relies on layout measurement that happy-dom lacks;
// inject a fixed size so the chart actually draws (the standard recharts test shim).
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    // The element type carries the props being injected: a bare `ReactElement`
    // has `unknown` props, so `cloneElement` rejects width/height.
    ResponsiveContainer: ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) =>
      React.cloneElement(children, { width: 800, height: 300 }),
  };
});

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

const DATA = [
  { day: 'Mon', sessions: 24 },
  { day: 'Tue', sessions: 31 },
  { day: 'Wed', sessions: 28 },
];
const SERIES = [{ key: 'sessions', label: 'Sessions' }];

function renderChart(props: Partial<React.ComponentProps<typeof MetricChart>> = {}) {
  return render(<MetricChart kind="bar" data={DATA} xKey="day" series={SERIES} aria-label="Consultation sessions per day" {...props} />);
}

describe('MetricChart', () => {
  it('renders a bar chart for the given series', () => {
    const { container } = renderChart({ kind: 'bar' });
    expect(container.querySelector('[data-slot="metric-chart"]')).toHaveAttribute('data-kind', 'bar');
    expect(container.querySelector('.recharts-wrapper')).toBeTruthy();
  });

  it('renders a line chart', () => {
    const { container } = renderChart({ kind: 'line' });
    expect(container.querySelector('[data-slot="metric-chart"]')).toHaveAttribute('data-kind', 'line');
    expect(container.querySelector('.recharts-wrapper')).toBeTruthy();
  });

  it('renders an area chart', () => {
    const { container } = renderChart({ kind: 'area' });
    expect(container.querySelector('[data-slot="metric-chart"]')).toHaveAttribute('data-kind', 'area');
    expect(container.querySelector('.recharts-wrapper')).toBeTruthy();
  });

  it('drives series colors from the --chart-* tokens via ChartStyle', () => {
    const { container } = renderChart();
    const styleTags = Array.from(container.querySelectorAll('style')).map((s) => s.textContent ?? '');
    const combined = styleTags.join('\n');
    expect(combined).toContain('--color-sessions');
    expect(combined).toContain('var(--chart-1)');
  });

  it('exposes the chart as role="img" with a descriptive aria-label', () => {
    renderChart();
    expect(screen.getByRole('img', { name: 'Consultation sessions per day' })).toBeInTheDocument();
  });

  it('provides an offscreen (sr-only) data-table fallback', () => {
    const { container } = renderChart();
    const table = container.querySelector('table[data-slot="metric-chart-table"]') as HTMLElement;
    expect(table).toBeTruthy();
    expect(table.className).toContain('sr-only');
    // header scopes + one column per series + the x-axis column
    const heads = table.querySelectorAll('th[scope="col"]');
    expect(heads).toHaveLength(2);
    expect(table.textContent).toContain('Mon');
    expect(table.textContent).toContain('24');
  });

  it('renders loading, empty and error (with retry) states', () => {
    const onRetry = vi.fn();
    const { rerender, container } = renderChart({ isLoading: true });
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();

    rerender(<MetricChart kind="bar" data={[]} xKey="day" series={SERIES} aria-label="x" />);
    expect(container.querySelector('[data-slot="empty"]')).toBeInTheDocument();

    rerender(<MetricChart kind="bar" data={[]} xKey="day" series={SERIES} aria-label="x" error={new Error('nope')} onRetry={onRetry} />);
    expect(screen.getByText('nope')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('reflects density via data-density', () => {
    const { container } = renderChart({ density: 'compact' });
    expect(container.querySelector('[data-slot="metric-chart"]')).toHaveAttribute('data-density', 'compact');
  });

  it('has no axe violations', async () => {
    const { container } = renderChart();
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
