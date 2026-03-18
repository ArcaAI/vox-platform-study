import { extractScopeFromPath } from './lib/scope-utils';
import type { DocRegistry, DocRegistryMap } from './types';

type RegistryModule = {
  default?: DocRegistry;
  docs?: DocRegistry;
};

const registryModules = import.meta.glob<RegistryModule>('/src/docs/**/index.ts');

function resolveRegistryFromModule(module: RegistryModule): DocRegistry | null {
  if (module.default) return module.default;
  if (module.docs) return module.docs;
  return null;
}

function validateRegistry(value: unknown): value is DocRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([key, entry]) => {
    if (!key.trim()) return false;
    if (!entry || typeof entry !== 'object') return false;
    return typeof (entry as Record<string, unknown>).content === 'string';
  });
}

function buildDocRegistryMap(): DocRegistryMap {
  const map: DocRegistryMap = {};

  for (const [path, importModule] of Object.entries(registryModules)) {
    const scopeKey = extractScopeFromPath(path);
    if (!scopeKey) {
      console.warn(`[DocPanel] Could not extract scope key from module path: "${path}" — skipping`);
      continue;
    }

    if (scopeKey in map) {
      throw new Error(`[DocPanel] Duplicate doc registry scope detected: "${scopeKey}" (conflicting path: "${path}")`);
    }

    map[scopeKey] = async () => {
      const module = await importModule();
      const registry = resolveRegistryFromModule(module);
      if (registry === null) {
        throw new Error(`[DocPanel] Docs module at "${path}" has no valid export (expected "default" or "docs")`);
      }
      if (!validateRegistry(registry)) {
        throw new Error(`[DocPanel] Docs module at "${path}" exports an invalid registry shape`);
      }
      return registry;
    };
  }

  return map;
}

export const docRegistryMap: DocRegistryMap = buildDocRegistryMap();

const registryCache = new Map<string, DocRegistry>();

export async function loadRegistry(featureId: string): Promise<DocRegistry | null> {
  if (registryCache.has(featureId)) {
    return registryCache.get(featureId)!;
  }

  const loader = docRegistryMap[featureId];
  if (!loader) return null;

  try {
    const registry = await loader();
    registryCache.set(featureId, registry);
    return registry;
  } catch (error) {
    console.error(`[DocPanel] Failed to load registry for feature "${featureId}":`, error);
    return null;
  }
}