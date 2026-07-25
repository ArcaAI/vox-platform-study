/**
 * `StreamSessionTenantBindingService`.
 *
 * Maps `sessionId → tenantId` for the lifetime of an STT streaming
 * session so the gateway can run a route-level tenant check on
 * `DELETE /stream/session/:sessionId` (the legacy enforcement was the
 * Prisma `tenantScope` extension on whatever rows the downstream
 * `removeSession` happened to touch — defence-in-depth but not a
 * route-level guard).
 *
 * Wire-format (single Redis key, TTL-bounded):
 *   stream-session-tenant:<sessionId>  →  <tenantId>
 *
 * The TTL matches the longest reasonable streaming-session lifetime
 * (default 24 hours) so the binding fades naturally if the close
 * endpoint is never called (pod crash, client gone away, etc.) and
 * doesn't leak Redis memory. The TTL is *not* a security boundary —
 * the close-endpoint guard 404s missing bindings, so an expired
 * binding just means the close call also 404s. The session itself
 * lives in STT / Redis with its own lifetime.
 *
 * The service intentionally treats:
 *   - empty / whitespace `sessionId`  →  null lookup (no existence leak)
 *   - Redis disconnect                →  null lookup (graceful — the
 *                                        interceptor 404s, consistent
 *                                        with every other resolver)
 *
 * For a discussion of alternative designs (a nested
 * `/jobs/:id/stream-session/:sessionId` URL, STT returning tenantId
 * on its status endpoint, etc.) see the TSDoc on
 * `TranscriptionJobController.closeStreamSession`.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';

import { IRedisCacheService } from '@arcaai/applications';

export const STREAM_SESSION_TENANT_KEY_PREFIX = 'stream-session-tenant:';
export const STREAM_SESSION_TENANT_DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h

/**
 * Sibling key carrying gateway-relevant session meta
 * (currently the negotiated audio sampleRate). Written by
 * `createStreamSession`, read once by the WS gateway at handshake so audio
 * frames are forwarded at the rate the client actually negotiated instead
 * of a hardcoded 16000.
 */
export const STREAM_SESSION_META_KEY_PREFIX = 'stream-session-meta:';

export interface StreamSessionMeta {
  sampleRate: number;
}

@Injectable()
export class StreamSessionTenantBindingService {
  private readonly logger = new Logger(StreamSessionTenantBindingService.name);

  constructor(@Inject(IRedisCacheService) private readonly cache: IRedisCacheService) {}

  async bind(sessionId: string, tenantId: string, ttlSeconds: number = STREAM_SESSION_TENANT_DEFAULT_TTL_SECONDS): Promise<void> {
    if (!this.isValidSessionId(sessionId) || !tenantId) {
      return;
    }
    await this.cache.setex(this.key(sessionId), Math.max(1, Math.floor(ttlSeconds)), tenantId);
  }

  async lookup(sessionId: string): Promise<string | null> {
    if (!this.isValidSessionId(sessionId)) {
      return null;
    }
    const raw = await this.cache.get(this.key(sessionId));
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    return raw;
  }

  /**
   * Persist session meta (negotiated sampleRate) under a TTL-bounded
   * sibling key. Same lifetime/posture as `bind()`.
   */
  async bindSessionMeta(sessionId: string, meta: StreamSessionMeta, ttlSeconds: number = STREAM_SESSION_TENANT_DEFAULT_TTL_SECONDS): Promise<void> {
    if (!this.isValidSessionId(sessionId)) {
      return;
    }
    await this.cache.setex(this.metaKey(sessionId), Math.max(1, Math.floor(ttlSeconds)), JSON.stringify(meta));
  }

  /**
   * Returns the bound session meta, or null for missing / corrupt / invalid
   * records (the gateway falls back to 16000 — graceful, never throws on
   * bad data).
   */
  async lookupSessionMeta(sessionId: string): Promise<StreamSessionMeta | null> {
    if (!this.isValidSessionId(sessionId)) {
      return null;
    }
    const raw = await this.cache.get(this.metaKey(sessionId));
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StreamSessionMeta>;
      if (typeof parsed?.sampleRate === 'number' && Number.isFinite(parsed.sampleRate) && parsed.sampleRate > 0) {
        return { sampleRate: parsed.sampleRate };
      }
    } catch {
      // Corrupt record — treated as absent.
    }
    return null;
  }

  async clear(sessionId: string): Promise<void> {
    if (!this.isValidSessionId(sessionId)) {
      return;
    }
    try {
      await this.cache.del(this.key(sessionId));
    } catch (err) {
      // Non-fatal: the binding TTL will reclaim it. We log and proceed so
      // the close handler's HTTP response is unaffected by a Redis blip.
      this.logger.warn({
        message: 'Failed to clear stream-session-tenant binding (TTL will reclaim)',
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private isValidSessionId(sessionId: string): boolean {
    return typeof sessionId === 'string' && sessionId.trim().length > 0;
  }

  private key(sessionId: string): string {
    return `${STREAM_SESSION_TENANT_KEY_PREFIX}${sessionId}`;
  }

  private metaKey(sessionId: string): string {
    return `${STREAM_SESSION_META_KEY_PREFIX}${sessionId}`;
  }
}
