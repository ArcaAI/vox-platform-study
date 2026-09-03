/**
 * regression sweep.
 *
 * The `host:port` leak reached production because each downstream call site
 * built its OWN client-facing message out of the caught error. Fixing the four
 * sites we could name would leave the next one free to repeat it, so this test
 * is a SOURCE sweep rather than an example: it scans every file in `apps/api`
 * and `packages/applications` that talks to a downstream service and fails on
 * any exception message composed from a caught error.
 *
 * Precedent for reading source in a unit test:
 * `apps/api/src/__tests__/base-proxy-controller.test.ts`.
 *
 * If this test fails on a file you just wrote: do not add it to the allow-list.
 * Throw the cause (or rethrow it) and let `ExceptionInterceptor` +
 * `apps/api/src/filters/downstream-error.ts` build the body.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { containsTopology } from '../downstream-error';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SEARCH_ROOTS = [path.join(REPO_ROOT, 'apps/api/src'), path.join(REPO_ROOT, 'packages/applications/src')];

/**
 * A comment cannot build a response body, and several of the fixed call sites
 * quote the old expression verbatim so the next reader knows what was wrong.
 * Scan CODE lines only.
 */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

// Directories that never hold hand-authored source we need to sweep, even
// though none are currently nested under SEARCH_ROOTS — defensive in case
// that changes.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', '__tests__']);

/**
 * Plain filesystem walk rather than `git ls-files`: this sweep only needs to
 * see the source tree as it sits on disk (there is nothing gitignored inside
 * `apps/api/src` or `packages/applications/src` to filter out — see
 * `.gitignore`), so it does not need git at all. That also means it keeps
 * working in a CI image with no `git` binary, unlike the previous
 * `execFileSync('git', ...)` form.
 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts')) {
        out.push(abs);
      }
    }
  };
  for (const root of SEARCH_ROOTS) walk(root);
  return out;
}

/**
 * A client-facing exception message built by interpolating a caught error.
 * Matches `throw new XxxException(`... ${error} ...`)` and the
 * `return new XxxException(`... ${err.message} ...`)` form the proxy clients used.
 */
const INTERPOLATED_CAUSE = /(?:throw|return)\s+new\s+\w*Exception\(\s*`[^`]*\$\{\s*(?:primaryError|fallbackError|error|err|e|cause|reason|message|detail)\b[^`]*`/;

/** `error.response.data ?? { message: error.message }` — leaks the axios message when the upstream body is empty. */
const AXIOS_MESSAGE_FALLBACK = /\?\?\s*\{\s*message:\s*\w*(?:rror|rr)\.message\s*\}/;

describe('no downstream call site builds a client-facing message from a caught error', () => {
  it('finds no interpolated-cause exception message', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        if (!isCommentLine(line) && INTERPOLATED_CAUSE.test(line)) offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `Build the body at the boundary instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('finds no axios-message fallback for an empty upstream body', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        if (!isCommentLine(line) && AXIOS_MESSAGE_FALLBACK.test(line)) offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `An empty upstream body must not fall back to the axios message:\n${offenders.join('\n')}`).toEqual([]);
  });

});

describe('the fixed call sites stay fixed', () => {
  // Named-site guards. The sweep above is the general rule; these pin the four
  // sites the evidence actually reproduced, so a revert is unambiguous.
  const FIXED = [
    'packages/applications/src/services/consultation/summary/summary.service.ts',
    'packages/applications/src/services/prompt-management/prompt-management.service.ts',
    'apps/api/src/modules/ai-inference/ai-inference.client.ts',
    'apps/api/src/modules/harness-admin/harness-ops.client.ts',
    'apps/api/src/modules/ai-service-admin/ai-service-proxy.client.ts',
  ];

  it.each(FIXED)('%s no longer says "Failed to call <X> service: ${error}"', (rel) => {
    const code = readFileSync(path.join(REPO_ROOT, rel), 'utf8')
      .split('\n')
      .filter((l) => !isCommentLine(l))
      .join('\n');
    expect(code).not.toMatch(/Failed to call \w+ service: \$\{/);
    expect(code).not.toMatch(/request failed \(\$\{action\}\): \$\{message\}/i);
  });
});

describe('containsTopology is strict enough to be worth asserting on', () => {
  // A sweep is only as good as its predicate — pin that the predicate would
  // actually have caught the observed production body.
  it('would have failed the  production body', () => {
    const observed = 'Failed to call TEXT service: AggregateError: connect ECONNREFUSED ::1:8862; connect ECONNREFUSED 127.0.0.1:8862';
    expect(containsTopology(observed)).toBe(true);
  });
});
