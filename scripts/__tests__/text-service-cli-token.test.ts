/**
 * Grep-gate: the Python summarization service CLI token is `text`, not `smr`.
 *
 * `scripts/dev-service.sh` only accepts `text`. Launchers that still put `smr`
 * in DEFAULT/ALL/PY lists fail with `Unknown argument: smr`. `smr` may remain
 * as a deprecated remap; it must not be the canonical list token.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf-8');
}

describe('text service CLI token', () => {
  it('package.json exposes test:up:text and points test:up:smr at text', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:up:text']).toBe('./scripts/start-test-app.sh text');
    expect(pkg.scripts['test:up:smr']).toBe('./scripts/start-test-app.sh text');
    expect(pkg.scripts['text:test:managed']).toBe('./scripts/test-run.sh text');
    expect(pkg.scripts['text:setup']).toContain('--service text');
  });

  it('dev-stack default/all lists use text, not smr', () => {
    const src = read('scripts/dev-stack.sh');
    expect(src).toMatch(/DEFAULT_SERVICES=\(api stt stt-worker text /);
    expect(src).toMatch(/ALL_SERVICES=\(api stt stt-worker text /);
    expect(src).not.toMatch(/DEFAULT_SERVICES=\([^)]*\bsmr\b/);
    expect(src).not.toMatch(/ALL_SERVICES=\([^)]*\bsmr\b/);
  });

  it('test-run and start-test-app canonical lists use text', () => {
    const testRun = read('scripts/test-run.sh');
    expect(testRun).toMatch(/PY_SERVICES=\(stt text nlp /);
    expect(testRun).not.toMatch(/PY_SERVICES=\([^)]*\bsmr\b/);

    const startTest = read('scripts/start-test-app.sh');
    expect(startTest).toMatch(/PY_TARGETS=\(stt text nlp /);
    expect(startTest).not.toMatch(/PY_TARGETS=\([^)]*\bsmr\b/);
  });

  it('setup-python-env known services include text, not smr', () => {
    const src = read('scripts/setup-python-env.sh');
    expect(src).toMatch(/ALL_SERVICES=\(stt text nlp /);
    expect(src).not.toMatch(/ALL_SERVICES=\([^)]*\bsmr\b/);
  });

  it('env inventory asks text.core.config, not smr.core.config', () => {
    const src = read('scripts/env-consumer-inventory.py');
    expect(src).toContain('"text"');
    expect(src).not.toMatch(/PY_SERVICES = \[[^\]]*"smr"/);
  });
});
