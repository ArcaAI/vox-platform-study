/**
 * @arcaai/vox - CrossTabHmacKeyManager Tests (TASK-280)
 *
 * Validates the SharedWorker-backed HMAC key manager that replaces the
 * per-page module singleton used by `SimpleCrossTabSync`. The key invariant
 * is that two managers backed by the same SharedWorker (i.e. two tabs in
 * the same origin) sign with the SAME secret, so each verifies the other's
 * HMACs — which was impossible under the prior per-process singleton.
 *
 * Approach (locked in §3.4 of the ticket): we install a `globalThis.SharedWorker`
 * mock that maps any URL to a single shared in-memory worker impl and routes
 * RPC messages back to the originating port. A separate fallback test deletes
 * the mock and asserts the per-session secret path still signs/verifies.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CrossTabHmacKeyManager,
  __resetSessionHmacSecretForTests,
} from '../CrossTabHmacKeyManager';

// =============================================================================
// MockSharedWorker — a minimal SharedWorker stand-in. All instances sharing
// the same URL talk to the SAME `MockSharedWorkerImpl`, just like the real
// SharedWorker semantics (one worker process per origin+url+name).
// =============================================================================

type Req =
  | { id: string; op: 'sign'; payload: ArrayBuffer }
  | { id: string; op: 'verify'; payload: ArrayBuffer; hmac: ArrayBuffer }
  | { id: string; op: 'reset' };

type Res =
  | { id: string; ok: true; result: ArrayBuffer | boolean | null }
  | { id: string; ok: false; error: string };

class MockSharedWorkerImpl {
  private secret: Uint8Array | null = null;
  private keyPromise: Promise<CryptoKey> | null = null;
  shouldStall = false;

  private async getKey(): Promise<CryptoKey> {
    if (this.keyPromise === null) {
      if (this.secret === null) {
        const buf = new Uint8Array(32);
        crypto.getRandomValues(buf);
        this.secret = buf;
      }
      this.keyPromise = crypto.subtle.importKey(
        'raw',
        this.secret as unknown as ArrayBuffer,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      );
    }
    return this.keyPromise;
  }

  reset(): void {
    this.secret = null;
    this.keyPromise = null;
  }

  async handle(req: Req, respond: (res: Res) => void): Promise<void> {
    if (this.shouldStall) return;
    try {
      if (req.op === 'sign') {
        const key = await this.getKey();
        const sig = await crypto.subtle.sign('HMAC', key, req.payload);
        respond({ id: req.id, ok: true, result: sig });
      } else if (req.op === 'verify') {
        const key = await this.getKey();
        const ok = await crypto.subtle.verify('HMAC', key, req.hmac, req.payload);
        respond({ id: req.id, ok: true, result: ok });
      } else if (req.op === 'reset') {
        this.reset();
        respond({ id: req.id, ok: true, result: null });
      }
    } catch (err) {
      respond({ id: req.id, ok: false, error: String(err) });
    }
  }
}

class MockMessagePort {
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  private impl: MockSharedWorkerImpl;

  constructor(impl: MockSharedWorkerImpl) {
    this.impl = impl;
  }

  postMessage(req: unknown): void {
    if (this.closed) return;
    queueMicrotask(() => {
      void this.impl.handle(req as Req, (res) => {
        if (this.closed) return;
        this.onmessage?.(new MessageEvent('message', { data: res }));
      });
    });
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }
}

class MockSharedWorker {
  static instances = new Map<string, MockSharedWorkerImpl>();
  static lastInstance: MockSharedWorkerImpl | null = null;
  port: MockMessagePort;

  constructor(url: string | URL, _options?: { name?: string }) {
    const key = typeof url === 'string' ? url : url.toString();
    let impl = MockSharedWorker.instances.get(key);
    if (!impl) {
      impl = new MockSharedWorkerImpl();
      MockSharedWorker.instances.set(key, impl);
    }
    MockSharedWorker.lastInstance = impl;
    this.port = new MockMessagePort(impl);
  }

  static reset(): void {
    this.instances.clear();
    this.lastInstance = null;
  }
}

// =============================================================================
// Helpers
// =============================================================================

const WORKER_URL = 'mock://cross-tab-hmac.worker';

async function flushAsync(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function bytes(len = 16, seed = 7): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (i * seed + 11) & 0xff;
  return out;
}

// =============================================================================
// Tests
// =============================================================================

describe('CrossTabHmacKeyManager (TASK-280)', () => {
  beforeEach(() => {
    MockSharedWorker.reset();
    __resetSessionHmacSecretForTests();
    (globalThis as unknown as { SharedWorker: typeof MockSharedWorker }).SharedWorker =
      MockSharedWorker;
  });

  afterEach(() => {
    delete (globalThis as { SharedWorker?: unknown }).SharedWorker;
  });

  describe('SharedWorker mode', () => {
    it('sign() returns a 32-byte HMAC over the input via the SharedWorker', async () => {
      const mgr = new CrossTabHmacKeyManager({ workerUrl: WORKER_URL });
      const sig = await mgr.sign(bytes(16));
      expect(sig).toBeInstanceOf(Uint8Array);
      // HMAC-SHA-256 → 32 bytes.
      expect(sig.byteLength).toBe(32);
      mgr.close();
    });

    it('verify() accepts a freshly-signed envelope from the same manager', async () => {
      const mgr = new CrossTabHmacKeyManager({ workerUrl: WORKER_URL });
      const payload = bytes(32);
      const sig = await mgr.sign(payload);
      const ok = await mgr.verify(payload, sig);
      expect(ok).toBe(true);
      mgr.close();
    });

    it('two managers sharing the worker URL agree on the secret (cross-tab)', async () => {
      // This is the CORE cross-tab guarantee of TASK-280. The prior
      // per-process singleton failed this scenario because each tab had
      // its own SESSION_HMAC_SECRET.
      const tabA = new CrossTabHmacKeyManager({ workerUrl: WORKER_URL });
      const tabB = new CrossTabHmacKeyManager({ workerUrl: WORKER_URL });

      const payload = bytes(48, 13);
      const sigFromA = await tabA.sign(payload);
      const okOnB = await tabB.verify(payload, sigFromA);
      expect(okOnB).toBe(true);

      const sigFromB = await tabB.sign(payload);
      const okOnA = await tabA.verify(payload, sigFromB);
      expect(okOnA).toBe(true);

      tabA.close();
      tabB.close();
    });

    it('isUsingSharedWorker() returns true when SharedWorker is available', () => {
      const mgr = new CrossTabHmacKeyManager({ workerUrl: WORKER_URL });
      expect(mgr.isUsingSharedWorker()).toBe(true);
      mgr.close();
    });

    it('__resetForTests() wipes the shared secret so old HMACs no longer verify', async () => {
      const mgr = new CrossTabHmacKeyManager({ workerUrl: WORKER_URL });
      const payload = bytes(24);
      const sig = await mgr.sign(payload);
      expect(await mgr.verify(payload, sig)).toBe(true);

      await mgr.__resetForTests();

      // After reset, the worker generates a new secret on the next sign/verify
      // — so the previously-issued signature must not verify any more.
      expect(await mgr.verify(payload, sig)).toBe(false);
      mgr.close();
    });
  });

  describe('Timeout / failure handling', () => {
    it('rejects sign() within the RPC timeout when the SharedWorker never replies', async () => {
      const mgr = new CrossTabHmacKeyManager({
        workerUrl: WORKER_URL,
        rpcTimeoutMs: 50,
      });
      // Force the just-created mock impl into a stalled state.
      const impl = MockSharedWorker.lastInstance;
      expect(impl).not.toBeNull();
      impl!.shouldStall = true;

      await expect(mgr.sign(bytes(8))).rejects.toThrow(/timeout|timed out/i);
      mgr.close();
    });

    it('closing the manager rejects pending requests', async () => {
      const mgr = new CrossTabHmacKeyManager({
        workerUrl: WORKER_URL,
        rpcTimeoutMs: 5000,
      });
      const impl = MockSharedWorker.lastInstance;
      impl!.shouldStall = true;

      const pending = mgr.sign(bytes(8));
      mgr.close();

      await expect(pending).rejects.toThrow(/closed|aborted|disposed/i);
    });
  });

  describe('Fallback mode (SharedWorker unavailable)', () => {
    beforeEach(() => {
      delete (globalThis as { SharedWorker?: unknown }).SharedWorker;
      __resetSessionHmacSecretForTests();
    });

    it('isUsingSharedWorker() returns false when SharedWorker is undefined', () => {
      const mgr = new CrossTabHmacKeyManager();
      expect(mgr.isUsingSharedWorker()).toBe(false);
      mgr.close();
    });

    it('sign() and verify() still work via the per-session fallback secret', async () => {
      const mgr = new CrossTabHmacKeyManager();
      const payload = bytes(40, 19);
      const sig = await mgr.sign(payload);
      expect(sig.byteLength).toBe(32);
      expect(await mgr.verify(payload, sig)).toBe(true);
      mgr.close();
    });

    it('two manager instances on the same page share the per-session fallback secret', async () => {
      const a = new CrossTabHmacKeyManager();
      const b = new CrossTabHmacKeyManager();
      const payload = bytes(20);
      const sig = await a.sign(payload);
      // Same-page singletons → b verifies a's signature.
      expect(await b.verify(payload, sig)).toBe(true);
      a.close();
      b.close();
    });

    it('still emits 32-byte HMACs (NIST guidance for HMAC-SHA-256)', async () => {
      const mgr = new CrossTabHmacKeyManager();
      const sig = await mgr.sign(bytes(4));
      expect(sig.byteLength).toBe(32);
      mgr.close();
    });
  });

  describe('Constructor robustness', () => {
    it('falls back when `new SharedWorker(...)` throws (CSP / cross-origin)', async () => {
      class ExplodingSharedWorker {
        constructor() {
          throw new Error('CSP: shared worker blocked');
        }
      }
      (globalThis as unknown as { SharedWorker: unknown }).SharedWorker = ExplodingSharedWorker;

      const warn = [] as Array<{ msg: string; meta?: Record<string, unknown> }>;
      const mgr = new CrossTabHmacKeyManager({
        workerUrl: WORKER_URL,
        logger: { warn: (msg, meta) => warn.push({ msg, meta }) },
      });

      expect(mgr.isUsingSharedWorker()).toBe(false);
      // Fallback must still work after the failed worker construction.
      const sig = await mgr.sign(bytes(8));
      expect(sig.byteLength).toBe(32);
      expect(warn.length).toBeGreaterThan(0);
      mgr.close();
    });
  });
});
