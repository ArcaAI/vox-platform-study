/**
 * TASK-1004 D-8/OD-1 — the stateless, v1-compat `hope.summarization.*` surface (and the text-compat
 * gateway routes it called) was removed outright (zero production traffic in the ten days before
 * removal; superseded OD-704). Pins the absence so a future change cannot silently reintroduce it.
 * Use `hope.consultations.summaries.*` (consultation-bound) or `hope.agents.invoke()` instead.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HopeClient } from '../client';
import { buildUrl } from '../core/url';

const PACKAGE_ROOT = resolve(__dirname, '..', '..');

describe('hope.summarization.* is gone (TASK-1004 D-8)', () => {
  it('HopeClient carries no .summarization property', () => {
    const client = new HopeClient({ baseUrl: 'http://localhost:8868' });
    expect('summarization' in client).toBe(false);
  });

  it('src/resources/summarization.ts and src/types/summarization.ts no longer exist', () => {
    expect(existsSync(join(PACKAGE_ROOT, 'src', 'resources', 'summarization.ts'))).toBe(false);
    expect(existsSync(join(PACKAGE_ROOT, 'src', 'types', 'summarization.ts'))).toBe(false);
  });

  it('the retired examples no longer exist', () => {
    expect(existsSync(join(PACKAGE_ROOT, 'examples', '01-summary.ts'))).toBe(false);
    expect(existsSync(join(PACKAGE_ROOT, 'examples', '02-presummary-stream.ts'))).toBe(false);
  });

  it.each(['api/smr/api/v1/presummary', 'api/smr/api/v1/summary/sync', 'api/stt/start_session', 'api/stt/switch', 'api/stt/stop_session'])(
    'core/url.ts no longer exempts %s from the api/v1 prefix',
    (path) => {
      expect(buildUrl('http://localhost:8868', path)).toBe(`http://localhost:8868/api/v1/${path}`);
    },
  );
});
