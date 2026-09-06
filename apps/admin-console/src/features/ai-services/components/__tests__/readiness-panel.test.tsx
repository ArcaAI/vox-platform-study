/**
 * TDD tests for the readiness grid on `/ai-services` (tier 10-19) — TASK-890
 * §3.12 / OD-L: "the platform admin must be able to monitor the readiness of
 * all inference services".
 *
 * The panel renders ONE stored observation. Its whole contract is that the
 * reader can tell measured from unmeasured: every state carries words as well
 * as colour (rule 11 §10), `checkedAt` is always visible, and an empty
 * observation says "nothing observed yet" rather than showing a green grid it
 * did not measure.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { InferenceReadiness } from '../../api/types';
import { ReadinessPanel } from '../readiness-panel';

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

const READINESS: InferenceReadiness = {
  checkedAt: new Date().toISOString(),
  engines: [
    {
      provider: 'lm-studio',
      providerClass: 'engine-served',
      baseUrlHost: 'hope-lmstudio:1234',
      status: 'up',
      latencyMs: 12,
      loadedCount: 1,
      listedCount: 3,
      detail: null,
    },
    {
      provider: 'ollama',
      providerClass: 'engine-served',
      baseUrlHost: 'hope-ollama:11434',
      status: 'down',
      latencyMs: null,
      loadedCount: 0,
      listedCount: 0,
      detail: 'connect ECONNREFUSED',
    },
    {
      provider: 'vllm',
      providerClass: 'engine-served',
      baseUrlHost: null,
      status: 'unknown',
      latencyMs: null,
      loadedCount: 0,
      listedCount: 0,
      detail: null,
    },
    {
      provider: 'llama-cpp',
      providerClass: 'engine-served',
      baseUrlHost: 'hope-llamacpp:8080',
      status: 'up',
      latencyMs: 4,
      loadedCount: 1,
      listedCount: 1,
      detail: null,
    },
  ],
  services: [
    { key: 'text', healthy: true, lastSeenAt: new Date().toISOString() },
    { key: 'nlp', healthy: true, lastSeenAt: new Date().toISOString() },
    { key: 'stt', healthy: false, lastSeenAt: new Date(Date.now() - 600_000).toISOString() },
    { key: 'tts', healthy: true, lastSeenAt: new Date().toISOString() },
    { key: 'guardrail', healthy: true, lastSeenAt: new Date().toISOString() },
    { key: 'harness', healthy: false, lastSeenAt: null },
  ],
  models: [
    {
      id: 'm-1',
      slug: 'qwen3-8b',
      taskType: 'TEXT_GENERATION',
      provider: 'lm-studio',
      providerClass: 'engine-served',
      readiness: 'ready',
      detail: null,
    },
    {
      id: 'm-2',
      slug: 'gemma3-27b',
      taskType: 'TEXT_GENERATION',
      provider: 'lm-studio',
      providerClass: 'engine-served',
      readiness: 'loadable',
      detail: 'listed, not resident — the first call pays a load',
    },
    {
      id: 'm-3',
      slug: 'whisper-large-v3',
      taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
      provider: 'built-in',
      providerClass: 'platform-self-host',
      readiness: 'engine_down',
      detail: 'the stt service heartbeat is not healthy',
    },
    {
      id: 'm-4',
      slug: 'azure-gpt-5-mini',
      taskType: 'TEXT_GENERATION',
      provider: 'azure',
      providerClass: 'cloud-platform',
      readiness: 'credential_missing',
      detail: 'the platform connection has no credential',
    },
  ],
};

const EMPTY: InferenceReadiness = { checkedAt: null, engines: [], services: [], models: [] };

interface RecordedCall {
  url: string;
  method: string;
}

function stubFetch(document: InferenceReadiness = READINESS, refreshed: InferenceReadiness = READINESS): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET' };
      calls.push(call);
      if (call.url === '/api/auth/session') return Response.json(SESSION);
      const url = new URL(call.url, 'http://test');
      if (url.pathname === '/api/hope/admin/ai-services/readiness/refresh') return Response.json(refreshed);
      if (url.pathname === '/api/hope/admin/ai-services/readiness') return Response.json(document);
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReadinessPanel', () => {
  it('shows content-shaped skeletons while the observation is in flight', () => {
    stubFetch();
    const { container } = renderWithProviders(<ReadinessPanel />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('summarises the observation and says when it was taken', async () => {
    stubFetch();
    renderWithProviders(<ReadinessPanel />);

    await screen.findByRole('region', { name: 'Inference engines' });
    // 2 of 4 engines answered; 4 of 6 services healthy; 1 of 4 models ready.
    expect(screen.getByText('2 of 4 up')).toBeDefined();
    expect(screen.getByText('4 of 6 healthy')).toBeDefined();
    expect(screen.getByText('1 of 4 ready')).toBeDefined();
    expect(screen.getByText(/Observed/)).toBeDefined();
  });

  it('renders every engine — including Ollama and llama.cpp — with its status in words', async () => {
    stubFetch();
    renderWithProviders(<ReadinessPanel />);

    const engines = await screen.findByRole('region', { name: 'Inference engines' });
    for (const provider of ['lm-studio', 'ollama', 'vllm', 'llama-cpp']) {
      expect(within(engines).getByText(provider)).toBeDefined();
    }
    expect(within(engines).getAllByText('Up').length).toBe(2);
    expect(within(engines).getByText('Down')).toBeDefined();
    // "Not probed" is its own answer — nobody looked is not the same as down.
    expect(within(engines).getByText('Not probed')).toBeDefined();
    expect(within(engines).getByText('connect ECONNREFUSED')).toBeDefined();
    expect(within(engines).getByText('hope-ollama:11434')).toBeDefined();
  });

  it('renders every HOPE service heartbeat, including one that has never been seen', async () => {
    stubFetch();
    renderWithProviders(<ReadinessPanel />);

    const services = await screen.findByRole('region', { name: 'Platform services' });
    for (const key of ['text', 'nlp', 'stt', 'tts', 'guardrail', 'harness']) {
      expect(within(services).getByText(key)).toBeDefined();
    }
    expect(within(services).getAllByText('Not healthy').length).toBe(2);
    expect(within(services).getByText('Never seen')).toBeDefined();
  });

  it('renders per-model readiness with the reason, never colour alone', async () => {
    stubFetch();
    renderWithProviders(<ReadinessPanel />);

    const models = await screen.findByRole('region', { name: 'Model readiness' });
    expect(within(models).getByText('qwen3-8b')).toBeDefined();
    expect(within(models).getByText('Ready')).toBeDefined();
    expect(within(models).getByText('Loadable')).toBeDefined();
    expect(within(models).getByText('Engine down')).toBeDefined();
    expect(within(models).getByText('No credential')).toBeDefined();
    expect(within(models).getByText('the platform connection has no credential')).toBeDefined();
  });

  it('“Probe now” posts a refresh and shows the new observation', async () => {
    const refreshed: InferenceReadiness = {
      ...READINESS,
      engines: READINESS.engines.map((engine) => (engine.provider === 'ollama' ? { ...engine, status: 'up', detail: null } : engine)),
    };
    const calls = stubFetch(READINESS, refreshed);
    renderWithProviders(<ReadinessPanel />);

    await screen.findByRole('region', { name: 'Inference engines' });
    fireEvent.click(screen.getByRole('button', { name: 'Probe now' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST' && call.url.includes('/readiness/refresh'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getAllByText('Up').length).toBe(3);
    });
  });

  it('says nothing has been observed yet rather than rendering an all-clear grid', async () => {
    stubFetch(EMPTY);
    renderWithProviders(<ReadinessPanel />);

    expect(await screen.findByText('No readiness observation yet')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Inference engines' })).toBeNull();
    // The one action that can produce one is offered right there.
    expect(screen.getByRole('button', { name: 'Probe now' })).toBeDefined();
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<ReadinessPanel />);
    await screen.findByRole('region', { name: 'Inference engines' });

    expect(await axe(container)).toHaveNoViolations();
  });
});
