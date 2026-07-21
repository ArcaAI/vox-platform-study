/**
 * @arcaai/vox - Simple Cross-Tab Sync
 *
 * Lightweight cross-tab synchronisation using `BroadcastChannel`.
 *
 * Security hardening:
 *
 *   - **W0-4 — HMAC-signed messages.** Every outgoing message is wrapped in
 *     a `{ payload, hmac }` envelope. The HMAC is `HMAC-SHA-256` using a
 *     per-session 32-byte secret. Receivers verify HMAC and drop any
 *     unsigned / mismatched message, logging a warning via the optional
 *     `SDKLogger` injected at construction.
 *
 *   - **W0-5 — Per-tenant channel naming.** The `BroadcastChannel` name is
 *     always namespaced: `agentic.<tenantId>` when a tenant id is reachable,
 *     otherwise `agentic.<consultationKey>`. Never the bare `'agentic'`
 *     string — that would let two tenants in different browser tabs read
 *     each other's PHI broadcasts.
 *
 *   - `setTenantId(id)` closes the existing channel and reopens a new one
 *     with the updated namespace so a runtime tenant switch is honoured.
 *
 * Multi-tab HMAC key sharing:
 *
 *   - HMAC sign / verify is now delegated to `CrossTabHmacKeyManager`,
 *     which routes through a SharedWorker so that ALL tabs of the same
 *     origin sign and verify against the same 32-byte secret. The prior
 *     per-page module singleton survives as the manager's fallback path
 *     for environments without SharedWorker (older Safari, non-secure
 *     contexts, vitest/jsdom without a mock).
 *
 *   - `isUsingSharedWorkerHmac()` exposes the active mode for diagnostics
 *     and for tests.
 *
 * The `broadcastContext*` methods are `async` because Web Crypto's
 * `sign('HMAC')` is async — callers may `await` them in tests but the
 * existing fire-and-forget callsite in `useArcaSession` works fine because
 * any signing error is caught and logged internally.
 */

import type { ContextItem } from '../types';
import {
  CrossTabHmacKeyManager,
  __ensureFallbackSecretForTests,
  __resetSessionHmacSecretForTests as __resetFallbackForTests,
  __getSessionHmacSecretForTests as __getFallbackForTests,
} from './CrossTabHmacKeyManager';

// =============================================================================
// Public types
// =============================================================================

export type CrossTabEventType = 'context_added' | 'context_updated' | 'consultation_loaded';

/** Inner payload signed by HMAC. Shape matches the legacy SimpleCrossTabSync. */
export interface CrossTabPayload {
  type: CrossTabEventType;
  data: unknown;
  timestamp: number;
  tabId: string;
}

/** On-the-wire envelope. `hmac` is base64-encoded HMAC-SHA-256 over JSON(payload). */
export interface CrossTabEnvelope {
  payload: CrossTabPayload;
  hmac: string;
}

/**
 * Minimal logger surface (subset of `ISDKLogger`). Kept local so this module
 * does not import the SDKLogger type and create a layering cycle with
 * `core/logger`.
 */
interface MinimalLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface SimpleCrossTabSyncOptions {
  /** Active tenant id. When set, channel name becomes `agentic.<tenantId>`. */
  tenantId?: string;
  /** Logger used for warnings on dropped / unverified messages. */
  logger?: MinimalLogger;
}

// =============================================================================
// Test-only re-exports — preserve the legacy surface for existing tests.
// Underscore-prefixed; NOT exported from the public SDK barrel.
// =============================================================================

export function __resetSessionHmacSecretForTests(): void {
  __resetFallbackForTests();
}

export function __getSessionHmacSecretForTests(): Uint8Array | null {
  return __getFallbackForTests();
}

// =============================================================================
// Base64 helpers — browsers do not have a built-in for Uint8Array<->base64 yet.
// =============================================================================

function uint8ToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// =============================================================================
// SimpleCrossTabSync
// =============================================================================

export class SimpleCrossTabSync {
  private channel: BroadcastChannel | null = null;
  private readonly tabId: string;
  private readonly consultationKey: string;
  private tenantId?: string;
  private readonly logger?: MinimalLogger;
  private listeners: Map<CrossTabEventType, Set<(data: unknown) => void>> = new Map();
  private isSupported: boolean;
  // SharedWorker-backed HMAC key. Constructed lazily on the first
  // broadcast / handleIncoming / isUsingSharedWorkerHmac call so the
  // constructor stays side-effect-free beyond opening the BroadcastChannel.
  private hmacKey: CrossTabHmacKeyManager | null = null;
  /**
   * Channel creation may need to compute a SHA-256 hash
   * of the consultation key when no tenantId is set. The hash work is async,
   * so we expose a promise so callers (tests, broadcast) can await it.
   */
  private channelReady: Promise<void> = Promise.resolve();

  constructor(config: { patientId: string; doctorId: string; appointmentDate: string }, options: SimpleCrossTabSyncOptions = {}) {
    this.tabId = `tab_${crypto.randomUUID()}`;
    this.consultationKey = `${config.patientId}_${config.doctorId}_${config.appointmentDate}`;
    this.tenantId = options.tenantId;
    this.logger = options.logger;

    this.isSupported = typeof BroadcastChannel !== 'undefined';
    if (this.isSupported) {
      this.channelReady = this.openChannel();
    }
  }

  /**
   * Await the asynchronous channel creation (needed when
   * the fallback name requires SHA-256 hashing of the consultation key).
   * Returns immediately once the channel is open. Tests call this before
   * spying on `(sync as any).channel.postMessage`.
   */
  whenReady(): Promise<void> {
    return this.channelReady;
  }

  // ---------------------------------------------------------------------------
  // Public lifecycle / inspection
  // ---------------------------------------------------------------------------

  getTabId(): string {
    return this.tabId;
  }

  getConsultationKey(): string {
    return this.consultationKey;
  }

  isAvailable(): boolean {
    // `channel` may still be null between construction and
    // the async channelName resolution. Treat capability (isSupported) as
    // the truthful answer; consumers awaiting full readiness should call
    // `whenReady()`.
    return this.isSupported;
  }

  /**
   * Report whether HMAC sign/verify is currently routed through
   * the SharedWorker (true) or the per-session fallback secret (false).
   * Materialises the manager lazily so the answer is available even before
   * any broadcast.
   */
  isUsingSharedWorkerHmac(): boolean {
    return this.ensureHmacKey().isUsingSharedWorker();
  }

  /**
   * Update the active tenant id at runtime.
   *
   * Closes the old channel and reopens a new one with the
   * tenant-namespaced name so cross-tenant messages cannot leak after a
   * tenant switch (e.g. user impersonation flow).
   */
  setTenantId(tenantId: string): void {
    if (this.tenantId === tenantId) return;
    this.tenantId = tenantId;
    // Rotate the HMAC subkey alongside the channel so
    // post-switch envelopes can't be forged with the prior tenant's subkey.
    if (this.hmacKey) {
      this.hmacKey.setTenantId(tenantId);
    }
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // Ignore — already closed.
      }
      this.channel = null;
    }
    if (this.isSupported) {
      this.channelReady = this.openChannel();
    }
  }

  close(): void {
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // Ignore — already closed.
      }
      this.channel = null;
    }
    if (this.hmacKey) {
      this.hmacKey.close();
      this.hmacKey = null;
    }
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Public broadcast / subscription API
  // ---------------------------------------------------------------------------

  broadcastContext(context: ContextItem): Promise<void> {
    return this.broadcast('context_added', context);
  }

  broadcastContextUpdate(context: ContextItem): Promise<void> {
    return this.broadcast('context_updated', context);
  }

  onContextAdded(cb: (context: ContextItem) => void): () => void {
    return this.on('context_added', cb as (data: unknown) => void);
  }

  onContextUpdated(cb: (context: ContextItem) => void): () => void {
    return this.on('context_updated', cb as (data: unknown) => void);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Build the channel name.
   *
   * - With `tenantId` → synchronous `agentic.<tenantId>`.
   * - Without `tenantId` → `agentic.<sha256-first8-hex>` of the consultation
   *   key. The hash is async; openChannel awaits it. This
   *   prevents the raw `patientId_doctorId_appointmentDate` triple — which
   *   is PHI — from appearing in DevTools / BroadcastChannel inspectors.
   */
  private async channelName(): Promise<string> {
    if (this.tenantId && this.tenantId.length > 0) {
      return `agentic.${this.tenantId}`;
    }
    const hash = await sha256First8Hex(this.consultationKey);
    return `agentic.${hash}`;
  }

  private ensureHmacKey(): CrossTabHmacKeyManager {
    if (this.hmacKey === null) {
      this.hmacKey = new CrossTabHmacKeyManager({ logger: this.logger });
      // Bind the HMAC subkey to the active tenant so
      // envelopes are signed/verified with HKDF(secret, tenantId).
      if (this.tenantId !== undefined) {
        this.hmacKey.setTenantId(this.tenantId);
      }
    }
    return this.hmacKey;
  }

  private async openChannel(): Promise<void> {
    try {
      // When SharedWorker is unavailable the manager falls back
      // to the per-session module singleton owned by CrossTabHmacKeyManager.
      // Materialise that secret eagerly so the legacy invariant — the
      // 32-byte secret exists immediately after `new SimpleCrossTabSync()` —
      // survives the refactor. When SharedWorker IS available the secret
      // lives in worker memory and there is nothing to eager-init here.
      if (typeof SharedWorker === 'undefined') {
        __ensureFallbackSecretForTests();
      }

      const name = await this.channelName();
      const ch = new BroadcastChannel(name);
      ch.onmessage = (event: MessageEvent) => {
        void this.handleIncoming(event.data);
      };
      this.channel = ch;
    } catch {
      this.isSupported = false;
    }
  }

  private async handleIncoming(raw: unknown): Promise<void> {
    if (!isEnvelope(raw)) {
      this.logger?.warn('[SimpleCrossTabSync] dropped non-envelope cross-tab message', {
        component: 'SimpleCrossTabSync',
        reason: 'no-envelope',
      });
      return;
    }

    const { payload, hmac } = raw;
    if (!isCrossTabPayload(payload)) {
      this.logger?.warn('[SimpleCrossTabSync] dropped malformed payload', {
        component: 'SimpleCrossTabSync',
        reason: 'bad-payload',
      });
      return;
    }

    // Ignore our own outgoing broadcasts.
    if (payload.tabId === this.tabId) return;

    let verified = false;
    try {
      const sigBytes = base64ToUint8(hmac);
      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
      verified = await this.ensureHmacKey().verify(payloadBytes, sigBytes);
    } catch {
      verified = false;
    }

    if (!verified) {
      this.logger?.warn('[SimpleCrossTabSync] dropped message — HMAC verification failed', {
        component: 'SimpleCrossTabSync',
        reason: 'hmac-mismatch',
        type: payload.type,
        tabId: payload.tabId,
      });
      return;
    }

    const listeners = this.listeners.get(payload.type);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(payload.data);
      } catch {
        // Listener errors must not break sibling listeners.
      }
    }
  }

  private async broadcast(type: CrossTabEventType, data: unknown): Promise<void> {
    // Wait for the (potentially async) channel name hash.
    await this.channelReady;
    if (!this.channel) return;

    const payload: CrossTabPayload = {
      type,
      data,
      timestamp: Date.now(),
      tabId: this.tabId,
    };

    let envelope: CrossTabEnvelope;
    try {
      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
      const sig = await this.ensureHmacKey().sign(payloadBytes);
      envelope = { payload, hmac: uint8ToBase64(sig) };
    } catch (err) {
      this.logger?.warn('[SimpleCrossTabSync] HMAC sign failed — dropping outgoing broadcast', {
        component: 'SimpleCrossTabSync',
        error: err,
      });
      return;
    }

    try {
      this.channel.postMessage(envelope);
    } catch {
      // Channel may have been closed between the check and postMessage.
    }
  }

  private on(type: CrossTabEventType, callback: (data: unknown) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(callback);
    return () => {
      this.listeners.get(type)?.delete(callback);
    };
  }
}

// =============================================================================
// Hash helper
// =============================================================================

/**
 * SHA-256 of `input` (UTF-8) → hex of the first 8 bytes (16 hex chars).
 * Used as the BroadcastChannel name suffix when no `tenantId` is present.
 * Returns `'fallback'` if Web Crypto is unavailable (degraded test envs).
 */
async function sha256First8Hex(input: string): Promise<string> {
  try {
    const data = new TextEncoder().encode(input);
    const buf = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(buf, 0, 8);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  } catch {
    return 'fallback';
  }
}

// =============================================================================
// Wire-format guards
// =============================================================================

function isEnvelope(value: unknown): value is CrossTabEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as { payload?: unknown; hmac?: unknown };
  return typeof v.hmac === 'string' && typeof v.payload === 'object' && v.payload !== null;
}

function isCrossTabPayload(value: unknown): value is CrossTabPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown; tabId?: unknown; timestamp?: unknown };
  return (
    typeof v.type === 'string' &&
    typeof v.tabId === 'string' &&
    typeof v.timestamp === 'number' &&
    (v.type === 'context_added' || v.type === 'context_updated' || v.type === 'consultation_loaded')
  );
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a `SimpleCrossTabSync` instance.
 *
 * @example
 * ```ts
 * const sync = createCrossTabSync({
 *   patientId: 'patient-123',
 *   doctorId: 'doctor-456',
 *   appointmentDate: '2026-01-29',
 * });
 * ```
 */
export function createCrossTabSync(
  config: { patientId: string; doctorId: string; appointmentDate: string },
  options?: SimpleCrossTabSyncOptions,
): SimpleCrossTabSync {
  return new SimpleCrossTabSync(config, options);
}
