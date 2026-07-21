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

  /** Register one descriptor. Throws on a duplicate key so assembly fails loudly. */
  register(descriptor: SettingDescriptor): this {
    if (this.byKey.has(descriptor.key)) {
      throw new Error(`SettingsRegistry: duplicate setting key '${descriptor.key}'`);
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
