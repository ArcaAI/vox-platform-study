/**
 * The JSON `error` object on a log line: `{ name, message, code?, status?,
 * stack, cause: {...} }`. `code` and `status` were dropped before, so an
 * operator reading a 5xx line could not tell `P2002` from a timeout; and the
 * transport must only ever render the REDACTED cause chain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggingService } from '../logging.service';
import { REDACTED_VALUE } from '../redactor';
import { ConsoleTransport } from '../transports/console.transport';

function lastJsonLine(write: { mock: { calls: unknown[][] } }): Record<string, any> {
  return JSON.parse(String(write.mock.calls.at(-1)?.[0]));
}

describe('formatError on the JSON line', () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_CONSOLE_ENABLED: 'false', LOG_FILE_ENABLED: 'false' };
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('emits code and status when present', () => {
    const transport = new ConsoleTransport({ name: 'console', json: true, level: 'trace' });
    const err = Object.assign(new Error('unique violation'), { code: 'P2002', status: 409 });

    transport.log({ level: 'error', levelNumber: 50, message: 'x', timestamp: 't', timestampMs: 0, error: err });

    expect(lastJsonLine(stderr).error).toMatchObject({ name: 'Error', message: 'unique violation', code: 'P2002', status: 409 });
  });

  it('emits statusCode as status', () => {
    const transport = new ConsoleTransport({ name: 'console', json: true, level: 'trace' });
    const err = Object.assign(new Error('nope'), { statusCode: 503 });

    transport.log({ level: 'error', levelNumber: 50, message: 'x', timestamp: 't', timestampMs: 0, error: err });

    expect(lastJsonLine(stderr).error.status).toBe(503);
  });

  it('renders the cause chain with code/status at each level', () => {
    const transport = new ConsoleTransport({ name: 'console', json: true, level: 'trace' });
    const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const err = new Error('upstream failed', { cause });

    transport.log({ level: 'error', levelNumber: 50, message: 'x', timestamp: 't', timestampMs: 0, error: err });

    expect(lastJsonLine(stderr).error.cause).toMatchObject({ message: 'socket hang up', code: 'ECONNRESET' });
  });

  it('does not recurse forever on a self-referencing cause', () => {
    const transport = new ConsoleTransport({ name: 'console', json: true, level: 'trace' });
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;

    expect(() => transport.log({ level: 'error', levelNumber: 50, message: 'x', timestamp: 't', timestampMs: 0, error: err })).not.toThrow();
  });

  it('through the service, a PHI-bearing cause never reaches the line un-redacted', () => {
    process.env.LOG_CONSOLE_ENABLED = 'true';
    process.env.LOG_CONSOLE_JSON = 'true';
    process.env.LOG_CONSOLE_PRETTY = 'false';
    process.env.LOG_CONSOLE_COLORIZE = 'false';
    const service = new LoggingService();
    const cause = Object.assign(new Error('lookup failed for jane.doe@example.com'), { patientName: 'Jane Doe' });

    service.error('write failed', new Error('outer', { cause }));

    const raw = String(stderr.mock.calls.at(-1)?.[0]);
    expect(raw).not.toContain('Jane Doe');
    expect(raw).not.toContain('jane.doe@example.com');
    const line = JSON.parse(raw);
    expect(line.error.cause.patientName ?? REDACTED_VALUE).toBe(REDACTED_VALUE);
  });
});
