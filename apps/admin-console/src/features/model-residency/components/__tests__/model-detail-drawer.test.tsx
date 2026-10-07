import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import { GatewayError } from '@/shared/api';
import { renderWithProviders } from '@/test/render';
import { DEVICE, makeLoaded, makeModel, makeService } from './fixtures';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const saveMutate = vi.fn();
const pinMutate = vi.fn();
vi.mock('../../api/hooks', () => ({
  useSaveResidencyPolicy: () => ({ mutate: saveMutate, isPending: false }),
  usePinResidencyModel: () => ({ mutate: pinMutate, isPending: false }),
}));

import { ModelDetailDrawer } from '../model-detail-drawer';

function renderDrawer(model = makeLoaded(), serviceOverrides = {}, handlers: Partial<Record<'onLink' | 'onUnload' | 'onLoad', () => void>> = {}) {
  const props = { onLink: vi.fn(), onUnload: vi.fn(), onLoad: vi.fn(), ...handlers };
  const view = renderWithProviders(
    <ModelDetailDrawer
      open
      onOpenChange={vi.fn()}
      service={makeService(model, serviceOverrides)}
      model={model}
      devices={[DEVICE]}
      actionPending={false}
      onReload={vi.fn()}
      {...props}
    />,
  );
  return { ...view, ...props };
}

beforeEach(() => {
  saveMutate.mockReset();
  pinMutate.mockReset();
  vi.mocked(toast.error).mockClear();
});
afterEach(cleanup);

describe('ModelDetailDrawer', () => {
  it('shows consumer tiles, budget and the new role labels', () => {
    const model = makeLoaded({
      usage: {
        agentCount: 1,
        tenantCount: 1,
        liveConsultation: false,
        consumers: { agents: 1, fallbacks: 0, routingPolicies: 0, pipelineStages: 3, workflowNodes: 4 },
        uses: [
          {
            tenantId: 't',
            tenantName: 'ArcaAI',
            agentSlug: null,
            agentName: null,
            task: 'SPEECH_TO_TEXT',
            role: 'pipeline_stage',
            liveConsultation: false,
          },
          { tenantId: 't', tenantName: 'ArcaAI', agentSlug: null, agentName: null, task: 'summary', role: 'workflow_node', liveConsultation: false },
        ],
      },
    });
    renderDrawer(model);
    expect(screen.getByText('Pipeline stage')).toBeTruthy();
    expect(screen.getByText('Workflow node')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Who uses it' })).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText(/Load budget/i)).toBeTruthy();
  });

  it('unmatched identity shows a block that calls onLink', () => {
    const model = makeLoaded({
      identity: { matched: false, runtimeKeys: [], reportedKey: 'gemma@q4_0', candidates: [] },
    });
    const { onLink } = renderDrawer(model);
    expect(screen.getByText(/runtime identity/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /review and link/i }));
    expect(onLink).toHaveBeenCalled();
  });

  it('matched identity shows no link block', () => {
    renderDrawer(makeLoaded());
    expect(screen.queryByText(/runtime identity/i)).toBeNull();
  });

  it('pins the running model', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /pin on running service/i }));
    expect(pinMutate).toHaveBeenCalledWith({ service: 'stt', modelRef: 'whisper-large-gguf', pinned: true }, expect.any(Object));
  });

  it('a 412 on policy save says it changed and offers reload', async () => {
    saveMutate.mockImplementation((_vars, opts) => opts.onError(new GatewayError(412, 'drift')));
    const { queryClient } = renderDrawer();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: /save keep policy/i }));
    const call = vi.mocked(toast.error).mock.calls[0]!;
    expect(String(call[0])).toMatch(/changed since you opened it/i);
    const action = (call[1] as { action: { label: string; onClick: () => void } }).action;
    expect(action.label).toBe('Reload');
    action.onClick();
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });

  it('other save errors keep the generic toast', () => {
    saveMutate.mockImplementation((_vars, opts) => opts.onError(new GatewayError(500, 'x')));
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /save keep policy/i }));
    expect(String(vi.mocked(toast.error).mock.calls[0]![0])).toMatch(/couldn.t save/i);
  });

  it('pinned row: Unload disabled with a visible reason', () => {
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
    renderDrawer(model);
    const unload = screen.getByRole('button', { name: /^unload/i }) as HTMLButtonElement;
    expect(unload.disabled).toBe(true);
    expect(screen.getAllByText(/pinned by a live path/i).length).toBeGreaterThan(0);
  });

  it('re-seeds an unedited keep-policy draft when the server policy changes, but keeps an edited one', () => {
    const base = makeLoaded();
    const withTtl = (minutes: number, version: number) =>
      makeLoaded({ keepPolicy: { ...base.keepPolicy, policyVersion: version, idleTtlSeconds: minutes * 60 } });
    const view = (model: ReturnType<typeof makeLoaded>) => (
      <ModelDetailDrawer
        open
        onOpenChange={vi.fn()}
        service={makeService(model)}
        model={model}
        devices={[DEVICE]}
        actionPending={false}
        onReload={vi.fn()}
        onLink={vi.fn()}
        onUnload={vi.fn()}
        onLoad={vi.fn()}
      />
    );
    const { rerender } = renderDrawer(withTtl(10, 1));
    expect((screen.getByLabelText('Idle minutes') as HTMLInputElement).value).toBe('10');
    rerender(view(withTtl(20, 2)));
    expect((screen.getByLabelText('Idle minutes') as HTMLInputElement).value).toBe('20');
    fireEvent.change(screen.getByLabelText('Idle minutes'), { target: { value: '45' } });
    rerender(view(withTtl(30, 3)));
    expect((screen.getByLabelText('Idle minutes') as HTMLInputElement).value).toBe('45');
  });

  it('the 412 Reload action resets the draft to the server values', () => {
    saveMutate.mockImplementation((_vars, opts) => opts.onError(new GatewayError(412, 'drift')));
    renderDrawer();
    fireEvent.change(screen.getByLabelText('Idle minutes'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /save keep policy/i }));
    const action = (vi.mocked(toast.error).mock.calls[0]![1] as unknown as { action: { onClick: () => void } }).action;
    act(() => action.onClick());
    expect((screen.getByLabelText('Idle minutes') as HTMLInputElement).value).toBe('');
  });

  it('validates idle minutes inline and does not save an invalid value', () => {
    renderDrawer();
    fireEvent.change(screen.getByLabelText('Idle minutes'), { target: { value: '1.5' } });
    expect(screen.getByText(/whole minutes/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /save keep policy/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces the server message on a 400 save', () => {
    saveMutate.mockImplementation((_vars, opts) => opts.onError(new GatewayError(400, 'idle TTL out of range')));
    renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /save keep policy/i }));
    expect(String(vi.mocked(toast.error).mock.calls[0]![0])).toMatch(/idle TTL out of range/);
  });

  it('labels the keep-policy radio group and disables On demand while a live path uses the model', () => {
    const model = makeLoaded({ usage: { ...makeLoaded().usage, liveConsultation: true } });
    renderDrawer(model);
    expect(screen.getByRole('radiogroup', { name: 'Keep policy' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: /Load when needed/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/live-consultation path uses this model/i)).toBeTruthy();
  });

  it('Reload sends flashAttention only when the user touched it', () => {
    const model = makeLoaded({ actions: ['reload', 'edit_policy'] });
    const onReload = vi.fn();
    const props = { onLink: vi.fn(), onUnload: vi.fn(), onLoad: vi.fn() };
    renderWithProviders(
      <ModelDetailDrawer
        open
        onOpenChange={vi.fn()}
        service={makeService(model, { service: 'lm-studio' })}
        model={model}
        devices={[DEVICE]}
        actionPending={false}
        onReload={onReload}
        {...props}
      />,
    );
    fireEvent.change(screen.getByLabelText('Context length'), { target: { value: '4096' } });
    fireEvent.click(screen.getByRole('button', { name: /reload with options/i }));
    expect(onReload.mock.calls[0]![2]).toEqual({ contextLength: 4096 });
    fireEvent.click(screen.getByRole('checkbox', { name: /flash attention/i }));
    fireEvent.click(screen.getByRole('button', { name: /reload with options/i }));
    expect(onReload.mock.calls[1]![2]).toEqual({ contextLength: 4096, flashAttention: true });
  });

  it('remote rows offer no load/unload/pin and say not applicable', () => {
    const model = makeModel({ kind: 'remote', actions: [] });
    renderDrawer(model);
    expect(screen.getByText(/not applicable/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /pin on running service/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(load|unload)/i })).toBeNull();
  });

  it('has no axe violations', async () => {
    renderDrawer();
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
});
