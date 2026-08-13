/**
 * (lane B) — `loadEnv()` is the single TS env-loading implementation.
 * These tests exercise the real dotenv round-trip so the precedence contract is
 * proven end to end, not just in the resolver.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadEnv } from '../index';

function makeEnvFile(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hope-loadenv-'));
  const file = path.join(dir, '.env.custom');
  fs.writeFileSync(file, body);
  return file;
}

describe('loadEnv', () => {
  const created: string[] = [];
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
    while (created.length > 0) {
      const file = created.pop();
      if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  const envFile = (body: string): string => {
    const file = makeEnvFile(body);
    created.push(file);
    return file;
  };

  it('sets variables that the host environment does not define', () => {
    const file = envFile('TASK_558_ONLY_IN_FILE=from-file\n');
    delete process.env['TASK_558_ONLY_IN_FILE'];
    process.env['NODE_ENV'] = 'development';
    delete process.env['CI'];

    const result = loadEnv({ envFilePath: file });

    expect(result.loaded).toBe(true);
    expect(process.env['TASK_558_ONLY_IN_FILE']).toBe('from-file');
  });

  it('does NOT overwrite a variable already present in the host environment (D4)', () => {
    const file = envFile('TASK_558_PRECEDENCE=from-file\n');
    process.env['TASK_558_PRECEDENCE'] = 'from-host';
    process.env['NODE_ENV'] = 'development';
    delete process.env['CI'];

    loadEnv({ envFilePath: file });

    expect(process.env['TASK_558_PRECEDENCE']).toBe('from-host');
  });

  it('reads no file at all when CI=true (D7)', () => {
    const file = envFile('TASK_558_CI_GUARD=from-file\n');
    delete process.env['TASK_558_CI_GUARD'];
    process.env['NODE_ENV'] = 'development';
    process.env['CI'] = 'true';

    const result = loadEnv({ envFilePath: file });

    expect(result.loaded).toBe(false);
    expect(result.isCI).toBe(true);
    expect(process.env['TASK_558_CI_GUARD']).toBeUndefined();
  });

  it('reads no file at all when NODE_ENV=production (D7)', () => {
    const file = envFile('TASK_558_PROD_GUARD=from-file\n');
    delete process.env['TASK_558_PROD_GUARD'];
    process.env['NODE_ENV'] = 'production';
    delete process.env['CI'];

    const result = loadEnv({ envFilePath: file });

    expect(result.loaded).toBe(false);
    expect(process.env['TASK_558_PROD_GUARD']).toBeUndefined();
  });

  it('is idempotent — a second call cannot change an already-resolved value', () => {
    const file = envFile('TASK_558_IDEMPOTENT=from-file\n');
    delete process.env['TASK_558_IDEMPOTENT'];
    process.env['NODE_ENV'] = 'development';
    delete process.env['CI'];

    loadEnv({ envFilePath: file });
    process.env['TASK_558_IDEMPOTENT'] = 'mutated-after-load';
    loadEnv({ envFilePath: file });

    expect(process.env['TASK_558_IDEMPOTENT']).toBe('mutated-after-load');
  });
});
