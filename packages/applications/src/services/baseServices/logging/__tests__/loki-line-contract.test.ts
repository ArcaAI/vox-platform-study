/**
 * The contract Loki reads the gateway's stdout with.
 *
 * Measured in `hope-v2-dev` on 2026-09-19, over 30 minutes: 4,821 of 4,846
 * gateway lines carried `detected_level=unknown`, and the 22 Loki DID label
 * `error` were mislabelled — Loki had matched the word "error" inside the
 * payload of lines whose real level was `warn`. Every Python service, on the
 * same cluster and through the same Alloy pipeline, parsed cleanly.
 *
 * Three separate causes, all pinned here:
 *
 *   1. the console transport chose pretty+ANSI whenever `NODE_ENV=development`,
 *      which is exactly what the dev cluster sets — "development" is not the
 *      same question as "a human is watching this stream";
 *   2. the JSON shape it would have emitted used `msg` / `time` / `trace_id`,
 *      none of which match what the fleet's other services emit or what
 *      Grafana's Loki->Tempo derived field looks for (`"traceId":"..."`);
 *   3. NestJS's `Logger.log({ message, ...fields })` arrived as an OBJECT and
 *      was `JSON.stringify`-ed into the message string, so even in JSON mode
 *      every field would have been a string inside a string.
 */

import { ConsoleTransport } from '../transports/console.transport';
import { LoggingService } from '../logging.service';
import type { LogEntry } from '../types';

const ANSI = /\[\d+m/;

function entryOf(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 'info',
    levelNumber: 30,
    message: 'Request completed',
    timestamp: '2026-09-19T18:22:08.883Z',
    timestampMs: 1789842128883,
    context: 'ContextInterceptor',
    serviceName: 'api',
    ...overrides,
  } as LogEntry;
}

function captureStdout(fn: () => void): string {
  const written: string[] = [];
  const original = process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- replacing a Node stream method for the duration of one assertion
  (process.stdout as any).write = (chunk: any) => {
    written.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return written.join('');
}

describe('Loki line contract', () => {
  describe('the emitted line', () => {
    it('is one parseable JSON object, with no ANSI escapes', () => {
      const transport = new ConsoleTransport({ name: 'console', json: true });

      const output = captureStdout(() => transport.log(entryOf()));

      expect(output.endsWith('\n')).toBe(true);
      expect(output.trimEnd()).not.toMatch(ANSI);
      expect(output.trimEnd().includes('\n')).toBe(false);
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('names the level and the message the way Loki and the fleet do', () => {
      const transport = new ConsoleTransport({ name: 'console', json: true });

      const line = JSON.parse(captureStdout(() => transport.log(entryOf({ level: 'warn' }))));

      // `level` is what Loki 3.x derives `detected_level` from, and lowercase
      // is the value set it recognises.
      expect(line.level).toBe('warn');
      expect(line.message).toBe('Request completed');
      expect(line.timestamp).toBe('2026-09-19T18:22:08.883Z');
      expect(line.msg).toBeUndefined();
      expect(line.time).toBeUndefined();
    });

    it('carries traceId in the spelling the Grafana derived field matches', () => {
      // `deployment/k8s/base/observability-config.yaml` matches
      // `"traceId"\s*:\s*"(\w+)"` to turn a log line into a trace link.
      // Renaming this key to snake_case silently unlinks logs from traces.
      const transport = new ConsoleTransport({ name: 'console', json: true });

      const raw = captureStdout(() =>
        transport.log(
          entryOf({ traceId: 'abc123', spanId: 'def456', requestId: 'req-1', tenantId: 't-1' }),
        ),
      );

      expect(raw).toMatch(/"traceId":"abc123"/);
      const line = JSON.parse(raw);
      expect(line.spanId).toBe('def456');
      expect(line.requestId).toBe('req-1');
      expect(line.tenantId).toBe('t-1');
      expect(line.trace_id).toBeUndefined();
    });
  });

  describe('format selection', () => {
    const saved = { ...process.env };
    const savedTty = process.stdout.isTTY;

    afterEach(() => {
      process.env = { ...saved };
      Object.defineProperty(process.stdout, 'isTTY', { value: savedTty, configurable: true });
    });

    function consoleConfigFor(env: Record<string, string | undefined>, isTTY: boolean) {
      process.env = { ...saved, ...env };
      Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
      const service = new LoggingService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching a private field is the point: the transport config is what selects the format
      const transport = (service as any).transports.find((t: any) => t.name === 'console');
      return transport.config as { json?: boolean; colorize?: boolean; prettyPrint?: boolean };
    }

    it('emits JSON in a container, even when NODE_ENV is development', () => {
      // The dev cluster runs NODE_ENV=development. Nobody reads that stream
      // with their eyes; Loki does.
      const config = consoleConfigFor({ NODE_ENV: 'development' }, false);

      expect(config.json).toBe(true);
      expect(config.colorize).toBe(false);
      expect(config.prettyPrint).toBe(false);
    });

    it('still prints for a human on an attached terminal', () => {
      const config = consoleConfigFor({ NODE_ENV: 'development' }, true);

      expect(config.json).toBe(false);
      expect(config.colorize).toBe(true);
      expect(config.prettyPrint).toBe(true);
    });

    it('lets an operator override either way', () => {
      expect(
        consoleConfigFor({ NODE_ENV: 'development', LOG_CONSOLE_JSON: 'true' }, true).json,
      ).toBe(true);
      expect(
        consoleConfigFor({ NODE_ENV: 'production', LOG_CONSOLE_PRETTY: 'true' }, false).prettyPrint,
      ).toBe(true);
    });
  });

  describe('a NestJS Logger call that passes an object', () => {
    const saved = { ...process.env };

    afterEach(() => {
      process.env = { ...saved };
    });

    it('lands as top-level keys, not as JSON inside the message string', () => {
      // `this.logger.log({ message: 'Streaming session finalized', sessionId, reason })`
      // — apps/api/src/modules/streaming/stt-ws.gateway.ts and every other
      // structured call site in the gateway.
      process.env.LOG_CONSOLE_JSON = 'true';
      const service = new LoggingService();

      const raw = captureStdout(() =>
        service.log({
          message: 'Streaming session finalized',
          sessionId: 's-1',
          reason: 'client_closed',
          traceId: 'abc123',
        }),
      );

      const line = JSON.parse(raw);
      expect(line.message).toBe('Streaming session finalized');
      expect(line.sessionId).toBe('s-1');
      expect(line.reason).toBe('client_closed');
      expect(line.traceId).toBe('abc123');
    });

    it('does the same for warn and error, which reach the service directly', () => {
      process.env.LOG_CONSOLE_JSON = 'true';
      const service = new LoggingService();

      const raw = captureStdout(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the NestJS LoggerService overload, which is typed as `any`
        (service as any).warn({ message: 'Effective-config value refused', key: 'storage.x' }),
      );

      const line = JSON.parse(raw);
      expect(line.level).toBe('warn');
      expect(line.message).toBe('Effective-config value refused');
      expect(line.key).toBe('storage.x');
    });

    it('leaves an object with no message field stringified, as before', () => {
      process.env.LOG_CONSOLE_JSON = 'true';
      const service = new LoggingService();

      const raw = captureStdout(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the NestJS LoggerService overload, which is typed as `any`
        (service as any).info({ shape: 'unknown' }),
      );

      expect(JSON.parse(raw).message).toBe('{"shape":"unknown"}');
    });
  });
});
