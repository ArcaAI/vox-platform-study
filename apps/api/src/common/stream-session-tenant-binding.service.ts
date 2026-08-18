/**
 * `StreamSessionTenantBindingService`.
 *
 * Maps `sessionId → { tenantId, userId }` for the lifetime of an STT
 * streaming session so the gateway can run a route-level ownership check on
 * `DELETE /stream/session/:sessionId` (the legacy enforcement was the
 * Prisma `tenantScope` extension on whatever rows the downstream
 * `removeSession` happened to touch — defence-in-depth but not a
 * route-level guard).
 *
 * OWNER IDENTITY. The record used to carry the tenant ALONE, so
 * every gate built on it — ticket mint, refresh-ticket, WS handshake,
 * close/switch — could only ever ask "same tenant?". Any authenticated user
 * who learned a colleague's sessionId passed all four and could have the live
 * clinical audio-ingest + transcript stream transplanted onto their own
 * socket. The binding now records the OWNING USER, which is what makes a
 * same-tenant/different-user check possible at all.
 *
 * Wire-format (single Redis key, TTL-bounded):
 *   stream-session-tenant:<sessionId>  →  {"tenantId":"…","userId":"…"}
 *
 * ROLLOUT. Records written before this change are the BARE
 * tenant id with no JSON envelope, and sit in Redis for up to the 24h TTL.
 * `lookupBinding` reads those as `{ tenantId, userId: null }` rather than
 * failing — but a `null` owner is "owner unproven", and every enforcement
 * point treats it as a mismatch (same posture as a legacy `ConsultationJob`
 * row with no `userId` under `scope: 'creator'`). A live pre-deploy session
 * therefore stops refreshing its ticket and must be re-created; that is the
 * deliberate trade against leaving the hijack open for a TTL window.
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

/**
 * The resolved owner of a streaming session: the tenant it belongs to and the
 * user who created it. `userId` is `null` only for a legacy (pre-owner)
 * record or a creation path that had no user context — both mean "owner
 * unproven", which every enforcement point denies.
 */
export interface StreamSessionBinding {
  tenantId: string;
  userId: string | null;
}

@Injectable()
export class StreamSessionTenantBindingService {
  private readonly logger = new Logger(StreamSessionTenantBindingService.name);

  constructor(@Inject(IRedisCacheService) private readonly cache: IRedisCacheService) {}

  /**
   * Record the session's owner. `userId` is the user whose request created
   * the session; pass `null` only where there genuinely is no user context
   * (the caller then cannot pass any owner check, by design).
   */
  async bind(
    sessionId: string,
    tenantId: string,
    userId: string | null = null,
    ttlSeconds: number = STREAM_SESSION_TENANT_DEFAULT_TTL_SECONDS,
  ): Promise<void> {
    if (!this.isValidSessionId(sessionId) || !tenantId) {
      return;
    }
    const payload: StreamSessionBinding = { tenantId, userId: userId && userId.length > 0 ? userId : null };
    await this.cache.setex(this.key(sessionId), Math.max(1, Math.floor(ttlSeconds)), JSON.stringify(payload));
  }

  /**
   * Resolve the full `{ tenantId, userId }` binding. Returns null for a
   * missing, corrupt, or tenant-less record (fail-closed — every caller
   * turns null into a 404 / generic WS close).
   */
  async lookupBinding(sessionId: string): Promise<StreamSessionBinding | null> {
    if (!this.isValidSessionId(sessionId)) {
      return null;
    }
    const raw = await this.cache.get(this.key(sessionId));
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    // Legacy record: the bare tenant id, written before the owner was
    // tracked. Read it rather than throwing, but with NO owner.
    if (!raw.startsWith('{')) {
      return { tenantId: raw, userId: null };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StreamSessionBinding>;
      if (typeof parsed?.tenantId !== 'string' || parsed.tenantId.length === 0) {
        return null;
      }
      return {
        tenantId: parsed.tenantId,
        userId: typeof parsed.userId === 'string' && parsed.userId.length > 0 ? parsed.userId : null,
      };
    } catch {
      // Corrupt record — treated as absent.
      return null;
    }
  }

  /**
   * Tenant-only view of the binding, kept for callers whose ownership model
   * is the tenant itself (the v1-compat plane authenticates a MACHINE
   * identity, so there is no end user to compare against). Anything gating a
   * per-user session must use {@link lookupBinding}.
   */
  async lookup(sessionId: string): Promise<string | null> {
    return (await this.lookupBinding(sessionId))?.tenantId ?? null;
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
