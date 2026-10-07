/**
 * TASK-1051 lane C1 — GPU memory cards (artboard 01, F5, C-e): a stacked bar of
 * per-model bytes per service, estimates visibly marked, an unattributed
 * segment, a headroom marker, an over-headroom status, full titles.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { GpuMemoryBar } from '../gpu-memory-bar';
import { GpuSummaryPanel } from '../gpu-summary-panel';
import { GiB, makeDevice } from './residency-test-data';

afterEach(cleanup);

describe('GpuMemoryBar', () => {
  it('draws one segment per model with bytes, plus an unattributed segment, sized as a share of total', () => {
    const device = makeDevice();
    const { container } = render(<GpuMemoryBar device={device} />);

    const segments = container.querySelectorAll('[data-slot="gpu-segment"]');
    expect(segments).toHaveLength(3);
    const [stt, lms, unattributed] = Array.from(segments) as HTMLElement[];
    expect(stt!.dataset.service).toBe('stt');
    expect(stt!.style.width).toBe(`${(1.5 / 16) * 100}%`);
    expect(stt!.dataset.estimated).toBe('false');
    expect(lms!.dataset.service).toBe('lm-studio');
    expect(lms!.dataset.estimated).toBe('true');
    expect(unattributed!.dataset.service).toBe('unattributed');
    expect(unattributed!.style.width).toBe(`${(2 / 16) * 100}%`);
  });

  it('marks the headroom line at 100 − headroomPercent', () => {
    const { container } = render(<GpuMemoryBar device={makeDevice({ headroomPercent: 15 })} />);
    const marker = container.querySelector('[data-slot="gpu-headroom-marker"]') as HTMLElement;
    expect(marker.style.left).toBe('85%');
  });

  it('is an image with a full text summary', () => {
    render(<GpuMemoryBar device={makeDevice()} />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toBe(
      'GPU 0: 4 GB attributed to models, 2 GB not attributed, 10 GB free; 2.4 GB should stay free (headroom line at 85%)',
    );
  });

  it('skips models with no bytes and never overflows 100%', () => {
    const device = makeDevice({
      totalBytes: 10 * GiB,
      unattributedBytes: 9 * GiB,
      models: [
        { service: 'nlp', modelRef: 'a', name: 'A', bytes: null, bytesSource: 'unknown' },
        { service: 'nlp', modelRef: 'b', name: 'B', bytes: 4 * GiB, bytesSource: 'measured' },
      ],
    });
    const { container } = render(<GpuMemoryBar device={device} />);
    const widths = Array.from(container.querySelectorAll('[data-slot="gpu-segment"]')).map((el) => parseFloat((el as HTMLElement).style.width));
    expect(widths).toHaveLength(2);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(100);
  });
});

describe('GpuSummaryPanel', () => {
  it('shows the full device label (no truncation), used of total, free, and "Room for" when inside headroom', () => {
    render(<GpuSummaryPanel devices={[makeDevice()]} />);
    const card = screen.getByRole('article', { name: /GPU 0/ });
    expect(within(card).getByRole('heading', { name: 'GPU 0' })).toBeDefined();
    expect(within(card).getByText('NVIDIA RTX 2000 Ada Generation')).toBeDefined();
    expect(card.querySelector('.truncate')).toBeNull();
    expect(within(card).getByText('6 GB')).toBeDefined();
    expect(within(card).getByText(/of 16 GB · 10 GB free/)).toBeDefined();
    expect(within(card).getByText('Room for 7.6 GB')).toBeDefined();
    expect(within(card).getByText('Utilisation 12%')).toBeDefined();
  });

  it('flags over-headroom in words, with a destructive badge', () => {
    render(<GpuSummaryPanel devices={[makeDevice({ overHeadroom: true, freeBytes: 26 * 1024 ** 2 })]} />);
    const badge = screen.getByText('Over headroom');
    expect(badge.getAttribute('data-variant')).toBe('destructive');
  });

  it('renders "n/a" for an unknown utilisation, never 0', () => {
    render(<GpuSummaryPanel devices={[makeDevice({ utilisationPercent: null })]} />);
    expect(screen.getByText('Utilisation n/a')).toBeDefined();
  });

  it('lists models with measured vs "est." sizes and the unattributed remainder', () => {
    render(<GpuSummaryPanel devices={[makeDevice()]} />);
    const list = screen.getByRole('list', { name: 'Memory on GPU 0' });
    expect(within(list).getByText('ArcaAI Whisper ml-en')).toBeDefined();
    expect(within(list).getByText('1.5 GB')).toBeDefined();
    expect(within(list).getByText('Gemma 4 E2B')).toBeDefined();
    expect(within(list).getByText('~2.5 GB est.')).toBeDefined();
    expect(within(list).getByText(/Not attributed/)).toBeDefined();
    expect(within(list).getByText('2 GB')).toBeDefined();
  });

  it('has an empty state when no device reports', () => {
    render(<GpuSummaryPanel devices={[]} />);
    expect(screen.getByText('No GPUs reported')).toBeDefined();
  });

  it('has a legend naming each service colour, estimates, unattributed and the headroom line', () => {
    render(<GpuSummaryPanel devices={[makeDevice()]} />);
    const legend = screen.getByRole('list', { name: 'Legend' });
    for (const text of ['Speech-to-text', 'LM Studio', 'Estimated', 'Not attributed', 'Headroom line']) {
      expect(within(legend).getByText(text)).toBeDefined();
    }
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <GpuSummaryPanel devices={[makeDevice(), makeDevice({ id: 'gpu1', label: 'GPU 1 — NVIDIA RTX 2000 Ada Generation', overHeadroom: true })]} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
