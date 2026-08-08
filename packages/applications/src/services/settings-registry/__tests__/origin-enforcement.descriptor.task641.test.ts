// TASK-641 §3.1 step 3 / T-9 — `origin.enforcementEnabled` flips from
// permissive-by-default (TASK-610 §4C) to enforcing-by-default.
//
// Owner directive: "no default is off." The descriptor's `default` IS the
// platform posture on a fresh database (no row is seeded for this key — see
// `origin-enforcement.descriptor.task610.test.ts` for the properties that stay
// unchanged: tier/dataType/maxScope/globalOnly/failMode). This test pins ONLY
// the value that TASK-641 reverses, so a silent revert to permissive-by-default
// is caught here rather than discovered as a production CORS regression.
import { describe, expect, it } from 'vitest';

import { HOPE_SETTINGS_REGISTRY } from '../registry';

const KEY = 'origin.enforcementEnabled';

describe('origin.enforcementEnabled descriptor (TASK-641 — enforcement ON by default)', () => {
  const descriptor = HOPE_SETTINGS_REGISTRY.get(KEY);

  it('is registered in the assembled catalog', () => {
    expect(descriptor, `no descriptor registered for '${KEY}'`).toBeDefined();
  });

  it('defaults to TRUE — enforcing by default, for every tenant including SYSTEM and GLOBAL (FR-6)', () => {
    expect(descriptor!.default).toBe(true);
  });

  it('keeps failMode open-to-default — an unreadable control plane fails INTO enforcement, a deliberate trade (H-3)', () => {
    expect(descriptor!.failMode).toBe('open-to-default');
  });

  it('states plainly, in the description, what the new default means', () => {
    const description = descriptor!.description.toLowerCase();
    expect(description).toContain('default');
    // The description must no longer claim FALSE is the default.
    expect(description).not.toMatch(/false\s*—\s*the default/);
  });
});
