// The warmup list must cover every SYNCHRONOUS reader.
//
// `SecretsService.getSecretSync()` is cache-only BY DESIGN: it never falls back
// to the provider, because it exists for call sites that cannot await (passport
// verify callbacks, proxy `on.proxyReq` hooks, WS bridge headers). A key read
// that way and NOT warmed therefore resolves to `undefined` on EVERY request,
// forever — not just on the first one. The failure is silent: the caller omits
// an optional header, or substitutes a default, and the request 401s downstream.
//
// So: every string-literal `getSecretSync` key in gateway production code must
// appear in `COMMON_SERVICE_WARMUP_KEYS`, UNLESS that call site has an awaited
// fallback on the same expression (`getSecretSync(K) ?? await getSecretOptional(K)`),
// which self-heals a cold cache.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMON_SERVICE_WARMUP_KEYS } from '../../../common.service.module';
import { REPO_ROOT, scanSecretCallSites } from './secret-key-surface';

/** True when the same line also awaits an async lookup for the same key. */
function hasAsyncFallback(where: string, name: string): boolean {
  const [relativePath, lineNumber] = where.split(':');
  const line = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8').split(/\r?\n/)[Number(lineNumber) - 1] ?? '';
  return line.includes(`getSecretOptional('${name}')`) || line.includes(`getSecret('${name}')`);
}

describe('SecretsService warmup covers every synchronous reader', () => {
  it('has no getSecretSync key that is neither warmed nor async-fallback-backed', () => {
    const warmed = new Set<string>(COMMON_SERVICE_WARMUP_KEYS);

    const unwarmed = scanSecretCallSites()
      .filter((site) => site.method === 'getSecretSync')
      .filter((site) => !warmed.has(site.name))
      .filter((site) => !hasAsyncFallback(site.where, site.name));

    expect(
      unwarmed.map((s) => `${s.name} @ ${s.where}`),
      'getSecretSync() is cache-only — an unwarmed key resolves to undefined on every request. ' +
        'Add the key to COMMON_SERVICE_WARMUP_KEYS, or give the call site an awaited fallback.',
    ).toEqual([]);
  });
});
