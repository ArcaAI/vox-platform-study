/**
 * Frame 54 — LLM Playground. fetch is stubbed at the network boundary by
 * pathname (the api layer has its own tests) and EventSource by a
 * FakeEventSource global. Covers the row 38 contract: providers picker
 * (availability + default preselection), sync generate (content + usage +
 * latency + finish), the streaming flow over the BFF-proxied SSE (chunk
 * append, done finalize, cancel), the designed 422 fail-closed panel, the
 * assembled debug admin gate, the __GLOBAL__ catalog switch and the NoTenant
 * gate.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { GenerateTextResponse, SmrProvider, StreamingGenerateAck } from '../../api/types';
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
    const { roles = ['GLOBAL_ADMIN'], ...rest } = overrides;
    return {
        user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles, tenantId: null },
        isElevated: true,
        workingTenantId: 't-1',
        workingTenantName: 'Sunrise Medical Group',
        impersonatingUserId: null,
        impersonatingUsername: null,
        ...rest,
    };
}

const PROVIDERS: SmrProvider[] = [
    { name: 'azure-openai', models: [{ name: 'gpt-5', size: '' }, { name: 'gpt-5-mini', size: '' }], is_available: true, is_default: true, default_model: 'gpt-5' },
    { name: 'anthropic', models: [{ name: 'claude-4.5', size: '' }], is_available: false },
    { name: 'vertex', models: [{ name: 'gemini-3', size: '4b' }], is_available: true },
];

const GUARDRAILS: SmrProvider[] = [
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

function defaultHandler(call: RecordedCall, parsed: URL): Response | undefined {
    if (call.method !== 'GET') return undefined;
    const path = parsed.pathname;
    if (path === '/api/auth/session') return Response.json(session());
    if (path === '/api/hope/text/providers') return Response.json(PROVIDERS);
    if (path === '/api/hope/text/guardrail-providers') return Response.json(GUARDRAILS);
    return undefined;
}

function stubLlm(custom: FetchHandler = () => undefined): RecordedCall[] {
    return stubFetch((call, parsed) => custom(call, parsed) ?? defaultHandler(call, parsed));
}

/** Fills the prompt and presses the header Generate action. */
async function generateWithPrompt(prompt: string): Promise<void> {
    fireEvent.change(await screen.findByLabelText(/^Prompt/), { target: { value: prompt } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
}

function chunk(content: string): string {
    return JSON.stringify({ type: 'chunk', content, data: null });
}

beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('PlaygroundLlmScreen', () => {
    it('gates an elevated session without a working tenant and fires no text/* query', async () => {
        const calls = stubLlm((call, parsed) => {
            if (parsed.pathname === '/api/auth/session') return Response.json(session({ workingTenantId: null }));
            return undefined;
        });
        renderWithProviders(<PlaygroundLlmScreen />);

        expect(await screen.findByText('Select a working tenant')).toBeDefined();
        expect(screen.getByRole('heading', { level: 1, name: 'LLM Playground' })).toBeDefined();
        expect(calls.filter((call) => call.url.includes('/api/hope/text/'))).toHaveLength(0);
    });

    it('keeps the layout skeleton while the session is loading', () => {
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
        const { container } = renderWithProviders(<PlaygroundLlmScreen />);

        expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
        expect(screen.getByRole('heading', { level: 1, name: 'LLM Playground' })).toBeDefined();
    });

    it('renders the provider picker from text/providers: default preselected, unavailable options disabled', async () => {
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
            if (parsed.pathname === '/api/hope/text/generate' && call.method === 'POST') {
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
            temperature: 0.2,
            max_tokens: 1024,
            stream: false,
        });
        expect(screen.getByText('42 prompt \u00b7 128 completion \u00b7 170 total')).toBeDefined();
        expect(screen.getByText('1,840 ms')).toBeDefined();
        expect(screen.getByText('stop')).toBeDefined();
        expect(screen.getByText('azure-openai \u00b7 gpt-5')).toBeDefined();
    });

    it('streams tokens over the BFF-proxied SSE: chunks append live, usage/done finalize', async () => {
        const calls = stubLlm((call, parsed) => {
            if (parsed.pathname === '/api/hope/text/generate' && call.method === 'POST') return Response.json(STREAM_ACK);
            return undefined;
        });
        renderWithProviders(<PlaygroundLlmScreen />);

        await screen.findByLabelText('Provider');
        // Streaming is the default mode — no switch flip.
        await generateWithPrompt('Summarize the visit');

        await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
        const source = FakeEventSource.instances[0];
        // Same-origin BFF proxy with cookie auth; NO stream ticket is minted
        // (the gateway route has no @StreamScope, tickets would 401).
        expect(source.url).toBe('/api/hope/text/tasks/t-5531/stream');
        expect(calls.some((call) => call.url.includes('/api/auth/stream-ticket'))).toBe(false);

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

    it('cancels a running stream via POST text/tasks/:taskId/cancel and stops the source', async () => {
        const calls = stubLlm((call, parsed) => {
            if (parsed.pathname === '/api/hope/text/generate' && call.method === 'POST') return Response.json(STREAM_ACK);
            if (parsed.pathname === '/api/hope/text/tasks/t-5531/cancel' && call.method === 'POST') {
                return Response.json({ task_id: 't-5531', status: 'cancelled', provider: 'azure-openai', model: 'gpt-5', retry_count: 0, max_retries: 3, created_at: '2026-07-06T10:00:00.000Z', total_chunks: 1, total_tokens: 1 });
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

        await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.includes('/text/tasks/t-5531/cancel'))).toBe(true));
        await waitFor(() => expect(source.closed).toBe(true));
        expect(await screen.findByText('Cancelled')).toBeDefined();
    });

    it('renders the designed 422 fail-closed panel (no model resolved) instead of a toast, with a retry', async () => {
        const calls = stubLlm((call, parsed) => {
            if (parsed.pathname === '/api/hope/text/generate' && call.method === 'POST') {
                return Response.json({ statusCode: 422, message: 'No SMR model is configured for this tenant', error: 'Unprocessable Entity' }, { status: 422 });
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

        fireEvent.click(within(panel).getByRole('button', { name: /retry/i }));
        await waitFor(() => expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/text/generate')).length).toBe(2));
    });

    it('surfaces a transport drop as the designed reattach state and reads the task post-mortem', async () => {
        const calls = stubLlm((call, parsed) => {
            if (parsed.pathname === '/api/hope/text/generate' && call.method === 'POST') return Response.json(STREAM_ACK);
            if (parsed.pathname === '/api/hope/text/tasks/t-5531' && call.method === 'GET') {
                return Response.json({ task_id: 't-5531', status: 'failed', provider: 'azure-openai', model: 'gpt-5', retry_count: 1, max_retries: 3, created_at: '2026-07-06T10:00:00.000Z', error: 'provider timeout', total_chunks: 3, total_tokens: 3 });
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
        // Frame 54 error variant: "task FAILED -> GET /text/tasks/:taskId".
        await waitFor(() => expect(calls.some((call) => call.method === 'GET' && call.url.endsWith('/text/tasks/t-5531'))).toBe(true));
        expect(await screen.findByText(/provider timeout/)).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: 'Reattach stream' }));
        await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    });

    it('renders the cascade fallback (no picker) for an empty tenant catalog and omits provider/model from the body', async () => {
        let generateBody: unknown;
        stubLlm((call, parsed) => {
            if (parsed.pathname === '/api/hope/text/providers') return Response.json([]);
            if (parsed.pathname === '/api/hope/text/generate' && call.method === 'POST') {
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
        expect(generateBody).toEqual({ prompt: 'Summarize', temperature: 0.2, max_tokens: 1024, stream: false });
    });

    it('offers a model omit option that drops the model from the body (HarnessPolicy cascade)', async () => {
        let generateBody: unknown;
        stubLlm((call, parsed) => {
            if (parsed.pathname === '/api/hope/text/generate' && call.method === 'POST') {
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
        expect(generateBody).toEqual({ prompt: 'Summarize', provider: 'azure-openai', temperature: 0.2, max_tokens: 1024, stream: false });
    });

    it('shows the request-summary strip with the effective settings and the live task id', async () => {
        stubLlm((call, parsed) => {
            if (parsed.pathname === '/api/hope/text/generate' && call.method === 'POST') return Response.json(STREAM_ACK);
            return undefined;
        });
        renderWithProviders(<PlaygroundLlmScreen />);

        await screen.findByLabelText('Provider');
        expect(screen.getByText('Provider: azure-openai')).toBeDefined();
        expect(screen.getByText('model gpt-5')).toBeDefined();
        expect(screen.getByText('temp 0.2')).toBeDefined();
        expect(screen.getByText('max-tokens 1024')).toBeDefined();
        expect(screen.getByText('streaming')).toBeDefined();

        await generateWithPrompt('Summarize');
        expect(await screen.findByText('task t-5531')).toBeDefined();
    });

    it('finalizes a dropped stream from the task read when the task completed server-side', async () => {
        stubLlm((call, parsed) => {
            if (parsed.pathname === '/api/hope/text/generate' && call.method === 'POST') return Response.json(STREAM_ACK);
            if (parsed.pathname === '/api/hope/text/tasks/t-5531' && call.method === 'GET') {
                return Response.json({ task_id: 't-5531', status: 'completed', provider: 'azure-openai', model: 'gpt-5', retry_count: 0, max_retries: 3, created_at: '2026-07-06T10:00:00.000Z', content: 'Full recovered content.', usage: { prompt_tokens: 10, completion_tokens: 90, total_tokens: 100 }, total_chunks: 12, total_tokens: 100 });
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
        expect(screen.getByText(/recovered via GET \/text\/tasks/)).toBeDefined();
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
            if (parsed.pathname === '/api/hope/text/generate/assembled' && call.method === 'POST') {
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
        fireEvent.change(screen.getByLabelText('Template ID'), { target: { value: 'tpl-1' } });
        fireEvent.click(screen.getByRole('switch', { name: /debug/i }));
        fireEvent.click(screen.getByRole('switch', { name: 'Streaming mode' }));
        fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

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

        const globalSwitch = await screen.findByRole('switch', { name: /__GLOBAL__/ });
        fireEvent.click(globalSwitch);

        await waitFor(() => expect(calls.some((call) => call.url.includes('/api/hope/text/providers?tenantKey=__GLOBAL__'))).toBe(true));
        await waitFor(() => expect(calls.some((call) => call.url.includes('/api/hope/text/guardrail-providers?tenantKey=__GLOBAL__'))).toBe(true));
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
});
