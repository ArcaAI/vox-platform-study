// TASK-890 J7-5 — `workflowExposure.enabled` ships ON.
//
// The descriptor's `default: false` was a SHIPPED KILL SWITCH standing in for a
// precondition ("API-key scope enforcement must be verified end-to-end"). That
// precondition has been discharged — TASK-757 (`@ForbidApiKey()` checked before
// the scope check, boot audit) and TASK-776 (the 656-route authz matrix, the
// credential-class depth suites). With the precondition met, the pre-production
// posture applies: ship complete and ENABLED, and let a platform admin turn it
// off (`00-project-context.md` / the owner's build-for-day-1 rule).
//
// Left at `false`, the whole `/api/v1/workflows/:slug/…` surface 404s on a
// fresh install — the black-box J7 BLOCKER. The generated `.env.sample` is
// derived from this default and `pnpm setup:dev` copies it to `.env.dev`, so
// the descriptor default is the value a new developer actually runs with.

import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

const KEY = 'workflowExposure.enabled';

describe('workflowExposure.enabled descriptor', () => {
  it('defaults to ON', () => {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(KEY);
    expect(descriptor, `${KEY} is not registered`).toBeDefined();
    expect(descriptor!.default).toBe(true);
  });

  // A default-ON descriptor may not carry `killSwitch: true`: the marker means
  // "an ENFORCEMENT/engine gate that ships OFF" and `killSwitches()` throws on a
  // truthy default. Dropping it is REQUIRED by the flip, not incidental to it —
  // and the registry must still assemble, which is what the second assertion
  // proves (it is the same call the governance suite makes).
  it('is not marked a kill switch, and the kill-switch governance still holds', () => {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(KEY)!;
    expect(descriptor.killSwitch).toBeUndefined();
    expect(() => HOPE_SETTINGS_REGISTRY.killSwitches()).not.toThrow();
  });

  it('stays an operator veto: an env-tier boolean a platform admin can set to false', () => {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(KEY)!;
    expect(descriptor.tier).toBe('env');
    expect(descriptor.dataType).toBe('boolean');
  });

  it('records that the API-key-scope precondition was discharged, so the default is not re-flipped by memory', () => {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(KEY)!;
    expect(descriptor.description).toMatch(/TASK-757/);
    expect(descriptor.description).toMatch(/TASK-776/);
  });
});
