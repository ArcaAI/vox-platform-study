// TASK-883 — the gateway's TEXT proxies present the ONE shared internal token.
//
// Owner rule: a single devops-set `INTERNAL_ACCESS_TOKEN` authenticates every
// internal hop. The per-service `TEXT_SERVICE_TOKEN` was the migration
// fallback; these three sites are the last gateway readers of it and they are
// retired here. (The descriptor itself is NOT removed by this lane — ~10
// `packages/applications` call sites still pass the name to
// `resolveInternalAccessToken` as their legacy fallback.)
//
// All three are SYNCHRONOUS hot paths — `on.proxyReq` and `getForwardHeaders`
// cannot await — so they read the bootstrap-warmed cache via `getSecretSync`
// rather than the async `resolveInternalAccessToken` helper.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

const SOURCES = ['src/shared/base-proxy.controller.ts', 'src/modules/streaming/text-proxy.controller.ts', 'src/modules/text-compat/text-compat.controller.ts'];

describe('gateway TEXT proxies present INTERNAL_ACCESS_TOKEN', () => {
  for (const rel of SOURCES) {
    describe(rel, () => {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');

      it('reads no service token from process.env', () => {
        expect(src).not.toMatch(/process\.env\.(TEXT_)?SERVICE_TOKEN/);
        expect(src).not.toMatch(/process\.env\.INTERNAL_ACCESS_TOKEN/);
      });

      it('reads INTERNAL_ACCESS_TOKEN via SecretsService.getSecretSync (sync hot path)', () => {
        // Optional chaining is allowed: these sites fall back to no header when
        // the SecretsService is not provided (tests, cold cache).
        expect(src).toMatch(/(secrets|secretsService)\??\.getSecretSync\(['"]INTERNAL_ACCESS_TOKEN['"]/);
      });

      it('never LOOKS UP the retired per-service TEXT_SERVICE_TOKEN', () => {
        // The name may still appear in a comment saying what was retired and
        // why; what must not survive is a lookup of it.
        expect(src).not.toMatch(/getSecret\w*\(\s*['"]TEXT_SERVICE_TOKEN['"]/);
      });
    });
  }
});
