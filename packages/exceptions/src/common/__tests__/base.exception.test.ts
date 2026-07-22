import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArgumentInvalidException } from '../../backend/application/argumentInvalid.exception';

/**
 * F-030 — non-production error bodies leaked full stack traces with absolute
 * filesystem paths (`toJSON().stack` echoed `this.stack` verbatim whenever
 * `NODE_ENV !== 'production'`). Class/message/code stay useful for
 * debugging; the filesystem layout does not belong in an HTTP response body
 * in any environment, including staging/test.
 */
describe('BaseException.toJSON — stack sanitisation (F-030)', () => {
  const originalEnv = process.env['NODE_ENV'];

  beforeEach(() => {
    process.env['NODE_ENV'] = 'test';
  });

  afterEach(() => {
    process.env['NODE_ENV'] = originalEnv;
  });

  it('never includes an absolute filesystem path in the serialised stack outside production', () => {
    const exc = new ArgumentInvalidException('bad input');
    const json = exc.toJSON();

    expect(json.stack).toBeDefined();
    // Absolute POSIX paths start with a `/` segment before the file name;
    // none may survive serialisation.
    expect(json.stack).not.toMatch(/\/[\w.-]+\/[\w.-/]+\.(ts|js|tsx|jsx|mjs|cjs)/);
    expect(json.stack).not.toContain(process.cwd());
  });

  it('still carries the exception class name and message (useful, not empty)', () => {
    const exc = new ArgumentInvalidException('bad input');
    const json = exc.toJSON();

    expect(json.stack).toContain('ArgumentInvalidException');
    expect(json.stack).toContain('bad input');
  });

  it('still identifies the throwing file and line (basename only, no directory)', () => {
    const exc = new ArgumentInvalidException('bad input');
    const json = exc.toJSON();

    // `Error.captureStackTrace(this, this.constructor)` excludes the
    // constructor frame(s), so the topmost frame is the call site below —
    // basename only, no leading `/` directory segment.
    expect(json.stack).toMatch(/base\.exception\.test\.[tj]s:\d+:\d+/);
    expect(json.stack).not.toMatch(/\s\/[^\s]/);
  });

  it('omits the stack entirely in production, unchanged from before', () => {
    process.env['NODE_ENV'] = 'production';
    const exc = new ArgumentInvalidException('bad input');
    const json = exc.toJSON();
    expect(json.stack).toBeUndefined();
  });
});
