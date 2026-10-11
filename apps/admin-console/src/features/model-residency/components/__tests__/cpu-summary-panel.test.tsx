/**
 * TASK-1060 lane C — CPU & host memory section: node card, stacked bar,
 * per-service rows with nested models, agents-source note, empty state.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { CpuSummaryPanel } from '../cpu-summary-panel';
import { GiB, makeCpu } from './residency-test-data';

afterEach(cleanup);

describe('CpuSummaryPanel', () => {
  it('renders the node card with used/total/free, CPU utilisation and the headroom room badge', () => {
    render(<CpuSummaryPanel cpu={makeCpu()} />);
    expect(screen.getByRole('heading', { level: 2, name: 'CPU & host memory' })).toBeDefined();
    const card = screen.getByRole('article', { name: /dell/ });
    expect(within(card).getByText('24 GB')).toBeDefined();
    expect(within(card).getByText(/of 64 GB · 40 GB free/)).toBeDefined();
    expect(within(card).getByText('CPU 37% of 48 cores')).toBeDefined();
    expect(within(card).getByText('Room for 30.4 GB')).toBeDefined();
  });

  it('flags over headroom and shows CPU n/a when utilisation is not reported', () => {
    const base = makeCpu();
    render(<CpuSummaryPanel cpu={makeCpu({ node: { ...base.node, overHeadroom: true, freeBytes: 1 * GiB, utilisationPercent: null } })} />);
    expect(screen.getByText('Over headroom')).toBeDefined();
    expect(within(screen.getByRole('article', { name: /dell/ })).getAllByText('CPU n/a').length).toBeGreaterThan(1);
  });

  it('draws a bar segment per service plus the unattributed remainder, with a text summary', () => {
    const { container } = render(<CpuSummaryPanel cpu={makeCpu()} />);
    const segments = Array.from(container.querySelectorAll('[data-slot="cpu-segment"]')) as HTMLElement[];
    expect(segments.map((segment) => segment.dataset.service)).toEqual(['nlp', 'gateway', 'other', 'unattributed']);
    expect(segments[0]!.style.width).toBe(`${(8 / 64) * 100}%`);
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toContain('40 GB free');
    expect(container.querySelector('[data-slot="cpu-headroom-marker"]')).not.toBeNull();
  });

  it('formats memory, limit and cores per service, omitting absent parts and showing n/a for null', () => {
    render(<CpuSummaryPanel cpu={makeCpu()} />);
    const list = screen.getByRole('list', { name: 'Services on the host' });
    const nlp = within(list).getByText('Medical NLP').closest('li')!;
    expect(within(nlp).getByText('8 GB of 16 GB limit')).toBeDefined();
    expect(within(nlp).getByText('0.13 cores · request 0.5 · limit 2')).toBeDefined();
    const gateway = within(list).getByText('API gateway').closest('li')!;
    expect(within(gateway).getByText('2 GB')).toBeDefined();
    expect(within(gateway).getByText('CPU n/a')).toBeDefined();
    const other = within(list).getByText('Other workloads & system').closest('li')!;
    expect(within(other).getByText('1.5 cores')).toBeDefined();
  });

  it('shows the agents note only on the agents source', () => {
    const { rerender } = render(<CpuSummaryPanel cpu={makeCpu()} />);
    expect(screen.queryByText(/showing the services' own reports/)).toBeNull();
    rerender(<CpuSummaryPanel cpu={makeCpu({ source: 'agents' })} />);
    expect(screen.getByText('Per-service CPU and limits need cluster metrics; showing the services\' own reports.')).toBeDefined();
  });

  it('lists models under their service: measured, estimated and unknown, then the unattributed row', () => {
    render(<CpuSummaryPanel cpu={makeCpu()} />);
    const nlp = screen.getByText('Medical NLP').closest('li')!;
    expect(within(nlp).getByText('GLiNER2')).toBeDefined();
    expect(within(nlp).getByText('3 GB')).toBeDefined();
    expect(within(nlp).getByText('~1 GB est.')).toBeDefined();
    expect(within(nlp).getByText('size unknown')).toBeDefined();
    expect(within(nlp).getByText(/Not attributed — runtime, buffers, freed-but-retained memory/)).toBeDefined();
  });

  it('shows a service`s "Not attributed" row only when it holds a model on CPU (cluster proof: every row repeated it)', () => {
    const cpu = makeCpu();
    const gateway = cpu.services.find((s) => s.service === 'gateway')!;
    gateway.unattributedBytes = gateway.memoryBytes!; // no CPU models: the whole working set is "unattributed"
    render(<CpuSummaryPanel cpu={cpu} />);
    const row = screen.getByText(gateway.label).closest('li')!;
    expect(within(row).queryByText(/Not attributed/)).toBeNull();
    // a service that does hold CPU models keeps it
    const nlp = screen.getByText('Medical NLP').closest('li')!;
    expect(within(nlp).getByText(/Not attributed — runtime, buffers, freed-but-retained memory/)).toBeDefined();
  });

  it('states that CPU time cannot be split per model', () => {
    render(<CpuSummaryPanel cpu={makeCpu()} />);
    expect(screen.getByText('CPU time is measured per service; it cannot be split per model.')).toBeDefined();
  });

  it('shows the empty state when no host metrics are reported', () => {
    render(<CpuSummaryPanel cpu={null} />);
    expect(screen.getByRole('heading', { level: 2, name: 'CPU & host memory' })).toBeDefined();
    expect(screen.getByText('No host metrics reported')).toBeDefined();
  });

  it('has no axe violations', async () => {
    const { container } = render(<CpuSummaryPanel cpu={makeCpu({ source: 'agents' })} />);
    expect((await axe(container)).violations).toEqual([]);
  });
});
