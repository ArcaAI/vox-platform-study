// TASK-799 lane A.1 — the structural guard that keeps the bug fixed.
//
// THE DEFECT THIS EXISTS TO PREVENT. `EffectiveConfigService.resolveKey`
// deliberately catches a resolver failure and degrades to
// `{value: null, source: 'env-fallback'}` so a control-plane outage cannot take
// a Python service down. That degradation is correct for a TRANSIENT failure
// and catastrophic for a PERMANENT one: a descriptor whose tier has no resolver
// at all compiles, deploys, and serves `null` on every pull, forever, with a
// single WARN line to show for it. Three Phase-2 lanes (harness claim-check,
// stt STORAGE_PROVIDER, text's response views) each discovered this the hard
// way and each correctly refused to ship.
//
// Runtime cannot distinguish the two cases, so the check belongs HERE, where
// "this key is served to a deployable" and "this key has a lane" are both
// static facts. `effectiveResolverLane` is the same function
// `resolveEffective` dispatches on, so this can never drift from the
// implementation the way a transcribed list would.

import { describe, expect, it } from 'vitest';
import { effectiveResolverLane } from '../effective-settings.service';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

describe('consumedBy ⇒ the key is actually resolvable', () => {
  it('every descriptor served on the pull route has a registered resolver lane', () => {
    const orphans = HOPE_SETTINGS_REGISTRY.list()
      .filter((d) => d.consumedBy && d.consumedBy.length > 0)
      .filter((d) => effectiveResolverLane(d) === null)
      .map((d) => `${d.key} (tier: ${d.tier})`);

    expect(orphans, 'these keys are declared `consumedBy` but resolve to nothing — the pull route would serve null forever').toEqual([]);
  });

  it('no secret is declared consumedBy — the read surface filters them, but a declaration is still a defect', () => {
    const secrets = HOPE_SETTINGS_REGISTRY.list()
      .filter((d) => d.consumedBy && d.consumedBy.length > 0 && d.sensitivity === 'secret')
      .map((d) => d.key);

    expect(secrets).toEqual([]);
  });

  it('the db-config lane is open, and `storage.platformDefault.*` is what proves it', () => {
    // A named regression anchor: if the branch is ever removed, this fails with
    // a sentence rather than with an empty-array diff.
    const region = HOPE_SETTINGS_REGISTRY.getOrThrow('storage.platformDefault.region');
    expect(region.tier).toBe('db-config');
    expect(effectiveResolverLane(region)).toBe('db-config:platform-storage');
  });
});
