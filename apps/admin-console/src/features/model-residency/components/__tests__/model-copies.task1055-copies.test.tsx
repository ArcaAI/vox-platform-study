/**
 * TASK-1055 §8b D4 — an stt / nlp model held as separate copies on several
 * devices, as the gateway catalogue now reports it: `residency.deviceBytes`
 * names every copy (`gpu<N>`, or `cpu:<service>` for a host-memory copy) with
 * its bytes. The unload dialog offers one copy at a time and sends the device
 * in the request vocabulary; each GPU card shows the copy it holds.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GpuSummaryPanel } from '../gpu-summary-panel';
import { GIB, makeLoaded, makeService } from './fixtures';
import { makeDevice } from './residency-test-data';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const unloadAsync = vi.fn();
vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api/types')>('../../api/types');
  return {
    asModelResidencyConflict: actual.asModelResidencyConflict,
    residencyErrorMessage: actual.residencyErrorMessage,
    useUnloadResidencyModel: () => ({ mutateAsync: unloadAsync, isPending: false }),
  };
});

import { UnloadDialog } from '../unload-dialog';

beforeEach(() => {
  unloadAsync.mockReset();
  unloadAsync.mockResolvedValue({});
});
afterEach(cleanup);

function ner(deviceBytes: Array<{ device: string; bytes: number }>) {
  const base = makeLoaded({ name: 'Medical NER', modelRef: 'blaze999/Medical-NER' });
  return makeLoaded({
    name: 'Medical NER',
    modelRef: 'blaze999/Medical-NER',
    residency: { ...base.residency!, device: deviceBytes[0].device, bytes: 1.4 * GIB, deviceBytes },
  });
}

function renderUnload(model: ReturnType<typeof ner>) {
  render(<UnloadDialog open onOpenChange={vi.fn()} service={makeService(model, { service: 'nlp', label: 'Medical NLP' })} model={model} />);
}

describe('unload one copy of a model on two devices', () => {
  it('two GPU copies: "Only GPU 0" sends device gpu0', async () => {
    renderUnload(
      ner([
        { device: 'gpu0', bytes: 0.7 * GIB },
        { device: 'gpu1', bytes: 0.7 * GIB },
      ]),
    );
    const group = screen.getByRole('radiogroup', { name: /which copy/i });
    expect(within(group).getByRole('radio', { name: 'All copies (GPU 0, GPU 1)' })).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: 'Only GPU 0' }));
    fireEvent.click(screen.getByRole('button', { name: /^unload/i }));
    await waitFor(() => expect(unloadAsync).toHaveBeenCalled());
    expect(unloadAsync).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'blaze999/Medical-NER', device: 'gpu0' });
  });

  it('a host-memory copy is named "host memory" and sent as `cpu`', async () => {
    renderUnload(
      ner([
        { device: 'cpu:nlp', bytes: 0.8 * GIB },
        { device: 'gpu0', bytes: 0.7 * GIB },
      ]),
    );
    const group = screen.getByRole('radiogroup', { name: /which copy/i });
    expect(within(group).getByRole('radio', { name: 'All copies (host memory, GPU 0)' })).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: 'Only host memory' }));
    fireEvent.click(screen.getByRole('button', { name: /^unload/i }));
    await waitFor(() => expect(unloadAsync).toHaveBeenCalled());
    expect(unloadAsync).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'blaze999/Medical-NER', device: 'cpu' });
  });
});

describe('GPU cards with a model on two GPUs', () => {
  it('each card shows the copy it holds, with that copy`s bytes', () => {
    const model = ner([
      { device: 'gpu0', bytes: 0.7 * GIB },
      { device: 'gpu1', bytes: 0.8 * GIB },
    ]);
    const copyOn = (bytes: number) => ({ service: 'nlp', modelRef: 'blaze999/Medical-NER', name: 'Medical NER', bytes, bytesSource: 'measured' as const });
    const gpu0 = makeDevice({ usedBytes: 6 * GIB, attributedBytes: 0.7 * GIB, unattributedBytes: 5.3 * GIB, models: [copyOn(0.7 * GIB)] });
    const gpu1 = makeDevice({
      id: 'gpu1',
      label: 'GPU 1 — NVIDIA RTX 2000 Ada Generation',
      usedBytes: 3 * GIB,
      attributedBytes: 0.8 * GIB,
      unattributedBytes: 2.2 * GIB,
      models: [copyOn(0.8 * GIB)],
    });
    render(<GpuSummaryPanel devices={[gpu0, gpu1]} services={[makeService(model, { service: 'nlp', label: 'Medical NLP' })]} />);
    const card0 = within(screen.getByRole('list', { name: 'Memory on GPU 0' }));
    expect(card0.getByText('Medical NER').parentElement!.textContent).toMatch(/716\.8 MB/);
    const card1 = within(screen.getByRole('list', { name: 'Memory on GPU 1' }));
    expect(card1.getByText('Medical NER').parentElement!.textContent).toMatch(/819\.2 MB/);
  });
});
