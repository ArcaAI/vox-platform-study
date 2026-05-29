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
import { deriveTenantHmacKey } from '../CrossTabHmacSharedWorker';

// =============================================================================
// MockSharedWorker — a minimal SharedWorker stand-in. All instances sharing
// the same URL talk to the SAME `MockSharedWorkerImpl`, just like the real
// SharedWorker semantics (one worker process per origin+url+name).
// =============================================================================

type Req =
  | { id: string; op: 'sign'; payload: ArrayBuffer; tenantId?: string }
  | { id: string; op: 'verify'; payload: ArrayBuffer; hmac: ArrayBuffer; tenantId?: string }
  | { id: string; op: 'reset' };

type Res =
  | { id: string; ok: true; result: ArrayBuffer | boolean | null }
  | { id: string; ok: false; error: string };

class MockSharedWorkerImpl {
  private secret: Uint8Array | null = null;
  private keyPromise: Promise<CryptoKey> | null = null;
  // Mirrors the real worker's per-tenant subkey cache (TASK-317 AC-11).
  private tenantKeys = new Map<string, Promise<CryptoKey>>();
  shouldStall = false;

  private ensureSecret(): Uint8Array {
    if (this.secret === null) {
      const buf = new Uint8Array(32);
      crypto.getRandomValues(buf);
      this.secret = buf;
    }
    return this.secret;
  }

  private async getKey(): Promise<CryptoKey> {
    if (this.keyPromise === null) {
      this.keyPromise = crypto.subtle.importKey(
        'raw',
        this.ensureSecret() as unknown as ArrayBuffer,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      );
    }
    return this.keyPromise;
  }

  private keyFor(tenantId: string | undefined): Promise<CryptoKey> {
    if (!tenantId) return this.getKey();
    let cached = this.tenantKeys.get(tenantId);
    if (cached === undefined) {
      cached = deriveTenantHmacKey(this.ensureSecret(), tenantId);
      this.tenantKeys.set(tenantId, cached);
    }
    return cached;
  }

  reset(): void {
    this.secret = null;
    this.keyPromise = null;
    this.tenantKeys.clear();
  }

  async handle(req: Req, respond: (res: Res) => void): Promise<void> {
    if (this.shouldStall) return;
    try {
      if (req.op === 'sign') {
        const key = await this.keyFor(req.tenantId);
        const sig = await crypto.subtle.sign('HMAC', key, req.payload);
        respond({ id: req.id, ok: true, result: sig });
      } else if (req.op === 'verify') {
        const key = await this.keyFor(req.tenantId);
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

    // =========================================================================
    // TASK-317 W3.4 — AC-11: per-tenant HMAC subkey (SharedWorker path).
    //
    // TASK-280 made the secret per-Worker (shared across tabs). AC-11 layers a
    // per-tenant HKDF subkey on top so two tenants sharing the SAME worker (and
    // thus the same master secret) cannot forge each other's envelopes. The
    // worker derives HKDF(masterSecret, tenantId); the master secret never
    // leaves the worker.
    // =========================================================================
    it('TASK-317 W3.4 — AC-11 cross-tenant verify FAILS over the SharedWorker (forged message rejected)', async () => {
      const tabA = new CrossTabHmacKeyManager({ workerUrl: WORKER_URL });
      const tabB = new CrossTabHmacKeyManager({ workerUrl: WORKER_URL });
      tabA.setTenantId('tenant-A');
      tabB.setTenantId('tenant-B');

      const payload = bytes(32, 9);
      const sigFromA = await tabA.sign(payload);

      // tenant-B subkey must reject a signature minted under tenant-A.
      expect(await tabB.verify(payload, sigFromA)).toBe(false);
      // Same-tenant verify still passes.
      expect(await tabA.verify(payload, sigFromA)).toBe(true);

      tabA.close();
      tabB.close();
    });

    it('TASK-317 W3.4 — AC-11 two tabs on the SAME tenant still agree (SharedWorker cross-tab)', async () => {
      const tabA = new CrossTabHmacKeyManager({ workerUrl: WORKER_URL });
      const tabB = new CrossTabHmacKeyManager({ workerUrl: WORKER_URL });
      tabA.setTenantId('tenant-A');
      tabB.setTenantId('tenant-A');

      const payload = bytes(24, 3);
      const sigFromA = await tabA.sign(payload);
      expect(await tabB.verify(payload, sigFromA)).toBe(true);

      tabA.close();
      tabB.close();
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

    // =========================================================================
    // TASK-317 W3.4 — AC-11: per-tenant HMAC subkey (fallback path).
    //
    // In fallback mode two managers on the same page share FALLBACK_SECRET, but
    // each derives a DISTINCT HKDF subkey from its tenantId. A message signed
    // under tenant-A's subkey must therefore FAIL verification under tenant-B's
    // subkey (fail-closed cross-tenant rejection), while same-tenant verify
    // still succeeds. The subkey rotates whenever setTenantId changes.
    // =========================================================================
    it('TASK-317 W3.4 — AC-11 cross-tenant subkey: A-signed message is REJECTED under tenant-B', async () => {
      const a = new CrossTabHmacKeyManager();
      const b = new CrossTabHmacKeyManager();
      a.setTenantId('tenant-A');
      b.setTenantId('tenant-B');

      const payload = bytes(32, 5);
      const sigFromA = await a.sign(payload);

      // Forged cross-tenant envelope: tenant-B subkey must reject it.
      expect(await b.verify(payload, sigFromA)).toBe(false);
      // Same-tenant verify still passes.
      expect(await a.verify(payload, sigFromA)).toBe(true);

      a.close();
      b.close();
    });

    it('TASK-317 W3.4 — AC-11 setTenantId rotates the subkey (old-tenant signature stops verifying)', async () => {
      const mgr = new CrossTabHmacKeyManager();
      mgr.setTenantId('tenant-A');
      const payload = bytes(28, 6);
      const sigUnderA = await mgr.sign(payload);
      expect(await mgr.verify(payload, sigUnderA)).toBe(true);

      // Rotate the active tenant — the previous tenant's signature must no
      // longer verify under the new subkey.
      mgr.setTenantId('tenant-B');
      expect(await mgr.verify(payload, sigUnderA)).toBe(false);

      mgr.close();
    });

    // =========================================================================
    // TASK-317 W3.1 (M-1) — empty/whitespace tenantId behaves like no tenant.
    //
    // The SharedWorker `keyFor('')` is falsy → master key, but the fallback
    // derived HKDF(secret, '') for ANY non-undefined tenantId. So a blank /
    // whitespace tenant signed under a derived subkey in fallback mode but the
    // master secret in worker mode — an asymmetry. setTenantId now normalises
    // empty/whitespace → undefined so BOTH modes fall back to the master/global
    // secret identically (cosmetic fail-closed symmetry).
    // =========================================================================
    it('TASK-317 W3.1 (M-1) — whitespace/empty tenantId behaves like no tenant (master-secret parity with worker keyFor)', async () => {
      const noTenant = new CrossTabHmacKeyManager();
      const blankTenant = new CrossTabHmacKeyManager();
      // Whitespace-only must normalise to undefined → master/global key,
      // NOT a derived HKDF(secret, '   ') subkey.
      blankTenant.setTenantId('   ');

      const payload = bytes(32, 8);
      const sig = await blankTenant.sign(payload);

      // Same-page managers share FALLBACK_SECRET; with the blank tenant
      // normalised away both use the global key, so the no-tenant manager
      // verifies the blank-tenant manager's signature.
      expect(await noTenant.verify(payload, sig)).toBe(true);

      noTenant.close();
      blankTenant.close();
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
