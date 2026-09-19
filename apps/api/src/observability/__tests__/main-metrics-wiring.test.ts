/**
 * Two ordering invariants in `main.ts` that are load-bearing and INVISIBLE —
 * violating either leaves the metrics registered, the scrape well-formed and
 * the numbers quietly wrong, with nothing failing.
 *
 *   1. `installPrismaPoolMetrics()` must run BEFORE `NestFactory.create()`.
 *      The DI warmup (secrets cache, settings registry) issues the process's
 *      first Prisma queries; an acquire observer registered afterwards has
 *      already missed them, and a pool that saturates during warmup — the most
 *      interesting moment there is — would never be seen.
 *
 *   2. The response counter must be the FIRST `app.use(...)`. Express runs
 *      middleware in registration order, so anything registered ahead of it
 *      (session, CORS, the security-header layer) can answer a request without
 *      this ever attaching its `close` listener.
 *
 * A source-shape assertion is the only way to pin an ordering that has no
 * runtime surface. It is deliberately narrow: it checks WHERE two calls sit,
 * not what the file says.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Comments are stripped first: `main.ts` EXPLAINS these orderings in prose
 * beside the calls, so an un-stripped search finds the explanation before the
 * statement and the assertion inverts.
 */
const mainSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'main.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

describe('main.ts metrics wiring', () => {
  it('installs the pool metrics before the Nest container is built', () => {
    const install = mainSource.indexOf('installPrismaPoolMetrics()');
    const nestFactory = mainSource.indexOf('NestFactory.create(');

    expect(install).toBeGreaterThan(-1);
    expect(nestFactory).toBeGreaterThan(-1);
    expect(install).toBeLessThan(nestFactory);
  });

  it('installs the pool metrics after loadEnv(), so the metric prefix is resolved', () => {
    expect(mainSource.indexOf('loadEnv()')).toBeLessThan(mainSource.indexOf('installPrismaPoolMetrics()'));
  });

  it('registers the response counter as the FIRST app.use(...)', () => {
    const firstUse = mainSource.indexOf('app.use(');
    expect(firstUse).toBeGreaterThan(-1);
    expect(mainSource.slice(firstUse, firstUse + 60)).toContain('httpResponseMetricsMiddleware()');
  });
});
