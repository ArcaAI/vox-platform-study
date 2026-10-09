import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import type { ModelResidencyLoadPreview } from '../../api/types';
import { DEVICE, GIB, makeModel, makePreview, makeService } from './fixtures';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const state: { data: ModelResidencyLoadPreview | undefined; isPending: boolean; isError: boolean } = {
  data: undefined,
  isPending: false,
  isError: false,
};
const previewMutate = vi.fn();
const unloadAsync = vi.fn();
const loadAsync = vi.fn();

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api/types')>('../../api/types');
  return {
    asModelResidencyConflict: actual.asModelResidencyConflict,
    residencyErrorMessage: actual.residencyErrorMessage,
    useLoadPreview: () => ({ mutate: previewMutate, ...state }),
    useUnloadResidencyModel: () => ({ mutateAsync: unloadAsync, isPending: false }),
    useLoadResidencyModel: () => ({ mutateAsync: loadAsync, isPending: false }),
    useModelResidencyCatalogue: () => ({ data: { devices: [DEVICE] } }),
  };
});

import { LoadPreviewDialog } from '../load-preview-dialog';

const model = makeModel();
const service = makeService(model);

function renderDialog(onAdmitted = vi.fn(), onOpenChange = vi.fn()) {
  const view = render(<LoadPreviewDialog open onOpenChange={onOpenChange} service={service} model={model} onAdmitted={onAdmitted} />);
  return { ...view, onAdmitted, onOpenChange };
}

beforeEach(() => {
  state.data = undefined;
  state.isPending = false;
  state.isError = false;
  previewMutate.mockReset();
  unloadAsync.mockReset().mockResolvedValue({ outcome: 'unloaded' });
  loadAsync.mockReset().mockResolvedValue({ outcome: 'accepted', operationId: 'op-1', model: {} });
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});
afterEach(cleanup);

describe('LoadPreviewDialog', () => {
  it('asks for a dry run on open and shows a skeleton while pending', () => {
    state.isPending = true;
    renderDialog();
    expect(previewMutate).toHaveBeenCalledWith({ service: 'stt', modelRef: 'whisper-large-gguf' });
    expect(screen.getByTestId('load-preview-skeleton')).toBeTruthy();
  });

  it('shows the fits callout and loads without a reason', async () => {
    state.data = makePreview({ fits: true, refusal: null, shortfallBytes: 0, evictable: [], pinned: [] });
    const { onAdmitted, onOpenChange } = renderDialog();
    expect(screen.getByText(/fits/i)).toBeTruthy();
    expect(screen.queryByLabelText(/reason/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(onAdmitted).toHaveBeenCalled());
    expect(loadAsync).toHaveBeenCalledWith({ service: 'stt', modelRef: 'whisper-large-gguf' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the shortfall, the catalogue need source, a labelled bar and pinned models as not offered', () => {
    state.data = makePreview();
    renderDialog();
    expect(screen.getByText(/does not fit — short by 3\.4 GB/i)).toBeTruthy();
    expect(screen.getByText(/catalogue × 1\.2, never measured/i)).toBeTruthy();
    expect(screen.getByRole('img', { name: /GPU 0/ })).toBeTruthy();
    expect(screen.getByText(/Radiology ASR/)).toBeTruthy();
    expect(screen.getByText(/not offered/i)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Radiology/ })).toBeNull();
  });

  it('recomputes the remaining shortfall as evictions are ticked, and unloads them before the load', async () => {
    state.data = makePreview();
    const { onAdmitted } = renderDialog();
    fireEvent.click(screen.getByRole('checkbox', { name: /Medical NER/ }));
    expect(screen.getByText(/still short by 2\.6 GB/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /Big One/ }));
    // 3.4 GB short, 4.8 GB freed → fits now, no reason needed
    expect(screen.queryByLabelText(/reason/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(onAdmitted).toHaveBeenCalled());
    expect(unloadAsync).toHaveBeenCalledTimes(2);
    expect(unloadAsync).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'medical-ner', reason: 'Make room for Whisper Large' });
    expect(Math.max(...unloadAsync.mock.invocationCallOrder)).toBeLessThan(loadAsync.mock.invocationCallOrder[0]!);
    expect(loadAsync).toHaveBeenCalledWith({ service: 'stt', modelRef: 'whisper-large-gguf' });
  });

  it('treats the idle (not yet started) state as loading, never as an error', () => {
    (state as { isIdle?: boolean }).isIdle = true;
    renderDialog();
    expect(screen.getByTestId('load-preview-skeleton')).toBeTruthy();
    expect(screen.queryByText(/couldn.t check placement/i)).toBeNull();
    (state as { isIdle?: boolean }).isIdle = false;
  });

  it('toasts each eviction, refreshes the preview, and names the evictions done when the load then fails', async () => {
    state.data = makePreview();
    loadAsync.mockRejectedValueOnce(new Error('boom'));
    renderDialog();
    fireEvent.click(screen.getByRole('checkbox', { name: /Medical NER/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Big One/ }));
    previewMutate.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Unloaded Medical NER');
    expect(toast.success).toHaveBeenCalledWith('Unloaded Big One');
    expect(previewMutate).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(toast.error).mock.calls[0]![0])).toMatch(/Already unloaded: Medical NER, Big One/);
  });

  it('marks the force reason as required', () => {
    state.data = makePreview();
    renderDialog();
    expect(screen.getByLabelText(/reason/i).getAttribute('aria-required')).toBe('true');
  });

  it('requires a reason to load anyway, then sends force with it', async () => {
    state.data = makePreview();
    renderDialog();
    const button = screen.getByRole('button', { name: /load anyway/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: '  trial run  ' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(loadAsync).toHaveBeenCalled());
    expect(loadAsync).toHaveBeenCalledWith({ service: 'stt', modelRef: 'whisper-large-gguf', force: true, reason: 'trial run' });
  });

  it('NO_SIZE needs a reason and says why', () => {
    state.data = makePreview({ needBytes: null, needSource: 'unknown', refusal: 'NO_SIZE', shortfallBytes: 0, evictable: [] });
    renderDialog();
    expect(screen.getByText(/no size known — loading needs a reason/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /load anyway/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('already loaded offers no load', () => {
    state.data = makePreview({ refusal: 'ALREADY_LOADED', fits: false, shortfallBytes: 0, evictable: [], pinned: [] });
    renderDialog();
    expect(screen.getByText(/already loaded/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^load/i })).toBeNull();
  });

  it('toasts the server message on a 409 and stays open', async () => {
    state.data = makePreview({ fits: true, refusal: null, shortfallBytes: 0, evictable: [], pinned: [] });
    loadAsync.mockRejectedValue({ details: { code: 'LOAD_IN_PROGRESS', message: 'Already loading it' } });
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Already loading it (LOAD_IN_PROGRESS)'));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('has no axe violations', async () => {
    state.data = makePreview();
    renderDialog();
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
});
void GIB;
