/**
 * @arcaai/vox — Cross-Tab HMAC Key Manager
 *
 * Client-side manager that wraps the `CrossTabHmacSharedWorker` so every
 * tab of the same origin signs and verifies BroadcastChannel envelopes
 * against a single shared 32-byte HMAC secret. When SharedWorker is not
 * available (older Safari, non-secure contexts, vitest/jsdom without a
 * mock), the manager falls back to a per-session module singleton — same
 * behaviour as the pre-280 `SimpleCrossTabSync` implementation, only now
 * routed through this single owner.
 *
 * Public surface:
 *
 *   const mgr = new CrossTabHmacKeyManager({ logger, workerUrl? });
 *   const sig = await mgr.sign(payloadBytes);            // Uint8Array(32)
 *   const ok  = await mgr.verify(payloadBytes, sigBytes); // boolean
 *   mgr.isUsingSharedWorker();                            // boolean
 *   mgr.close();                                          // releases port
 *
 *   __resetSessionHmacSecretForTests() — wipes the fallback secret.
 *   __getSessionHmacSecretForTests()   — read for assertions.
 *   mgr.__resetForTests()              — also resets the SharedWorker secret.
 *
 * `SimpleCrossTabSync` re-exports the underscore-prefixed helpers for
 * backward compatibility with existing tests; they are NOT part of the
 * public SDK barrel.
 */

import { deriveTenantHmacKey } from './CrossTabHmacSharedWorker';
import type { CrossTabHmacReq, CrossTabHmacRes } from './CrossTabHmacSharedWorker';

// =============================================================================
// Public types
// =============================================================================

export interface CrossTabHmacKeyManagerOptions {
  /**
   * Optional logger. Used only for warn-level diagnostics when the
   * SharedWorker construction fails or an RPC call times out. No PHI
   * is ever passed through.
   */
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };

  /**
   * URL of the SharedWorker entry script. When omitted, the manager
   * tries `new URL('./CrossTabHmacSharedWorker.ts', import.meta.url)`
   * and silently falls back to the per-session secret if that fails
   * (e.g. CJS builds without `import.meta`).
   */
  workerUrl?: string | URL;

  /**
   * RPC timeout in milliseconds. Defaults to 500ms — generous enough
   * for `crypto.subtle.sign('HMAC', ...)` on slow devices, short
   * enough that a stalled SharedWorker can't pin the BroadcastChannel
   * handler indefinitely.
   */
  rpcTimeoutMs?: number;
}

// =============================================================================
// Fallback secret — module-level singleton, scoped per JS context (one page).
// Used only when SharedWorker is unavailable / failed. This is where the
// shared HMAC secret lives now; `SimpleCrossTabSync` no longer owns it.
// =============================================================================

let FALLBACK_SECRET: Uint8Array | null = null;
let FALLBACK_KEY_PROMISE: Promise<CryptoKey> | null = null;

function ensureFallbackSecret(): Uint8Array {
  if (FALLBACK_SECRET === null) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    FALLBACK_SECRET = buf;
  }
  return FALLBACK_SECRET;
}

function getFallbackKey(): Promise<CryptoKey> {
  if (FALLBACK_KEY_PROMISE === null) {
    const secret = ensureFallbackSecret();
    FALLBACK_KEY_PROMISE = crypto.subtle.importKey('raw', secret as unknown as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
  }
  return FALLBACK_KEY_PROMISE;
}

/**
 * Test-only: wipe the per-session fallback secret so tests can simulate
 * an "app reload". Has no effect on a SharedWorker-resident secret —
 * call `manager.__resetForTests()` for that.
 */
export function __resetSessionHmacSecretForTests(): void {
  FALLBACK_SECRET = null;
  FALLBACK_KEY_PROMISE = null;
}

/**
 * Test-only: read the raw fallback secret to assert its 32-byte length
 * or detect regeneration after a reset.
 */
export function __getSessionHmacSecretForTests(): Uint8Array | null {
  return FALLBACK_SECRET;
}

/**
 * Materialise the fallback secret eagerly. `SimpleCrossTabSync.openChannel()`
 * calls this so the legacy invariant — "the 32-byte secret exists immediately
 * after constructing a SimpleCrossTabSync" — survives the refactor.
 */
export function __ensureFallbackSecretForTests(): Uint8Array {
  return ensureFallbackSecret();
}

// =============================================================================
// CrossTabHmacKeyManager
// =============================================================================

interface PendingRpc {
  resolve: (value: ArrayBuffer | boolean | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Distributive Omit — `Omit<A | B, K>` collapses to common keys only.
 * We need to strip `id` from each variant of `CrossTabHmacReq` while
 * preserving discriminated-union narrowing in `rpc()` callers.
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type CrossTabHmacReqBody = DistributiveOmit<CrossTabHmacReq, 'id'>;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Always copy into a fresh buffer so we never accidentally transfer or
  // share the caller's underlying buffer with the SharedWorker port.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function defaultWorkerUrl(): URL | null {
  // `import.meta.url` is shimmed at build time by tsup/esbuild for both
  // CJS and ESM emits — but TypeScript's NodeNext module mode rejects
  // direct `import.meta` access for a package without `"type": "module"`.
  // We isolate the escape hatch here so the rest of the file stays clean.
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-expect-error would fail the build under module modes where import.meta IS valid; @ts-ignore is required to cover both cases
    // @ts-ignore -- import.meta is provided at runtime by the bundler; see comment above.
    const metaUrl: unknown = typeof import.meta !== 'undefined' ? import.meta.url : undefined;
    if (typeof metaUrl === 'string') {
      return new URL('./CrossTabHmacSharedWorker.ts', metaUrl);
    }
  } catch {
    // import.meta may throw under some hosts (e.g. raw CJS) — fallback only.
  }
  return null;
}

const DEFAULT_RPC_TIMEOUT_MS = 500;

export class CrossTabHmacKeyManager {
  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  private readonly logger?: CrossTabHmacKeyManagerOptions['logger'];
  private readonly pending = new Map<string, PendingRpc>();
  private readonly rpcTimeoutMs: number;
  private closed = false;
  // Active tenant. When set, sign/verify use the
  // per-tenant HKDF subkey instead of the bare master/fallback secret.
  private tenantId?: string;
  // Cached per-tenant fallback subkey; invalidated on setTenantId (rotation).
  private fallbackTenantKeyPromise: Promise<CryptoKey> | null = null;

  constructor(options: CrossTabHmacKeyManagerOptions = {}) {
    this.logger = options.logger;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

    if (typeof SharedWorker === 'undefined') {
      // Fallback only — leave port/worker null. sign()/verify() will use
      // the per-session secret below.
      return;
    }

    const url = options.workerUrl ?? defaultWorkerUrl();
    if (url === null) {
      // No URL resolvable (CJS without import.meta and no override) —
      // fallback only.
      return;
    }

    try {
      const w = new SharedWorker(url as string, { name: 'arcaai-cross-tab-hmac' });
      const p = w.port;
      p.onmessage = (e: MessageEvent) => this.handleResponse(e.data);
      p.start();
      this.worker = w;
      this.port = p;
    } catch (err) {
      this.logger?.warn('[CrossTabHmacKeyManager] SharedWorker construction failed; falling back to per-session secret', {
        component: 'CrossTabHmacKeyManager',
        error: err as Error,
      });
      this.worker = null;
      this.port = null;
    }
  }

  /** True iff the SharedWorker port is connected (shared-secret mode). */
  isUsingSharedWorker(): boolean {
    return this.port !== null;
  }

  /**
   * Set the active tenant. Subsequent sign/verify use
   * the per-tenant HKDF subkey so a signature minted for one tenant cannot be
   * forged onto another tenant's channel. Changing the tenant rotates the
   * cached fallback subkey (fail-closed: old-tenant signatures stop verifying).
   * In SharedWorker mode the tenant is threaded per-RPC and the worker derives
   * the subkey, so the master secret never leaves the worker.
   */
  setTenantId(tenantId: string): void {
    // Normalize empty/whitespace tenantId to undefined so
    // the fallback and SharedWorker paths behave identically. The worker's
    // `keyFor('')` is falsy and uses the master key, whereas the fallback would
    // otherwise derive HKDF(secret, '') for a blank string; collapsing blanks to
    // undefined makes both modes fall back to the master/global secret.
    const normalized = tenantId.trim() === '' ? undefined : tenantId;
    if (this.tenantId === normalized) return;
    this.tenantId = normalized;
    this.fallbackTenantKeyPromise = null;
  }

  /**
   * Resolve the fallback (non-SharedWorker) signing key: the per-tenant HKDF
   * subkey when a tenant is set, otherwise the legacy global per-session key.
   */
  private getFallbackSigningKey(): Promise<CryptoKey> {
    if (this.tenantId === undefined) {
      return getFallbackKey();
    }
    if (this.fallbackTenantKeyPromise === null) {
      this.fallbackTenantKeyPromise = deriveTenantHmacKey(ensureFallbackSecret(), this.tenantId);
    }
    return this.fallbackTenantKeyPromise;
  }

  /**
   * Sign `payload` with HMAC-SHA-256. Routes via the SharedWorker when
   * available, otherwise uses the per-session fallback secret.
   */
  async sign(payload: Uint8Array): Promise<Uint8Array> {
    if (this.closed) throw new Error('CrossTabHmacKeyManager: instance is closed');

    if (this.port !== null) {
      const result = await this.rpc({ op: 'sign', payload: toArrayBuffer(payload), tenantId: this.tenantId });
      return new Uint8Array(result as ArrayBuffer);
    }

    const key = await this.getFallbackSigningKey();
    const sig = await crypto.subtle.sign('HMAC', key, payload as unknown as ArrayBuffer);
    return new Uint8Array(sig);
  }

  /** Verify `hmac` against `payload`. Returns true iff the signature matches. */
  async verify(payload: Uint8Array, hmac: Uint8Array): Promise<boolean> {
    if (this.closed) throw new Error('CrossTabHmacKeyManager: instance is closed');

    if (this.port !== null) {
      const result = await this.rpc({
        op: 'verify',
        payload: toArrayBuffer(payload),
        hmac: toArrayBuffer(hmac),
        tenantId: this.tenantId,
      });
      return result === true;
    }

    const key = await this.getFallbackSigningKey();
    return crypto.subtle.verify('HMAC', key, hmac as unknown as ArrayBuffer, payload as unknown as ArrayBuffer);
  }

  /**
   * Test-only: wipe the secret. Sends `op: 'reset'` to the SharedWorker
   * AND wipes the fallback singleton on this page. Underscore-prefixed —
   * NOT exported on the SDK barrel.
   */
  async __resetForTests(): Promise<void> {
    if (this.port !== null && !this.closed) {
      try {
        await this.rpc({ op: 'reset' });
      } catch {
        // Best-effort — a failure here doesn't affect correctness.
      }
    }
    __resetSessionHmacSecretForTests();
  }

  /** Close the SharedWorker port and reject any pending RPCs. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CrossTabHmacKeyManager: closed before RPC resolved'));
    }
    this.pending.clear();

    if (this.port !== null) {
      try {
        this.port.close();
      } catch {
        // Already closed — ignore.
      }
      this.port = null;
    }
    this.worker = null;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private rpc(body: CrossTabHmacReqBody): Promise<ArrayBuffer | boolean | null> {
    if (this.port === null) {
      return Promise.reject(new Error('CrossTabHmacKeyManager: no SharedWorker port available'));
    }
    const port = this.port;
    return new Promise<ArrayBuffer | boolean | null>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          const msg = `CrossTabHmacKeyManager: RPC timed out after ${this.rpcTimeoutMs}ms (op=${body.op})`;
          this.logger?.warn(msg, {
            component: 'CrossTabHmacKeyManager',
            op: body.op,
            timeoutMs: this.rpcTimeoutMs,
          });
          reject(new Error(msg));
        }
      }, this.rpcTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        const req = { id, ...body } as CrossTabHmacReq;
        port.postMessage(req);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  private handleResponse(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const res = data as CrossTabHmacRes;
    if (typeof res.id !== 'string') return;
    const pending = this.pending.get(res.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(res.id);

    if (res.ok) {
      pending.resolve(res.result);
    } else {
      pending.reject(new Error(res.error));
    }
  }
}
