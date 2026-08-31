/**
 * Self-hosted inference-engine screens (LM Studio, vLLM — tier 10-19).
 *
 * The controlling fact these tests encode: BOTH engines ship at zero replicas
 * today, so "the engine is not reachable" is the PRIMARY state of these screens,
 * not an edge case. It must render as information — a banner carrying the
 * probe error verbatim plus why that is expected — and never as a spinner that
 * never resolves, a blank grid, or a red error page that implies the console
 * itself is broken.
 *
 * The second theme is honesty about what is NOT here: no lifecycle controls, and
 * no claim about which accelerator the engine is using (that is not knowable
 * over HTTP). Both are asserted, because an absent affordance that is silently
 * absent reads as a missing feature rather than a decision.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { DiscoveryResponse, EngineArtifact, EngineConnection } from '../../api/types';
import { EngineScreen } from '../engine-screen';

const SESSION = {
  user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'] },
  isElevated: true,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'Sunrise Medical Group' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'], tenantId: null, departmentId: null },
  effectiveIsElevated: true,
  effectiveTenantId: 'tnt-1' as string | null,
};

/** The normal state today: the deployment runs at zero replicas. */
const UNREACHABLE: DiscoveryResponse = {
  entries: [],
  probes: [{ provider: 'lm-studio', probeStatus: 'error', error: 'connect ECONNREFUSED 10.43.2.7:1234', latencyMs: 12 }],
  probedAt: '2026-08-31T08:00:00.000Z',
};

const REACHABLE: DiscoveryResponse = {
  entries: [
    {
      provider: 'lm-studio',
      modelName: 'medgemma-27b-it-Q4_K_M',
      status: 'registered',
      loadState: 'loaded',
      registeredModel: { id: 'm-1', slug: 'medgemma-27b', resourceStatus: 'ENABLED' },
      engineMeta: { quantization: 'Q4_K_M', max_context_length: 8192 },
    },
    { provider: 'lm-studio', modelName: 'qwen3-8b-instruct', status: 'discovered', loadState: 'not-loaded' },
    {
      provider: 'lm-studio',
      modelName: 'retired-whisper',
      status: 'registered-missing-on-server',
      loadState: 'unknown',
      registeredModel: { id: 'm-9', slug: 'retired-whisper', resourceStatus: 'ENABLED' },
    },
  ],
  probes: [{ provider: 'lm-studio', probeStatus: 'ok', latencyMs: 34, connectionSource: 'system' }],
  probedAt: '2026-08-31T08:00:00.000Z',
};

const EMPTY_BUT_UP: DiscoveryResponse = {
  entries: [],
  probes: [{ provider: 'lm-studio', probeStatus: 'ok', latencyMs: 21, connectionSource: 'tenant' }],
  probedAt: '2026-08-31T08:00:00.000Z',
};

const CONNECTION: EngineConnection = {
  tenantId: '00000000-0000-0000-0000-000000000000',
  service: 'llm',
  provider: 'lm-studio',
  baseUrl: 'http://hope-lm-studio.hope-v2-dev.svc:1234/v1',
  hasKey: false,
  enabled: true,
  version: 3,
};

/** The gateway's "no row yet" placeholder — the normal shape for a keyless self-hosted engine. */
const NO_CONNECTION_ROW: EngineConnection = {
  tenantId: '00000000-0000-0000-0000-000000000000',
  service: 'llm',
  provider: 'lm-studio',
  baseUrl: null,
  hasKey: false,
  enabled: false,
  version: 0,
};

const ARTIFACTS: EngineArtifact[] = [
  { key: 'lm-studio/medgemma-27b/medgemma-27b-it-Q4_K_M.gguf', size: 16_492_674_416, lastModified: '2026-08-20T10:00:00.000Z' },
  { key: 'lm-studio/qwen3-8b/qwen3-8b-instruct-Q5_K_M.gguf', size: 5_732_884_992 },
];

interface StubOptions {
  discovery?: DiscoveryResponse;
  connection?: EngineConnection;
  artifacts?: EngineArtifact[];
  custom?: (call: { url: string; method: string }) => Response | undefined;
}

function stubFetch({ discovery = UNREACHABLE, connection = CONNECTION, artifacts = ARTIFACTS, custom }: StubOptions = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? 'GET' };
      calls.push(call);
      const handled = custom?.(call);
      if (handled) return handled;
      if (call.url === '/api/auth/session') return Response.json(SESSION);
      const url = new URL(call.url, 'http://test');
      if (url.pathname === '/api/hope/admin/ai-models/discovery') return Response.json(discovery);
      if (url.pathname.startsWith('/api/hope/admin/providers/llm/')) return Response.json(connection);
      if (url.pathname === '/api/hope/storage/buckets/hope-models/files') return Response.json(artifacts);
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EngineScreen — chrome', () => {
  it('renders one h1 and the three operational tabs', async () => {
    stubFetch();
    renderWithProviders(<EngineScreen provider="lm-studio" />);

    expect(screen.getByRole('heading', { level: 1, name: 'LM Studio' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Server' })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Models on server/ })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Artifacts/ })).toBeDefined();
    await screen.findByText(/zero replicas/);
  });

  it('scopes the probe to this engine — never a cross-engine listing', async () => {
    const calls = stubFetch();
    renderWithProviders(<EngineScreen provider="lm-studio" />);
    await screen.findByText(/zero replicas/);

    const discovery = calls.find((c) => c.url.includes('/admin/ai-models/discovery'));
    expect(discovery).toBeDefined();
    expect(new URL(discovery!.url, 'http://test').searchParams.get('provider')).toBe('lm-studio');
  });

  it('shows content-shaped skeletons while the reads are in flight — never a spinner', () => {
    stubFetch();
    const { container } = renderWithProviders(<EngineScreen provider="lm-studio" />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });
});

describe('EngineScreen — the engine is unreachable (the normal state today)', () => {
  it('renders the probe error verbatim in a page-level banner', async () => {
    stubFetch();
    renderWithProviders(<EngineScreen provider="lm-studio" />);

    const banner = await screen.findByRole('status', { name: 'Engine status' });
    expect(within(banner).getByText(/connect ECONNREFUSED 10\.43\.2\.7:1234/)).toBeDefined();
  });

  it('says WHY unreachable is expected, so the screen does not read as broken', async () => {
    stubFetch();
    renderWithProviders(<EngineScreen provider="lm-studio" />);

    expect(await screen.findByText(/zero replicas, so an unreachable probe is the expected result/)).toBeDefined();
  });

  it('badges the engine as unreachable in words, not by colour alone', async () => {
    stubFetch();
    renderWithProviders(<EngineScreen provider="lm-studio" />);

    // Twice on purpose: the stat tile carries the state, the banner carries the
    // detail. Neither may rely on colour to say "unreachable".
    const labels = await screen.findAllByText('Unreachable');
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(labels.some((node) => node.closest('[data-slot="stat-card-value"]') !== null)).toBe(true);
  });

  it('gives the Models tab an explicit unreachable empty state, not a blank grid', async () => {
    stubFetch();
    renderWithProviders(<EngineScreen provider="lm-studio" />, { searchParams: '?tab=models' });

    expect(await screen.findByText('The engine did not answer the probe')).toBeDefined();
    // "no models" and "could not ask" are different statements and must not be conflated.
    expect(screen.queryByText('This engine reported no models')).toBeNull();
  });
});

describe('EngineScreen — the engine is reachable', () => {
  it('lists the reported models with their registry status and load state', async () => {
    stubFetch({ discovery: REACHABLE });
    renderWithProviders(<EngineScreen provider="lm-studio" />, { searchParams: '?tab=models' });

    await screen.findByText('medgemma-27b-it-Q4_K_M');
    expect(screen.getByText('Registered')).toBeDefined();
    expect(screen.getByText('Discovered')).toBeDefined();
    expect(screen.getByText('Missing on server')).toBeDefined();
    expect(screen.getByText('Loaded')).toBeDefined();
  });

  it('surfaces engine-native metadata where the engine reported it', async () => {
    stubFetch({ discovery: REACHABLE });
    renderWithProviders(<EngineScreen provider="lm-studio" />, { searchParams: '?tab=models' });

    await screen.findByText('medgemma-27b-it-Q4_K_M');
    expect(screen.getByText('Q4_K_M')).toBeDefined();
    expect(screen.getByText(/8192/)).toBeDefined();
  });

  it('reports latency and which cascade tier supplied the probed endpoint', async () => {
    stubFetch({ discovery: REACHABLE });
    renderWithProviders(<EngineScreen provider="lm-studio" />);

    await screen.findByText('Reachable');
    expect(screen.getByText('34 ms')).toBeDefined();
    expect(screen.getByText(/Platform default/)).toBeDefined();
  });

  it('distinguishes "reachable but serving nothing" from "unreachable"', async () => {
    stubFetch({ discovery: EMPTY_BUT_UP });
    renderWithProviders(<EngineScreen provider="lm-studio" />, { searchParams: '?tab=models' });

    expect(await screen.findByText('This engine reported no models')).toBeDefined();
    expect(screen.queryByText('The engine did not answer the probe')).toBeNull();
  });
});

describe('EngineScreen — Server tab', () => {
  it('shows the resolved endpoint and the connection tier', async () => {
    stubFetch({ discovery: REACHABLE });
    renderWithProviders(<EngineScreen provider="lm-studio" />);

    expect(await screen.findByText('http://hope-lm-studio.hope-v2-dev.svc:1234/v1')).toBeDefined();
  });

  it('explains the `version: 0` placeholder rather than showing an empty endpoint', async () => {
    stubFetch({ connection: NO_CONNECTION_ROW });
    renderWithProviders(<EngineScreen provider="lm-studio" />);

    expect(await screen.findByText(/No connection row/)).toBeDefined();
  });

  it('states that the active accelerator is not determinable over HTTP', async () => {
    stubFetch({ discovery: REACHABLE });
    renderWithProviders(<EngineScreen provider="lm-studio" />);

    expect(await screen.findByText(/not exposed by any HTTP endpoint/)).toBeDefined();
  });

  it('names the absent lifecycle controls and why they are absent', async () => {
    stubFetch();
    renderWithProviders(<EngineScreen provider="lm-studio" />);

    expect(await screen.findByText('Start / stop / restart is not available here')).toBeDefined();
    expect(screen.getByText(/GitOps operation, not a console button/)).toBeDefined();
    // No control may exist that mutates the workload.
    for (const name of [/^start/i, /^stop/i, /^restart/i, /^scale/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });
});

describe('EngineScreen — Artifacts tab', () => {
  it('lists weight objects under this engine’s prefix in the models bucket', async () => {
    const calls = stubFetch();
    renderWithProviders(<EngineScreen provider="lm-studio" />, { searchParams: '?tab=artifacts' });

    await screen.findByText('lm-studio/medgemma-27b/medgemma-27b-it-Q4_K_M.gguf');
    const listing = calls.find((c) => c.url.includes('/storage/buckets/hope-models/files'));
    expect(new URL(listing!.url, 'http://test').searchParams.get('prefix')).toBe('lm-studio/');
  });

  it('renders an empty state when the prefix holds nothing', async () => {
    stubFetch({ artifacts: [] });
    renderWithProviders(<EngineScreen provider="lm-studio" />, { searchParams: '?tab=artifacts' });

    expect(await screen.findByText('No weight artifacts under this prefix')).toBeDefined();
  });

  it('degrades to an explanation when the models bucket is not readable', async () => {
    stubFetch({
      custom: (call) => {
        const url = new URL(call.url, 'http://test');
        if (url.pathname === '/api/hope/storage/buckets/hope-models/files') {
          return Response.json({ message: 'Bucket not found' }, { status: 404 });
        }
        return undefined;
      },
    });
    renderWithProviders(<EngineScreen provider="lm-studio" />, { searchParams: '?tab=artifacts' });

    expect(await screen.findByRole('alert')).toBeDefined();
  });
});

describe('EngineScreen — gateway failure is not engine failure', () => {
  it('shows a retryable error state when the gateway read itself fails', async () => {
    let attempts = 0;
    stubFetch({
      custom: (call) => {
        const url = new URL(call.url, 'http://test');
        if (url.pathname === '/api/hope/admin/ai-models/discovery') {
          attempts += 1;
          if (attempts === 1) return Response.json({ message: 'discovery service unavailable' }, { status: 503 });
        }
        return undefined;
      },
    });
    renderWithProviders(<EngineScreen provider="lm-studio" />);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('discovery service unavailable')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getAllByText('Unreachable').length).toBeGreaterThan(0));
  });
});

describe('EngineScreen — Probe now', () => {
  it('re-reads the engine on demand', async () => {
    const calls = stubFetch();
    renderWithProviders(<EngineScreen provider="lm-studio" />);
    await screen.findAllByText('Unreachable');
    const before = calls.filter((c) => c.url.includes('/admin/ai-models/discovery')).length;

    fireEvent.click(screen.getByRole('button', { name: 'Probe now' }));

    await waitFor(() => {
      const after = calls.filter((c) => c.url.includes('/admin/ai-models/discovery')).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});

describe('EngineScreen — vLLM renders its own operational copy', () => {
  it('names the hardware blocker rather than reusing the LM Studio wording', async () => {
    stubFetch({ discovery: { ...UNREACHABLE, probes: [{ provider: 'vllm', probeStatus: 'error', error: 'no route to host' }] } });
    renderWithProviders(<EngineScreen provider="vllm" />);

    expect(screen.getByRole('heading', { level: 1, name: 'vLLM' })).toBeDefined();
    expect(await screen.findByText(/A100\/H100-class hardware/)).toBeDefined();
  });

  it('offers no load/unload affordance — a vLLM model change is a re-deploy', async () => {
    stubFetch({ discovery: { ...REACHABLE, probes: [{ provider: 'vllm', probeStatus: 'ok', latencyMs: 9 }] } });
    renderWithProviders(<EngineScreen provider="vllm" />);

    expect(await screen.findByText('Model swaps are a re-deploy, not a hot swap')).toBeDefined();
    expect(screen.queryByRole('button', { name: /unload/i })).toBeNull();
  });
});

describe('EngineScreen — accessibility', () => {
  it('has no axe violations in the unreachable state (the primary one)', async () => {
    stubFetch();
    const { container } = renderWithProviders(<EngineScreen provider="lm-studio" />);
    await screen.findAllByText('Unreachable');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations with a reachable engine and a model list', async () => {
    stubFetch({ discovery: REACHABLE });
    const { container } = renderWithProviders(<EngineScreen provider="lm-studio" />, { searchParams: '?tab=models' });
    await screen.findByText('medgemma-27b-it-Q4_K_M');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations on the Artifacts tab', async () => {
    stubFetch();
    const { container } = renderWithProviders(<EngineScreen provider="lm-studio" />, { searchParams: '?tab=artifacts' });
    await screen.findByText('lm-studio/medgemma-27b/medgemma-27b-it-Q4_K_M.gguf');
    expect(await axe(container)).toHaveNoViolations();
  });
});
