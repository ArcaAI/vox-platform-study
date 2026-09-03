/**
 * Round 5 lane E — the API-key skip message names the cause that fired.
 *
 * THE DEFECT. `SEED_DEMO_DATA` in `index.ts` is
 * `isPhaseEnabled('02-apikey', mode) && shouldSeedApiKeys(nodeEnv)` — two
 * INDEPENDENT gates — but the warning printed when it is false asserted only
 * the second: `NODE_ENV="<x>" is not development/test`. Run the seed with
 * `RUN_SEED=safe` and `NODE_ENV=development` and it told the operator that
 * NODE_ENV was not development, which is FALSE. An operator chasing that
 * message edits `NODE_ENV`, re-runs, and gets the identical warning, because
 * the real gate was the seed MODE all along.
 *
 * A wrong diagnostic is worse than no diagnostic: it spends the reader's time
 * proving the message wrong before they can start on the real cause.
 */
import { describe, expect, it } from 'vitest';

import { describeApiKeySeedingSkip } from '../02-apikey';

describe('API-key seeding skip reason', () => {
  it('names the seed MODE when that is what excluded the phase', () => {
    const reason = describeApiKeySeedingSkip('safe', 'development');
    expect(reason).toContain('02-apikey');
    expect(reason).toContain('safe');
    // The old message's lie: NODE_ENV *is* development here.
    expect(reason).not.toContain('NODE_ENV');
  });

  it('names NODE_ENV when that is what excluded the phase', () => {
    const reason = describeApiKeySeedingSkip('all', 'production');
    expect(reason).toContain('NODE_ENV="production"');
    expect(reason).not.toContain('02-apikey');
  });

  it('names BOTH when both gates are closed', () => {
    const reason = describeApiKeySeedingSkip('safe', 'production');
    expect(reason).toContain('02-apikey');
    expect(reason).toContain('NODE_ENV="production"');
    expect(reason).toContain(' and ');
  });

  it('refuses to describe a skip that is not happening', () => {
    // `all` + development seeds the demo keys; asking for a skip reason here is
    // a caller bug, and returning a plausible sentence would hide it.
    expect(() => describeApiKeySeedingSkip('all', 'development')).toThrow(/not skipped/i);
  });

  it('reports `none` mode through the phase gate', () => {
    const reason = describeApiKeySeedingSkip('none', 'test');
    expect(reason).toContain('02-apikey');
    expect(reason).toContain('none');
  });
});
