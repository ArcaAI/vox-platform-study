// TASK-610 §4C — `origin.enforcementEnabled` is the switch that decides whether
// ANY of this ticket's origin machinery enforces.
//
// The descriptor is not decoration: its `default` IS the platform posture on a
// fresh database (no row is seeded — the registry write lane creates one when an
// operator first sets it), so a wrong default here silently changes whether the
// gateway admits every origin or refuses every unregistered one. Each assertion
// below pins one property that would fail SILENTLY if it drifted.
import { describe, expect, it } from 'vitest';

import { HOPE_SETTINGS_REGISTRY } from '../registry';

const KEY = 'origin.enforcementEnabled';

describe('origin.enforcementEnabled descriptor (TASK-610 §4C)', () => {
  const descriptor = HOPE_SETTINGS_REGISTRY.get(KEY);

  it('is registered in the assembled catalog', () => {
    expect(descriptor, `no descriptor registered for '${KEY}'`).toBeDefined();
  });

  it('defaults to FALSE — permissive by default, for every tenant including SYSTEM (owner directive §4C.1)', () => {
    expect(descriptor!.default).toBe(false);
  });

  it('is a boolean `global-kv` platform switch (not env, not per-tenant)', () => {
    expect(descriptor!.dataType).toBe('boolean');
    expect(descriptor!.tier).toBe('global-kv');
    expect(descriptor!.maxScope).toBe('system');
    expect(descriptor!.globalOnly).toBe(true);
  });

  it('fails OPEN to its default — an unreadable control plane must not start refusing browser traffic', () => {
    expect(descriptor!.failMode).toBe('open-to-default');
  });

  it('states plainly, in the description, what FALSE means', () => {
    const description = descriptor!.description.toLowerCase();
    expect(description).toContain('every origin');
    expect(description).toContain('every tenant');
  });
});
