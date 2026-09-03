/**
 * A small, accurate model of what NestJS can inject where — used by the R7
 * guards (/W3) so they assert RESOLUTION rather than the presence of
 * an import line.
 *
 * The distinction is load-bearing. Nest does NOT expose a grandchild module's
 * exports: importing `ChainSummaryServiceModule` (which itself imports
 * `GateEditMiningServiceModule`) does not give you `IGateEditExemplarRetriever`,
 * because `ChainSummaryServiceModule` exports only `ChainSummaryService`. So the
 * walk follows a module's `exports` — where a re-exported MODULE does propagate —
 * and never its `imports`.
 *
 * Not a test file: `vitest.config.ts` only collects `*.test.ts` / `*.spec.ts`.
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MODULE_IMPORTS_METADATA = 'imports';
export const MODULE_EXPORTS_METADATA = 'exports';
export const MODULE_PROVIDERS_METADATA = 'providers';

/** Every `*.module.ts` under `packages/applications/src/services`. */
export const SERVICES_ROOT = resolve(__dirname, '../..');

function moduleFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') moduleFiles(full, found);
    } else if (entry.name.endsWith('.module.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Module metadata, for a module CLASS (Reflect metadata) or a `DynamicModule`
 * (plain properties) alike — `BullModule.registerQueue(...)` and
 * `RedisCacheModule.register()` both produce the latter.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function metadata(target: any, key: string): unknown[] {
  if (target === null || (typeof target !== 'function' && typeof target !== 'object')) return [];
  const dynamic = (target as Record<string, unknown>)[key];
  if (Array.isArray(dynamic)) return dynamic;
  if (typeof target !== 'function') return [];
  return (Reflect.getMetadata(key, target) as unknown[]) ?? [];
}

/** Tokens a module hands to whoever imports it, following MODULE re-exports only. */
export function exportedTokens(entry: unknown, seen = new Set<unknown>()): Set<unknown> {
  const tokens = new Set<unknown>();
  if (!entry || seen.has(entry)) return tokens;
  seen.add(entry);

  for (const exported of metadata(entry, MODULE_EXPORTS_METADATA)) {
    tokens.add(exported);
    if (metadata(exported, MODULE_EXPORTS_METADATA).length > 0) {
      for (const t of exportedTokens(exported, seen)) tokens.add(t);
    }
  }
  return tokens;
}

/** Exactly what NestJS can inject into a provider declared in `moduleClass`. */
export function resolvableTokens(moduleClass: unknown): Set<unknown> {
  const tokens = new Set<unknown>();
  for (const imported of metadata(moduleClass, MODULE_IMPORTS_METADATA)) {
    for (const t of exportedTokens(imported)) tokens.add(t);
  }
  return tokens;
}

/**
 * The provider DEFINITION a module resolves `token` to, reached through its
 * import closure. `undefined` means the token does not resolve there at all.
 */
export function resolveProviderDefinition(moduleClass: unknown, token: unknown, seen = new Set<unknown>()): unknown {
  for (const imported of metadata(moduleClass, MODULE_IMPORTS_METADATA)) {
    if (!imported || seen.has(imported)) continue;
    seen.add(imported);
    if (!exportedTokens(imported).has(token)) continue;

    const own = metadata(imported, MODULE_PROVIDERS_METADATA).find((p) => (p as { provide?: unknown })?.provide === token || p === token);
    if (own) return own;

    // Re-exported from a nested module rather than provided here.
    const nested = resolveProviderDefinition(imported, token, seen);
    if (nested) return nested;
  }
  return undefined;
}

/** Every module in the package whose `providers` list contains `provider`. */
export async function modulesProviding(provider: unknown): Promise<[string, unknown][]> {
  const providers: [string, unknown][] = [];
  for (const file of moduleFiles(SERVICES_ROOT)) {
    const loaded = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const [name, exported] of Object.entries(loaded)) {
      if (typeof exported !== 'function') continue;
      if (metadata(exported, MODULE_PROVIDERS_METADATA).includes(provider)) providers.push([name, exported]);
    }
  }
  return providers;
}
