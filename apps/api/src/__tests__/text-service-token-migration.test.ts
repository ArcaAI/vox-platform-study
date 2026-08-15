// Pin the apps/api TEXT_SERVICE_TOKEN sites.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

const SOURCES = [
  // proxy controllers (sync — getSecretSync because on.proxyReq /
  // getForwardHeaders cannot await).
  'src/shared/base-proxy.controller.ts',
  'src/modules/streaming/text-proxy.controller.ts',
];

describe('TEXT_SERVICE_TOKEN migration (apps/api proxies)', () => {
  for (const rel of SOURCES) {
    describe(rel, () => {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');

      it('does not read process.env.TEXT_SERVICE_TOKEN', () => {
        expect(src).not.toMatch(/process\.env\.TEXT_SERVICE_TOKEN/);
      });

      it('reads TEXT_SERVICE_TOKEN via SecretsService.getSecretSync (sync hot path)', () => {
        // Allow optional chaining (?.) for sites that fall back when the
        // SecretsService is not provided in tests.
        expect(src).toMatch(/(secrets|secretsService)\??\.getSecretSync\(['"]TEXT_SERVICE_TOKEN['"]/);
      });
    });
  }
});
