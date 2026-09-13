// The settings registry container.
//
// A framework-agnostic, in-memory catalog of SettingDescriptors keyed by their
// canonical key. Kept pure (no Nest DI) so it is trivially testable and can be
// assembled at module load; the only cross-cutting dependency is the domain
// exception used to signal a clamp violation as a 400.

import { ArgumentInvalidException } from '@arcaai/exceptions';
import { SCOPE_DEPTH, SettingDescriptor, SettingScope } from './registry.types';

export class SettingsRegistry {
  private readonly byKey = new Map<string, SettingDescriptor>();

  /**
   * Register one descriptor. Throws on a duplicate key so assembly fails loudly,
   * and enforces the fail-closed invariant for secrets.
   *
   * The secret check runs HERE — at true assembly time — rather than in a
   * lister like `killSwitches()`, because it is a per-descriptor invariant with
   * no cross-descriptor view: asserting it on `register` makes a violating
   * registry impossible to construct at all, instead of merely detectable by
   * whoever remembers to call the lister.
   */
  register(descriptor: SettingDescriptor): this {
    if (this.byKey.has(descriptor.key)) {
      throw new Error(`SettingsRegistry: duplicate setting key '${descriptor.key}'`);
    }
    if (descriptor.sensitivity === 'secret' && descriptor.failMode !== 'closed') {
      throw new Error(
        `SettingsRegistry: secret setting '${descriptor.key}' must declare failMode 'closed' ` +
          `(got '${descriptor.failMode}'). A secret that falls back to a default silently substitutes ` +
          'a value the caller never authenticated against.',
      );
    }
    if (descriptor.sensitivity === 'secret' && descriptor.sampleValue !== undefined) {
      throw new Error(
        `SettingsRegistry: secret setting '${descriptor.key}' must not declare 'sampleValue' — ` +
          'that field exists to put a real-looking value into a COMMITTED template file, which is ' +
          'exactly what a secret must never carry.',
      );
    }
    this.byKey.set(descriptor.key, descriptor);
    return this;
  }

  registerAll(descriptors: SettingDescriptor[]): this {
    for (const d of descriptors) this.register(d);
    return this;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  get(key: string): SettingDescriptor | undefined {
    return this.byKey.get(key);
  }

  /** Like get, but throws when the key is not registered. */
  getOrThrow(key: string): SettingDescriptor {
    const d = this.byKey.get(key);
    if (!d) throw new Error(`SettingsRegistry: unknown setting '${key}'`);
    return d;
  }

  list(): SettingDescriptor[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }

  /** Map each requested key to its server-side category (throws on an unknown key). */
  categoriesOf(keys: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of keys) out[key] = this.getOrThrow(key).category;
    return out;
  }

  /**
   * Every registered enforcing kill-switch. Governance invariant: a kill-switch
   * MUST default OFF (fail-safe) — throws at call time if any defaults truthy,
   * so an accidental default-ON flip is caught by the governance test.
   */
  killSwitches(): SettingDescriptor[] {
    const switches = this.list().filter((d) => d.killSwitch === true);
    const defaultOn = switches.filter((d) => d.default === true);
    if (defaultOn.length > 0) {
      throw new Error(`SettingsRegistry: kill-switch(es) must default OFF but default ON: ${defaultOn.map((d) => d.key).join(', ')}`);
    }
    return switches;
  }

  /**
   * Every secret-sensitivity descriptor. All are `failMode: 'closed'` by the
   * `register()` invariant above; this is the catalog view (masking, write-only
   * UI treatment, and the Vault seeding script's key list).
   */
  secrets(): SettingDescriptor[] {
    return this.list().filter((d) => d.sensitivity === 'secret');
  }

  /**
   * ASSEMBLY-time check for every descriptor declaring `platformTierKey`: the
   * named twin must exist, be the PLATFORM tier (`maxScope: 'system'`), agree on
   * `dataType` and `globalOnly`, and not itself declare one.
   *
   * It lives here and NOT in `register()` for one reason: it is the only
   * CROSS-descriptor invariant in this container. `register()` sees one
   * descriptor at a time, so a forward reference — the tenant half registered
   * before its platform twin — would fail there for a registry that is perfectly
   * well formed. `registry.ts` calls this once, chained after `registerAll`, so
   * a mismatched pair still throws at module load and a violating registry
   * remains impossible to construct.
   *
   * Why each clause earns its place:
   *  - EXISTS: the write lane's refusal message names this key as the one to
   *    write instead, and the read lane resolves it. A name for a key that is
   *    not there turns a fix into a dead end.
   *  - `maxScope: 'system'`: the whole point of the twin is that it is the
   *    platform row the pull route serves. A `tenant`-scope "platform tier"
   *    would reintroduce the dead write one level up.
   *  - same `dataType`: the console renders ONE control for both halves.
   *  - same `globalOnly`: one row cannot have two audiences. The pair collapses
   *    into a single row precisely because OD-2 confirmed both halves are
   *    platform-admin-only; if that ever diverges the collapse is wrong and the
   *    registry must say so rather than render a control half its viewers may
   *    not use.
   *  - no CHAIN: a platform tier is the top of the pair, so a tier with a tier
   *    has no top — and the read lane, which follows exactly one hop, would
   *    silently report the wrong half.
   */
  assertPlatformTierPairs(): this {
    for (const descriptor of this.byKey.values()) {
      const twinKey = descriptor.platformTierKey;
      if (twinKey === undefined) continue;

      const problem = ((): string | undefined => {
        const twin = this.byKey.get(twinKey);
        if (!twin) return `names platform tier '${twinKey}', which is not a registered setting`;
        if (twin.maxScope !== 'system') {
          return `names platform tier '${twinKey}', whose maxScope is '${twin.maxScope}' — a platform tier must be 'system'`;
        }
        if (twin.dataType !== descriptor.dataType) {
          return `names platform tier '${twinKey}', whose dataType '${twin.dataType}' differs from its own '${descriptor.dataType}' — the pair renders as one control`;
        }
        if ((twin.globalOnly ?? false) !== (descriptor.globalOnly ?? false)) {
          return `names platform tier '${twinKey}', whose globalOnly '${twin.globalOnly ?? false}' differs from its own '${descriptor.globalOnly ?? false}' — one row cannot have two audiences`;
        }
        if (twin.platformTierKey !== undefined) {
          return `names platform tier '${twinKey}', which itself declares platformTierKey '${twin.platformTierKey}' — a platform tier is the top of the pair, so a chain has no top`;
        }
        return undefined;
      })();

      if (problem) {
        throw new Error(`SettingsRegistry: setting '${descriptor.key}' ${problem}.`);
      }
    }
    return this;
  }

  /**
   * Enforce the max-scope clamp for a write: the requested scope may not be
   * DEEPER (more specific) than the setting's `maxScope`. E.g. a setting capped
   * at `department` cannot be set per-`doctor`. Throws `ArgumentInvalidException`
   * (→ HTTP 400) on a violation, mirroring the pipeline-policy write guard.
   */
  assertWithinMaxScope(key: string, requestedScope: SettingScope): void {
    const descriptor = this.getOrThrow(key);
    if (SCOPE_DEPTH[requestedScope] > SCOPE_DEPTH[descriptor.maxScope]) {
      throw new ArgumentInvalidException(`Setting '${key}' may not be set at '${requestedScope}' scope (max: '${descriptor.maxScope}').`);
    }
  }
}
