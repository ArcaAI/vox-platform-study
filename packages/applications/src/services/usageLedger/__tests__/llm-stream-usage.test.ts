/**
 * TASK-890 L11 (§3.13) — the ONE SSE terminal-frame usage tee.
 *
 * Four production paths relay an `apps/text` SSE stream to a caller and must
 * bill what crossed the wire: the playground proxy (which owned this logic
 * first), the agent invocation route, the prompt test-run and the draft-agent
 * test. Four copies of a frame scanner is four places for a dropped tail to
 * become lost revenue silently, so the scanner lives here and every path tees
 * the same way.
 */
import { describe, expect, it } from 'vitest';

import { LlmStreamUsageCollector } from '../llm-stream-usage';

const TENANT = '50000000-0000-0000-0000-000000000000';

/** The terminal frame `apps/text` emits: `data:` + `{ data: { usage: <usage_detail> } }`. */
function terminalFrame(overrides: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({
    data: {
      usage: {
        task_id: 'task-1',
        request_id: 'req-1',
        provider: 'openai_compat',
        model: 'lms-gemma-4-e2b-it-qat',
        endpoint_kind: 'openai.chat',
        interrupted: false,
        byok: false,
        occurred_at: '2026-09-06T10:00:00.000Z',
        prompt_tokens: 120,
        completion_tokens: 40,
        ...overrides,
      },
    },
  })}\n\n`;
}

describe('LlmStreamUsageCollector — scanning', () => {
  it('yields one ledger batch from a stream whose terminal frame carries usage', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe(Buffer.from('data: {"data":{"delta":"Pati"}}\n\n'));
    collector.observe(Buffer.from(terminalFrame()));

    const batch = collector.take({ tenantId: TENANT, operation: 'generate.stream', trigger: 'AGENT_INVOCATION' });
    expect(batch).not.toBeNull();
    expect(batch!.common.operation).toBe('generate.stream');
    // `openai_compat` is an apps/text spelling; the ledger dimension is `lm-studio`.
    expect(batch!.common.provider).toBe('lm-studio');
    expect(batch!.common.attributesJson).toMatchObject({ trigger: 'AGENT_INVOCATION', interrupted: false });
    expect(batch!.units.length).toBeGreaterThan(0);
  });

  it('emits ONCE — teardown fires from `end`, `error` and client `close`', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe(terminalFrame());
    expect(collector.take({ tenantId: TENANT, operation: 'generate.stream' })).not.toBeNull();
    expect(collector.take({ tenantId: TENANT, operation: 'generate.stream' })).toBeNull();
  });

  it('reassembles a frame split across chunk boundaries', () => {
    const frame = terminalFrame();
    const collector = new LlmStreamUsageCollector();
    collector.observe(frame.slice(0, 40));
    collector.observe(frame.slice(40));
    expect(collector.take({ tenantId: TENANT, operation: 'generate.stream' })).not.toBeNull();
  });

  it('records `interrupted: true` when the caller tears the stream down early', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe(terminalFrame());
    const batch = collector.take({ tenantId: TENANT, operation: 'generate.stream', interrupted: true });
    expect(batch!.common.attributesJson).toMatchObject({ interrupted: true });
  });

  it('returns null when no terminal usage frame ever arrived — never a row saying "nothing happened"', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe('data: {"data":{"delta":"hello"}}\n\n');
    expect(collector.take({ tenantId: TENANT, operation: 'generate.stream' })).toBeNull();
  });

  it('never JSON-parses a token chunk (frame bodies are generated clinical text)', () => {
    const collector = new LlmStreamUsageCollector();
    // Deliberately non-JSON after `data:` — a parse attempt would throw, and a
    // throw inside a stream `data` handler kills the relay.
    expect(() => collector.observe('data: not json at all\n\n')).not.toThrow();
    expect(collector.take({ tenantId: TENANT, operation: 'generate.stream' })).toBeNull();
  });

  it('bounds the carry-over so a malformed stream cannot grow memory without limit', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe('x'.repeat(70_000));
    expect(collector.pendingBytes).toBe(0);
  });

  it('carries the attribution columns through to the batch', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe(terminalFrame());
    const batch = collector.take({
      tenantId: TENANT,
      operation: 'generate.stream',
      consultationId: 'c1',
      doctorId: 'd1',
      departmentId: 'dept-1',
    });
    expect(batch!.common).toMatchObject({ consultationId: 'c1', doctorId: 'd1', departmentId: 'dept-1' });
  });
});
