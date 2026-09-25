/**
 * TASK-1005 §13 L-RUI — the catalogue-first model residency screen. Built
 * against `tests/contracts/model-residency-catalogue.fixture.json` (the
 * catalogue read) and `tests/contracts/model-residency-admin.fixture.json`
 * (load/unload/policy actions), which the gateway lane (L-RCAT) implements
 * against the SAME pinned fixtures, so the shapes here track those fixtures
 * rather than the other way around.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { toast } from 'sonner';
import { renderWithProviders } from '@/test/render';
import type { ModelResidencyCatalogueResponse } from '../../api/types';
import { ModelResidencyScreen } from '../model-residency-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

const CATALOGUE: ModelResidencyCatalogueResponse = {
  mode: 'shadow',
  reportedAt: '2026-09-25T02:00:05Z',
  freshness: { maxAgeSeconds: 12, staleServices: [] },
  devices: [
    {
      id: 'gpu0',
      kind: 'gpu',
      label: 'GPU 0 — NVIDIA RTX 2000 Ada Generation',
      totalBytes: 17_175_674_880,
      usedBytes: 5_683_281_920,
      freeBytes: 11_492_392_960,
      utilisationPercent: 1.5,
      headroomPercent: 15,
      models: [{ service: 'stt', modelRef: 'arcaai-whisper-ml-en-ggml', name: 'ArcaAI Whisper ml-en', bytes: 1_623_195_648 }],
    },
  ],
  services: [
    {
      service: 'stt',
      label: 'Speech-to-text — live sessions',
      runsOn: 'gpu',
      controllable: true,
      reachable: true,
      loadedCount: 1,
      models: [
        {
          aiModelId: '0199a1b2-0000-7000-8000-000000000001',
          name: 'ArcaAI Whisper ml-en',
          slug: 'arcaai-whisper-ml-en-ggml',
          modelRef: 'arcaai-whisper-ml-en-ggml',
          format: 'WHISPER_CPP',
          status: 'loaded',
          size: { bytes: 1_623_195_648, source: 'measured' },
          loadSeconds: 6.8,
          residency: {
            device: 'gpu0',
            instance: 'hope-stt-5d9f7c8b6-abcde',
            bytes: 1_623_195_648,
            bytesSource: 'measured',
            inFlight: 1,
            requestsPerMin: 4.2,
            p50LatencyMs: 310,
            loadedAt: '2026-09-25T01:40:00Z',
            lastUsedAt: '2026-09-25T01:59:58Z',
          },
          usage: {
            agentCount: 4,
            tenantCount: 2,
            liveConsultation: true,
            uses: [
              {
                tenantId: '50000000-0000-0000-0000-000000000001',
                tenantName: 'ArcaAI',
                agentSlug: 'realtime-transcription-ml-en',
                agentName: 'Realtime transcription (ml-en)',
                task: 'SPEECH_TO_TEXT',
                role: 'primary',
                liveConsultation: true,
              },
            ],
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
          actions: ['unload', 'edit_policy'],
        },
        {
          aiModelId: '0199a1b2-0000-7000-8000-000000000002',
          name: 'ArcaAI Whisper radiology',
          slug: 'arcaai-whisper-radiology-en-f16',
          modelRef: 'arcaai-whisper-radiology-en-f16',
          format: 'WHISPER_CPP',
          status: 'not_loaded',
          size: { bytes: 1_610_612_736, source: 'catalogue' },
          loadSeconds: 7.2,
          residency: null,
          usage: {
            agentCount: 1,
            tenantCount: 1,
            liveConsultation: false,
            uses: [
              {
                tenantId: '50000000-0000-0000-0000-000000000001',
                tenantName: 'ArcaAI',
                agentSlug: 'realtime-radiology-medical-transcription',
                agentName: 'Radiology transcription',
                task: 'SPEECH_TO_TEXT',
                role: 'fallback',
                liveConsultation: false,
              },
            ],
          },
          keepPolicy: {
            kind: 'on_demand',
            label: 'Load when needed',
            reason: 'Default for models no live agent uses',
            source: 'default',
            policyId: null,
            policyVersion: null,
            idleTtlSeconds: 900,
          },
          actions: ['load', 'edit_policy'],
        },
      ],
    },
    {
      service: 'nlp',
      label: 'Medical NLP',
      runsOn: 'gpu',
      controllable: true,
      reachable: true,
      loadedCount: 1,
      models: [
        {
          aiModelId: '0199a1b2-0000-7000-8000-000000000003',
          name: 'GLiNER medical (large)',
          slug: 'gliner-medical-large',
          modelRef: 'gliner-medical-large',
          format: 'GLINER',
          status: 'loaded',
          size: { bytes: 900_000_000, source: 'measured' },
          loadSeconds: 2.1,
          residency: {
            device: 'gpu0',
            instance: 'hope-nlp-abc123',
            bytes: 900_000_000,
            bytesSource: 'measured',
            inFlight: 0,
            requestsPerMin: 0.4,
            p50LatencyMs: 120,
            loadedAt: '2026-09-25T01:00:00Z',
            lastUsedAt: '2026-09-25T01:30:00Z',
          },
          usage: { agentCount: 0, tenantCount: 0, liveConsultation: false, uses: [] },
          keepPolicy: {
            kind: 'warm',
            label: 'Keep warm',
            reason: 'Explicit policy',
            source: 'policy',
            policyId: 'policy-1',
            policyVersion: 3,
            idleTtlSeconds: 600,
          },
          actions: ['unload', 'edit_policy'],
        },
      ],
    },
    {
      service: 'lm-studio',
      label: 'Language models (LM Studio)',
      runsOn: 'gpu',
      controllable: true,
      reachable: true,
      loadedCount: 0,
      models: [],
    },
  ],
  suggestions: [
    {
      id: 'sugg-1',
      at: '2026-09-25T01:58:00Z',
      text: 'Unload Gliner medical large on nlp — idle for 20 minutes and no live agent uses it.',
      action: 'unload',
      service: 'nlp',
      modelRef: 'gliner-medical-large',
      applied: false,
    },
  ],
};

const BASE_URL = '/api/hope/admin/model-residency';
const CATALOGUE_URL = `${BASE_URL}/catalogue`;

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

function sttTable(): Promise<HTMLElement> {
  return screen.findByRole('table', { name: /Speech-to-text.*models/ });
}

describe('ModelResidencyScreen — catalogue-first, grouped by service', () => {
  it('renders one section per service, including an empty state for a service with no models', async () => {
    installFetchStub((call) => (call.url === CATALOGUE_URL ? CATALOGUE : undefined));
    renderWithProviders(<ModelResidencyScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Model residency' })).toBeDefined();
    expect(await screen.findByRole('heading', { name: 'Speech-to-text — live sessions' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Medical NLP' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Language models (LM Studio)' })).toBeDefined();
    expect(screen.getByText('No self-hosted models for this service')).toBeDefined();
  });

  it('lists a not-loaded model with a Load action — no free-text model reference anywhere', async () => {
    installFetchStub((call) => (call.url === CATALOGUE_URL ? CATALOGUE : undefined));
    renderWithProviders(<ModelResidencyScreen />);

    const row = within(await screen.findByRole('table', { name: /Speech-to-text.*models/ })).getByRole('row', { name: /ArcaAI Whisper radiology/ });
    expect(within(row).getByRole('button', { name: 'Load' })).toBeDefined();
    expect(screen.queryByLabelText(/model/i, { selector: 'input' })).toBeNull();
  });

  it('renders plain-language status and keep-policy text — never the raw enum values', async () => {
    installFetchStub((call) => (call.url === CATALOGUE_URL ? CATALOGUE : undefined));
    renderWithProviders(<ModelResidencyScreen />);

    const table = await screen.findByRole('table', { name: /Speech-to-text.*models/ });
    const loadedRow = within(table).getByRole('row', { name: /ArcaAI Whisper ml-en/ });
    expect(within(loadedRow).getByText(/Loaded/)).toBeDefined();
    expect(within(loadedRow).getByText(/GPU 0/)).toBeDefined();
    expect(within(loadedRow).getByText(/measured/)).toBeDefined();
    expect(within(loadedRow).getByText('Always loaded')).toBeDefined();

    const notLoadedRow = within(table).getByRole('row', { name: /ArcaAI Whisper radiology/ });
    expect(within(notLoadedRow).getByText(/Not loaded/)).toBeDefined();
    expect(within(notLoadedRow).getByText('Load when needed')).toBeDefined();

    for (const rawEnum of ['PINNED', 'ON_DEMAND', 'WARM', 'gpu0', 'implicit-live-path']) {
      expect(screen.queryByText(rawEnum)).toBeNull();
    }
  });
});

describe('ModelResidencyScreen — the detail drawer shows who uses the model', () => {
  it('opens on Details and lists the tenant, agent, task and role from usage.uses', async () => {
    installFetchStub((call) => (call.url === CATALOGUE_URL ? CATALOGUE : undefined));
    renderWithProviders(<ModelResidencyScreen />);

    const row = within(await screen.findByRole('table', { name: /Speech-to-text.*models/ })).getByRole('row', {
      name: /ArcaAI Whisper radiology/,
    });
    fireEvent.click(within(row).getByRole('button', { name: 'Details' }));

    const drawer = await screen.findByRole('dialog', { name: /ArcaAI Whisper radiology/ });
    expect(within(drawer).getByText('ArcaAI')).toBeDefined();
    expect(within(drawer).getByText('Radiology transcription')).toBeDefined();
    expect(within(drawer).getByText('Speech-to-text')).toBeDefined();
    expect(within(drawer).getByText('Fallback')).toBeDefined();
  });
});

describe('ModelResidencyScreen — unload while in flight forces a reason (OD-3 pattern)', () => {
  it('opens the force-unload confirmation directly for an in-flight model and requires a typed reason', async () => {
    const calls = installFetchStub((call) => {
      if (call.url === CATALOGUE_URL) return CATALOGUE;
      if (call.url === `${BASE_URL}/unload`) return { outcome: 'unloaded', service: 'stt', modelRef: 'arcaai-whisper-ml-en-ggml' };
      return undefined;
    });
    renderWithProviders(<ModelResidencyScreen />);

    const table = await sttTable();
    const row = within(table).getByRole('row', { name: /ArcaAI Whisper ml-en/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Unload' }));

    const confirm = await screen.findByRole('alertdialog');
    const forceButton = within(confirm).getByRole('button', { name: /Force unload/i });
    expect(forceButton).toHaveProperty('disabled', true);

    fireEvent.change(within(confirm).getByLabelText(/Reason/i), { target: { value: 'Card is about to OOM its neighbour' } });
    expect(forceButton).toHaveProperty('disabled', false);
    fireEvent.click(forceButton);

    await waitFor(() => expect(calls.some((call) => call.url === `${BASE_URL}/unload` && call.method === 'POST')).toBe(true));
    const unload = calls.find((call) => call.url === `${BASE_URL}/unload`);
    expect(unload?.body).toMatchObject({
      service: 'stt',
      modelRef: 'arcaai-whisper-ml-en-ggml',
      force: true,
      reason: 'Card is about to OOM its neighbour',
    });
  });
});

describe('ModelResidencyScreen — Load posts to the residency load route and polls the operation', () => {
  it('sends service + modelRef only, then polls the operation to a terminal state', async () => {
    vi.useFakeTimers();
    let operationPolls = 0;
    const calls = installFetchStub((call) => {
      if (call.url === CATALOGUE_URL) return CATALOGUE;
      if (call.url === `${BASE_URL}/load`) {
        return Response.json(
          {
            outcome: 'accepted',
            operationId: 'op-1',
            model: { service: 'stt', instance: 'hope-stt-new', modelRef: 'arcaai-whisper-radiology-en-f16', state: 'loading' },
          },
          { status: 202 },
        );
      }
      if (call.url === `${BASE_URL}/operations/op-1`) {
        operationPolls += 1;
        const status = operationPolls === 1 ? 'running' : 'succeeded';
        return {
          id: 'op-1',
          action: 'load',
          service: 'stt',
          modelRef: 'arcaai-whisper-radiology-en-f16',
          status,
          error: null,
          startedAt: '2026-09-25T02:05:00Z',
          finishedAt: status === 'succeeded' ? '2026-09-25T02:05:07Z' : null,
        };
      }
      return undefined;
    });
    renderWithProviders(<ModelResidencyScreen />);
    // Fake timers are active: every wait is an explicit `advanceTimersByTimeAsync`
    // (flushing the microtasks each fetch resolves through) rather than
    // testing-library's `waitFor`/`findBy*`, which relies on real timers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const table = screen.getByRole('table', { name: /Speech-to-text.*models/ });
    const row = within(table).getByRole('row', { name: /ArcaAI Whisper radiology/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Load' }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const loadCall = calls.find((call) => call.url === `${BASE_URL}/load`);
    expect(loadCall?.body).toMatchObject({ service: 'stt', modelRef: 'arcaai-whisper-radiology-en-f16', force: false });
    expect(operationPolls).toBe(1);

    // Advance past the 2s operation-poll interval so the operation settles.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });

    expect(operationPolls).toBeGreaterThanOrEqual(2);
    expect(toast.success).toHaveBeenCalled();
  });
});

describe('ModelResidencyScreen — the keep-policy editor is optimistic-concurrency (If-Match)', () => {
  it('PATCHes the existing policy row with If-Match built from its own version', async () => {
    const calls = installFetchStub((call) => {
      if (call.url === CATALOGUE_URL) return CATALOGUE;
      if (call.url === `${BASE_URL}/policies/policy-1`) {
        return {
          id: 'policy-1',
          aiModelId: '0199a1b2-0000-7000-8000-000000000003',
          service: 'nlp',
          class: 'ON_DEMAND',
          idleTtlSeconds: 600,
          priority: 100,
          maxInstances: 1,
          preferredDevice: null,
          _version: 4,
          updatedAt: '2026-09-25T02:10:00Z',
          updatedBy: null,
        };
      }
      return undefined;
    });
    renderWithProviders(<ModelResidencyScreen />);

    const nlpTable = await screen.findByRole('table', { name: /Medical NLP.*models/ });
    const row = within(nlpTable).getByRole('row', { name: /GLiNER medical/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Details' }));

    const drawer = await screen.findByRole('dialog', { name: /GLiNER medical/ });
    fireEvent.click(within(drawer).getByRole('radio', { name: /Load when needed/i }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save keep policy' }));

    await waitFor(() => expect(calls.some((call) => call.url === `${BASE_URL}/policies/policy-1` && call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.url === `${BASE_URL}/policies/policy-1`);
    expect(patch?.headers.get('if-match')).toBe('"3"');
    expect(patch?.body).toMatchObject({ class: 'ON_DEMAND', expectedVersion: 3 });
  });
});

describe('ModelResidencyScreen — routing-policy consumers and models outside the catalogue', () => {
  const EDGE_CATALOGUE: ModelResidencyCatalogueResponse = {
    ...CATALOGUE,
    services: [
      {
        service: 'nlp',
        label: 'Medical NLP',
        runsOn: 'gpu',
        controllable: true,
        reachable: true,
        loadedCount: 2,
        models: [
          {
            aiModelId: '0199a1b2-0000-7000-8000-000000000004',
            name: 'GLiNER routing candidate',
            slug: 'gliner-routing-candidate',
            modelRef: 'gliner-routing-candidate',
            format: 'GLINER',
            status: 'loaded',
            size: { bytes: 500_000_000, source: 'measured' },
            loadSeconds: 1.9,
            residency: {
              device: 'gpu0',
              instance: 'hope-nlp-routing',
              bytes: 500_000_000,
              bytesSource: 'measured',
              inFlight: 0,
              requestsPerMin: null,
              p50LatencyMs: null,
              loadedAt: '2026-09-25T01:00:00Z',
              lastUsedAt: null,
            },
            usage: {
              agentCount: 0,
              tenantCount: 1,
              liveConsultation: false,
              uses: [
                {
                  tenantId: '50000000-0000-0000-0000-000000000001',
                  tenantName: 'ArcaAI',
                  agentSlug: null,
                  agentName: null,
                  task: 'guardrail.judge',
                  role: 'routing',
                  liveConsultation: false,
                },
              ],
            },
            keepPolicy: {
              kind: 'on_demand',
              label: 'Load when needed',
              reason: 'Default for models no live agent uses',
              source: 'default',
              policyId: null,
              policyVersion: null,
              idleTtlSeconds: 900,
            },
            actions: ['unload', 'edit_policy'],
          },
          {
            aiModelId: null,
            name: 'orphan-nlp-instance',
            slug: null,
            modelRef: 'orphan-nlp-instance',
            format: null,
            status: 'loaded',
            size: { bytes: null, source: 'unknown' },
            loadSeconds: null,
            residency: {
              device: 'gpu0',
              instance: 'hope-nlp-orphan',
              bytes: null,
              bytesSource: 'unknown',
              inFlight: 0,
              requestsPerMin: null,
              p50LatencyMs: null,
              loadedAt: null,
              lastUsedAt: null,
            },
            usage: { agentCount: 0, tenantCount: 0, liveConsultation: false, uses: [] },
            keepPolicy: {
              kind: 'on_demand',
              label: 'Load when needed',
              reason: 'Default for models no live agent uses',
              source: 'default',
              policyId: null,
              policyVersion: null,
              idleTtlSeconds: 900,
            },
            actions: ['unload'],
          },
        ],
      },
      {
        service: 'stt-worker',
        label: 'Speech-to-text — background jobs',
        runsOn: 'cpu',
        controllable: false,
        reachable: true,
        loadedCount: 1,
        models: [
          {
            aiModelId: '0199a1b2-0000-7000-8000-000000000005',
            name: 'ArcaAI Whisper batch',
            slug: 'arcaai-whisper-batch',
            modelRef: 'arcaai-whisper-batch',
            format: 'WHISPER_CPP',
            status: 'loaded',
            size: { bytes: 800_000_000, source: 'measured' },
            loadSeconds: 3,
            residency: {
              device: 'cpu',
              instance: 'hope-stt-worker-1',
              bytes: 800_000_000,
              bytesSource: 'measured',
              inFlight: 0,
              requestsPerMin: 0.1,
              p50LatencyMs: 900,
              loadedAt: '2026-09-25T01:00:00Z',
              lastUsedAt: '2026-09-25T01:50:00Z',
            },
            usage: { agentCount: 0, tenantCount: 0, liveConsultation: false, uses: [] },
            keepPolicy: {
              kind: 'warm',
              label: 'Keep warm',
              reason: 'Default for a background worker',
              source: 'default',
              policyId: null,
              policyVersion: null,
              idleTtlSeconds: 1800,
            },
            actions: [],
          },
        ],
      },
    ],
  };

  it('shows the task and “Routing policy” (never a blank agent) for a routing-policy consumer', async () => {
    installFetchStub((call) => (call.url === CATALOGUE_URL ? EDGE_CATALOGUE : undefined));
    renderWithProviders(<ModelResidencyScreen />);

    const table = await screen.findByRole('table', { name: /Medical NLP.*models/ });
    const row = within(table).getByRole('row', { name: /GLiNER routing candidate/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Details' }));

    const drawer = await screen.findByRole('dialog', { name: /GLiNER routing candidate/ });
    expect(within(drawer).getByText('Guardrail judge')).toBeDefined();
    expect(within(drawer).getByText('Routing policy')).toBeDefined();
    expect(within(drawer).queryByText('null')).toBeNull();
  });

  it('shows modelRef as the name and a "not in the model catalogue" note for an orphan resident model, with no Details button', async () => {
    installFetchStub((call) => (call.url === CATALOGUE_URL ? EDGE_CATALOGUE : undefined));
    renderWithProviders(<ModelResidencyScreen />);

    const table = await screen.findByRole('table', { name: /Medical NLP.*models/ });
    const row = within(table).getByRole('row', { name: /orphan-nlp-instance/ });
    expect(within(row).getByText('Not in the model catalogue')).toBeDefined();
    expect(within(row).queryByRole('button', { name: 'Details' })).toBeNull();
  });

  it('offers no load/unload action for an uncontrollable service (stt-worker: Prometheus-only)', async () => {
    installFetchStub((call) => (call.url === CATALOGUE_URL ? EDGE_CATALOGUE : undefined));
    renderWithProviders(<ModelResidencyScreen />);

    const table = await screen.findByRole('table', { name: /background jobs.*models/ });
    const row = within(table).getByRole('row', { name: /ArcaAI Whisper batch/ });
    expect(within(row).queryByRole('button', { name: 'Load' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Unload' })).toBeNull();
    expect(screen.getByText('Read-only · no control API')).toBeDefined();
  });
});

describe('ModelResidencyScreen — accessibility', () => {
  it('has no axe violations', async () => {
    installFetchStub((call) => (call.url === CATALOGUE_URL ? CATALOGUE : undefined));
    const { container } = renderWithProviders(<ModelResidencyScreen />);
    await screen.findByRole('heading', { name: 'Speech-to-text — live sessions' });

    expect(await axe(container)).toHaveNoViolations();
  });
});
