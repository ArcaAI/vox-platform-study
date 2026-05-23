/**
 * @arcaai/vox — Cross-Tab HMAC SharedWorker (TASK-280)
 *
 * Owns the 32-byte HMAC secret in SharedWorker-process memory so every tab
 * of the same origin verifies BroadcastChannel envelopes against the same
 * key. This replaces the per-page module singleton that previously lived
 * in `SimpleCrossTabSync.ts`, which signed every tab with a different
 * secret and therefore could not actually authenticate cross-tab traffic.
 *
 * RPC protocol (sent from `CrossTabHmacKeyManager` via the port):
 *
 *   Request:
 *     { id: string; op: 'sign';   payload: ArrayBuffer }
 *     { id: string; op: 'verify'; payload: ArrayBuffer; hmac: ArrayBuffer }
 *     { id: string; op: 'reset' }                                       // test-only
 *
 *   Response:
 *     { id: string; ok: true;  result: ArrayBuffer | boolean | null }
 *     { id: string; ok: false; error: string }
 *
 * Binary payloads use `Transferable`-friendly `ArrayBuffer` (NOT JSON) so
 * the structured-clone cost stays minimal.
 *
 * The `reset` op is intended for tests only — it lets a test simulate an
 * "app reload" by regenerating the shared secret. It is not exposed on
 * the public SDK barrel.
 */

export interface CrossTabHmacSignReq {
  id: string;
  op: 'sign';
  payload: ArrayBuffer;
}

export interface CrossTabHmacVerifyReq {
  id: string;
  op: 'verify';
  payload: ArrayBuffer;
  hmac: ArrayBuffer;
}

export interface CrossTabHmacResetReq {
  id: string;
  op: 'reset';
}

export type CrossTabHmacReq = CrossTabHmacSignReq | CrossTabHmacVerifyReq | CrossTabHmacResetReq;

export interface CrossTabHmacResOk {
  id: string;
  ok: true;
  result: ArrayBuffer | boolean | null;
}

export interface CrossTabHmacResErr {
  id: string;
  ok: false;
  error: string;
}

export type CrossTabHmacRes = CrossTabHmacResOk | CrossTabHmacResErr;

// =============================================================================
// Worker-scoped HMAC secret. Shared across all ports (== all tabs).
// =============================================================================

let SECRET: Uint8Array | null = null;
let KEY_PROMISE: Promise<CryptoKey> | null = null;

function ensureSecret(): Uint8Array {
  if (SECRET === null) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    SECRET = buf;
  }
  return SECRET;
}

function getKey(): Promise<CryptoKey> {
  if (KEY_PROMISE === null) {
    const secret = ensureSecret();
    KEY_PROMISE = crypto.subtle.importKey('raw', secret as unknown as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }
  return KEY_PROMISE;
}

function resetSecret(): void {
  SECRET = null;
  KEY_PROMISE = null;
}

// =============================================================================
// SharedWorker entry point
// =============================================================================

interface SharedWorkerGlobalScopeCompat {
  onconnect: ((event: MessageEvent) => void) | null;
}
declare const self: SharedWorkerGlobalScopeCompat;

// Only wire `self.onconnect` when we're actually running inside a
// SharedWorker context. On a normal page (or vitest jsdom) `self === window`
// and we must NOT clobber the host's connection handling when the file is
// imported merely for its type re-exports.
if (typeof self !== 'undefined' && typeof (globalThis as { window?: unknown }).window === 'undefined') {
  self.onconnect = (event: MessageEvent) => {
    const port = (event as unknown as { ports: MessagePort[] }).ports[0];
    port.onmessage = async (msg: MessageEvent) => {
      const req = msg.data as CrossTabHmacReq;
      try {
        if (req.op === 'sign') {
          const key = await getKey();
          const sig = await crypto.subtle.sign('HMAC', key, req.payload);
          const res: CrossTabHmacResOk = { id: req.id, ok: true, result: sig };
          port.postMessage(res);
        } else if (req.op === 'verify') {
          const key = await getKey();
          const ok = await crypto.subtle.verify('HMAC', key, req.hmac, req.payload);
          const res: CrossTabHmacResOk = { id: req.id, ok: true, result: ok };
          port.postMessage(res);
        } else if (req.op === 'reset') {
          resetSecret();
          const res: CrossTabHmacResOk = { id: req.id, ok: true, result: null };
          port.postMessage(res);
        }
      } catch (err) {
        const res: CrossTabHmacResErr = { id: req.id, ok: false, error: String(err) };
        port.postMessage(res);
      }
    };
    port.start();
  };
}
