/**
 * TASK-1057 — the platform policy decides whether the residency reason is demanded:
 * a live-path reload is submittable without one when the row is switched off, and an
 * idle unload needs one when the row is switched to required.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { makeLoaded, makeService } from './fixtures';
import { ReloadConfirmDialog } from '../reload-confirm-dialog';
import { UnloadDialog } from '../unload-dialog';

const policy = vi.hoisted(() => ({ mode: 'when-risky' as string, actionId: '' }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/api', async () => ({
  ...(await vi.importActual<object>('@/shared/api')),
  getJson: vi.fn(async () => ({
    items: [{ actionId: policy.actionId, kind: 'reason', mode: policy.mode, locked: false, maxLength: 500 }],
  })),
}));
const unloadAsync = vi.fn().mockResolvedValue({ outcome: 'unloaded' });
vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api/types')>('../../api/types');
  return {
    asModelResidencyConflict: actual.asModelResidencyConflict,
    residencyErrorMessage: actual.residencyErrorMessage,
    useUnloadResidencyModel: () => ({ mutateAsync: unloadAsync, isPending: false }),
  };
});

afterEach(() => {
  cleanup();
  unloadAsync.mockClear();
});

const LIVE = makeLoaded({
  name: 'Gemma',
  keepPolicy: { kind: 'always', label: 'Always loaded', reason: 'live', source: 'implicit-live-path', policyId: null, policyVersion: null, idleTtlSeconds: null },
  usage: { agentCount: 1, tenantCount: 1, liveConsultation: true, uses: [], consumers: { agents: 1, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 } },
});

describe('residency reasons follow the platform policy', () => {
  it('reload: a live-path model reloads without a reason once the row is not-required', async () => {
    policy.actionId = 'modelResidency.reload';
    policy.mode = 'not-required';
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ReloadConfirmDialog open onOpenChange={vi.fn()} service={makeService(LIVE, { service: 'lm-studio', label: 'LM Studio' })} model={LIVE} options={{}} isPending={false} onConfirm={onConfirm} />,
    );
    await screen.findByText('(optional)');
    const reload = screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement;
    expect(reload.disabled).toBe(false);
    fireEvent.click(reload);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ reason: null, force: false }));
  });

  it('unload: an idle model needs a reason once the row is required, and sends it', async () => {
    policy.actionId = 'modelResidency.unload';
    policy.mode = 'required';
    const model = makeLoaded();
    renderWithProviders(<UnloadDialog open onOpenChange={vi.fn()} service={makeService(model)} model={model} />);
    const unload = screen.getByRole('button', { name: /^unload/i }) as HTMLButtonElement;
    await waitFor(() => expect(unload.disabled).toBe(true));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'free the card' } });
    expect(unload.disabled).toBe(false);
    fireEvent.click(unload);
    await waitFor(() => expect(unloadAsync).toHaveBeenCalledWith(expect.objectContaining({ reason: 'free the card' })));
  });
});
