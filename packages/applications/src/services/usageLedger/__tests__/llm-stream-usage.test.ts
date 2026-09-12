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

/**
 * J3-3 — the wire is CRLF, and the scanner was looking for LF LF.
 *
 * `apps/text` streams through `sse_starlette`, which frames with `\r\n` (verified with `od -c`
 * on a captured `/generate` stream: `id: …\r\nevent: done\r\ndata: {…}\r\n\r\n`). `\r\n\r\n`
 * contains no two consecutive `\n`, so `indexOf('\n\n')` never matched: NOT ONE frame was ever
 * parsed, the carry-over grew past the 64 KB bound and was silently discarded, `take()` returned
 * `null`, and the emit path returned early without a warning.
 *
 * Measured on dev: the same agent invocation billed 2 ledger rows at `?mode=blocking` and 0 at
 * `?mode=stream` — a tenant got unlimited un-metered LLM spend by choosing the streaming mode,
 * and the monthly rollup never saw it. All four consumers of this collector inherit the fix
 * (playground proxy, agent invocation, prompt-template bench, draft-agent test), which is the
 * point of the collector being shared.
 *
 * Normalisation happens on the CONCATENATED tail rather than per chunk, because a CRLF pair can
 * itself straddle a chunk boundary.
 */
describe('LlmStreamUsageCollector — CRLF framing (the wire `apps/text` actually writes)', () => {
  /** One frame exactly as `sse_starlette` writes it: `id` / `event` / `data`, CRLF throughout. */
  function crlfFrame(event: string, data: unknown, id = 'f113dfb6-d4e9-4999-af18-6898633b2955:9'): string {
    return `id: ${id}\r\nevent: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
  }

  const CRLF_USAGE = {
    data: {
      usage: {
        task_id: 'task-1',
        request_id: 'ec47f723-0d0b-4a9c-ab50-52ad096c4f21',
        provider: 'lm-studio',
        model: 'lms-gemma-4-e2b-it-qat',
        endpoint_kind: 'lmstudio.chat',
        interrupted: false,
        byok: false,
        cost_basis: 'INTERNAL',
        occurred_at: '2026-09-06T22:27:37.491776+00:00',
        prompt_tokens: 827,
        completion_tokens: 869,
        total_tokens: 1696,
      },
    },
  };

  it('meters a CRLF-framed stream — the shape the captured dev stream had', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe(crlfFrame('meta', { generation_id: 'f113dfb6' }));
    collector.observe(crlfFrame('token', { type: 'token', content: 'Patient' }));
    collector.observe(crlfFrame('done', CRLF_USAGE));

    expect(collector.hasUsage).toBe(true);
    const batch = collector.take({ tenantId: TENANT, operation: 'generate.stream', trigger: 'AGENT_INVOCATION' });
    expect(batch).not.toBeNull();
    expect(batch!.units.map((unit) => unit.quantity)).toEqual(expect.arrayContaining([827, 869]));
  });

  it('does not let the carry-over grow — the bound used to eat the whole stream', () => {
    const collector = new LlmStreamUsageCollector();
    for (let index = 0; index < 200; index += 1) collector.observe(crlfFrame('token', { type: 'token', content: 'x'.repeat(400) }));
    expect(collector.pendingBytes).toBe(0);
    collector.observe(crlfFrame('done', CRLF_USAGE));
    expect(collector.take({ tenantId: TENANT, operation: 'generate.stream' })).not.toBeNull();
  });

  it('reassembles when the CRLF pair itself straddles a chunk boundary', () => {
    const frame = crlfFrame('done', CRLF_USAGE);
    const cut = frame.length - 3; // ... \r | \n \r \n
    const collector = new LlmStreamUsageCollector();
    collector.observe(frame.slice(0, cut));
    collector.observe(frame.slice(cut));
    expect(collector.take({ tenantId: TENANT, operation: 'generate.stream' })).not.toBeNull();
  });

  it('still meters an LF-framed stream — normalising must not cost the other wire', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe(terminalFrame());
    expect(collector.take({ tenantId: TENANT, operation: 'generate.stream' })).not.toBeNull();
  });
});

/**
 * TASK-957 F-3 / TASK-959 — the guardrail block on the terminal frame.
 *
 * The blocking `/generate` response has always carried `guardrail_usage`, and
 * only the consultation-summary paths recorded it; the STREAM carried none at
 * all, so no stream consumer could. `apps/text` now puts it on all three
 * terminal frames, and this collector is the one tee that sees them — which
 * makes it the only place a stream's guardrail COGS can be picked up.
 */
describe('LlmStreamUsageCollector — guardrail usage on the terminal frame', () => {
  const TENANT = '50000000-0000-0000-0000-000000000000';

  const frame = (data: unknown): string => `event: done\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;

  const terminal = (overrides: Record<string, unknown> = {}) => ({
    data: {
      usage: {
        endpoint_kind: 'openai.chat',
        task_id: 'task-1',
        provider: 'openai',
        model: 'gpt-5',
        prompt_tokens: 100,
        completion_tokens: 20,
        total_ms: 2500,
      },
      ...overrides,
    },
  });

  const guardrailBlock = {
    endpoint_kind: 'openai.chat',
    task_id: 'guard-1',
    provider: 'openai',
    model: 'gpt-5-mini',
    prompt_tokens: 40,
    completion_tokens: 4,
    total_ms: 300,
  };

  it('returns the guardrail batch beside the generation batch', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe(frame(terminal({ guardrail_usage: guardrailBlock })));

    const taken = collector.takeAll({ tenantId: TENANT, operation: 'generate.stream' });

    expect(taken?.generation?.batch.common.operation).toBe('generate.stream');
    expect(taken?.guardrail?.batch.common.operation).toBe('guardrail.validate');
    expect(taken?.guardrail?.batch.common.requestId).toBe('guard-1');
  });

  it('returns a null guardrail half when the frame carried none — the common case', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe(frame(terminal()));

    const taken = collector.takeAll({ tenantId: TENANT, operation: 'generate.stream' });

    expect(taken?.generation).not.toBeNull();
    expect(taken?.guardrail).toBeNull();
  });

  it('answers ONCE — a teardown firing from end, error and close bills one stream once', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe(frame(terminal({ guardrail_usage: guardrailBlock })));

    expect(collector.takeAll({ tenantId: TENANT, operation: 'generate.stream' })).not.toBeNull();
    expect(collector.takeAll({ tenantId: TENANT, operation: 'generate.stream' })).toBeNull();
    expect(collector.take({ tenantId: TENANT, operation: 'generate.stream' })).toBeNull();
  });

  it('carries the caller’s trigger onto BOTH halves — a guardrail row is caused by the same activity', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe(frame(terminal({ guardrail_usage: guardrailBlock })));

    const taken = collector.takeAll({ tenantId: TENANT, operation: 'generate.stream', trigger: 'AGENT_INVOCATION' });

    expect(taken?.generation?.batch.common.attributesJson?.trigger).toBe('AGENT_INVOCATION');
    expect(taken?.guardrail?.batch.common.attributesJson?.trigger).toBe('AGENT_INVOCATION');
  });

  it('does not force the interrupted override onto the guardrail row — the guard call completed', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe(frame(terminal({ guardrail_usage: guardrailBlock })));

    const taken = collector.takeAll({ tenantId: TENANT, operation: 'generate.stream', interrupted: true });

    expect(taken?.generation?.batch.common.attributesJson?.interrupted).toBe(true);
    expect(taken?.guardrail?.batch.common.attributesJson?.interrupted).toBe(false);
  });

  it('keeps `take()` answering exactly what it always did', () => {
    const collector = new LlmStreamUsageCollector();
    collector.observe(frame(terminal({ guardrail_usage: guardrailBlock })));

    const batch = collector.take({ tenantId: TENANT, operation: 'generate.stream' });

    expect(batch?.common.operation).toBe('generate.stream');
    expect(batch?.units.length).toBeGreaterThan(0);
  });
});
