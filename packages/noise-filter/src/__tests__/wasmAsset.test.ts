/**
 * TASK-269 — CRIT-2
 *
 * Default WASM source must not be a hard-coded CDN URL. The binary
 * is bundled with the package and resolved via `import.meta.url`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDefaultWasmUrl } from '../wasmAsset.js';

describe('getDefaultWasmUrl (CRIT-2)', () => {
  it('does not reference a third-party CDN', () => {
    const url = getDefaultWasmUrl();
    expect(url).not.toContain('cdn.jsdelivr.net');
    expect(url).not.toContain('unpkg.com');
    expect(url).not.toContain('cdnjs.cloudflare.com');
  });

  it('resolves to a `rnnoise.wasm` URL', () => {
    const url = getDefaultWasmUrl();
    expect(url).toMatch(/rnnoise\.wasm$/);
    // Whatever scheme the bundler / runtime uses (file://, http://, blob:),
    // the path tail must point at the bundled asset directory.
    expect(url).toMatch(/\/assets\/rnnoise\.wasm$/);
  });

  it('ships the asset on disk at <pkg>/assets/rnnoise.wasm', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const assetPath = resolve(here, '..', '..', 'assets', 'rnnoise.wasm');
    expect(existsSync(assetPath)).toBe(true);
    const stats = statSync(assetPath);
    expect(stats.isFile()).toBe(true);
    expect(stats.size).toBeGreaterThan(10_000);
  });
});

describe('NoiseFilterProcessor default wasmPath', () => {
  it('uses the bundled asset, not the CDN, when no wasmPath is supplied', async () => {
    const { NoiseFilterProcessor } = await import('../processors/NoiseFilterProcessor.js');
    const proc = new NoiseFilterProcessor();
    const options = proc.getOptions();
    if (options.wasmPath !== undefined) {
      expect(options.wasmPath).not.toContain('cdn.jsdelivr.net');
    }

    // Stub fetch and capture the URL the processor would request.
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const stringUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
      calls.push(stringUrl);
      return new Response(new ArrayBuffer(0), { status: 200 });
    }) as typeof fetch;

    try {
      // Reach into the private loader by triggering the same code path it
      // uses; this is a deliberately small surface so we use a public probe.
      const loader = (proc as unknown as { loadWasmBinary: () => Promise<ArrayBuffer> }).loadWasmBinary;
      if (typeof loader === 'function') {
        await loader.call(proc);
      }
    } finally {
      globalThis.fetch = originalFetch;
      await proc.destroy();
    }

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((u) => u.includes('cdn.jsdelivr.net'))).toBe(false);
    expect(calls.every((u) => /rnnoise\.wasm/.test(u))).toBe(true);
  });
});
