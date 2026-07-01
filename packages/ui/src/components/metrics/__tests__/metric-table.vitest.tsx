import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { MetricTable, type MetricColumn } from '../metric-table';

expect.extend(axeMatchers);

const COLUMNS: MetricColumn[] = [
  { key: 'service', label: 'Service' },
  { key: 'p95', label: 'P95', format: 'numeric' },
  { key: 'uptime', label: 'Uptime', format: 'numeric' },
  { key: 'version', label: 'Version' },
];

const ROWS = [
  { service: 'API', p95: 82, uptime: '99.98%', version: '1.4.0' },
  { service: 'STT', p95: 240, uptime: '99.90%', version: '2.0.1' },
];

describe('MetricTable (§3.2)', () => {
  it('renders a caption and column headers with scope="col"', () => {
    const { container } = render(<MetricTable columns={COLUMNS} rows={ROWS} caption="Per-service metrics" />);
    expect(container.querySelector('caption')).toHaveTextContent('Per-service metrics');
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(COLUMNS.length);
    headers.forEach((h) => expect(h).toHaveAttribute('scope', 'col'));
  });

  it('right-aligns numeric columns with tabular-nums (header + cells)', () => {
    const { container } = render(<MetricTable columns={COLUMNS} rows={ROWS} caption="metrics" />);
    const head = container.querySelector('th[data-col="p95"]')!;
    expect(head.className).toContain('text-right');
    const cells = Array.from(container.querySelectorAll('td[data-col="p95"]'));
    expect(cells).toHaveLength(ROWS.length);
    cells.forEach((c) => {
      expect(c.className).toContain('text-right');
      expect(c.className).toContain('tabular-nums');
    });
    // text columns are not forced to numeric alignment
    expect(container.querySelector('td[data-col="service"]')!.className).not.toContain('tabular-nums');
  });

  it('renders the cell values', () => {
    const { container } = render(<MetricTable columns={COLUMNS} rows={ROWS} caption="metrics" />);
    const firstRow = container.querySelectorAll('tbody tr')[0];
    expect(within(firstRow as HTMLElement).getByText('API')).toBeInTheDocument();
    expect(within(firstRow as HTMLElement).getByText('82')).toBeInTheDocument();
  });

  it('shows skeleton rows while loading (headers still visible)', () => {
    const { container } = render(<MetricTable columns={COLUMNS} rows={[]} isLoading caption="metrics" skeletonRows={4} />);
    // headers remain so the table shape is stable
    expect(screen.getAllByRole('columnheader')).toHaveLength(COLUMNS.length);
    const skeletonRows = container.querySelectorAll('[data-slot="metric-table-skeleton-row"]');
    expect(skeletonRows).toHaveLength(4);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('renders a custom empty state when there are no rows', () => {
    render(<MetricTable columns={COLUMNS} rows={[]} caption="metrics" emptyState={<span>No services reporting</span>} />);
    expect(screen.getByText('No services reporting')).toBeInTheDocument();
  });

  it('renders a default empty state when none is provided', () => {
    const { container } = render(<MetricTable columns={COLUMNS} rows={[]} caption="metrics" />);
    expect(container.querySelector('[data-slot="metric-table-empty"]')).toBeInTheDocument();
  });

  it('reflects the density on the root', () => {
    const { container, rerender } = render(<MetricTable columns={COLUMNS} rows={ROWS} caption="metrics" />);
    expect(container.querySelector('[data-slot="metric-table"]')).toHaveAttribute('data-density', 'comfortable');
    rerender(<MetricTable columns={COLUMNS} rows={ROWS} caption="metrics" density="compact" />);
    expect(container.querySelector('[data-slot="metric-table"]')).toHaveAttribute('data-density', 'compact');
  });

  it('has no axe violations', async () => {
    const { container } = render(<MetricTable columns={COLUMNS} rows={ROWS} caption="Per-service metrics" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
