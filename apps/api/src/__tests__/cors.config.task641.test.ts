/**
 * TASK-641 T-10 — FR-8: **no env var participates in ANY CORS decision.**
 *
 * > "no env var may participate in any CORS decision — not as an allow-list,
 * >  and not as a behavioural branch."
 *
 * TASK-610 §4A.1 already deleted the last allow-list env var
 * (`CORS_ALLOWED_ORIGINS`). B-7 was the last *behavioural* one: a
 * `NODE_ENV === 'development'` branch in `isOriginAllowed` that admitted
 * loopback origins the registry had refused. It is gone; local development is
 * covered instead by the seeded SYSTEM-tenant loopback rows (`http://localhost:*`,
 * `http://127.0.0.1:*`), which are ordinary registry rows and therefore go
 * through the ordinary decision.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
 *
 * The behavioural half (below, §A) proves the branch is gone *today*. It does
 * not stop it growing back: someone re-adding `if (nodeEnv === 'development')`
 * would be reverting a security posture, and §A's cases would go red only for
 * the exact origins they happen to enumerate. The source-level half (§B) fails
 * for ANY env read anywhere in the decision path, enumerated or not — the same
 * reason TASK-610 shipped a source-reading guard for the `main.ts` bootstrap
 * log (`platform-knobs.binder.enforcement.task610.test.ts`, "does NOT claim a
 * posture it cannot know").
 *
 * ── WHY IT IS SCOPED, AND WHY THAT IS NOT A LOOPHOLE ────────────────────────
 *
 * `logCorsDecision` reads `process.env.NODE_ENV` to decide whether to emit a
 * `debug` line. That read is DELIBERATELY LEFT IN PLACE and is deliberately
 * excluded here. It gates LOG VERBOSITY, not admission: both of that function's
 * branches `return allowed` unchanged, so no value of `NODE_ENV` can move an
 * origin from refused to admitted or back. FR-8 governs the CORS *decision*;
 * deleting a diagnostic would cost the operator the only per-origin trace they
 * have and buy no security. §B therefore excises exactly that one function and
 * asserts over everything else — and §B.1 proves the excision is honest by
 * running the identical pipeline over a source that DOES plant an env read in
 * the decision path, and requiring it to be caught.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isOriginAllowed, setOriginEnforcementResolver, setOriginRegistryResolver } from '../cors.config';

const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';

/**
 * The seeded SYSTEM loopback grants, as the registry answers them.
 *
 * `http://localhost:*` / `http://127.0.0.1:*` are stored as PATTERNS; the real
 * `OriginRegistryService` expands them at lookup time. This stub reproduces the
 * two properties the pattern grammar actually gives (any port, exact scheme,
 * exact host) rather than re-implementing `origin-pattern.ts`, which has its own
 * suite.
 */
function seededLoopbackRegistry() {
  const has = vi.fn((origin: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return { has, allows: (_o: string, t: string) => t === SYSTEM_TENANT };
}

const EMPTY_REGISTRY = { has: () => false, allows: () => false };

/** Every environment string the gateway is ever started with. */
const ALL_NODE_ENVS = ['development', 'test', 'staging', 'production'] as const;

describe('§A — behaviour: the environment is not an input to the decision (FR-8, B-7)', () => {
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    setOriginRegistryResolver(null);
    // FR-6: enforcement is ON. Under the permissive default nothing below would
    // discriminate — every origin is admitted regardless of environment, so the
    // suite would pass with the dev branch fully restored.
    setOriginEnforcementResolver(() => true);
  });

  afterEach(() => {
    setOriginRegistryResolver(null);
    setOriginEnforcementResolver(null);
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    vi.restoreAllMocks();
  });

  /**
   * The B-7 regression, stated as its failure mode: an UNSEEDED database in
   * development used to be rescued by the env branch. It must not be any more —
   * that rescue is what made `NODE_ENV` a CORS input.
   */
  it.each([
    'http://localhost',
    'http://localhost:5173',
    'http://localhost:5176',
    'http://127.0.0.1:5173',
    'https://localhost:8868',
    'http://[::1]:5173',
  ])('refuses the loopback origin %s in development when the registry does not hold it', (origin) => {
    setOriginRegistryResolver(() => EMPTY_REGISTRY);
    process.env.NODE_ENV = 'development';

    expect(isOriginAllowed(origin, 'development')).toBe(false);
  });

  it('refuses loopback identically in every environment — development is not a special case', () => {
    setOriginRegistryResolver(() => EMPTY_REGISTRY);

    for (const nodeEnv of ALL_NODE_ENVS) {
      process.env.NODE_ENV = nodeEnv;
      expect(isOriginAllowed('http://localhost:5173', nodeEnv), `arg=${nodeEnv}`).toBe(false);
    }
  });

  /**
   * The other half of the same claim, and the one that proves the deletion did
   * not simply break local development: with the seeded rows present, loopback
   * is admitted — in production too, because a row is a row.
   */
  it('admits the seeded loopback origins through the registry, in every environment', () => {
    setOriginRegistryResolver(() => seededLoopbackRegistry());

    for (const nodeEnv of ALL_NODE_ENVS) {
      process.env.NODE_ENV = nodeEnv;
      expect(isOriginAllowed('http://localhost:5173', nodeEnv), `localhost in ${nodeEnv}`).toBe(true);
      expect(isOriginAllowed('http://127.0.0.1:5173', nodeEnv), `127.0.0.1 in ${nodeEnv}`).toBe(true);
    }
  });

  /**
   * The `nodeEnv` PARAMETER is now inert. It is kept in the signature because
   * `getCorsOrigins`/`buildCorsOptions` are called from `main.ts` with it and
   * removing it is a wider change than this lane owns — so pin that it cannot
   * influence anything, which is the property FR-8 actually cares about.
   */
  it('returns the same verdict for every value of the nodeEnv argument, seeded or not', () => {
    setOriginRegistryResolver(() => seededLoopbackRegistry());
    const seeded = ALL_NODE_ENVS.map((e) => isOriginAllowed('http://localhost:5173', e));
    const unseeded = ALL_NODE_ENVS.map((e) => isOriginAllowed('http://unregistered.example.com', e));

    expect(new Set(seeded).size, `verdicts differed by environment: ${seeded.join(',')}`).toBe(1);
    expect(new Set(unseeded).size, `verdicts differed by environment: ${unseeded.join(',')}`).toBe(1);
    expect(seeded[0]).toBe(true);
    expect(unseeded[0]).toBe(false);
  });

  it('refusing an unseeded loopback origin logs the ordinary registry miss, not a bespoke dev reason', () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    setOriginRegistryResolver(() => EMPTY_REGISTRY);

    isOriginAllowed('http://localhost:61641', 'development');

    const payloads = warnSpy.mock.calls.map(([p]) => p as { origin?: string; reason?: string });
    const hit = payloads.find((p) => p.origin === 'http://localhost:61641');
    expect(hit?.reason).toBe('origin_registry_miss');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §B — source: the branch cannot grow back
// ───────────────────────────────────────────────────────────────────────────

/**
 * Strip comments, then cut one named function out by brace-matching.
 *
 * Comments are stripped FIRST and unconditionally: this file's own header names
 * `NODE_ENV` repeatedly, and so does `cors.config.ts`'s. A guard that trips on
 * prose would be un-maintainable and would push people to stop explaining
 * themselves — which is the opposite of what the deletion is worth.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** Returns `null` when the function is not found, so the caller can fail loudly. */
function exciseFunction(code: string, name: string): string | null {
  const start = code.indexOf(`function ${name}(`);
  if (start === -1) return null;

  const open = code.indexOf('{', start);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(0, start) + code.slice(i + 1);
    }
  }
  return null;
}

/**
 * `apps/api` compiles as CommonJS and `tsc` rejects `import.meta` (TS1343), so
 * the path is resolved from `cwd` — which is the repo root or `apps/api`
 * depending on how vitest was invoked. Both are tried, and a miss FAILS.
 * (Lifted from TASK-610's `main.ts` bootstrap-log guard, same constraint.)
 */
const CORS_CONFIG = ['apps/api/src/cors.config.ts', 'src/cors.config.ts'].map((c) => resolve(process.cwd(), c)).find(existsSync);

describe('§B — source: no env read anywhere in the CORS decision path (FR-8, T-10)', () => {
  const source = CORS_CONFIG ? readFileSync(CORS_CONFIG, 'utf8') : '';
  const code = stripComments(source);
  const decisionPath = exciseFunction(code, 'logCorsDecision');

  it('located cors.config.ts — a source guard that cannot find its source proves nothing', () => {
    expect(CORS_CONFIG, `could not locate apps/api/src/cors.config.ts from cwd ${process.cwd()}`).toBeDefined();
    expect(code.length).toBeGreaterThan(1000);
  });

  it('excised logCorsDecision, and nothing else', () => {
    expect(decisionPath, 'logCorsDecision not found — rename it here too, or the guard silently stops guarding').not.toBeNull();
    // The excision took the logger out …
    expect(decisionPath).not.toContain("message: 'CORS decision'");
    // … and left every decision function in.
    for (const fn of ['export function isOriginAllowed', 'function queryRegistry', 'export function isOriginEnforcementEnabled', 'export function getCorsOrigins', 'export function buildCorsOptions']) {
      expect(decisionPath, `${fn} must remain under the guard`).toContain(fn);
    }
  });

  /**
   * THE ANTI-VACUITY PROOF. Without this, an `exciseFunction` that returned `''`
   * — or a `stripComments` that ate the file — would make every assertion below
   * pass while checking nothing. The identical pipeline is run over a source
   * that plants the exact branch B-7 deleted, and is required to catch it.
   */
  it('the guard detects a planted env read in the decision path', () => {
    const planted = [
      '/* a comment mentioning NODE_ENV, which must be ignored */',
      'function logCorsDecision(o, a, r) {',
      "  if (process.env.NODE_ENV === 'development') { debug(); }",
      '  return a;',
      '}',
      'export function isOriginAllowed(origin, nodeEnv) {',
      "  if (process.env.NODE_ENV === 'development' && isLoopbackOrigin(origin)) return true;",
      '  return false;',
      '}',
    ].join('\n');

    const guarded = exciseFunction(stripComments(planted), 'logCorsDecision');

    expect(guarded).not.toBeNull();
    expect(guarded).not.toContain('debug()'); // the excision really happened
    expect(guarded).toContain('NODE_ENV'); // and the survivor is still caught
  });

  it('reads no environment variable', () => {
    expect(decisionPath).not.toContain('process.env');
  });

  it('reads NODE_ENV nowhere — not directly, not via a destructure or an alias', () => {
    expect(decisionPath).not.toContain('NODE_ENV');
  });

  it('has no `development` / `production` string literal left to branch on', () => {
    expect(decisionPath).not.toMatch(/['"`]development['"`]/);
    expect(decisionPath).not.toMatch(/['"`]production['"`]/);
  });

  it('no longer carries the deleted loopback branch or its helper (B-7)', () => {
    expect(code).not.toContain('development_loopback');
    expect(code).not.toContain('isLoopbackOrigin');
    expect(code).not.toContain('isLoopbackHost');
  });

  /**
   * H-4. `credentials: false` is security-load-bearing (TASK-610 §4C.2) and is
   * pinned behaviourally in `cors.config.enforcement.task610.test.ts`. It is
   * restated at the source level here because this lane deletes lines from this
   * file, and "tidying up" that literal while nearby is the plausible accident.
   */
  it('still sets credentials: false (H-4 — not this lane, not any lane)', () => {
    expect(code).toContain('credentials: false');
  });
});
