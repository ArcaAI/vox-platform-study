/**
 * Backend PHI log redaction.
 *
 * The logging package DECLARED `redactFields?: string[]` on its config type
 * (`transports/types.ts`) and never read it — zero call sites. So on a
 * multi-tenant healthcare platform, every backend log line reached console,
 * file, Loki, Highlight and the OTel bridge completely unredacted. Only the
 * BROWSER SDK ever implemented redaction.
 *
 * This mirrors the SDK's `core/logger/redactor.ts` semantics deliberately: one
 * PHI vocabulary and one set of guarantees across both runtimes, so a reviewer
 * does not have to hold two mental models.
 */

import { describe, expect, it } from 'vitest';

import { PHI_KEYS, REDACTED_VALUE, redactEntry, redactValue } from '../redactor';

describe('redactValue', () => {
  it('redacts every canonical PHI key', () => {
    const input = Object.fromEntries(PHI_KEYS.map((k) => [k, 'sensitive']));

    const out = redactValue(input) as Record<string, unknown>;

    for (const key of PHI_KEYS) {
      expect(out[key], `${key} must be redacted`).toBe(REDACTED_VALUE);
    }
  });

  it('redacts PHI nested arbitrarily deep', () => {
    const input = { a: { b: { c: [{ patientId: 'P-1', keep: 'ok' }] } } };

    const out = redactValue(input) as any;

    expect(out.a.b.c[0].patientId).toBe(REDACTED_VALUE);
    expect(out.a.b.c[0].keep).toBe('ok');
  });

  it('does NOT mutate the input', () => {
    const input = { patientId: 'P-1', nested: { transcript: 'text' } };

    redactValue(input);

    expect(input.patientId).toBe('P-1');
    expect(input.nested.transcript).toBe('text');
  });

  it('survives circular references', () => {
    const input: Record<string, unknown> = { patientId: 'P-1' };
    input.self = input;

    expect(() => redactValue(input)).not.toThrow();
    expect((redactValue(input) as any).patientId).toBe(REDACTED_VALUE);
  });

  it('treats binary payloads as opaque PHI — audio buffers are PHI here', () => {
    const out = redactValue({ blob: new Uint8Array([1, 2, 3]) }) as any;

    expect(out.blob).not.toEqual([1, 2, 3]);
    expect(String(out.blob)).toContain('REDACTED');
  });

  it('rewrites data:/blob:/file: URLs, which can carry an entire recording', () => {
    const out = redactValue({
      a: 'data:audio/wav;base64,AAAA',
      b: 'blob:http://x/9f',
      c: 'file:///tmp/consult.wav',
      d: 'https://example.com/ok',
    }) as any;

    expect(out.a).toBe('[REDACTED-URL]');
    expect(out.b).toBe('[REDACTED-URL]');
    expect(out.c).toBe('[REDACTED-URL]');
    expect(out.d).toBe('https://example.com/ok');
  });

  it('honours extra caller-supplied field names', () => {
    const out = redactValue({ customSecret: 'x' }, ['customSecret']) as any;

    expect(out.customSecret).toBe(REDACTED_VALUE);
  });
});

describe('redactEntry', () => {
  const base = {
    level: 'info' as const,
    levelNumber: 30,
    message: 'consultation processed',
    timestamp: '2026-08-08T00:00:00.000Z',
    timestampMs: 1786100000000,
  };

  it('redacts PHI in meta', () => {
    const out = redactEntry({ ...base, meta: { patientId: 'P-1', durationMs: 12 } });

    expect((out.meta as any).patientId).toBe(REDACTED_VALUE);
    expect((out.meta as any).durationMs).toBe(12);
  });

  it('redacts PHI carried in an error payload', () => {
    const out = redactEntry({
      ...base,
      error: { name: 'Err', message: 'failed', transcript: 'patient said...' } as any,
    });

    expect((out.error as any).transcript).toBe(REDACTED_VALUE);
  });

  it('preserves routing/correlation identifiers', () => {
    // tenantId/userId/traceId are how an operator FINDS the log line. They are
    // internal identifiers, not PHI, and redacting them would make the
    // telemetry useless without protecting anything.
    const out = redactEntry({
      ...base,
      tenantId: 'tenant-1',
      userId: 'user-1',
      traceId: 'abc123',
      spanId: 'def456',
      requestId: 'req-1',
    });

    expect(out.tenantId).toBe('tenant-1');
    expect(out.userId).toBe('user-1');
    expect(out.traceId).toBe('abc123');
    expect(out.spanId).toBe('def456');
    expect(out.requestId).toBe('req-1');
  });

  it('redacts a PHI-shaped message body', () => {
    const out = redactEntry({
      ...base,
      message: 'audio at data:audio/wav;base64,AAAA',
    });

    expect(out.message).toContain('[REDACTED-URL]');
    expect(out.message).not.toContain('base64,AAAA');
  });

  it('leaves a clean entry structurally identical', () => {
    const entry = { ...base, context: 'SummaryService', meta: { count: 3 } };

    expect(redactEntry(entry)).toEqual(entry);
  });
});

describe('LoggingService dispatch integration', () => {
  it('redacts before ANY transport sees the entry', async () => {
    const { LoggingService } = await import('../logging.service');

    const seen: unknown[] = [];
    const service = new LoggingService();
    // Replace the configured transports with a spy; redaction must already
    // have happened by the time `log()` is called.
    (service as any).transports = [
      { name: 'spy', log: (e: unknown) => seen.push(e), state: 'ready' },
    ];

    // `info()`, not `log()` — the latter is the NestJS LoggerService signature
    // where a second object argument is treated as optionalParams, not meta.
    service.info('processed', { patientId: 'P-1', durationMs: 5 });

    expect(seen).toHaveLength(1);
    const entry = seen[0] as any;
    expect(entry.meta.patientId).toBe(REDACTED_VALUE);
    expect(entry.meta.durationMs).toBe(5);
  });

  it('applies LOG_REDACT_FIELDS from the environment', async () => {
    const { LoggingService } = await import('../logging.service');

    const previous = process.env.LOG_REDACT_FIELDS;
    process.env.LOG_REDACT_FIELDS = 'internalCaseRef';
    try {
      const seen: unknown[] = [];
      const service = new LoggingService();
      (service as any).transports = [
        { name: 'spy', log: (e: unknown) => seen.push(e), state: 'ready' },
      ];

      service.info('processed', { internalCaseRef: 'C-9', keep: 'ok' });

      expect((seen[0] as any).meta.internalCaseRef).toBe(REDACTED_VALUE);
      expect((seen[0] as any).meta.keep).toBe('ok');
    } finally {
      if (previous === undefined) delete process.env.LOG_REDACT_FIELDS;
      else process.env.LOG_REDACT_FIELDS = previous;
    }
  });
});

describe('identity preservation (transport contract)', () => {
  it('returns the ORIGINAL object when nothing needs redacting', () => {
    // Not an optimisation: transports branch on `instanceof Error`, and
    // existing callers compare identity.
    const clean = { durationMs: 5, nested: { ok: true } };

    expect(redactValue(clean)).toBe(clean);
  });

  it('keeps a clean Error as the same instance', () => {
    const err = new Error('boom');

    expect(redactValue(err)).toBe(err);
  });

  it('a redacted Error is still a real Error', () => {
    const err = new Error('boom') as Error & { patientId?: string };
    err.patientId = 'P-1';

    const out = redactValue(err) as Error & { patientId?: string };

    expect(out).toBeInstanceOf(Error);
    expect(out).not.toBe(err);
    expect(out.message).toBe('boom');
    expect(out.patientId).toBe(REDACTED_VALUE);
    expect(err.patientId).toBe('P-1'); // original untouched
  });

  it('redacts a PHI URL out of the stack, not just the message', () => {
    const err = new Error('failed on data:audio/wav;base64,AAAA');

    const out = redactValue(err) as Error;

    expect(out.message).toContain('[REDACTED-URL]');
    expect(out.stack ?? '').not.toContain('base64,AAAA');
  });
});
