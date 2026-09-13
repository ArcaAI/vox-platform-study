/**
 * Frame 54 — LLM Playground. fetch is stubbed at the network boundary by
 * pathname (the api layer has its own tests) and EventSource by a
 * FakeEventSource global. Covers the row 38 contract: providers picker
 * (availability + default preselection), sync generate (content + usage +
 * latency + finish), the streaming flow over the ticket-authenticated
 * gateway SSE (chunk
 * append, done finalize, cancel), the designed 422 fail-closed panel, the
 * assembled debug admin gate, the __GLOBAL__ catalog switch and the NoTenant
 * gate.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { axe } from 'vitest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { GenerateTextResponse, TextProvider, StreamingGenerateAck } from '../../api/types';
import { PlaygroundLlmScreen } from '../playground-llm-screen';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

/** Instrumented EventSource double (same shape as the use-task-stream test). */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(name) ?? [];
    this.listeners.set(name, [...existing, listener]);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent);
    }
  }

  fail(): void {
    this.onerror?.(new Event('error'));
    for (const listener of this.listeners.get('error') ?? []) {
      listener(new Event('error') as unknown as MessageEvent);
    }
  }
}

function session(overrides: Partial<{ isElevated: boolean; workingTenantId: string | null; roles: string[] }> = {}) {
  const { roles = ['SUPER_ADMIN'], ...rest } = overrides;
  const base = {
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles, tenantId: null },
    isElevated: true,
    workingTenantId: 't-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: null,
    impersonatingUsername: null,
    ...rest,
  };
  // WorkingTenantGate now reads the effective identity; mirror the
  // (possibly overridden) operator fields since these fixtures never impersonate.
  return {
    ...base,
    effectiveUser: { ...base.user, departmentId: null },
    effectiveIsElevated: base.isElevated,
    effectiveTenantId: base.workingTenantId,
  };
}

const PROVIDERS: TextProvider[] = [
  {
    name: 'azure-openai',
    models: [
      { name: 'gpt-5', size: '' },
      { name: 'gpt-5-mini', size: '' },
    ],
    is_available: true,
    is_default: true,
    default_model: 'gpt-5',
  },
  { name: 'anthropic', models: [{ name: 'claude-4.5', size: '' }], is_available: false },
  { name: 'vertex', models: [{ name: 'gemini-3', size: '4b' }], is_available: true },
];

const GUARDRAILS: TextProvider[] = [
  { name: 'guardrail-v2', models: [{ name: 'pii-shield', size: '' }], is_available: true, is_default: true, default_model: 'pii-shield' },
];

const SYNC_RESULT: GenerateTextResponse = {
  task_id: 't-sync-1',
  status: 'completed',
  content: 'Patient presents with exertional dyspnea.',
  provider: 'azure-openai',
  model: 'gpt-5',
  usage: { prompt_tokens: 42, completion_tokens: 128, total_tokens: 170 },
  latency_ms: 1840,
  finish_reason: 'stop',
  created_at: '2026-07-06T10:00:00.000Z',
};

const STREAM_ACK: StreamingGenerateAck = {
  task_id: 't-5531',
  status: 'queued',
  stream_url: '/api/v1/tasks/t-5531/stream',
  created_at: '2026-07-06T10:00:00.000Z',
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

type FetchHandler = (call: RecordedCall, parsed: URL) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const response = handler(call, new URL(call.url, 'http://test.local'));
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

let ticketCounter = 0;

function defaultHandler(call: RecordedCall, parsed: URL): Response | undefined {
  // SSE now authenticates with a single-use scope-bound ticket minted through
  // the BFF; the stream itself connects directly to the gateway.
  if (call.method === 'POST' && parsed.pathname === '/api/auth/stream-ticket') {
    ticketCounter += 1;
    return Response.json({ ticket: `tkt-${ticketCounter}`, expiresAt: Date.now() + 30_000, scope: 'text_task:t-5531' });
  }
  if (call.method !== 'GET') return undefined;
  const path = parsed.pathname;
  if (path === '/api/auth/session') return Response.json(session());
  if (path === '/api/hope/text-generations/providers') return Response.json(PROVIDERS);
  if (path === '/api/hope/text-generations/guardrail-providers') return Response.json(GUARDRAILS);
  return undefined;
}

function stubLlm(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call, parsed) => custom(call, parsed) ?? defaultHandler(call, parsed));
}

/** Fills the prompt and presses the header Run action. */
async function generateWithPrompt(prompt: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/^Prompt/), { target: { value: prompt } });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
}

function chunk(content: string): string {
  return JSON.stringify({ type: 'chunk', content, data: null });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  ticketCounter = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('PlaygroundLlmScreen', () => {
  // the screen was renamed (Agent Playground → LLM Playground), so its
  // accessibility gate is re-run against the loaded canvas rather than assumed.
  it('has no axe violations once the canvas has loaded', async () => {
    stubLlm();
    const { container } = renderWithProviders(<PlaygroundLlmScreen />);
    await screen.findByRole('heading', { level: 1, name: 'LLM Playground' });
    await screen.findByLabelText('Provider');

    expect(await axe(container)).toHaveNoViolations();
  });

  it('gates an elevated session without a working tenant and fires no text/* query', async () => {
    const calls = stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'LLM Playground' })).toBeDefined();
    expect(calls.filter((call) => call.url.includes('/api/hope/text-generations/'))).toHaveLength(0);
  });

  it('keeps the layout skeleton while the session is loading', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { container } = renderWithProviders(<PlaygroundLlmScreen />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { level: 1, name: 'LLM Playground' })).toBeDefined();
  });

  it('renders the provider picker from text-generations/providers: default preselected, unavailable options disabled', async () => {
    stubLlm();
    renderWithProviders(<PlaygroundLlmScreen />);

    const providerSelect = (await screen.findByLabelText('Provider')) as HTMLSelectElement;
    // is_default drives the preselection; default_model follows.
    expect(providerSelect.value).toBe('azure-openai');
    const modelSelect = screen.getByLabelText('Model') as HTMLSelectElement;
    expect(modelSelect.value).toBe('gpt-5');

    const anthropic = within(providerSelect).getByRole('option', { name: /anthropic/ }) as HTMLOptionElement;
    expect(anthropic.disabled).toBe(true);
    const vertex = within(providerSelect).getByRole('option', { name: /vertex/ }) as HTMLOptionElement;
    expect(vertex.disabled).toBe(false);

    // Providers & guardrails pane lists both catalogs.
    expect(await screen.findByText('guardrail-v2')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Refresh provider catalogs' })).toBeDefined();
  });

  it('runs a sync generation and renders content, usage, latency and finish reason', async () => {
    let generateBody: unknown;
    stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/hope/text-generations/generate' && call.method === 'POST') {
        generateBody = call.body;
        return Response.json(SYNC_RESULT);
      }
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    await screen.findByLabelText('Provider');
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'You are a clinical summarizer.' } });
    // Flip the stream-vs-sync switch to sync.
    fireEvent.click(screen.getByRole('switch', { name: 'Streaming mode' }));
    await generateWithPrompt('Summarize the visit transcript below');

    expect(await screen.findByText('Patient presents with exertional dyspnea.')).toBeDefined();
    expect(generateBody).toEqual({
      prompt: 'Summarize the visit transcript below',
      system_prompt: 'You are a clinical summarizer.',
      provider: 'azure-openai',
      model: 'gpt-5',
      temperature: 0.1,
      max_tokens: 32768,
      stream: false,
    });
    expect(screen.getByText('42 prompt \u00b7 128 completion \u00b7 170 total')).toBeDefined();
    expect(screen.getByText('1,840 ms')).toBeDefined();
    expect(screen.getByText('stop')).toBeDefined();
    expect(screen.getByText('azure-openai \u00b7 gpt-5')).toBeDefined();
  });

  it('renders a Reasoning panel for a sync generation that carries reasoning', async () => {
    stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/hope/text-generations/generate' && call.method === 'POST') {
        return Response.json({ ...SYNC_RESULT, reasoning: 'Checking for cardiac vs pulmonary causes first.' });
      }
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    await screen.findByLabelText('Provider');
    fireEvent.click(screen.getByRole('switch', { name: 'Streaming mode' }));
    await generateWithPrompt('Summarize the visit transcript below');

    expect(await screen.findByText('Checking for cardiac vs pulmonary causes first.')).toBeDefined();
    expect(screen.getByText('Patient presents with exertional dyspnea.')).toBeDefined();
  });

  it('streams tokens over the ticket-authenticated gateway SSE: chunks append live, usage/done finalize', async () => {
    const calls = stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/hope/text-generations/generate' && call.method === 'POST') return Response.json(STREAM_ACK);
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    await screen.findByLabelText('Provider');
    // Streaming is the default mode — no switch flip.
    await generateWithPrompt('Summarize the visit');

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    // House SSE posture: a single-use ticket scoped to the route's
    // @StreamScope, then a DIRECT gateway connection (never the BFF tunnel).
    const mint = calls.find((call) => call.url.includes('/api/auth/stream-ticket'));
    expect(mint?.body).toEqual({ scope: 'text_task:t-5531' });
    expect(source.url).toContain('/api/v1/text-generations/tasks/t-5531/stream');
    expect(source.url).toContain('ticket=');
    expect(source.url).not.toContain('/api/hope/');

    act(() => {
      source.open();
      source.emit('chunk', chunk('The patient presents'));
    });
    act(() => source.emit('chunk', chunk(' with a five-day history.')));

    expect(await screen.findByText(/The patient presents with a five-day history\./)).toBeDefined();
    expect(screen.getByText('Task running')).toBeDefined();
    expect(screen.getByText('2 tokens')).toBeDefined();

    act(() => {
      source.emit('usage', JSON.stringify({ type: 'usage', data: { prompt_tokens: 20, completion_tokens: 214, total_tokens: 234 } }));
      source.emit('done', JSON.stringify({ type: 'done', data: { finish_reason: 'stop' } }));
    });

    expect(await screen.findByText('Done')).toBeDefined();
    expect(screen.getByText('20 prompt \u00b7 214 completion \u00b7 234 total')).toBeDefined();
    expect(screen.getByText('stop')).toBeDefined();
    expect(screen.queryByText('Task running')).toBeNull();
    expect(source.closed).toBe(true);
  });

  it('cancels a running stream via POST text-generations/tasks/:taskId/cancel and stops the source', async () => {
    const calls = stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/hope/text-generations/generate' && call.method === 'POST') return Response.json(STREAM_ACK);
      if (parsed.pathname === '/api/hope/text-generations/tasks/t-5531/cancel' && call.method === 'POST') {
        return Response.json({
          task_id: 't-5531',
          status: 'cancelled',
          provider: 'azure-openai',
          model: 'gpt-5',
          retry_count: 0,
          max_retries: 3,
          created_at: '2026-07-06T10:00:00.000Z',
          total_chunks: 1,
          total_tokens: 1,
        });
      }
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    await screen.findByLabelText('Provider');
    await generateWithPrompt('Summarize');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => {
      source.open();
      source.emit('chunk', chunk('partial'));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.includes('/text-generations/tasks/t-5531/cancel'))).toBe(true));
    await waitFor(() => expect(source.closed).toBe(true));
    expect(await screen.findByText('Cancelled')).toBeDefined();
  });

  it('renders the designed 422 fail-closed panel (no model resolved) instead of a toast, with a retry', async () => {
    const calls = stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/hope/text-generations/generate' && call.method === 'POST') {
        return Response.json(
          {
            statusCode: 422,
            message: 'No text-generation model is configured for this tenant',
            error: 'Unprocessable Entity',
            // TASK-969 WS-3: the gateway relay for a real MODEL_NOT_SELECTED
            // 422 carries this code — the console branches the panel on it.
            error_code: 'MODEL_NOT_SELECTED',
          },
          { status: 422 },
        );
      }
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    await screen.findByLabelText('Provider');
    await generateWithPrompt('Summarize');

    const panel = await screen.findByRole('alert');
    expect(within(panel).getByText(/422/)).toBeDefined();
    expect(within(panel).getByText(/fail-closed/i)).toBeDefined();
    expect(within(panel).getByText(/no model resolved for this tenant/i)).toBeDefined();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(screen.getByText(/no effective model for this tenant/i)).toBeDefined();

    fireEvent.click(within(panel).getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/text-generations/generate')).length).toBe(2));
  });

  it('renders the content-not-clinical panel for a CONTENT_BLOCKED_NOT_MEDICAL 422, never the "no model resolved" copy', async () => {
    stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/hope/text-generations/generate' && call.method === 'POST') {
        return Response.json(
          {
            // The gateway's own fixed phrase for this code (never the upstream
            // TEXT `detail`, which can quote the prompt) — deliberately worded
            // differently from the panel's own title copy below, so the test
            // proves the TITLE is code-driven rather than an accidental
            // substring match against the message line.
            detail: 'TEXT rejected this request under the tenant guardrail policy.',
            error_code: 'CONTENT_BLOCKED_NOT_MEDICAL',
          },
          { status: 422 },
        );
      }
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    await screen.findByLabelText('Provider');
    await generateWithPrompt('hello');

    const panel = await screen.findByRole('alert');
    expect(within(panel).getByText('The prompt was not classified as clinical content.')).toBeDefined();
    expect(within(panel).getByText('TEXT rejected this request under the tenant guardrail policy.')).toBeDefined();
    expect(within(panel).queryByText(/no model resolved for this tenant/i)).toBeNull();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    // The footer status line names the real cause too, not the stale
    // "no effective model" text that used to be shown for every 422.
    expect(screen.getByText(/prompt not classified as clinical content/i)).toBeDefined();
  });

  it('renders a generic fail-closed explanation when the 422 carries no recognised error_code', async () => {
    stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/hope/text-generations/generate' && call.method === 'POST') {
        return Response.json({ detail: 'Something else went wrong upstream.' }, { status: 422 });
      }
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    await screen.findByLabelText('Provider');
    await generateWithPrompt('hello');

    const panel = await screen.findByRole('alert');
    expect(within(panel).getByText(/generation failed closed/i)).toBeDefined();
    expect(within(panel).queryByText(/no model resolved for this tenant/i)).toBeNull();
    expect(within(panel).queryByText(/not classified as clinical content/i)).toBeNull();
    expect(within(panel).getByText('Something else went wrong upstream.')).toBeDefined();
  });

  it('surfaces a transport drop as the designed reattach state and reads the task post-mortem', async () => {
    const calls = stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/hope/text-generations/generate' && call.method === 'POST') return Response.json(STREAM_ACK);
      if (parsed.pathname === '/api/hope/text-generations/tasks/t-5531' && call.method === 'GET') {
        return Response.json({
          task_id: 't-5531',
          status: 'failed',
          provider: 'azure-openai',
          model: 'gpt-5',
          retry_count: 1,
          max_retries: 3,
          created_at: '2026-07-06T10:00:00.000Z',
          error: 'provider timeout',
          total_chunks: 3,
          total_tokens: 3,
        });
      }
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    await screen.findByLabelText('Provider');
    await generateWithPrompt('Summarize');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => {
      FakeEventSource.instances[0].open();
      FakeEventSource.instances[0].fail();
    });

    expect(await screen.findByText('Dropped')).toBeDefined();
    // Frame 54 error variant: "task FAILED -> GET /text-generations/tasks/:taskId".
    await waitFor(() => expect(calls.some((call) => call.method === 'GET' && call.url.endsWith('/text-generations/tasks/t-5531'))).toBe(true));
    expect(await screen.findByText(/provider timeout/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Reattach stream' }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  });

  it('renders the cascade fallback (no picker) for an empty tenant catalog and omits provider/model from the body', async () => {
    let generateBody: unknown;
    stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/hope/text-generations/providers') return Response.json([]);
      if (parsed.pathname === '/api/hope/text-generations/generate' && call.method === 'POST') {
        generateBody = call.body;
        return Response.json(SYNC_RESULT);
      }
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    expect(await screen.findByText(/No provider catalog/)).toBeDefined();
    expect(screen.queryByLabelText('Provider')).toBeNull();
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.getByText('provider/model omitted → tenant default via HarnessPolicy cascade')).toBeDefined();

    fireEvent.click(screen.getByRole('switch', { name: 'Streaming mode' }));
    await generateWithPrompt('Summarize');
    await waitFor(() => expect(generateBody).toBeDefined());
    expect(generateBody).toEqual({ prompt: 'Summarize', temperature: 0.1, max_tokens: 32768, stream: false });
  });

  it('offers a model omit option that drops the model from the body (HarnessPolicy cascade)', async () => {
    let generateBody: unknown;
    stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/hope/text-generations/generate' && call.method === 'POST') {
        generateBody = call.body;
        return Response.json(SYNC_RESULT);
      }
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    const modelSelect = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: '' } });
    expect(screen.getByText('model omitted → tenant default via HarnessPolicy cascade')).toBeDefined();

    fireEvent.click(screen.getByRole('switch', { name: 'Streaming mode' }));
    await generateWithPrompt('Summarize');
    await waitFor(() => expect(generateBody).toBeDefined());
    // model is absent; the gateway cascade resolves the {provider, model} pair.
    expect(generateBody).toEqual({ prompt: 'Summarize', provider: 'azure-openai', temperature: 0.1, max_tokens: 32768, stream: false });
  });

  it('shows the request-summary strip with the effective settings and the live task id', async () => {
    stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/hope/text-generations/generate' && call.method === 'POST') return Response.json(STREAM_ACK);
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    await screen.findByLabelText('Provider');
    // The request-summary strip sits under the canvas header (the
    // playground banner moved to the top-bar persona control).
    const strip = (text: string) => screen.getByText((_, element) => element?.textContent === text);
    expect(strip('Provider azure-openai')).toBeDefined();
    expect(strip('model gpt-5')).toBeDefined();
    expect(strip('temp 0.1')).toBeDefined();
    expect(strip('max-tokens 32768')).toBeDefined();
    expect(screen.getByText('streaming')).toBeDefined();

    await generateWithPrompt('Summarize');
    expect(await screen.findByText((_, element) => element?.textContent === 'task t-5531')).toBeDefined();
  });

  it('finalizes a dropped stream from the task read when the task completed server-side', async () => {
    stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/hope/text-generations/generate' && call.method === 'POST') return Response.json(STREAM_ACK);
      if (parsed.pathname === '/api/hope/text-generations/tasks/t-5531' && call.method === 'GET') {
        return Response.json({
          task_id: 't-5531',
          status: 'completed',
          provider: 'azure-openai',
          model: 'gpt-5',
          retry_count: 0,
          max_retries: 3,
          created_at: '2026-07-06T10:00:00.000Z',
          content: 'Full recovered content.',
          usage: { prompt_tokens: 10, completion_tokens: 90, total_tokens: 100 },
          total_chunks: 12,
          total_tokens: 100,
        });
      }
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    await screen.findByLabelText('Provider');
    await generateWithPrompt('Summarize');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => {
      source.open();
      source.emit('chunk', chunk('partial'));
    });
    act(() => source.fail());

    // The post-mortem read finalizes the pane: full content, Done chip,
    // usage — the drop/reattach affordance is no longer relevant.
    expect(await screen.findByText('Full recovered content.')).toBeDefined();
    expect(await screen.findByText('Done')).toBeDefined();
    expect(screen.getByText('10 prompt \u00b7 90 completion \u00b7 100 total')).toBeDefined();
    expect(screen.getByText(/recovered via GET \/text-generations\/tasks/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Reattach stream' })).toBeNull();
    expect(screen.queryByText('Dropped')).toBeNull();
  });

  it('hides the assembled debug switch for non-admin roles', async () => {
    stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/auth/session') {
        return Response.json(session({ isElevated: false, roles: ['DOCTOR'], workingTenantId: null }));
      }
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Assembled mode' }));
    expect(await screen.findByLabelText('Type')).toBeDefined();
    expect(screen.queryByRole('switch', { name: /debug/i })).toBeNull();
  });

  it('sends debug: true for admins and renders the admin-only chip + assembly meta panel', async () => {
    let assembledBody: unknown;
    stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/hope/admin/prompt-templates' && call.method === 'GET') {
        return Response.json({ data: [{ id: 'tpl-1', name: 'Cardio Pre-Summary', scope: 'TENANT_DEFAULT' }], count: 1, limit: 20, page: 1 });
      }
      if (parsed.pathname === '/api/hope/text-generations/generate/assembled' && call.method === 'POST') {
        assembledBody = call.body;
        return Response.json({
          ...SYNC_RESULT,
          _debug: {
            assembled: true,
            type: 'pre-summary',
            prompt_template_id: 'tpl-1',
            prompt_template_name: 'Cardio pre-summary',
            prompt_length: 342,
            system_prompt_length: 128,
          },
        });
      }
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Assembled mode' }));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Patient reports chest pressure.' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Template' }));
    fireEvent.click(await screen.findByText('Cardio Pre-Summary — TENANT_DEFAULT'));
    fireEvent.click(screen.getByRole('switch', { name: /debug/i }));
    fireEvent.click(screen.getByRole('switch', { name: 'Streaming mode' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByText('Debug')).toBeDefined();
    expect(assembledBody).toMatchObject({
      type: 'pre-summary',
      message: 'Patient reports chest pressure.',
      prompt_template_id: 'tpl-1',
      debug: true,
      stream: false,
    });
    expect(screen.getByText('Cardio pre-summary')).toBeDefined();
    expect(screen.getByText('342')).toBeDefined();
  });

  it('offers the __GLOBAL__ catalog switch to elevated sessions only and refetches with tenantKey', async () => {
    const calls = stubLlm();
    renderWithProviders(<PlaygroundLlmScreen />);

    const globalSwitch = await screen.findByRole('switch', { name: /Global catalog/ });
    fireEvent.click(globalSwitch);

    await waitFor(() => expect(calls.some((call) => call.url.includes('/api/hope/text-generations/providers?tenantKey=__GLOBAL__'))).toBe(true));
    await waitFor(() => expect(calls.some((call) => call.url.includes('/api/hope/text-generations/guardrail-providers?tenantKey=__GLOBAL__'))).toBe(true));
  });

  it('hides the __GLOBAL__ switch for tenant-bound sessions', async () => {
    stubLlm((call, parsed) => {
      if (parsed.pathname === '/api/auth/session') {
        return Response.json(session({ isElevated: false, roles: ['TENANT_ADMIN'], workingTenantId: null }));
      }
      return undefined;
    });
    renderWithProviders(<PlaygroundLlmScreen />);

    await screen.findByLabelText('Provider');
    expect(screen.queryByRole('switch', { name: /__GLOBAL__/ })).toBeNull();
  });

  /**
   * TASK-970 — per-run reasoning control.
   *
   * The case that matters most is `inherit`: it must send NO `reasoning` key at all,
   * so the gateway applies the platform tier. Sending `{enabled:true}` to mean
   * "inherit" would silently pin every playground run to reasoning ON — which is the
   * class of bug this whole ticket exists to remove.
   */
  describe('reasoning posture (TASK-970)', () => {
    async function bodyForReasoning(prepare: () => void): Promise<Record<string, unknown>> {
      let generateBody: Record<string, unknown> = {};
      stubLlm((call, parsed) => {
        if (parsed.pathname === '/api/hope/text-generations/generate' && call.method === 'POST') {
          generateBody = call.body as Record<string, unknown>;
          return Response.json(SYNC_RESULT);
        }
        return undefined;
      });
      renderWithProviders(<PlaygroundLlmScreen />);
      await screen.findByLabelText('Provider');
      fireEvent.click(screen.getByRole('switch', { name: 'Streaming mode' }));
      prepare();
      await generateWithPrompt('hello');
      return generateBody;
    }

    it('defaults to the platform default and sends NO reasoning field', async () => {
      const body = await bodyForReasoning(() => undefined);
      expect('reasoning' in body).toBe(false);
    });

    it('sends an explicit off when the admin pins it', async () => {
      const body = await bodyForReasoning(() => {
        fireEvent.change(screen.getByLabelText('Reasoning / thinking'), { target: { value: 'off' } });
      });
      expect(body.reasoning).toEqual({ enabled: false });
    });

    it('sends on with no effort when the engine should pick the budget', async () => {
      const body = await bodyForReasoning(() => {
        fireEvent.change(screen.getByLabelText('Reasoning / thinking'), { target: { value: 'on' } });
      });
      expect(body.reasoning).toEqual({ enabled: true });
    });

    it('sends on with a named effort', async () => {
      const body = await bodyForReasoning(() => {
        fireEvent.change(screen.getByLabelText('Reasoning / thinking'), { target: { value: 'on' } });
        fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'high' } });
      });
      expect(body.reasoning).toEqual({ enabled: true, effort: 'high' });
    });

    it('hides the effort picker unless reasoning is on', async () => {
      stubLlm(() => undefined);
      renderWithProviders(<PlaygroundLlmScreen />);
      await screen.findByLabelText('Provider');
      expect(screen.queryByLabelText('Effort')).toBeNull();
      fireEvent.change(screen.getByLabelText('Reasoning / thinking'), { target: { value: 'on' } });
      expect(screen.getByLabelText('Effort')).toBeDefined();
      fireEvent.change(screen.getByLabelText('Reasoning / thinking'), { target: { value: 'off' } });
      expect(screen.queryByLabelText('Effort')).toBeNull();
    });
  });

});
