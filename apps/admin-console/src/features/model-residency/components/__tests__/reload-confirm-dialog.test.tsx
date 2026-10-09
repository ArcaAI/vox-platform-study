/**
 * "Reload with options" confirmation (TASK-1051, TASK-1055 lane FC): says what
 * comes back (the serving profile, plus only the options changed — R3-1);
 * a live-path / pinned model needs a reason and lists who uses it, like an
 * unload; in-flight requests force; a 409 LIVE_PATH_REASON_REQUIRED or
 * IN_FLIGHT from the reload itself turns the reason mandatory; other failures
 * toast the model and the server's words (R3-3).
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import type { LmStudioResidencyLoadOptions } from '@/shared/residency';
import type { ResidencyCatalogueModel } from '../../api/types';
import { makeLoaded, makeService } from './fixtures';
import { ReloadConfirmDialog } from '../reload-confirm-dialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const LIVE = makeLoaded({
  name: 'Gemma',
  usage: {
    agentCount: 10,
    tenantCount: 10,
    liveConsultation: true,
    uses: [],
    consumers: { agents: 10, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
  },
  keepPolicy: {
    kind: 'always',
    label: 'Always loaded',
    reason: 'Used by a live-consultation agent',
    source: 'implicit-live-path',
    policyId: null,
    policyVersion: null,
    idleTtlSeconds: null,
  },
});

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
});
afterEach(cleanup);

function renderDialog(
  model: ResidencyCatalogueModel = makeLoaded(),
  options: LmStudioResidencyLoadOptions = { contextLength: 4096 },
  onConfirm = vi.fn().mockResolvedValue(undefined),
) {
  const view = render(
    <ReloadConfirmDialog
      open
      onOpenChange={vi.fn()}
      service={makeService(model, { service: 'lm-studio', label: 'LM Studio' })}
      model={model}
      options={options}
      isPending={false}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, ...view };
}

const reloadButton = () => screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement;

describe('ReloadConfirmDialog', () => {
  it('idle model: confirms without a reason and says what changes and what is restored', async () => {
    const { onConfirm } = renderDialog();
    expect(
      screen.getByText(/unloaded and loaded again with context length 4096; everything else is restored from its serving profile/i),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/reason/i)).toBeNull();
    fireEvent.click(reloadButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ reason: null, force: false }));
  });

  it('nothing changed: says it is restored to its serving profile (R3-1)', () => {
    renderDialog(makeLoaded(), {});
    expect(screen.getByText(/unloaded and loaded again, restored to its serving profile/i)).toBeTruthy();
  });

  it('in-flight requests require a reason and force', async () => {
    const base = makeLoaded();
    const { onConfirm } = renderDialog(makeLoaded({ residency: { ...base.residency!, inFlight: 3 } }));
    expect(screen.getByRole('alert').textContent).toMatch(/3 requests/);
    expect(reloadButton().disabled).toBe(true);
    expect(screen.getByLabelText(/reason/i).getAttribute('aria-required')).toBe('true');
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: ' roll profile ' } });
    fireEvent.click(reloadButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ reason: 'roll profile', force: true }));
  });

  it('a live-path model lists who uses it and needs a reason, without force (mirrors unload)', async () => {
    const { onConfirm } = renderDialog(LIVE);
    const list = screen.getByRole('list', { name: /who is interrupted/i });
    expect(within(list).getByText('10 agents · 10 tenants')).toBeTruthy();
    expect(within(list).getByText('Live consultations')).toBeTruthy();
    expect(reloadButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'restore ctx' } });
    fireEvent.click(reloadButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ reason: 'restore ctx', force: false }));
  });

  it('a 409 LIVE_PATH_REASON_REQUIRED from the reload makes the reason mandatory and shows the server’s consumers', async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce({
      details: { code: 'LIVE_PATH_REASON_REQUIRED', message: 'Whisper Large is on the live path', consumers: ['3 agents (live consultations)'] },
    });
    renderDialog(makeLoaded(), { contextLength: 4096 }, onConfirm);
    fireEvent.click(reloadButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/on the live path/);
    expect(screen.getByText('3 agents (live consultations)')).toBeTruthy();
    expect(screen.getByLabelText(/reason/i).getAttribute('aria-required')).toBe('true');
    expect(reloadButton().disabled).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a 409 IN_FLIGHT from the reload switches to a forced reload with a reason', async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce({ details: { code: 'IN_FLIGHT', message: 'busy', inFlight: 2 } })
      .mockResolvedValue(undefined);
    renderDialog(makeLoaded(), { contextLength: 4096 }, onConfirm);
    fireEvent.click(reloadButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(/2 requests/);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'now' } });
    fireEvent.click(reloadButton());
    await waitFor(() => expect(onConfirm).toHaveBeenLastCalledWith({ reason: 'now', force: true }));
  });

  it('other failures toast the model and the server’s words, the code in the description', async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce({ details: { code: 'SERVICE_UNREACHABLE', message: 'lm-studio agent did not answer' } });
    renderDialog(makeLoaded(), { contextLength: 4096 }, onConfirm);
    fireEvent.click(reloadButton());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't reload Whisper Large: lm-studio agent did not answer", {
        description: 'Error code: SERVICE_UNREACHABLE',
      }),
    );
  });

  it('has no axe violations (live path)', async () => {
    renderDialog(LIVE);
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
});
