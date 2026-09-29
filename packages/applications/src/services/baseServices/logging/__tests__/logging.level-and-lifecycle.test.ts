/**
 * Level gating, child construction and bounded flush.
 *
 * `setLevel()` used to assign a field nothing read, so the platform's live
 * log-level knob (`platform-knobs.binder.ts`) was inert; `child()`/`withMeta()`
 * built a whole new `LoggingService` (env re-read, transports re-created) per
 * call; and `flush()` awaited every transport with no bound, so one hung
 * transport held a crashing process open.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggingService } from '../logging.service';
import type { ILogTransport, LogEntry, LogLevel, TransportState } from '../transports/types';

class RecordingTransport implements ILogTransport {
  public logs: LogEntry[] = [];
  public readonly config = { name: 'recording', enabled: true };
  constructor(public readonly name = 'recording') {}
  get state(): TransportState {
    return 'running';
  }
  async initialize(): Promise<void> {}
  log(entry: LogEntry): void {
    this.logs.push(entry);
  }
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
  shouldLog(_level: LogLevel): boolean {
    return true;
  }
}

describe('LoggingService level gating', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_CONSOLE_ENABLED: 'false', LOG_FILE_ENABLED: 'false', LOG_LEVEL: 'info' };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("setLevel('warn') suppresses info on every transport", () => {
    const service = new LoggingService();
    const a = new RecordingTransport('a');
    const b = new RecordingTransport('b');
    service.addTransport(a);
    service.addTransport(b);

    service.setLevel('warn');
    service.info('quiet');
    service.warn('loud');

    expect(a.logs.map((e) => e.message)).toEqual(['loud']);
    expect(b.logs.map((e) => e.message)).toEqual(['loud']);
  });

  it("setLevel('debug') enables debug, including on the built-in console transport", () => {
    process.env.LOG_CONSOLE_ENABLED = 'true';
    process.env.LOG_CONSOLE_JSON = 'true';
    process.env.LOG_CONSOLE_PRETTY = 'false';
    process.env.LOG_CONSOLE_COLORIZE = 'false';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    const service = new LoggingService();
    service.debug('before');
    service.setLevel('debug');
    service.debug('after');

    const printed = [...write.mock.calls, ...consoleLog.mock.calls, ...consoleDebug.mock.calls]
      .map((c) => String(c[0]))
      .join('\n');
    expect(printed).toContain('after');
    expect(printed).not.toContain('before');
  });

  it('children created before setLevel follow the root level', () => {
    const service = new LoggingService();
    const t = new RecordingTransport();
    service.addTransport(t);
    const child = service.child('Child');
    const withMeta = service.withMeta({ requestId: 'r-1' });

    service.setLevel('error');
    child.warn('child-warn');
    withMeta.warn('meta-warn');
    service.setLevel('debug');
    child.debug('child-debug');

    expect(t.logs.map((e) => e.message)).toEqual(['child-debug']);
    expect(child.getLevel()).toBe('debug');
  });

  it("setLogLevels (Nest adapter path) gates output too", () => {
    const service = new LoggingService();
    const t = new RecordingTransport();
    service.addTransport(t);

    service.setLogLevels?.(['error']);
    service.warn('dropped');
    service.error('kept');

    expect(t.logs.map((e) => e.message)).toEqual(['kept']);
  });
});

describe('LoggingService child construction', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_CONSOLE_ENABLED: 'false', LOG_FILE_ENABLED: 'false' };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('child()/withMeta() do not construct transports', () => {
    const service = new LoggingService();
    const spy = vi.spyOn(LoggingService.prototype as any, 'initializeTransports');

    const child = service.child('Child');
    const meta = child.withMeta({ requestId: 'r-1' });

    expect(spy).not.toHaveBeenCalled();
    expect(child).toBeInstanceOf(LoggingService);
    expect(meta).toBeInstanceOf(LoggingService);
  });

  it('a transport added to the root after child() is seen by the child', () => {
    const service = new LoggingService();
    const child = service.child('Child');
    const t = new RecordingTransport();
    service.addTransport(t);

    child.info('late');

    expect(t.logs.map((e) => e.message)).toEqual(['late']);
    expect(t.logs[0].context).toBe('Child');
  });

  it('withMeta() on a child keeps the child context and does not leak into the parent', () => {
    const service = new LoggingService();
    const t = new RecordingTransport();
    service.addTransport(t);

    service.child('Child').withMeta({ requestId: 'r-9' }).info('scoped');
    service.info('root');

    expect(t.logs[0].context).toBe('Child');
    expect(t.logs[0].requestId).toBe('r-9');
    expect(t.logs[1].context).toBeUndefined();
    expect(t.logs[1].requestId).toBeUndefined();
  });
});

describe('LoggingService bounded flush', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_CONSOLE_ENABLED: 'false', LOG_FILE_ENABLED: 'false' };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('flush() resolves within its cap when a transport hangs', async () => {
    const service = new LoggingService();
    const hung = new RecordingTransport('hung');
    hung.flush = () => new Promise<void>(() => undefined);
    const ok = new RecordingTransport('ok');
    const okFlush = vi.spyOn(ok, 'flush');
    service.addTransport(hung);
    service.addTransport(ok);

    const started = Date.now();
    await service.flush(50);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(okFlush).toHaveBeenCalled();
  });

  it('flush() with the default cap resolves when a transport hangs', async () => {
    vi.useFakeTimers();
    const service = new LoggingService();
    const hung = new RecordingTransport('hung');
    hung.flush = () => new Promise<void>(() => undefined);
    service.addTransport(hung);

    let done = false;
    const p = service.flush().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2_100);
    await p;

    expect(done).toBe(true);
  });

  it('flush() does not reject when a transport flush fails', async () => {
    const service = new LoggingService();
    const bad = new RecordingTransport('bad');
    bad.flush = () => Promise.reject(new Error('disk gone'));
    service.addTransport(bad);

    await expect(service.flush(50)).resolves.toBeUndefined();
  });
});
