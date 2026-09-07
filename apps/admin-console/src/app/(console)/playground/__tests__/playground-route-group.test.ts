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
import { join } from 'node:path';

import { NAV_ENTRIES } from '@/shared/navigation/nav-config';

const APP = join(process.cwd(), 'src/app');

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
