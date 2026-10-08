/**
 * TASK-1050 finding D — the DNA writing-style analysis call names, for its guardrail evaluation,
 * the agent that serves it (`agent_slug`): the platform analyst on the production branch, the
 * selection's agent on the legacy one. It names no consultation — the corpus spans many.
 *
 * The REAL `TextRequestEnrichmentService` builds the body; `callText` is driven directly.
 */
import { describe, expect, it, vi } from 'vitest';
import { DnaWritingStyleProcessor } from '../dna-writing-style.processor';
import { TextRequestEnrichmentService } from '../../text-request/text-request-enrichment.service';

const TENANT = 'tenant-1';

function build(harnessPolicyService?: unknown) {
  const post = vi.fn().mockResolvedValue({ data: { content: '{}' } });
  const args: unknown[] = new Array(30).fill(undefined);
  args[9] = { axiosRef: { post } };
  args[10] = { get: vi.fn(() => 'http://text.test') };
  args[11] = { recordTextCallDuration: vi.fn() };
  args[12] = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };
  args[14] = harnessPolicyService;
  args[18] = new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined);
  const processor = new (DnaWritingStyleProcessor as unknown as new (...a: unknown[]) => DnaWritingStyleProcessor)(...args);
  const callText = (processor as unknown as { callText: (...a: unknown[]) => Promise<unknown> }).callText.bind(processor);
  return { post, callText };
}

const lastHeaders = (post: ReturnType<typeof vi.fn>) => (post.mock.calls.at(-1)?.[2] as { headers: Record<string, string> }).headers;

describe('DNA analysis — guardrail attribution on the TEXT call', () => {
  it('the platform analyst branch names the analyst agent', async () => {
    const { post, callText } = build();
    await callText('samples', 'system', null, {
      agent: { slug: 'dna-writing-style-analyst' },
      primary: { agent: { slug: 'dna-writing-style-analyst' }, provider: 'lm-studio', model: 'gemma', parameters: {} },
    });
    expect((post.mock.calls.at(-1)?.[1] as Record<string, unknown>).agent_slug).toBe('dna-writing-style-analyst');
    expect(lastHeaders(post)['X-Hope-Consultation-Id']).toBeUndefined();
  });

  it('the legacy selection branch names the selection`s agent', async () => {
    const { post, callText } = build({
      resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'gemma', agentSlug: 'platform-summarization' }),
    });
    await callText('samples', 'system', null, null);
    expect((post.mock.calls.at(-1)?.[1] as Record<string, unknown>).agent_slug).toBe('platform-summarization');
  });
});
