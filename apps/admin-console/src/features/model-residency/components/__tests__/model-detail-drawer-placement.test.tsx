/**
 * TASK-1055 lane C — the drawer: Reload with options reachable next to Unload
 * for a loaded LM Studio model and prefilled from the live config (E10),
 * "Reset to default" on an explicit keep policy (E9), errors in the server's
 * words (AC-6).
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import { GatewayError } from '@/shared/api';
import { renderWithProviders } from '@/test/render';
import type { ResidencyCatalogueModel } from '../../api/types';
import { DEVICE, GIB, makeLoaded, makeService } from './fixtures';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const saveMutate = vi.fn();
const pinMutate = vi.fn();
const resetMutate = vi.fn();
vi.mock('../../api/hooks', () => ({
  useSaveResidencyPolicy: () => ({ mutate: saveMutate, isPending: false }),
  usePinResidencyModel: () => ({ mutate: pinMutate, isPending: false }),
  useResetResidencyPolicy: () => ({ mutate: resetMutate, isPending: false }),
}));

import { ModelDetailDrawer } from '../model-detail-drawer';

const GPU1 = { ...DEVICE, id: 'gpu1', label: 'GPU 1 — NVIDIA RTX 2000 Ada Generation' };

function granite(overrides: Partial<ResidencyCatalogueModel> = {}) {
  const base = makeLoaded();
  return makeLoaded({
    name: 'Granite Guardian',
    modelRef: 'granite-guardian',
    actions: ['unload', 'edit_policy'],
    residency: {
      ...base.residency!,
      device: 'gpu1',
      bytes: 4 * GIB,
      loadConfig: { contextLength: 16384, parallel: 10, flashAttention: true, kvCacheQuantK: 'q8_0', kvCacheQuantV: 'q8_0', device: 'gpu1' },
    },
    ...overrides,
  });
}

function renderDrawer(model: ResidencyCatalogueModel, serviceId = 'lm-studio') {
  const handlers = { onLink: vi.fn(), onUnload: vi.fn(), onLoad: vi.fn(), onReload: vi.fn() };
  renderWithProviders(
    <ModelDetailDrawer
      open
      onOpenChange={vi.fn()}
      service={makeService(model, { service: serviceId, label: serviceId === 'lm-studio' ? 'LM Studio' : 'Speech-to-text' })}
      model={model}
      devices={[DEVICE, GPU1]}
      actionPending={false}
      {...handlers}
    />,
  );
  return handlers;
}

beforeEach(() => {
  saveMutate.mockReset();
  pinMutate.mockReset();
  resetMutate.mockReset();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});
afterEach(cleanup);

describe('ModelDetailDrawer — Reload with options (E10)', () => {
  it('shows Reload with options next to Unload for a loaded LM Studio model', () => {
    renderDrawer(granite());
    expect(screen.getByRole('button', { name: /^unload/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reload with options/i })).toBeTruthy();
  });

  it('starts empty = "restore the serving profile", showing the live values as context (R3-1)', () => {
    renderDrawer(granite());
    const context = screen.getByLabelText('Context length') as HTMLInputElement;
    expect(context.value).toBe('');
    expect(context.getAttribute('placeholder')).toBe('Serving profile');
    expect(screen.getByText('Currently loaded with 16384. Leave empty to restore the serving profile.')).toBeTruthy();
    const flash = screen.getByRole('radiogroup', { name: 'Flash attention' });
    expect(within(flash).getByRole('radio', { name: 'Serving profile' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Currently loaded with flash attention on.')).toBeTruthy();
    const facts = screen.getByRole('region', { name: 'Currently loaded with' });
    expect(facts.textContent).toMatch(/Parallel slots\s*10/);
    expect(facts.textContent).toMatch(/KV cache\s*q8_0 \/ q8_0/);
    expect(facts.textContent).toMatch(/Placement\s*GPU 1/);
  });

  it('a reload sends only what the admin set (the profile restores the rest)', () => {
    const { onReload } = renderDrawer(granite());
    fireEvent.click(screen.getByRole('button', { name: /reload with options/i }));
    expect(onReload.mock.calls[0]![2]).toEqual({});
    fireEvent.change(screen.getByLabelText('Context length'), { target: { value: '32768' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    fireEvent.click(screen.getByRole('button', { name: /reload with options/i }));
    expect(onReload.mock.calls[1]![2]).toEqual({ contextLength: 32768, flashAttention: false });
  });

  it('validates the context length as a positive whole number (R3-11)', () => {
    const { onReload } = renderDrawer(granite());
    for (const bad of ['0', '12.5', '-4', 'abc']) {
      fireEvent.change(screen.getByLabelText('Context length'), { target: { value: bad } });
      expect(screen.getByText('Enter a whole number of tokens greater than 0.')).toBeTruthy();
      expect(screen.getByLabelText('Context length').getAttribute('aria-invalid')).toBe('true');
      expect((screen.getByRole('button', { name: /reload with options/i }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(onReload).not.toHaveBeenCalled();
  });

  it('a split model names its placement in words', () => {
    const base = granite();
    renderDrawer(granite({ residency: { ...base.residency!, device: 'multi', loadConfig: { ...base.residency!.loadConfig!, device: 'multi' } } }));
    expect(screen.getByRole('region', { name: 'Load options' }).textContent).toMatch(/Placement\s*Split across cards/);
  });

  it('offers no Reload for a speech-to-text model', () => {
    renderDrawer(granite(), 'stt');
    expect(screen.queryByRole('button', { name: /reload with options/i })).toBeNull();
  });
});

describe('ModelDetailDrawer — Reset to default (E9)', () => {
  const explicit = (source: 'policy' | 'implicit-live-path') =>
    granite({
      keepPolicy: {
        kind: 'always',
        label: 'Always loaded',
        reason: source === 'policy' ? 'Set by an administrator' : 'Used by a live-consultation agent',
        source,
        policyId: source === 'policy' ? 'pol-1' : null,
        policyVersion: source === 'policy' ? 3 : null,
        idleTtlSeconds: null,
      },
    });

  it('asks first, then deletes the explicit policy row and says so (R3-10)', async () => {
    resetMutate.mockImplementation((_vars, opts) => opts.onSuccess());
    renderDrawer(explicit('policy'));
    fireEvent.click(screen.getByRole('button', { name: /reset to default/i }));
    expect(resetMutate).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('alertdialog', { name: /reset the keep policy/i });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(resetMutate).toHaveBeenCalledWith({ policyId: 'pol-1', policyVersion: 3 }, expect.any(Object)));
    expect(String(vi.mocked(toast.success).mock.calls[0]![0])).toMatch(/back to its default/i);
  });

  it('the confirmation has no axe violations', async () => {
    renderDrawer(explicit('policy'));
    fireEvent.click(screen.getByRole('button', { name: /reset to default/i }));
    expect((await axe(await screen.findByRole('alertdialog'))).violations).toEqual([]);
  });

  it('cancelling the confirmation resets nothing', async () => {
    renderDrawer(explicit('policy'));
    fireEvent.click(screen.getByRole('button', { name: /reset to default/i }));
    const confirm = await screen.findByRole('alertdialog', { name: /reset the keep policy/i });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(resetMutate).not.toHaveBeenCalled();
  });

  it('a successful reset discards an unsaved keep-policy draft', async () => {
    resetMutate.mockImplementation((_vars, opts) => opts.onSuccess());
    renderDrawer(explicit('policy'));
    fireEvent.click(screen.getByRole('radio', { name: /Keep warm/ }));
    expect(screen.getByRole('radio', { name: /Keep warm/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /reset to default/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Always loaded/ }).getAttribute('aria-checked')).toBe('true'));
  });

  it('is hidden when there is no explicit row', () => {
    renderDrawer(explicit('implicit-live-path'));
    expect(screen.queryByRole('button', { name: /reset to default/i })).toBeNull();
  });

  it('a failed reset toasts the server message', async () => {
    resetMutate.mockImplementation((_vars, opts) => opts.onError(new GatewayError(404, 'No such policy')));
    renderDrawer(explicit('policy'));
    fireEvent.click(screen.getByRole('button', { name: /reset to default/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(vi.mocked(toast.error).mock.calls[0]![0])).toMatch(/^Couldn.t reset .*: No such policy$/);
  });
});

describe('ModelDetailDrawer — errors in the server’s words (AC-6)', () => {
  it('a failed pin toasts the model and the server message, the code in the description', () => {
    pinMutate.mockImplementation((_vars, opts) =>
      opts.onError({ details: { code: 'SERVICE_UNREACHABLE', message: 'lm-studio agent did not answer' } }),
    );
    renderDrawer(granite());
    fireEvent.click(screen.getByRole('button', { name: /pin on running service/i }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't pin Granite Guardian: lm-studio agent did not answer", {
      description: 'Error code: SERVICE_UNREACHABLE',
    });
  });

  it('has no axe violations', async () => {
    renderDrawer(granite());
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
});
