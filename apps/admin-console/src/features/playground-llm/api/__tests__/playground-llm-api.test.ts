import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelTask,
  generateAssembled,
  generateText,
  getTask,
  listGuardrailProviders,
  listProviders,
  taskStreamPath,
  taskStreamScope,
} from '../client';
import { playgroundLlmKeys } from '../keys';
import { isStreamingAck } from '../types';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetchMock(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return Response.json({ success: true });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('playgroundLlmKeys', () => {
  it('separates the tenant and __GLOBAL__ catalogs and the per-task reads', () => {
    expect(playgroundLlmKeys.providers()).toEqual(playgroundLlmKeys.providers());
    expect(playgroundLlmKeys.providers()).not.toEqual(playgroundLlmKeys.providers('__GLOBAL__'));
    expect(playgroundLlmKeys.guardrailProviders('__GLOBAL__')).not.toEqual(playgroundLlmKeys.providers('__GLOBAL__'));
    expect(playgroundLlmKeys.task('t-1')).not.toEqual(playgroundLlmKeys.task('t-2'));
    expect(playgroundLlmKeys.task('t-1')[0]).toBe('playground-llm');
  });
});

describe('playground-llm client', () => {
  it('lists text-generation providers from the tenant catalog, with the explicit __GLOBAL__ override', async () => {
    const calls = installFetchMock();
    await listProviders();
    await listProviders('__GLOBAL__');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/text/providers',
      'GET /api/hope/text/providers?tenantKey=__GLOBAL__',
    ]);
  });

  it('lists guardrail providers on the sibling route', async () => {
    const calls = installFetchMock();
    await listGuardrailProviders();
    await listGuardrailProviders('__GLOBAL__');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/text/guardrail-providers',
      'GET /api/hope/text/guardrail-providers?tenantKey=__GLOBAL__',
    ]);
  });

  it('POSTs the snake_case generate body verbatim (text-generation Pydantic contract)', async () => {
    const calls = installFetchMock();
    await generateText({
      prompt: 'Summarize',
      system_prompt: 'You are a clinical summarizer.',
      provider: 'azure-openai',
      model: 'gpt-5',
      temperature: 0.2,
      max_tokens: 1024,
      stream: true,
    });
    expect(calls).toHaveLength(1);
    expect(`${calls[0].method} ${calls[0].url}`).toBe('POST /api/hope/text/generate');
    expect(calls[0].body).toEqual({
      prompt: 'Summarize',
      system_prompt: 'You are a clinical summarizer.',
      provider: 'azure-openai',
      model: 'gpt-5',
      temperature: 0.2,
      max_tokens: 1024,
      stream: true,
    });
  });

  it('POSTs the assembled body with exactly-one context source untouched', async () => {
    const calls = installFetchMock();
    await generateAssembled({
      type: 'pre-summary',
      visit_type: 'new_visit',
      message: 'Chest pressure.',
      prompt_template_id: 'tpl-1',
      dna_writing_style_id: 'dna-1',
      debug: true,
      stream: false,
    });
    expect(`${calls[0].method} ${calls[0].url}`).toBe('POST /api/hope/text/generate/assembled');
    expect(calls[0].body).toEqual({
      type: 'pre-summary',
      visit_type: 'new_visit',
      message: 'Chest pressure.',
      prompt_template_id: 'tpl-1',
      dna_writing_style_id: 'dna-1',
      debug: true,
      stream: false,
    });
  });

  it('reads and cancels a task by id', async () => {
    const calls = installFetchMock();
    await getTask('t-5531');
    await cancelTask('t-5531');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/text/tasks/t-5531', 'POST /api/hope/text/tasks/t-5531/cancel']);
  });

  it('builds the gateway stream path + ticket scope (never a BFF-proxied stream URL)', () => {
    expect(taskStreamPath('t-5531')).toBe('text/tasks/t-5531/stream');
    expect(taskStreamPath('t 1')).toBe('text/tasks/t%201/stream');
    // Must match @StreamScope({ namespace: 'text_task', param: 'taskId' }).
    expect(taskStreamScope('t-5531')).toBe('text_task:t-5531');
    expect(taskStreamPath('t-5531')).not.toContain('/api/hope/');
  });
});

describe('isStreamingAck', () => {
  it('discriminates the streaming acknowledgement from the sync body', () => {
    expect(isStreamingAck({ task_id: 't-1', status: 'queued', stream_url: '/api/v1/tasks/t-1/stream', created_at: 'now' })).toBe(true);
    expect(
      isStreamingAck({
        task_id: 't-1',
        status: 'completed',
        content: 'Done.',
        provider: 'azure-openai',
        model: 'gpt-5',
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        latency_ms: 10,
        finish_reason: 'stop',
        created_at: 'now',
      }),
    ).toBe(false);
  });
});
