/**
 * TASK-1055 post-merge review, lane FC — the Load dialog:
 * R1-F1 the pick defaults to the model's own target when it fits; R1-F8
 * `cpu:<service>` and `cpu` are one device; R3-4 a failed preview / re-check
 * shows the server's reason with Retry and Load waits for a good preview;
 * R3-5 the re-check spinner; R3-6 "Select <closest GPU>" when nothing fits;
 * R3-7 the UI holds still while making room; R3-8 the make-default checkbox;
 * R3-9 split-across-cards copy; R3-11 exceeds-device and IN_FLIGHT copy.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import { GatewayError } from '@/shared/api';
import type { LoadModelResidencyRequest } from '@/shared/residency';
import type { ModelResidencyLoadPreview, ResidencyPlacementCandidate } from '../../api/types';
import { DEVICE, GIB, makeModel, makePreview, makeService } from './fixtures';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PENDING = Symbol('pending');
type Answer = ModelResidencyLoadPreview | Error | typeof PENDING;
let resolver: (body: LoadModelResidencyRequest) => Answer = () => makePreview();
const previewMutate = vi.fn();
const unloadAsync = vi.fn();
const loadAsync = vi.fn();

vi.mock('../../api', async () => {
  const React = await import('react');
  const actual = await vi.importActual<typeof import('../../api/types')>('../../api/types');
  return {
    asModelResidencyConflict: actual.asModelResidencyConflict,
    residencyErrorMessage: actual.residencyErrorMessage,
    // Mirrors TanStack's mutation: a new mutate clears `data`; an error leaves `data` undefined.
    useLoadPreview: () => {
      const [state, setState] = React.useState<{ data?: ModelResidencyLoadPreview; error: Error | null; pending: boolean; idle: boolean }>({
        error: null,
        pending: false,
        idle: true,
      });
      const mutate = React.useCallback((body: LoadModelResidencyRequest) => {
        previewMutate(body);
        const answer = resolver(body);
        if (answer === PENDING) setState({ error: null, pending: true, idle: false });
        else if (answer instanceof Error) setState({ error: answer, pending: false, idle: false });
        else setState({ data: answer, error: null, pending: false, idle: false });
      }, []);
      return { mutate, data: state.data, error: state.error, isPending: state.pending, isIdle: state.idle, isError: state.error !== null };
    },
    useUnloadResidencyModel: () => ({ mutateAsync: unloadAsync, isPending: false }),
    useLoadResidencyModel: () => ({ mutateAsync: loadAsync, isPending: false }),
    useModelResidencyCatalogue: () => ({
      data: {
        devices: [
          DEVICE,
          { ...DEVICE, id: 'gpu1', label: 'GPU 1 — NVIDIA RTX 2000 Ada Generation', usedBytes: 2 * GIB, freeBytes: 14 * GIB },
          { ...DEVICE, id: 'cpu:nlp', kind: 'cpu', label: 'CPU — Medical NLP' },
        ],
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

const GPU0_FITS = candidate({ freeBytes: 6 * GIB, remainingBytes: 1.6 * GIB, shortfallBytes: 0, fits: true });
const GPU0_SHORT = candidate({});
const GPU1_FITS = candidate({
  device: 'gpu1',
  label: 'GPU 1 · NVIDIA RTX 2000 Ada Generation',
  freeBytes: 13.5 * GIB,
  remainingBytes: 9.1 * GIB,
  shortfallBytes: 0,
  fits: true,
  livePathModels: 0,
});
const GPU1_SHORT = candidate({ device: 'gpu1', label: 'GPU 1 · NVIDIA RTX 2000 Ada Generation', freeBytes: 4.2 * GIB, shortfallBytes: 0.2 * GIB });
const MULTI_FITS = candidate({ device: 'multi', label: 'Split across cards', freeBytes: 17 * GIB, shortfallBytes: 0, fits: true });

/** What the gateway answers for `device` (none = the model's target, `target`). */
function previewFor(
  device: string | null | undefined,
  candidates: ResidencyPlacementCandidate[],
  target: string,
  extra: Partial<ModelResidencyLoadPreview> = {},
): ModelResidencyLoadPreview {
  const asked = device ?? target;
  const judged = candidates.find((c) => c.device === asked) ?? candidates[0]!;
  return makePreview({
    device: device ?? target,
    needBytes: 2 * GIB,
    freeBytes: judged.freeBytes,
    headroomBytes: judged.headroomBytes,
    shortfallBytes: judged.shortfallBytes,
    fits: judged.fits,
    refusal: judged.fits ? null : 'OVER_BUDGET',
    evictable: [],
    pinned: [],
    candidates,
    suggestedDevice: candidates[0]!.device,
    suggestionReason: null,
    ...extra,
  });
}

const model = makeModel();
const service = makeService(model, { service: 'nlp', label: 'Medical NLP' });

function renderDialog(svc = service) {
  const onAdmitted = vi.fn();
  render(<LoadPreviewDialog open onOpenChange={vi.fn()} service={svc} model={model} onAdmitted={onAdmitted} />);
  return { onAdmitted };
}

const loadButton = () => screen.getByRole('button', { name: 'Load' }) as HTMLButtonElement;
const radio = (name: RegExp) => screen.getByRole('radio', { name });

beforeEach(() => {
  previewMutate.mockReset();
  unloadAsync.mockReset().mockResolvedValue({ outcome: 'unloaded' });
  loadAsync.mockReset().mockResolvedValue({ outcome: 'accepted', operationId: 'op-1', model: {} });
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});
afterEach(cleanup);

describe('R1-F1 / R1-F8 — the default pick', () => {
  it('defaults to the model’s own target when it fits, even if another GPU has more room', async () => {
    resolver = (body) => previewFor(body.device, [GPU1_FITS, GPU0_FITS], 'gpu0');
    const { onAdmitted } = renderDialog();
    expect(radio(/GPU 0/).getAttribute('aria-checked')).toBe('true');
    // The first answer already judged the target: no re-check is sent.
    expect(previewMutate).toHaveBeenCalledTimes(1);
    fireEvent.click(loadButton());
    await waitFor(() => expect(onAdmitted).toHaveBeenCalled());
    expect(loadAsync).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu0' });
  });

  it('falls back to the suggested GPU when the target does not fit', () => {
    resolver = (body) => previewFor(body.device, [GPU1_FITS, GPU0_SHORT], 'gpu0');
    renderDialog();
    expect(radio(/GPU 1/).getAttribute('aria-checked')).toBe('true');
  });

  it('treats `cpu:<service>` and `cpu` as the same device', async () => {
    const cpu = candidate({ device: 'cpu', label: 'CPU', freeBytes: 30 * GIB, shortfallBytes: 0, fits: true });
    resolver = (body) => ({ ...previewFor(body.device, [GPU1_FITS, cpu], 'cpu'), device: body.device ?? 'cpu:nlp' });
    const { onAdmitted } = renderDialog();
    expect(radio(/CPU/).getAttribute('aria-checked')).toBe('true');
    expect(previewMutate).toHaveBeenCalledTimes(1);
    expect(loadButton().disabled).toBe(false);
    fireEvent.click(loadButton());
    await waitFor(() => expect(onAdmitted).toHaveBeenCalled());
    expect(loadAsync).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'cpu' });
  });
});

describe('R3-4 / R3-5 — a failed preview says why and can be retried', () => {
  it('the first dry run failing shows the server’s reason and Retry re-asks', async () => {
    let fail = true;
    resolver = (body) => (fail ? new GatewayError(502, 'nlp agent did not answer') : previewFor(body.device, [GPU1_FITS, GPU0_FITS], 'gpu0'));
    renderDialog();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Couldn.t check placement/);
    expect(alert.textContent).toMatch(/nlp agent did not answer/);
    expect(screen.queryByRole('button', { name: 'Load' })).toBeNull();
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(previewMutate).toHaveBeenLastCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf' });
    await waitFor(() => expect(radio(/GPU 0/).getAttribute('aria-checked')).toBe('true'));
  });

  it('a failed re-check for the picked GPU shows the reason, keeps Load disabled, and Retry re-checks that GPU', async () => {
    let failGpu1 = true;
    resolver = (body) =>
      body.device === 'gpu1' && failGpu1 ? new GatewayError(503, 'gpu1 not reported') : previewFor(body.device, [GPU0_FITS, GPU1_FITS], 'gpu0');
    renderDialog();
    fireEvent.click(radio(/GPU 1/));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Couldn.t re-check GPU 1: gpu1 not reported/);
    expect(loadButton().disabled).toBe(true);
    failGpu1 = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(previewMutate).toHaveBeenLastCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu1' });
    await waitFor(() => expect(loadButton().disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an inline Spinner while re-checking the picked GPU', async () => {
    resolver = (body) => (body.device === 'gpu1' ? PENDING : previewFor(body.device, [GPU0_FITS, GPU1_FITS], 'gpu0'));
    renderDialog();
    fireEvent.click(radio(/GPU 1/));
    const line = await screen.findByText(/Checking GPU 1/);
    expect(within(line).getByRole('status')).toBeTruthy();
    expect(loadButton().disabled).toBe(true);
  });
});

describe('R3-6 — no GPU fits', () => {
  it('offers "Select <closest GPU>" and points to unloading or loading anyway', async () => {
    resolver = (body) => previewFor(body.device, [GPU1_SHORT, GPU0_SHORT], 'gpu1');
    renderDialog();
    fireEvent.click(radio(/GPU 0/));
    await waitFor(() => expect(previewMutate).toHaveBeenLastCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu0' }));
    const callout = screen.getByRole('alert');
    expect(callout.textContent).toMatch(/No GPU has room; GPU 1 is the closest/);
    expect(callout.textContent).toMatch(/To load it here, unload models (below|on this GPU) to make room, or load anyway with a reason\./);
    fireEvent.click(within(callout).getByRole('button', { name: 'Select GPU 1' }));
    expect(radio(/GPU 1/).getAttribute('aria-checked')).toBe('true');
    expect(loadAsync).not.toHaveBeenCalled();
  });
});

describe('R3-7 — the dialog holds still while making room', () => {
  it('shows "Making room…" and keeps the fit verdict and selection until the load is sent', async () => {
    resolver = () => makePreview();
    let finishUnload: () => void = () => {};
    unloadAsync.mockImplementation(() => new Promise((resolve) => (finishUnload = () => resolve({ outcome: 'unloaded' }))));
    let finishLoad: () => void = () => {};
    loadAsync.mockImplementation(
      () => new Promise((resolve) => (finishLoad = () => resolve({ outcome: 'accepted', operationId: 'op-1', model: {} }))),
    );
    const { onAdmitted } = renderDialog(makeService(model));
    fireEvent.click(screen.getByRole('checkbox', { name: /unload big one/i }));
    expect(screen.getByText(/Fits once the selected models are unloaded/)).toBeTruthy();
    fireEvent.click(loadButton());
    expect(await screen.findByText(/Making room…/)).toBeTruthy();
    finishUnload();
    await waitFor(() => expect(loadAsync).toHaveBeenCalled());
    expect(screen.getByText(/Fits once the selected models are unloaded/)).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /unload big one/i }).getAttribute('aria-checked')).toBe('true');
    expect(loadAsync).toHaveBeenCalledWith({ service: 'stt', modelRef: 'whisper-large-gguf' });
    finishLoad();
    await waitFor(() => expect(onAdmitted).toHaveBeenCalled());
  });
});

describe('R3-8 — make default', () => {
  it('names the GPU and the model, and resets when the pick changes', async () => {
    resolver = (body) => previewFor(body.device, [GPU0_FITS, GPU1_FITS], 'gpu0');
    renderDialog();
    const box = screen.getByRole('checkbox', { name: 'Make GPU 0 the default placement for Whisper Large (used at boot)' });
    fireEvent.click(box);
    expect(box.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(radio(/GPU 1/));
    await waitFor(() => expect(previewMutate).toHaveBeenCalledTimes(2));
    const gpu1Box = screen.getByRole('checkbox', { name: 'Make GPU 1 the default placement for Whisper Large (used at boot)' });
    expect(gpu1Box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(loadButton());
    await waitFor(() => expect(loadAsync).toHaveBeenCalled());
    expect(loadAsync).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu1' });
  });

  it('is disabled for a forced load and never sent with it', async () => {
    resolver = (body) => previewFor(body.device, [GPU1_FITS, GPU0_SHORT], 'gpu1');
    renderDialog();
    fireEvent.click(radio(/GPU 0/));
    const box = await screen.findByRole('checkbox', { name: /Make GPU 0 the default placement/ });
    expect(box.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'test' } });
    fireEvent.click(screen.getByRole('button', { name: /load anyway/i }));
    await waitFor(() => expect(loadAsync).toHaveBeenCalled());
    expect(loadAsync).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu0', force: true, reason: 'test' });
  });

  it('"Load on <suggested>" after a 409 never carries a default ticked for another GPU', async () => {
    resolver = (body) => previewFor(body.device, [GPU0_FITS, GPU1_FITS], 'gpu0');
    loadAsync.mockRejectedValueOnce({
      details: { code: 'OVER_BUDGET', message: 'GPU 0 filled up.', device: 'gpu0', suggestedDevice: 'gpu1', candidates: [GPU1_FITS, GPU0_SHORT] },
    });
    renderDialog();
    fireEvent.click(screen.getByRole('checkbox', { name: /Make GPU 0 the default placement/ }));
    fireEvent.click(loadButton());
    const callout = await screen.findByRole('alert');
    loadAsync.mockResolvedValueOnce({ outcome: 'accepted', operationId: 'op-2', model: {} });
    fireEvent.click(within(callout).getByRole('button', { name: 'Load on GPU 1' }));
    await waitFor(() => expect(loadAsync).toHaveBeenCalledTimes(2));
    expect(loadAsync).toHaveBeenLastCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu1' });
  });

  it('for a split placement it says "split across cards"', () => {
    resolver = (body) => previewFor(body.device, [MULTI_FITS, GPU0_SHORT], 'multi');
    renderDialog(makeService(model, { service: 'lm-studio', label: 'LM Studio' }));
    expect(screen.getByRole('checkbox', { name: 'Make “split across cards” the default placement for Whisper Large (used at boot)' })).toBeTruthy();
  });
});

describe('R3-9 / R3-11 — copy', () => {
  it('split across cards: "Splitting across both cards has room" and "Load split across cards"', async () => {
    resolver = (body) => previewFor(body.device, [MULTI_FITS, GPU0_SHORT], 'multi');
    renderDialog(makeService(model, { service: 'lm-studio', label: 'LM Studio' }));
    expect(screen.getByText('Splitting across both cards has room')).toBeTruthy();
    fireEvent.click(radio(/GPU 0/));
    const callout = await screen.findByRole('alert');
    expect(callout.textContent).toMatch(/Splitting across both cards has room\./);
    fireEvent.click(within(callout).getByRole('button', { name: 'Load split across cards' }));
    await waitFor(() => expect(loadAsync).toHaveBeenCalledWith({ service: 'lm-studio', modelRef: 'whisper-large-gguf', device: 'multi' }));
  });

  it('exceeds the card: "needs more than GPU 0 has free at all"', async () => {
    const exceeds = candidate({ freeBytes: 1 * GIB, shortfallBytes: 3.4 * GIB, exceedsDevice: true });
    resolver = (body) => previewFor(body.device, [GPU1_FITS, exceeds], 'gpu1');
    renderDialog();
    fireEvent.click(radio(/GPU 0/));
    const callout = await screen.findByRole('alert');
    expect(callout.textContent).toMatch(/needs more than GPU 0 has free at all/);
    expect(screen.getByText(/the model needs more than GPU 0 has free at all/)).toBeTruthy();
  });

  it('IN_FLIGHT: once a reason is typed the callout stops asking for one', () => {
    resolver = () => makePreview({ refusal: 'IN_FLIGHT', fits: false, shortfallBytes: 0, evictable: [], pinned: [] });
    renderDialog(makeService(model));
    expect(screen.getByText(/loading anyway needs a reason/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'roll it' } });
    expect(screen.queryByText(/loading anyway needs a reason/)).toBeNull();
    expect(screen.getByText(/Load anyway interrupts the requests in flight/)).toBeTruthy();
  });

  it('has no axe violations with the failed re-check and the no-fit advice showing', async () => {
    resolver = (body) => previewFor(body.device, [GPU1_SHORT, GPU0_SHORT], 'gpu1');
    renderDialog();
    fireEvent.click(radio(/GPU 0/));
    await screen.findByRole('button', { name: 'Select GPU 1' });
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
});
