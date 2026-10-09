/**
 * TASK-1055 lane C (AC-3 / AC-4) — the Load dialog's GPU picker and capacity
 * advice: defaults to the suggested GPU, re-checks on every pick, says plainly
 * when the picked GPU cannot hold the model and offers "Load on <GPU>" for the
 * one that can; force stays behind a reason and is refused outright when the
 * model exceeds the card (OD-5); "make default" is sent with the device (OD-4).
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import type { LoadModelResidencyRequest } from '@/shared/residency';
import type { ModelResidencyLoadPreview, ResidencyPlacementCandidate } from '../../api/types';
import { DEVICE, GIB, makeModel, makePreview, makeService } from './fixtures';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let resolver: (body: LoadModelResidencyRequest) => ModelResidencyLoadPreview = () => makePreview();
const previewMutate = vi.fn();
const unloadAsync = vi.fn();
const loadAsync = vi.fn();

vi.mock('../../api', async () => {
  const React = await import('react');
  const actual = await vi.importActual<typeof import('../../api/types')>('../../api/types');
  return {
    asModelResidencyConflict: actual.asModelResidencyConflict,
    residencyErrorMessage: actual.residencyErrorMessage,
    useLoadPreview: () => {
      const [data, setData] = React.useState<ModelResidencyLoadPreview | undefined>(undefined);
      const mutate = React.useCallback((body: LoadModelResidencyRequest) => {
        previewMutate(body);
        setData(resolver(body));
      }, []);
      return { mutate, data, isPending: false, isIdle: data === undefined, isError: false };
    },
    useUnloadResidencyModel: () => ({ mutateAsync: unloadAsync, isPending: false }),
    useLoadResidencyModel: () => ({ mutateAsync: loadAsync, isPending: false }),
    useModelResidencyCatalogue: () => ({
      data: {
        devices: [DEVICE, { ...DEVICE, id: 'gpu1', label: 'GPU 1 — NVIDIA RTX 2000 Ada Generation', usedBytes: 2 * GIB, freeBytes: 14 * GIB }],
      },
    }),
  };
});

import { LoadPreviewDialog } from '../load-preview-dialog';

function candidate(overrides: Partial<ResidencyPlacementCandidate>): ResidencyPlacementCandidate {
  return {
    device: 'gpu0',
    label: 'GPU 0 · NVIDIA RTX 2000 Ada Generation',
    totalBytes: 16 * GIB,
    freeBytes: 3.8 * GIB,
    headroomBytes: 2.4 * GIB,
    remainingBytes: -0.6 * GIB,
    shortfallBytes: 0.6 * GIB,
    fits: false,
    exceedsDevice: false,
    livePathModels: 4,
    evictable: [],
    ...overrides,
  };
}

const GPU1_FITS = candidate({
  device: 'gpu1',
  label: 'GPU 1 · NVIDIA RTX 2000 Ada Generation',
  freeBytes: 13.5 * GIB,
  remainingBytes: 9.1 * GIB,
  shortfallBytes: 0,
  fits: true,
  livePathModels: 0,
});
const GPU0_SHORT = candidate({});
const CANDIDATES = [GPU1_FITS, GPU0_SHORT];

/** The preview the gateway would answer for the device asked about (none = the model's default, GPU 0). */
function previewFor(device: string | null | undefined, candidates = CANDIDATES, extra: Partial<ModelResidencyLoadPreview> = {}) {
  const judged = candidates.find((c) => c.device === (device ?? 'gpu0'))!;
  return makePreview({
    device: judged.device,
    needBytes: 2 * GIB,
    freeBytes: judged.freeBytes,
    headroomBytes: judged.headroomBytes,
    shortfallBytes: judged.shortfallBytes,
    fits: judged.fits,
    refusal: judged.fits ? null : 'OVER_BUDGET',
    evictable: [],
    pinned: [],
    candidates,
    suggestedDevice: 'gpu1',
    suggestionReason: 'GPU 1 has 9.1 GB free above headroom; GPU 0 is 0.6 GB short.',
    ...extra,
  });
}

const model = makeModel();
const service = makeService(model, { service: 'nlp', label: 'Medical NLP' });

function renderDialog(onAdmitted = vi.fn(), svc = service) {
  const view = render(<LoadPreviewDialog open onOpenChange={vi.fn()} service={svc} model={model} onAdmitted={onAdmitted} />);
  return { ...view, onAdmitted };
}

beforeEach(() => {
  resolver = (body) => previewFor(body.device);
  previewMutate.mockReset();
  unloadAsync.mockReset().mockResolvedValue({ outcome: 'unloaded' });
  loadAsync.mockReset().mockResolvedValue({ outcome: 'accepted', operationId: 'op-1', model: {} });
  vi.mocked(toast.error).mockClear();
});
afterEach(cleanup);

describe('LoadPreviewDialog — GPU choice', () => {
  it('asks without a device first, defaults the picker to the suggested GPU, and re-checks that GPU', async () => {
    renderDialog();
    expect(previewMutate.mock.calls[0]![0]).toEqual({ service: 'nlp', modelRef: 'whisper-large-gguf' });
    await waitFor(() => expect(previewMutate).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu1' }));
    expect((screen.getByRole('radio', { name: /GPU 1/ }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/GPU 1 has 9\.1 GB free above headroom/)).toBeTruthy();
  });

  it('shows each GPU’s free memory, the need, and a fits / does-not-fit badge in words', () => {
    renderDialog();
    const picker = within(screen.getByRole('radiogroup', { name: /GPU/ }));
    const gpu1 = picker.getByRole('radio', { name: /GPU 1/ }).closest('[data-slot="placement-candidate"]') as HTMLElement;
    const gpu0 = picker.getByRole('radio', { name: /GPU 0/ }).closest('[data-slot="placement-candidate"]') as HTMLElement;
    expect(gpu1.textContent).toMatch(/Fits/);
    expect(gpu1.textContent).toMatch(/Suggested/);
    expect(gpu1.textContent).toMatch(/13\.5 GB free · needs 2 GB/);
    expect(gpu0.textContent).toMatch(/Does not fit/);
    expect(gpu0.textContent).toMatch(/short 614\.4 MB/);
  });

  it('loads on the picked GPU when it fits', async () => {
    const { onAdmitted } = renderDialog();
    await waitFor(() => expect(previewMutate).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(onAdmitted).toHaveBeenCalled());
    expect(loadAsync).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu1' });
  });

  it('picking a GPU that cannot hold the model re-checks it, says why, and offers Load on the suggested GPU', async () => {
    const { onAdmitted } = renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /GPU 0/ }));
    await waitFor(() => expect(previewMutate).toHaveBeenLastCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu0' }));
    const callout = screen.getByRole('alert');
    expect(callout.textContent).toMatch(
      /GPU 0 cannot hold this model — needs 2 GB, 1\.4 GB free above headroom \(short 614\.4 MB\)\. GPU 1 has room\./,
    );
    fireEvent.click(within(callout).getByRole('button', { name: 'Load on GPU 1' }));
    await waitFor(() => expect(onAdmitted).toHaveBeenCalled());
    expect(loadAsync).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu1' });
  });

  it('forcing onto a GPU that is short keeps the mandatory reason and sends the device', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /GPU 0/ }));
    const anyway = (await screen.findByRole('button', { name: /load anyway/i })) as HTMLButtonElement;
    expect(anyway.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'test a split' } });
    fireEvent.click(anyway);
    await waitFor(() => expect(loadAsync).toHaveBeenCalled());
    expect(loadAsync).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu0', force: true, reason: 'test a split' });
  });

  it('refuses to force when the model needs more than the card has free at all (OD-5)', async () => {
    const exceeds = [GPU1_FITS, candidate({ freeBytes: 1 * GIB, shortfallBytes: 3.4 * GIB, exceedsDevice: true })];
    resolver = (body) => previewFor(body.device, exceeds);
    renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /GPU 0/ }));
    const anyway = (await screen.findByRole('button', { name: /load anyway/i })) as HTMLButtonElement;
    expect(screen.queryByLabelText(/reason/i)).toBeNull();
    expect(anyway.disabled).toBe(true);
    expect(screen.getByText(/would run its card-mates out of memory/i)).toBeTruthy();
    expect(screen.getByRole('radio', { name: /GPU 0/ }).closest('[data-slot="placement-candidate"]')!.textContent).toMatch(/Exceeds the card/);
  });

  it('sends makeDefault with the device when "make this the default GPU" is ticked', async () => {
    renderDialog();
    await waitFor(() => expect(previewMutate).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('checkbox', { name: /make this the model.s default GPU/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(loadAsync).toHaveBeenCalled());
    expect(loadAsync).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu1', makeDefault: true });
  });

  it('offers LM Studio’s "Split across cards" placement', () => {
    const multi = candidate({ device: 'multi', label: 'Split across cards', fits: true, shortfallBytes: 0, freeBytes: 17 * GIB, livePathModels: 4 });
    resolver = (body) => previewFor(body.device, [GPU1_FITS, multi, GPU0_SHORT]);
    renderDialog(vi.fn(), makeService(model, { service: 'lm-studio', label: 'LM Studio' }));
    expect(screen.getByRole('radio', { name: /Split across cards/ })).toBeTruthy();
  });

  it('shows the same advice when the load itself is refused 409 OVER_BUDGET, without a generic toast', async () => {
    resolver = (body) =>
      previewFor(
        body.device,
        [GPU1_FITS, GPU0_SHORT].map((c) => ({ ...c, fits: true, shortfallBytes: 0 })),
        {
          suggestedDevice: 'gpu0',
        },
      );
    loadAsync.mockRejectedValueOnce({
      details: {
        code: 'OVER_BUDGET',
        message: 'GPU 0 cannot hold Whisper Large (short 0.6 GB). GPU 1 can.',
        device: 'gpu0',
        shortfallBytes: 0.6 * GIB,
        suggestedDevice: 'gpu1',
        candidates: CANDIDATES,
      },
    });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    const callout = await screen.findByRole('alert');
    expect(callout.textContent).toMatch(/GPU 0 cannot hold this model/);
    expect(callout.textContent).toMatch(/GPU 1 has room/);
    expect(toast.error).not.toHaveBeenCalled();
    loadAsync.mockResolvedValueOnce({ outcome: 'accepted', operationId: 'op-2', model: {} });
    fireEvent.click(within(callout).getByRole('button', { name: 'Load on GPU 1' }));
    await waitFor(() => expect(loadAsync).toHaveBeenLastCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu1' }));
  });

  it('a failed load toasts the server’s message and code', async () => {
    loadAsync.mockRejectedValueOnce({ details: { code: 'SERVICE_UNREACHABLE', message: 'nlp agent did not answer' } });
    renderDialog();
    await waitFor(() => expect(previewMutate).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nlp agent did not answer (SERVICE_UNREACHABLE)'));
  });

  it('the picker is keyboard operable: arrow keys move the pick and re-check', async () => {
    renderDialog();
    const gpu1 = screen.getByRole('radio', { name: /GPU 1/ });
    act(() => gpu1.focus());
    fireEvent.keyDown(gpu1, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('radio', { name: /GPU 0/ }).getAttribute('aria-checked')).toBe('true'));
    await waitFor(() => expect(previewMutate).toHaveBeenLastCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu0' }));
  });

  it('has no axe violations with the capacity callout showing', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /GPU 0/ }));
    await screen.findByRole('alert');
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
});
