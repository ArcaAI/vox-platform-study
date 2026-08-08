// TASK-610 §4C — `origin.enforcementEnabled` is the switch that decides whether
// ANY of this ticket's origin machinery enforces.
//
// The descriptor is not decoration: its `default` IS the platform posture on a
// fresh database (no row is seeded — the registry write lane creates one when an
// operator first sets it), so a wrong default here silently changes whether the
// gateway admits every origin or refuses every unregistered one. Each assertion
// below pins one property that would fail SILENTLY if it drifted.
//
// TASK-641 FR-6 REVERSED the default this file originally pinned (permissive,
// `false`) to enforcing (`true`) — "no default is off". The shape/tier/
// failMode assertions below are unchanged and still hold; the default-value
// assertion was updated in place to the new value rather than deleted, so this
// file keeps pinning EVERY property of the descriptor, not just the ones
// TASK-641 left alone. `origin-enforcement.descriptor.task641.test.ts` is the
// companion file that documents and pins specifically the value and rationale
// TASK-641 changed — read it for the "why", this file for "still true".
import { describe, expect, it } from 'vitest';

import { HOPE_SETTINGS_REGISTRY } from '../registry';

const KEY = 'origin.enforcementEnabled';

describe('origin.enforcementEnabled descriptor (TASK-610 §4C, default reversed by TASK-641)', () => {
  const descriptor = HOPE_SETTINGS_REGISTRY.get(KEY);

  it('is registered in the assembled catalog', () => {
    expect(descriptor, `no descriptor registered for '${KEY}'`).toBeDefined();
  });

  it('defaults to TRUE — enforcing by default, for every tenant including SYSTEM (TASK-641 FR-6, reverses this file\'s original §4C.1 assertion)', () => {
    expect(descriptor!.default).toBe(true);
  });

  it('is a boolean `global-kv` platform switch (not env, not per-tenant)', () => {
    expect(descriptor!.dataType).toBe('boolean');
    expect(descriptor!.tier).toBe('global-kv');
    expect(descriptor!.maxScope).toBe('system');
    expect(descriptor!.globalOnly).toBe(true);
  });

  it('keeps failMode open-to-default — TASK-641 did not touch failMode, only what it now defaults into (H-3)', () => {
    expect(descriptor!.failMode).toBe('open-to-default');
  });

  it('states plainly, in the description, what the current default means', () => {
    const description = descriptor!.description.toLowerCase();
    expect(description).toContain('every origin');
    expect(description).toContain('every tenant');
  });
});
