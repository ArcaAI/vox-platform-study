import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AI_TASK_KEYS } from '../types';

/**
 * The console mirror of `AI_TASK_KEYS` has drifted from the backend registry
 * three times (3-vs-9, then 's four keys, then 's two
 * PII keys). Each time the doc comment in `types.ts` already said "keep the two
 * lists in lockstep" — a comment is not a guard, so this is one.
 *
 * The backend list is read by PARSING the constants file, not by importing it:
 * `types.ts` is deliberately hand-declared with no server import (BFF boundary),
 * and `@arcaai/applications` is not — and should not become — a dependency of
 * this app. A text parse keeps the boundary intact and needs nothing built.
 */

/** Walk up from this file to the pnpm workspace root. */
function workspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    try {
      readFileSync(join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error('could not locate the pnpm workspace root above this test file');
}

const BACKEND_CONSTANTS = join(workspaceRoot(), 'packages/applications/src/services/ai-task-default/constants.ts');

/**
 * Extract the string literals of the backend `export const AI_TASK_KEYS = [...]`
 * array. Line comments are stripped first so a commented-out key never counts.
 */
function parseBackendTaskKeys(source: string): string[] {
  const start = source.indexOf('export const AI_TASK_KEYS = [');
  expect(start, `AI_TASK_KEYS declaration not found in ${BACKEND_CONSTANTS}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('] as const;', start);
  expect(end, `AI_TASK_KEYS array terminator not found in ${BACKEND_CONSTANTS}`).toBeGreaterThan(start);
  const body = source
    .slice(start + 'export const AI_TASK_KEYS = ['.length, end)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe('AI_TASK_KEYS console mirror', () => {
  const backendKeys = parseBackendTaskKeys(readFileSync(BACKEND_CONSTANTS, 'utf8'));

  it('parses a non-empty backend registry (guards the parser itself)', () => {
    expect(backendKeys.length).toBeGreaterThan(0);
    expect(new Set(backendKeys).size).toBe(backendKeys.length);
  });

  it('declares exactly the backend task keys', () => {
    // Sorted compare: order is presentation here, membership is the invariant.
    // A failure names the offending keys — add them to `AI_TASK_KEYS` in
    // apps/admin-console/src/features/ai-task-defaults/api/types.ts.
    expect([...AI_TASK_KEYS].sort()).toEqual([...backendKeys].sort());
  });
});
