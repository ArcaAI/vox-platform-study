/**
 * TASK-972 Lane 2 — the training-capture gate is only real if `ConfigResolver` actually resolves
 * in BOTH halves of the mining loop, AND the instance it resolves to can read the tenant setting.
 *
 * Both injections are `@Optional()`, so a missing provider is silent: the gate answers its code
 * default (enabled) for every tenant and an opted-out clinician is mined anyway. That is the
 * failure these specs exist to catch.
 *
 * The wiring is deliberately a LOCAL provider rather than an import of `ConfigResolverModule`.
 * `ConfigResolverModule` cannot import `EffectiveSettingsModule` without closing a cycle through
 * the package-wide `services` barrel (the path is written out in `config-resolver.module.ts`),
 * and a Nest module whose `imports` array contains `undefined` fails to boot. Declaring
 * `ConfigResolver` here instead adds no edge at all: both of its collaborators come from modules
 * this one already imports. The last spec pins that the cycle stays un-closed.
 *
 * This file imports NOTHING from the consultation graph on purpose — pulling in
 * `SummaryServiceModule` would put `config-resolver/index.ts` in flight, and bindings resolved
 * inside that window read as `undefined` for reasons that predate this ticket.
 */
import { describe, it, expect } from 'vitest';
import { UserSettingsRepository } from '@arcaai/domains';
import { GateEditMiningServiceModule } from '../gate-edit-mining.service.module';
import { ConfigResolverModule } from '../../config-resolver';
import { ConfigResolver } from '../../config-resolver/config-resolver.service';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { MODULE_IMPORTS_METADATA, MODULE_PROVIDERS_METADATA, metadata, resolvableTokens } from './module-graph.helper';

describe('GateEditMiningServiceModule — TASK-972 Lane 2 wiring', () => {
  it('declares ConfigResolver as its own provider, so the queue and the processor both get one', () => {
    expect(metadata(GateEditMiningServiceModule, MODULE_PROVIDERS_METADATA)).toContain(ConfigResolver);
  });

  it('can build the FULL resolver: the tenant-gate cascade and the doctor`s preference row both resolve here', () => {
    const tokens = resolvableTokens(GateEditMiningServiceModule);
    // Without this the tenant gate silently answers its code default for every tenant.
    expect(tokens.has(EffectiveSettingsService)).toBe(true);
    // Without this the clinician's own opt-out is never read at all.
    expect(tokens.has(UserSettingsRepository)).toBe(true);
  });
});

describe('ConfigResolverModule — the cycle that must stay un-closed', () => {
  it('does NOT import the settings registry — that edge closes a cycle through the `services` barrel', () => {
    const imports = metadata(ConfigResolverModule, MODULE_IMPORTS_METADATA).map((m) => (m as { name?: string })?.name);
    expect(imports).not.toContain('EffectiveSettingsModule');
    // …and nothing in its import list is `undefined`, which is what that cycle produces and what
    // Nest refuses to boot with.
    expect(metadata(ConfigResolverModule, MODULE_IMPORTS_METADATA).filter((m) => m === undefined)).toEqual([]);
  });
});
