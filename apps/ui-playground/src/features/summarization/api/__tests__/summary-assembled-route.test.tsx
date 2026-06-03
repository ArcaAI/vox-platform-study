/**
 * F2 (TASK-331 doc-07) — the DEFAULT (non-debug) summary generation must post to
 * the ID-based assembled route (`/text/generate/assembled`), not the raw
 * `/text/generate` route. The assembled route is the one the backend ownership
 * guard protects (per-context-item cross-tenant + cross-doctor DNA checks) and
 * it resolves the prompt template / DNA style / context items by ID server-side
 * instead of inlining raw DNA text + template + concatenated context content
 * (the X3 anti-pattern TASK-329 removed).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Mock the SMR client so we can assert the exact route + payload without any
// real network / store wiring (mirrors how the request layer is exercised
// elsewhere in the summarization tests).
vi.mock('../smr-client', () => ({
  SmrApiError: class SmrApiError extends Error {},
  smrClient: { post: vi.fn() },
}));

import { smrClient } from '../smr-client';
import { useGenerateSummaryAssembled } from '../summarization';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useGenerateSummaryAssembled (F2 — default summary via assembled/ID route)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (smrClient.post as Mock).mockResolvedValue({
      task_id: 't-1',
      status: 'completed',
      content: 'summary',
      provider: 'ollama',
      model: 'm',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      latency_ms: 1,
      finish_reason: 'stop',
      created_at: new Date().toISOString(),
    });
  });

  it('posts to /text/generate/assembled with prompt_template_id + dna_writing_style_id + context_item_ids (no raw text)', async () => {
    const { result } = renderHook(() => useGenerateSummaryAssembled(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        type: 'summary',
        context_item_ids: ['ctx-a', 'ctx-b'],
        prompt_template_id: 'tpl-1',
        dna_writing_style_id: 'dna-1',
        provider: 'ollama',
        temperature: 0.4,
        max_tokens: 4096,
      });
    });

    expect(smrClient.post).toHaveBeenCalledTimes(1);
    const [path, body] = (smrClient.post as Mock).mock.calls[0] as [string, Record<string, unknown>];

    // Default summary generation goes through the assembled/ID route, not raw `/text/generate`.
    expect(path).toBe('/text/generate/assembled');

    // IDs are sent so the backend resolves + ownership-checks them server-side.
    expect(body.type).toBe('summary');
    expect(body.context_item_ids).toEqual(['ctx-a', 'ctx-b']);
    expect(body.prompt_template_id).toBe('tpl-1');
    expect(body.dna_writing_style_id).toBe('dna-1');
    expect(body.stream).toBe(false);

    // The X3 anti-pattern (raw inlined DNA text / template / context) must NOT be present.
    expect(body.prompt).toBeUndefined();
    expect(body.system_prompt).toBeUndefined();
  });
});
