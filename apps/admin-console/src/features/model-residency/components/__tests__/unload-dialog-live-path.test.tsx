/**
 * TASK-1055 lane C (E9 / OD-2) — unloading a live-path ("Always loaded")
 * model is allowed: the confirmation names who uses it and requires a reason
 * (audited); a model held as separate copies on several GPUs can be unloaded
 * one device at a time.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import { GIB, makeLoaded, makeService } from './fixtures';

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

const LIVE = makeLoaded({
  name: 'Medical NER',
  modelRef: 'medical-ner',
  usage: {
    agentCount: 10,
    tenantCount: 10,
    liveConsultation: true,
    uses: [],
    consumers: { agents: 10, fallbacks: 0, routingPolicies: 1, pipelineStages: 0, workflowNodes: 0 },
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

function renderDialog(model = LIVE) {
  const onUnloaded = vi.fn();
  render(
    <UnloadDialog
      open
      onOpenChange={vi.fn()}
      service={makeService(model, { service: 'nlp', label: 'Medical NLP' })}
      model={model}
      onUnloaded={onUnloaded}
    />,
  );
  return { onUnloaded };
}

beforeEach(() => {
  unloadAsync.mockReset().mockResolvedValue({ outcome: 'unloaded' });
  vi.mocked(toast.error).mockClear();
});
afterEach(cleanup);

describe('UnloadDialog — live-path models', () => {
  it('names the consumers and why it is pinned', () => {
    renderDialog();
    const list = screen.getByRole('list', { name: /who loses it/i });
    expect(within(list).getByText('10 agents · 10 tenants')).toBeTruthy();
    expect(within(list).getByText('Routing policy')).toBeTruthy();
    expect(within(list).getByText('Live consultations')).toBeTruthy();
    expect(screen.getByText(/Used by a live-consultation agent/)).toBeTruthy();
  });

  it('requires a reason, then unloads without force and without touching the keep policy', async () => {
    const { onUnloaded } = renderDialog();
    const button = screen.getByRole('button', { name: /^unload/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: '  make room on GPU 0  ' } });
    fireEvent.click(button);
    await waitFor(() => expect(onUnloaded).toHaveBeenCalled());
    expect(unloadAsync).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'medical-ner', reason: 'make room on GPU 0' });
  });

  it('a 409 LIVE_PATH_REASON_REQUIRED turns an optional reason into a required one and shows the server’s consumers', async () => {
    unloadAsync.mockRejectedValueOnce({
      details: {
        code: 'LIVE_PATH_REASON_REQUIRED',
        message: 'Medical NER is on the live consultation path',
        consumers: ['10 agents · 10 tenants (live consultations)'],
      },
    });
    const plain = makeLoaded({ name: 'Medical NER', modelRef: 'medical-ner' });
    renderDialog(plain);
    expect(screen.getByLabelText(/reason/i).getAttribute('aria-required')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: /^unload/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/live consultation path/);
    expect(screen.getByText('10 agents · 10 tenants (live consultations)')).toBeTruthy();
    expect(screen.getByLabelText(/reason/i).getAttribute('aria-required')).toBe('true');
    expect((screen.getByRole('button', { name: /^unload/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('other failures toast the model and the server message, the code only in the description (R3-3)', async () => {
    unloadAsync.mockRejectedValueOnce({ details: { code: 'SERVICE_UNREACHABLE', message: 'nlp agent did not answer' } });
    renderDialog(makeLoaded());
    fireEvent.click(screen.getByRole('button', { name: /^unload/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't unload Whisper Large: nlp agent did not answer", {
        description: 'Error code: SERVICE_UNREACHABLE',
      }),
    );
  });

  it('a code-only failure never shows a bare code as the title', async () => {
    unloadAsync.mockRejectedValueOnce({ details: { code: 'SERVICE_UNREACHABLE', message: '' } });
    renderDialog(makeLoaded());
    fireEvent.click(screen.getByRole('button', { name: /^unload/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't unload Whisper Large.", { description: 'Error code: SERVICE_UNREACHABLE' }),
    );
  });

  it('says plainly it is NOT reloaded automatically and how to bring it back with its profile (R3-9 / R2-F4)', () => {
    renderDialog();
    const body = screen.getByRole('dialog').textContent ?? '';
    expect(body).toMatch(/will not be reloaded automatically unless the residency controller is in enforce mode/);
    expect(body).toMatch(/may load it on demand with default settings, not its serving profile/);
    expect(body).toMatch(/Use Load to restore it with its serving profile/);
  });

  it('the same is said for an ordinary model', () => {
    renderDialog(makeLoaded());
    expect(screen.getByRole('dialog').textContent).toMatch(/will not be reloaded automatically unless the residency controller is in enforce mode/);
  });

  it('a server IN_FLIGHT after a reason was typed does not ask for one again (R3-11)', async () => {
    unloadAsync.mockRejectedValueOnce({ details: { code: 'IN_FLIGHT', message: 'busy', inFlight: 2 } });
    renderDialog(makeLoaded());
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'free GPU 0' } });
    fireEvent.click(screen.getByRole('button', { name: /^unload/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/2 requests still in flight/);
    expect(alert.textContent).not.toMatch(/Enter a reason/);
    expect(alert.textContent).toMatch(/Unload anyway interrupts them; your reason is recorded/);
    expect((screen.getByRole('button', { name: /unload anyway/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('separate copies on two GPUs: unloads one device, or all by default', async () => {
    const base = makeLoaded();
    const twoCopies = makeLoaded({
      residency: {
        ...base.residency!,
        deviceBytes: [
          { device: 'gpu0', bytes: GIB },
          { device: 'gpu1', bytes: GIB },
        ],
      },
    });
    renderDialog(twoCopies);
    const group = screen.getByRole('radiogroup', { name: /which copy/i });
    expect((within(group).getByRole('radio', { name: /all copies/i }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(group).getByRole('radio', { name: /only GPU 1/i }));
    fireEvent.click(screen.getByRole('button', { name: /^unload/i }));
    await waitFor(() => expect(unloadAsync).toHaveBeenCalled());
    expect(unloadAsync).toHaveBeenCalledWith({ service: 'nlp', modelRef: 'whisper-large-gguf', device: 'gpu1' });
  });

  it('has no axe violations', async () => {
    renderDialog();
    expect((await axe(screen.getByRole('dialog'))).violations).toEqual([]);
  });
});
