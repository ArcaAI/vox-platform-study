/**
 * @arcaai/vox - Simple Cross-Tab Sync
 *
 * Lightweight cross-tab synchronisation using `BroadcastChannel`.
 *
 * Hardenings landed under TASK-266:
 *
 *   - **W0-4 — HMAC-signed messages.** Every outgoing message is wrapped in
 *     a `{ payload, hmac }` envelope. The HMAC is `HMAC-SHA-256` using a
 *     per-session 32-byte secret held in module memory (never persisted,
 *     regenerated on app reload). Receivers verify HMAC and drop any
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
 * The `broadcastContext*` methods are `async` because Web Crypto's
 * `sign('HMAC')` is async — callers may `await` them in tests but the
 * existing fire-and-forget callsite in `useArcaSession` works fine because
 * any signing error is caught and logged internally.
 */

import type { ContextItem } from '../types';

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
// Per-session HMAC secret (module-level singleton)
// =============================================================================

let SESSION_HMAC_SECRET: Uint8Array | null = null;
let SESSION_HMAC_KEY_PROMISE: Promise<CryptoKey> | null = null;

function ensureSessionSecret(): Uint8Array {
  if (SESSION_HMAC_SECRET === null) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    SESSION_HMAC_SECRET = buf;
  }
  return SESSION_HMAC_SECRET;
}

function getSessionHmacKey(): Promise<CryptoKey> {
  if (SESSION_HMAC_KEY_PROMISE === null) {
    const secret = ensureSessionSecret();
    SESSION_HMAC_KEY_PROMISE = crypto.subtle.importKey('raw', secret as unknown as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
  }
  return SESSION_HMAC_KEY_PROMISE;
}

/**
 * Test-only: wipe the module singleton so tests can simulate "app reload".
 * Underscored prefix marks this as not part of the public SDK surface.
 */
export function __resetSessionHmacSecretForTests(): void {
  SESSION_HMAC_SECRET = null;
  SESSION_HMAC_KEY_PROMISE = null;
}

/** Test-only: read the raw secret to assert its 32-byte length / freshness. */
export function __getSessionHmacSecretForTests(): Uint8Array | null {
  return SESSION_HMAC_SECRET;
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

  constructor(config: { patientId: string; doctorId: string; appointmentDate: string }, options: SimpleCrossTabSyncOptions = {}) {
    this.tabId = `tab_${crypto.randomUUID()}`;
    this.consultationKey = `${config.patientId}_${config.doctorId}_${config.appointmentDate}`;
    this.tenantId = options.tenantId;
    this.logger = options.logger;

    this.isSupported = typeof BroadcastChannel !== 'undefined';
    if (this.isSupported) {
      this.openChannel();
    }
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
    return this.isSupported && this.channel !== null;
  }

  /**
   * Update the active tenant id at runtime.
   *
   * TASK-266 W0-5: closes the old channel and reopens a new one with the
   * tenant-namespaced name so cross-tenant messages cannot leak after a
   * tenant switch (e.g. user impersonation flow).
   */
  setTenantId(tenantId: string): void {
    if (this.tenantId === tenantId) return;
    this.tenantId = tenantId;
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // Ignore — already closed.
      }
      this.channel = null;
    }
    if (this.isSupported) {
      this.openChannel();
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

  private channelName(): string {
    // W0-5: NEVER bare `agentic` — must include tenant id (preferred) or the
    // consultation key as a session-scoped fallback.
    const suffix = this.tenantId && this.tenantId.length > 0 ? this.tenantId : this.consultationKey;
    return `agentic.${suffix}`;
  }

  private openChannel(): void {
    try {
      // Materialise the per-session secret eagerly so the channel is ready to
      // sign/verify as soon as the first message is exchanged. Idempotent.
      ensureSessionSecret();

      const ch = new BroadcastChannel(this.channelName());
      ch.onmessage = (event: MessageEvent) => {
        // The handler returns void but the body runs an async verify step.
        // Errors are swallowed and logged — receivers must never throw past
        // the event boundary or they crash the BroadcastChannel.
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
      const key = await getSessionHmacKey();
      const sigBytes = base64ToUint8(hmac);
      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
      verified = await crypto.subtle.verify('HMAC', key, sigBytes as unknown as ArrayBuffer, payloadBytes as unknown as ArrayBuffer);
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
    if (!this.channel) return;

    const payload: CrossTabPayload = {
      type,
      data,
      timestamp: Date.now(),
      tabId: this.tabId,
    };

    let envelope: CrossTabEnvelope;
    try {
      const key = await getSessionHmacKey();
      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
      const sig = await crypto.subtle.sign('HMAC', key, payloadBytes as unknown as ArrayBuffer);
      envelope = { payload, hmac: uint8ToBase64(new Uint8Array(sig)) };
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
