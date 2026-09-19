/**
 * `pool-observability.ts` classifies an acquire failure by MATCHING `pg-pool`'s
 * error message, because the library exposes no code, no class and no event for
 * either timeout. That is a string dependency on a third-party internal, and a
 * silent one: if `pg` renames a message, `classifyPgAcquireError` quietly
 * degrades every saturation timeout to `error`, the
 * `..._prisma_pool_acquire_timeouts_total{reason="pool_exhausted"}` series
 * reads zero forever, and the HPA loses exactly the signal TASK-993 OD-3 asked
 * for — with nothing failing.
 *
 * So the dependency is pinned here, against the INSTALLED package. A pg upgrade
 * that moves either literal is a red test with an obvious fix, instead of a
 * counter that cannot fire.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PG_POOL_TIMEOUT_MESSAGES } from '../pool-observability.js';

const require_ = createRequire(import.meta.url);

/** Resolve the `pg-pool` source `pg` itself will load at runtime. */
function readInstalledPgPoolSource(): string {
  // `pg` depends on `pg-pool`; resolving from `pg`'s own directory follows the
  // same path Node takes for `require('pg-pool')` inside `pg/lib/index.js`,
  // which is what pnpm's nested layout demands.
  const pgEntry = require_.resolve('pg');
  const pgPoolEntry = createRequire(pgEntry).resolve('pg-pool');
  return readFileSync(join(dirname(pgPoolEntry), 'index.js'), 'utf8');
}

describe('pg-pool timeout message parity', () => {
  const source = readInstalledPgPoolSource();

  it('still constructs the pool-exhaustion message we classify on', () => {
    expect(source).toContain(PG_POOL_TIMEOUT_MESSAGES.poolExhausted);
  });

  it('still constructs the handshake-timeout message we classify on', () => {
    expect(source).toContain(PG_POOL_TIMEOUT_MESSAGES.connectTimeout);
  });

  it('reads a file that really is pg-pool (guards against an empty/mis-resolved read)', () => {
    expect(source).toContain('waitingCount');
    expect(source.length).toBeGreaterThan(1_000);
  });
});
