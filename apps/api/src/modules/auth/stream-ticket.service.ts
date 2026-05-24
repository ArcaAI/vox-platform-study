/**
 * StreamTicketService — TASK-263 / W0-1 (D1 contract)
 *
 * Issues and consumes single-use, short-TTL tickets that let SDK clients
 * authenticate Server-Sent-Events endpoints without leaking long-lived JWTs
 * into the URL query string (HIPAA-relevant; query strings show up in CDN
 * access logs, browser history, and Highlight.io network recordings).
 *
 * Locked contract (TASK-263 §2.1 D1):
 *   - Redis key shape: `stream-ticket:<ticket>` → `{ userId, tenantId, scope, exp }`
 *   - TTL: 30 seconds
 *   - Single-use: `consumeTicket()` does GET + DEL
 *   - `consumeTicket()` returns `null` for unknown / expired / corrupt records
 *
 * The "atomic" GET+DEL is currently a 2-call sequence. The race window is in
 * the microsecond range and is not exploitable for 30-second tickets, but
 * a follow-up (see TASK-263 §6) can swap in `IRedisCacheService.getdel(...)`
 * once that method exists on the cache interface.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { IRedisCacheService } from '@arcaai/applications';

export const STREAM_TICKET_KEY_PREFIX = 'stream-ticket:';
export const STREAM_TICKET_TTL_SECONDS = 30;
const STREAM_TICKET_BYTES = 32; // 256 bits → 43 base64url chars

export interface IssueTicketInput {
  userId: string;
  tenantId?: string | null;
  scope: string;
  /**
   * TASK-295 SEC-A5-6 / M-8: when the ticket is issued during an active
   * impersonation, the admin's id is carried forward so the eventual
   * ticket-authenticated request (e.g. SSE/WS) can restore the
   * `impersonatedBy` claim on `req.user` and produce the appropriate
   * audit row via `ImpersonationAuditInterceptor`.
   *
   * Optional and backward-compatible: existing call-sites omit it and
   * receive non-impersonated tickets as before.
   */
  impersonatedBy?: string | null;
}

export interface IssuedTicket {
  ticket: string;
  expiresAt: number; // epoch milliseconds
  scope: string;
}

export interface StoredTicket {
  userId: string;
  tenantId: string | null;
  scope: string;
  exp: number; // epoch milliseconds
  /** Mirrors `IssueTicketInput.impersonatedBy`. Null when the request was not impersonated. */
  impersonatedBy: string | null;
}

@Injectable()
export class StreamTicketService {
  private readonly logger = new Logger(StreamTicketService.name);

  constructor(@Inject(IRedisCacheService) private readonly cache: IRedisCacheService) {}

  async issueTicket(input: IssueTicketInput): Promise<IssuedTicket> {
    const ticket = randomBytes(STREAM_TICKET_BYTES).toString('base64url');
    const expiresAt = Date.now() + STREAM_TICKET_TTL_SECONDS * 1000;
    const payload: StoredTicket = {
      userId: input.userId,
      tenantId: input.tenantId ?? null,
      scope: input.scope,
      exp: expiresAt,
      impersonatedBy: input.impersonatedBy ?? null,
    };

    await this.cache.setex(this.key(ticket), STREAM_TICKET_TTL_SECONDS, JSON.stringify(payload));

    return { ticket, expiresAt, scope: input.scope };
  }

  async consumeTicket(ticket: string): Promise<StoredTicket | null> {
    if (!ticket) return null;
    const key = this.key(ticket);

    const raw = await this.cache.get(key);
    if (raw === null) return null;

    // Best-effort delete to enforce single-use semantics. We delete even for
    // bad/expired records so corrupt keys don't accumulate.
    let parsed: StoredTicket | null = null;
    try {
      const candidate = JSON.parse(raw) as Partial<StoredTicket>;
      if (typeof candidate.userId === 'string' && typeof candidate.scope === 'string' && typeof candidate.exp === 'number') {
        parsed = {
          userId: candidate.userId,
          tenantId: typeof candidate.tenantId === 'string' ? candidate.tenantId : null,
          scope: candidate.scope,
          exp: candidate.exp,
          // Backward-compatible: tickets minted before TASK-295 lack this
          // field; default to null so non-impersonated requests still work.
          impersonatedBy: typeof candidate.impersonatedBy === 'string' ? candidate.impersonatedBy : null,
        };
      }
    } catch (error) {
      this.logger.warn({
        message: 'Discarding corrupt stream ticket',
        ticketKey: key,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    await this.cache.del(key);

    if (!parsed) return null;
    if (parsed.exp <= Date.now()) return null;
    return parsed;
  }

  private key(ticket: string): string {
    return `${STREAM_TICKET_KEY_PREFIX}${ticket}`;
  }
}
