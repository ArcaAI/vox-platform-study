import type { SettingScope } from './types';

/** Query keys for the descriptor-driven settings registry lane. */
export const settingsRegistryKeys = {
  root: ['settings-registry'] as const,
  catalog: () => [...settingsRegistryKeys.root, 'catalog'] as const,
  /** Scoped: the same key resolves to a different row per scope. */
  setting: (key: string, scope: SettingScope) => [...settingsRegistryKeys.root, 'setting', key, scope] as const,
};
