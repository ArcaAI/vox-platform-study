/**
 * TASK-1055 lane C (E8) — the GPU cards use the per-card bytes the service
 * measured (`residency.deviceBytes`), so a split LM Studio model shows its
 * real share on each card instead of a ratio estimate.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { GpuSummaryPanel } from '../gpu-summary-panel';
import { GiB, LMS, makeDevice, makeModel, makeService, ROUTING_GUARD } from './residency-test-data';

afterEach(cleanup);

const granite = {
  service: 'lm-studio',
  modelRef: 'granite-guardian',
  name: 'Granite Guardian 4.1 8B',
  bytes: 0.1 * GiB,
  bytesSource: 'estimated' as const,
};
const gpu0 = makeDevice({ usedBytes: 8 * GiB, attributedBytes: 0.1 * GiB, unattributedBytes: 7.9 * GiB, models: [granite] });
const gpu1 = makeDevice({
  id: 'gpu1',
  label: 'GPU 1 — NVIDIA RTX 2000 Ada Generation',
  usedBytes: 4 * GiB,
  attributedBytes: 0.08 * GiB,
  unattributedBytes: 3.92 * GiB,
  models: [{ ...granite, bytes: 0.08 * GiB }],
});
const split = makeModel({
  ...ROUTING_GUARD,
  residency: {
    ...ROUTING_GUARD.residency!,
    device: 'multi',
    deviceBytes: [
      { device: 'gpu0', bytes: 3 * GiB },
      { device: 'gpu1', bytes: 3.7 * GiB },
    ],
  },
});

describe('GpuSummaryPanel with measured per-card bytes', () => {
  it('lists each card’s measured share and recomputes the unattributed remainder', () => {
    render(<GpuSummaryPanel devices={[gpu0, gpu1]} services={[makeService({ ...LMS, models: [split] })]} />);
    const card0 = within(screen.getByRole('list', { name: 'Memory on GPU 0' }));
    expect(card0.getByText('Granite Guardian 4.1 8B').parentElement!.textContent).toMatch(/3 GB/);
    expect(card0.getByText(/Not attributed/).parentElement!.textContent).toMatch(/5 GB/);
    const card1 = within(screen.getByRole('list', { name: 'Memory on GPU 1' }));
    expect(card1.getByText('Granite Guardian 4.1 8B').parentElement!.textContent).toMatch(/3\.7 GB/);
  });

  it('without services keeps the server figures', () => {
    render(<GpuSummaryPanel devices={[gpu0]} />);
    const card0 = within(screen.getByRole('list', { name: 'Memory on GPU 0' }));
    expect(card0.getByText('Granite Guardian 4.1 8B').parentElement!.textContent).toMatch(/~102\.4 MB est\./);
  });

  it('has no axe violations', async () => {
    const { container } = render(<GpuSummaryPanel devices={[gpu0, gpu1]} services={[makeService({ ...LMS, models: [split] })]} />);
    expect((await axe(container)).violations).toEqual([]);
  });
});
