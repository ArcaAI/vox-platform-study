/**
 * TASK-1005 §8.1/§8.3 L-UI — Model residency screen. Built against
 * `tests/contracts/model-residency-admin.fixture.json`, which the controller
 * lane (L-CTRL) implements the gateway routes against, so the shapes here
 * track that fixture rather than the other way around.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import { renderWithProviders } from '@/test/render';
import type { ModelResidencyResponse } from '../../api/types';
import { ModelResidencyScreen } from '../model-residency-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

const RESIDENCY: ModelResidencyResponse = {
  mode: 'shadow',
  reportedAt: '2026-09-24T13:00:05Z',
  freshness: { maxAgeSeconds: 15, staleServices: [] },
  devices: [
    {
      id: 'gpu0',
      kind: 'gpu',
      name: 'NVIDIA RTX 2000 Ada Generation',
      totalBytes: 17_175_674_880,
      usedBytes: 4_117_757_952,
      freeBytes: 13_057_916_928,
      utilisationPercent: 1.5,
      headroomPercent: 15,
    },
    {
      id: 'gpu1',
      kind: 'gpu',
      name: 'NVIDIA RTX 2000 Ada Generation',
      totalBytes: 17_175_674_880,
      usedBytes: 2_097_152,
      freeBytes: 17_173_577_728,
      utilisationPercent: 0.3,
      headroomPercent: 15,
    },
  ],
  models: [
    {
      service: 'stt',
      instance: 'hope-stt-5d9f7c8b6-abcde',
      modelRef: 'arcaai-whisper-ml-en-ggml',
      aiModelId: '0199a1b2-0000-7000-8000-000000000001',
      aiModelName: 'ArcaAI Whisper ml-en (GGML)',
      device: 'gpu0',
      state: 'loaded',
      bytes: 1_623_195_648,
      bytesSource: 'measured',
      inFlight: 2,
      requestsPerMin: 4.2,
      p50LatencyMs: 310,
      loadedAt: '2026-09-24T12:40:00Z',
      lastUsedAt: '2026-09-24T12:59:58Z',
      loadSeconds: 6.8,
      class: 'PINNED',
      classSource: 'implicit-live-path',
      ttlSeconds: null,
      pinned: true,
      adminPinned: false,
      policyId: null,
      policyVersion: null,
    },
    {
      service: 'nlp',
      instance: 'hope-nlp-abc123',
      modelRef: 'gliner-medical-large',
      aiModelId: '0199a1b2-0000-7000-8000-000000000002',
      aiModelName: 'GLiNER medical (large)',
      device: 'gpu1',
      state: 'loaded',
      bytes: 900_000_000,
      bytesSource: 'measured',
      inFlight: 0,
      requestsPerMin: 0.4,
      p50LatencyMs: 120,
      loadedAt: '2026-09-24T11:00:00Z',
      lastUsedAt: '2026-09-24T12:30:00Z',
      loadSeconds: 2.1,
      class: 'ON_DEMAND',
      classSource: 'policy',
      ttlSeconds: 600,
      pinned: false,
      adminPinned: false,
      policyId: 'policy-1',
      policyVersion: 3,
    },
  ],
  recommendations: [
    {
      id: 'rec-1',
      at: '2026-09-24T12:58:00Z',
      action: 'unload',
      service: 'nlp',
      modelRef: 'gliner-medical-large',
      reason: 'idle_ttl_expired',
      mode: 'shadow',
      applied: false,
    },
  ],
};

const LIST_URL = '/api/hope/admin/model-residency';

function installFetchStub(handle: (call: RecordedCall) => Response | unknown): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      if (call.url.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ success: true });
      const result = handle(call);
      if (result === undefined) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return result instanceof Response ? result : Response.json(result);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** Every modelRef renders TWICE (the device-memory legend + the table row), so
 * "has it rendered" waits for at least one occurrence rather than a unique one. */
async function waitForModelRef(text: string): Promise<void> {
  await waitFor(() => expect(screen.getAllByText(text).length).toBeGreaterThan(0));
}

/** Scopes a query to the resident-models table, where every row action lives. */
function grid(): HTMLElement {
  return screen.getByRole('grid', { name: 'Resident models' });
}

describe('ModelResidencyScreen — the resident-model table', () => {
  it('renders every resident model from the fixture GET', async () => {
    installFetchStub((call) => (call.url === LIST_URL ? RESIDENCY : undefined));
    renderWithProviders(<ModelResidencyScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Model residency' })).toBeDefined();
    await waitForModelRef('arcaai-whisper-ml-en-ggml');
    await waitForModelRef('gliner-medical-large');
    expect(within(grid()).getByText('arcaai-whisper-ml-en-ggml')).toBeDefined();
    expect(within(grid()).getByText('gliner-medical-large')).toBeDefined();
    // Freshness and device stats render from the same read.
    expect(screen.getByText(/Every service reported within 15s/)).toBeDefined();
  });
});

describe('ModelResidencyScreen — unload is gated on in-flight work (OD-3 pattern)', () => {
  it('disables Unload with a visible reason while the model is serving requests, offering Force unload instead', async () => {
    installFetchStub((call) => (call.url === LIST_URL ? RESIDENCY : undefined));
    renderWithProviders(<ModelResidencyScreen />);
    await waitForModelRef('arcaai-whisper-ml-en-ggml');

    fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for stt/arcaai-whisper-ml-en-ggml' }), { key: 'Enter' });
    const unloadItem = await screen.findByRole('menuitem', { name: /Unload.*disabled.*2 in flight/i });
    expect(unloadItem.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: 'Force unload…' })).toBeDefined();
  });

  it('offers a plain, enabled Unload for an idle model', async () => {
    installFetchStub((call) => (call.url === LIST_URL ? RESIDENCY : undefined));
    renderWithProviders(<ModelResidencyScreen />);
    await waitForModelRef('gliner-medical-large');

    fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for nlp/gliner-medical-large' }), { key: 'Enter' });
    const unloadItem = await screen.findByRole('menuitem', { name: 'Unload' });
    expect(unloadItem.getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.queryByRole('menuitem', { name: 'Force unload…' })).toBeNull();
  });

  it('requires a typed reason before a forced unload can be confirmed, then sends it', async () => {
    const calls = installFetchStub((call) => {
      if (call.url === LIST_URL) return RESIDENCY;
      if (call.url === `${LIST_URL}/unload`) return { outcome: 'unloaded', service: 'stt', modelRef: 'arcaai-whisper-ml-en-ggml' };
      return undefined;
    });
    renderWithProviders(<ModelResidencyScreen />);
    await waitForModelRef('arcaai-whisper-ml-en-ggml');

    fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for stt/arcaai-whisper-ml-en-ggml' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Force unload…' }));
    const confirm = await screen.findByRole('alertdialog');
    const forceButton = within(confirm).getByRole('button', { name: 'Force unload' });
    expect(forceButton).toHaveProperty('disabled', true);

    fireEvent.change(within(confirm).getByLabelText(/Reason/i), { target: { value: 'Card is about to OOM its neighbour' } });
    expect(forceButton).toHaveProperty('disabled', false);
    fireEvent.click(forceButton);

    await waitFor(() => expect(calls.some((call) => call.url === `${LIST_URL}/unload` && call.method === 'POST')).toBe(true));
    const unload = calls.find((call) => call.url === `${LIST_URL}/unload`);
    expect(unload?.body).toMatchObject({
      service: 'stt',
      modelRef: 'arcaai-whisper-ml-en-ggml',
      force: true,
      reason: 'Card is about to OOM its neighbour',
    });
  });
});

describe('ModelResidencyScreen — force-load over budget requires a reason (OD-3)', () => {
  it('refuses to arm Force load until a reason is typed, then resends with force + reason', async () => {
    let attempt = 0;
    const calls = installFetchStub((call) => {
      if (call.url === LIST_URL) return RESIDENCY;
      if (call.url === `${LIST_URL}/load`) {
        attempt += 1;
        if (attempt === 1) return Response.json({ code: 'OVER_BUDGET', message: 'over budget' }, { status: 409 });
        return Response.json(
          {
            outcome: 'accepted',
            operationId: 'op-force-1',
            model: {
              ...RESIDENCY.models[0],
              modelRef: 'gemma-4-e4b-it-qat@q4_0',
              service: 'lm-studio',
              instance: 'lm-studio:1',
              state: 'loading',
              bytes: null,
              bytesSource: 'unknown',
            },
          },
          { status: 202 },
        );
      }
      return undefined;
    });
    renderWithProviders(<ModelResidencyScreen />);
    await waitForModelRef('arcaai-whisper-ml-en-ggml');

    fireEvent.click(screen.getByRole('button', { name: 'Load model' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'gemma-4-e4b-it-qat@q4_0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load' }));

    const forceButton = await within(dialog).findByRole('button', { name: /Force load/i });
    expect(forceButton).toHaveProperty('disabled', true);

    fireEvent.change(within(dialog).getByLabelText(/Reason to force/i), { target: { value: 'Platform admin accepts the OOM risk' } });
    expect(forceButton).toHaveProperty('disabled', false);
    fireEvent.click(forceButton);

    await waitFor(() => expect(calls.filter((call) => call.url === `${LIST_URL}/load`)).toHaveLength(2));
    const forced = calls.filter((call) => call.url === `${LIST_URL}/load`)[1];
    expect(forced?.body).toMatchObject({ force: true, reason: 'Platform admin accepts the OOM risk' });
  });
});

describe('ModelResidencyScreen — async load polls the operation to terminal', () => {
  it('shows the new row as loading immediately, then updates it once the operation succeeds', async () => {
    vi.useFakeTimers();
    let getCalls = 0;
    let operationPolls = 0;
    const loadedRow = {
      service: 'stt',
      instance: 'hope-stt-new-xyz',
      modelRef: 'new-model-x',
      aiModelId: '0199a1b2-0000-7000-8000-000000000009',
      aiModelName: 'New model X',
      device: 'gpu0',
      state: 'loaded' as const,
      bytes: 500_000_000,
      bytesSource: 'measured' as const,
      inFlight: 0,
      requestsPerMin: null,
      p50LatencyMs: null,
      loadedAt: '2026-09-24T13:05:00Z',
      lastUsedAt: null,
      loadSeconds: 3.1,
      class: 'ON_DEMAND' as const,
      classSource: 'default' as const,
      ttlSeconds: 300,
      pinned: false,
      adminPinned: false,
      policyId: null,
      policyVersion: null,
    };
    installFetchStub((call) => {
      if (call.url === LIST_URL) {
        getCalls += 1;
        return getCalls === 1 ? RESIDENCY : { ...RESIDENCY, models: [...RESIDENCY.models, loadedRow] };
      }
      if (call.url === `${LIST_URL}/load`) {
        return Response.json(
          { outcome: 'accepted', operationId: 'op-1', model: { ...loadedRow, state: 'loading', bytes: null, bytesSource: 'unknown' } },
          { status: 202 },
        );
      }
      if (call.url === `${LIST_URL}/operations/op-1`) {
        operationPolls += 1;
        const status = operationPolls === 1 ? 'running' : 'succeeded';
        return {
          id: 'op-1',
          action: 'load',
          service: 'stt',
          modelRef: 'new-model-x',
          status,
          error: null,
          startedAt: '2026-09-24T13:05:00Z',
          finishedAt: status === 'succeeded' ? '2026-09-24T13:05:03Z' : null,
        };
      }
      return undefined;
    });
    renderWithProviders(<ModelResidencyScreen />);
    // Fake timers are active, so every wait here is an explicit
    // `advanceTimersByTimeAsync` (which flushes the microtasks each fetch
    // resolves through) rather than testing-library's `waitFor`/`findBy*`,
    // whose internal polling relies on REAL timers and would otherwise hang.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getAllByText('arcaai-whisper-ml-en-ggml').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Load model' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'new-model-x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load' }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('new-model-x')).toBeDefined();
    expect(screen.getByText('Loading…')).toBeDefined();
    expect(operationPolls).toBe(1);

    // Advance past the 2s operation-poll interval so the SECOND poll fires,
    // reports the operation succeeded, and the residency GET is invalidated.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });

    expect(operationPolls).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(getCalls).toBeGreaterThanOrEqual(2);
    expect(toast.success).toHaveBeenCalled();
  });
});

describe('ModelResidencyScreen — policy edit is optimistic-concurrency (If-Match)', () => {
  it('PATCHes the existing policy row with If-Match built from its own version', async () => {
    const calls = installFetchStub((call) => {
      if (call.url === LIST_URL) return RESIDENCY;
      if (call.url === `${LIST_URL}/policies/policy-1`)
        return {
          ...RESIDENCY.models[1],
          id: 'policy-1',
          aiModelId: RESIDENCY.models[1].aiModelId,
          service: 'nlp',
          class: 'WARM',
          idleTtlSeconds: 900,
          priority: 100,
          maxInstances: 1,
          preferredDevice: null,
          _version: 4,
          updatedAt: '2026-09-24T13:10:00Z',
          updatedBy: null,
        };
      return undefined;
    });
    renderWithProviders(<ModelResidencyScreen />);
    await waitForModelRef('gliner-medical-large');

    fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for nlp/gliner-medical-large' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit policy…' }));
    const drawer = await screen.findByRole('dialog', { name: /Residency policy/i });

    fireEvent.change(within(drawer).getByLabelText('Class'), { target: { value: 'WARM' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save policy' }));

    await waitFor(() => expect(calls.some((call) => call.url === `${LIST_URL}/policies/policy-1` && call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.url === `${LIST_URL}/policies/policy-1`);
    expect(patch?.headers.get('if-match')).toBe('"3"');
    expect(patch?.body).toMatchObject({ class: 'WARM', expectedVersion: 3 });
  });
});

describe('ModelResidencyScreen — accessibility', () => {
  it('has no axe violations', async () => {
    installFetchStub((call) => (call.url === LIST_URL ? RESIDENCY : undefined));
    const { container } = renderWithProviders(<ModelResidencyScreen />);
    await waitForModelRef('arcaai-whisper-ml-en-ggml');

    expect(await axe(container)).toHaveNoViolations();
  });
});
