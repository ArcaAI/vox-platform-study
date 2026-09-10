/**
 * TASK-890 black-box J5 — the clinician playground must be reachable by a clinician.
 *
 * Rule 13 §Routing: "Tier 50–59 (playground) has NO route group of its own: the five playground
 * screens are nested under (console)/(tenant)/playground/* and gated at the NAV level by a role
 * check, not by a group layout. They carry an empty ability list (`required: []`) for that
 * reason." The file layout said otherwise — sitting inside `(tenant)` put them behind that
 * group's tier-30–49 layout, which `notFound()`s anyone who is neither TENANT_ADMIN nor
 * elevated. A signed-in DOCTOR opening /playground/consultation got "Page not found", so the
 * Consultation Scribe, Live Transcription, voice enrollment and DNA-writing-style screens were
 * unreachable by exactly the people they are for.
 *
 * The guard a playground route may sit behind is `(console)` — signed in — and nothing narrower.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NAV_ENTRIES } from '@/shared/navigation/nav-config';

/**
 * Anchored to THIS FILE, never to `process.cwd()`.
 *
 * It used to be `join(process.cwd(), 'src/app')`, which made the result depend on where vitest
 * was invoked from rather than on what the repository contains. `pnpm --filter
 * @arcaai/admin-console test` runs with the package as its cwd and passed; the same suite driven
 * from the repo root (`vitest run --root apps/admin-console`, which does NOT change the process
 * cwd) resolved `<repo>/src/app`, found nothing, and reported every playground route as missing.
 *
 * A route-layout assertion that answers differently depending on the caller's shell is worse than
 * no assertion: it cries wolf on a healthy tree, and a real regression would be indistinguishable
 * from the noise. This file sits at `src/app/(console)/playground/__tests__`, so `../../..` is
 * `src/app` wherever the checkout lives — including a git worktree.
 */
const APP = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('playground routes (tier 50–59) sit outside the tenant-admin route group', () => {
  it('every tier 50–59 entry has a page under (console)/<route> and none under (console)/(tenant)', () => {
    // Ability gates still apply per entry. (/playground/workbench was retired in TASK-893: running
    // a definition now lives in the Workflow Studio's Run tab, and the route only redirects.)
    const playground = NAV_ENTRIES.filter((entry) => entry.tier === '50-59');
    expect(playground.length).toBeGreaterThan(0);
    for (const entry of playground) {
      expect(existsSync(join(APP, '(console)', `${entry.route}/page.tsx`))).toBe(true);
      expect(existsSync(join(APP, '(console)', '(tenant)', `${entry.route}/page.tsx`))).toBe(false);
    }
  });
});
