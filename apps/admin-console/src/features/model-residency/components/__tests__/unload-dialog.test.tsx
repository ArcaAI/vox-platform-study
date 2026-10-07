import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import { makeLoaded, makeService } from './fixtures';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const unloadAsync = vi.fn();
vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api/types')>('../../api/types');
  return {
    asModelResidencyConflict: actual.asModelResidencyConflict,
    useUnloadResidencyModel: () => ({ mutateAsync: unloadAsync, isPending: false }),
  };
});

import { UnloadDialog } from '../unload-dialog';

function renderDialog(model = makeLoaded(), onUnloaded = vi.fn(), onOpenChange = vi.fn()) {
  render(<UnloadDialog open onOpenChange={onOpenChange} service={makeService(model)} model={model} onUnloaded={onUnloaded} />);
  return { onUnloaded, onOpenChange };
}

beforeEach(() => {
  unloadAsync.mockReset().mockResolvedValue({ outcome: 'unloaded' });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(cleanup);

describe('UnloadDialog', () => {
  it('idle: optional reason, unloads without force', async () => {
    const { onUnloaded } = renderDialog();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'tidy' } });
    fireEvent.click(screen.getByRole('button', { name: /^unload/i }));
    await waitFor(() => expect(onUnloaded).toHaveBeenCalled());
    expect(unloadAsync).toHaveBeenCalledWith({ service: 'stt', modelRef: 'whisper-large-gguf', reason: 'tidy' });
    expect(toast.success).toHaveBeenCalled();
  });

  it('idle with no reason sends none', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /^unload/i }));
    await waitFor(() => expect(unloadAsync).toHaveBeenCalled());
    expect(unloadAsync).toHaveBeenCalledWith({ service: 'stt', modelRef: 'whisper-large-gguf' });
  });

  it('in-flight requests force a mandatory reason', async () => {
    const base = makeLoaded();
    const model = makeLoaded({ residency: { ...base.residency!, inFlight: 2 } });
    renderDialog(model);
    const button = screen.getByRole('button', { name: /unload anyway|force unload/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'stuck' } });
    fireEvent.click(button);
    await waitFor(() => expect(unloadAsync).toHaveBeenCalled());
    expect(unloadAsync).toHaveBeenCalledWith({ service: 'stt', modelRef: 'whisper-large-gguf', force: true, reason: 'stuck' });
  });

  it('switches to force mode when the server answers 409 IN_FLIGHT', async () => {
    unloadAsync.mockRejectedValueOnce({ details: { code: 'IN_FLIGHT', message: 'serving 2 requests', inFlight: 2 } });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /^unload/i }));
    const force = await screen.findByRole('button', { name: /unload anyway|force unload/i });
    expect((force as HTMLButtonElement).disabled).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a pinned row shows the reason and no destructive button', () => {
    const model = makeLoaded({
      keepPolicy: {
        kind: 'always',
        label: 'Always loaded',
        reason: 'Pinned by a live path',
        source: 'implicit-live-path',
        policyId: null,
        policyVersion: null,
        idleTtlSeconds: null,
      },
    });
    renderDialog(model);
    expect(screen.getByText(/Pinned by a live path/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /unload/i })).toBeNull();
  });

  it('has no axe violations', async () => {
    renderDialog();
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
});
