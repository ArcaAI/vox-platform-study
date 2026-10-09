/**
 * TASK-1055 follow-up — a model the platform cannot load from the console says WHY before the admin
 * tries: the catalogue row carries `loadBlockedReason` (the gateway's own refusal words). The Load
 * dialog shows it instead of a dry run, offers no Load button, and the drawer shows it next to Load.
 * A row without it behaves exactly as before (the dry run runs).
 */

import { cleanup, screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { DEVICE, makeModel, makeService } from './fixtures';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const previewMutate = vi.fn();
vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api/types')>('../../api/types');
  return {
    asModelResidencyConflict: actual.asModelResidencyConflict,
    residencyErrorMessage: actual.residencyErrorMessage,
    useLoadPreview: () => ({ mutate: previewMutate, data: undefined, error: null, isPending: false, isIdle: true, isError: false }),
    useUnloadResidencyModel: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useLoadResidencyModel: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useModelResidencyCatalogue: () => ({ data: { devices: [] } }),
  };
});

vi.mock('../../api/hooks', () => ({
  useSaveResidencyPolicy: () => ({ mutate: vi.fn(), isPending: false }),
  usePinResidencyModel: () => ({ mutate: vi.fn(), isPending: false }),
  useResetResidencyPolicy: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { LoadPreviewDialog } from '../load-preview-dialog';
import { ModelDetailDrawer } from '../model-detail-drawer';

const REASON =
  "nlp_entailment_scorer for 'nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF' needs the model's local path, and the catalogue row has none (not published to the models bucket); the scorer never auto-downloads.";

beforeEach(() => previewMutate.mockReset());
afterEach(cleanup);

describe('LoadPreviewDialog — loadBlockedReason', () => {
  it('shows the reason, runs no dry run and offers no Load', async () => {
    const model = makeModel({ name: 'MiniCheck Flan-T5 Large (GGUF)', loadBlockedReason: REASON });
    const service = makeService(model, { service: 'nlp', label: 'Medical NLP' });
    render(<LoadPreviewDialog open onOpenChange={vi.fn()} service={service} model={model} onAdmitted={vi.fn()} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/can.t be loaded from the console/i);
    expect(alert.textContent).toContain(REASON);
    expect(previewMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^Load/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThanOrEqual(2); // the footer's, beside the dialog's own X
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });

  it('a row without a reason still runs the dry run (Prompt Guard 2 behaves like any other model)', () => {
    const model = makeModel({ name: 'Llama Prompt Guard 2 86M', modelRef: 'meta-llama/Llama-Prompt-Guard-2-86M' });
    const service = makeService(model, { service: 'nlp', label: 'Medical NLP' });
    render(<LoadPreviewDialog open onOpenChange={vi.fn()} service={service} model={model} onAdmitted={vi.fn()} />);
    expect(previewMutate).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'meta-llama/Llama-Prompt-Guard-2-86M' });
    expect(screen.queryByText(/can.t be loaded from the console/i)).toBeNull();
  });
});

describe('ModelDetailDrawer — loadBlockedReason', () => {
  it('states the reason next to Load, wired to the button', () => {
    const model = makeModel({ name: 'Silero VAD', actions: ['load', 'edit_policy'], loadBlockedReason: 'stt loads it with its ASR agent.' });
    renderWithProviders(
      <ModelDetailDrawer
        open
        onOpenChange={vi.fn()}
        service={makeService(model)}
        model={model}
        devices={[DEVICE]}
        actionPending={false}
        onLoad={vi.fn()}
        onUnload={vi.fn()}
        onLink={vi.fn()}
        onReload={vi.fn()}
      />,
    );
    const load = screen.getByRole('button', { name: 'Load' });
    const describedBy = load.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/Can.t be loaded from the console: stt loads it with its ASR agent\./);
  });
});
