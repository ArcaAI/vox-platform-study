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

import { IRedisCacheService, parseMetadataMarks, type StreamMetadataMarks } from '@arcaai/applications';

export const STREAM_SESSION_TENANT_KEY_PREFIX = 'stream-session-tenant:';
export const STREAM_SESSION_TENANT_DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h

/**
 * Sibling key carrying gateway-relevant session meta: the negotiated audio
 * sampleRate, and (TASK-951 R2) the client-declared session `context` plus the
 * session's creation epoch. Written by `createStreamSession`, read once by the
 * WS gateway at handshake — so audio frames are forwarded at the rate the
 * client actually negotiated instead of a hardcoded 16000, and every transcript
 * of the session carries the caller's own metadata back.
 */
export const STREAM_SESSION_META_KEY_PREFIX = 'stream-session-meta:';

/**
 * TASK-951 R2 (clarified) — the session's metadata TIMELINE: the spans a client declared with
 * `{type:'metadata'}` frames, plus the audio offset they were measured on.
 *
 * A key of its own rather than another field on the meta record above, for one reason: the meta
 * record is written ONCE at create and read ONCE at attach, whereas this one is REWRITTEN on
 * the audio path every time the client changes its metadata. Folding the two together would
 * turn each of those writes into a read-modify-write that races the create path for a record
 * whose other fields (sampleRate, the frozen schema) must never be rewritten at all.
 *
 * Same TTL and the same fail-soft posture as its siblings: a missing or corrupt record rebuilds
 * as an EMPTY timeline, never an error.
 */
export const STREAM_SESSION_MARKS_KEY_PREFIX = 'stream-session-marks:';

export interface StreamSessionMeta {
  sampleRate: number;
  /**
   * TASK-951 R2 (D-8) — the client-declared session context
   * (`CreateStreamSessionRequest.context`, `{ [kindKey]: payload }`), stored
   * VERBATIM so every transcript of the session can echo it.
   *
   * It lives HERE, beside the sampleRate, rather than in a key of its own for
   * one reason: the WS gateway already reads this record exactly once at
   * handshake, so the echo costs no extra round trip and cannot drift out of
   * step with the sampleRate it was negotiated alongside. It is bounded at
   * 4 KB by the controller before it ever reaches Redis, and it is NEVER
   * forwarded to `apps/stt` — the echo is a gateway concern end to end.
   */
  context?: Record<string, unknown>;
  /**
   * TASK-951 R2 — `Date.now()` at session creation. Segment times on the wire
   * are relative to the session, so this is what lets a client that runs
   * several concurrent sessions (one per microphone) place them on one clock.
   */
  sessionEpochMs?: number;
  /**
   * TASK-951 R2 (clarified) — the JSON Schema ONE `{type:'metadata'}` frame must satisfy, or
   * absent when the session's ASR agent binds no stream-identity kind.
   *
   * It is the `fields` of the kind the agent's pinned context schema marked `streamContext`
   * (`compiledConfig.contextSchema.openBindings.streamContext.kindKey`, looked up in the same
   * artifact's `payloadSchema.properties`), resolved ONCE by `createStreamSession` and frozen
   * here. The gateway validates every metadata frame against it without resolving an agent or
   * touching the database on the audio path — a WS control frame cannot afford either, and the
   * answer must not change under a live session because a tenant edited a schema row.
   *
   * ABSENT is meaningful and is NOT "reject everything": an agent that declares no
   * stream-identity vocabulary has no opinion about what a client may label its audio with, so
   * any object is accepted on the size bound alone. That is the same reading
   * `assertStreamContextConforms` gives an agent with no bound schema at all.
   */
  metadataSchema?: Record<string, unknown>;
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
        // TASK-951 — the two echo fields are read back INDEPENDENTLY of each other and
        // of the sampleRate gate above: a record written before this ticket carries
        // neither, and a record whose `context` is somehow not a plain object is read as
        // "no context" rather than failing a handshake over a display concern.
        const context =
          parsed.context !== null && typeof parsed.context === 'object' && !Array.isArray(parsed.context)
            ? (parsed.context as Record<string, unknown>)
            : undefined;
        const sessionEpochMs =
          typeof parsed.sessionEpochMs === 'number' && Number.isFinite(parsed.sessionEpochMs) && parsed.sessionEpochMs > 0
            ? parsed.sessionEpochMs
            : undefined;
        // TASK-951 R2 (clarified) — read on exactly the same terms: independently of the other
        // fields, and as "no schema" rather than a failed handshake when it is not an object.
        const metadataSchema =
          parsed.metadataSchema !== null && typeof parsed.metadataSchema === 'object' && !Array.isArray(parsed.metadataSchema)
            ? (parsed.metadataSchema as Record<string, unknown>)
            : undefined;
        return {
          sampleRate: parsed.sampleRate,
          ...(context ? { context } : {}),
          ...(sessionEpochMs != null ? { sessionEpochMs } : {}),
          ...(metadataSchema ? { metadataSchema } : {}),
        };
      }
    } catch {
      // Corrupt record — treated as absent.
    }
    return null;
  }

  /**
   * TASK-951 R2 (clarified) — persist the session's metadata timeline.
   *
   * Called from the WS gateway whenever a `{type:'metadata'}` frame changes the spans, which is
   * a control-frame cadence (a microphone opening or closing), NOT an audio-frame cadence — so
   * this is nothing like a per-frame write. The gateway serves every transcript from its own
   * in-memory copy; this record exists only so a session that reconnects onto a different
   * gateway instance, or onto one that restarted, rebuilds the timeline instead of silently
   * starting a second one at zero and reporting every later segment as unlabelled.
   */
  async bindMetadataMarks(sessionId: string, marks: StreamMetadataMarks, ttlSeconds: number = STREAM_SESSION_TENANT_DEFAULT_TTL_SECONDS): Promise<void> {
    if (!this.isValidSessionId(sessionId)) {
      return;
    }
    await this.cache.setex(this.marksKey(sessionId), Math.max(1, Math.floor(ttlSeconds)), JSON.stringify(marks));
  }

  /**
   * The session's persisted metadata timeline, or an EMPTY one.
   *
   * Never null and never a throw: {@link parseMetadataMarks} is total, and a missing record is
   * the ordinary case (every session that has not sent a `metadata` frame). The caller cannot
   * tell "absent" from "corrupt", and deliberately should not — both mean "nothing to rebuild",
   * and a live transcription must not be refused over an attribution aid.
   */
  async lookupMetadataMarks(sessionId: string): Promise<StreamMetadataMarks> {
    if (!this.isValidSessionId(sessionId)) {
      return { spans: [], audioSec: 0 };
    }
    const raw = await this.cache.get(this.marksKey(sessionId));
    if (typeof raw !== 'string' || raw.length === 0) {
      return { spans: [], audioSec: 0 };
    }
    try {
      return parseMetadataMarks(JSON.parse(raw));
    } catch {
      return { spans: [], audioSec: 0 };
    }
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

  private marksKey(sessionId: string): string {
    return `${STREAM_SESSION_MARKS_KEY_PREFIX}${sessionId}`;
  }
}
