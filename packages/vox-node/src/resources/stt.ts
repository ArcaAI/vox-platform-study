/**
 * `hope.stt.*` — the STT streaming-session lifecycle (TASK-933).
 *
 * Three ordinary HTTP routes on
 * `apps/api/src/modules/streaming/transcription-job.controller.ts`, plus one
 * factory that wires {@link RealtimeSttSocket} to this client.
 *
 * ## What "select an ASR" means here
 *
 * It means naming an AGENT, or naming nothing. `agentSlug` is a lineage key for
 * a published `SPEECH_TO_TEXT` agent; omit it and the tenant → department
 * `AgentAssignment` cascade decides. There is no engine, no model id and no
 * pipeline to choose — `pipelineId` survives only as a deprecated alias and is
 * removed in R4.
 *
 * ## Session ownership
 *
 * A streaming session belongs to ONE principal, and every gate downstream
 * (ticket mint, refresh, WS handshake, close) compares against it. For a
 * service-account client that principal is the service account itself
 * (TASK-933 lane H1) — so a second client, even one on the same tenant, gets a
 * 404 on this session, not a 403. That is the ordinary 404-over-403 posture,
 * not a bug in your session id.
 */

import { RealtimeSttSocket } from '../core/realtime-stt-socket';
import type { RealtimeSttSocketOptions } from '../core/realtime-stt-socket';
import type { Transport } from '../core/transport';
import { encodePathSegment } from '../core/url';
import type { CreateStreamSessionRequest, StreamSessionResponse, StreamTicketRefreshResponse } from '../types/stt';

/** Per-call options for the session routes. */
export interface SttRequestOptions {
  signal?: AbortSignal;
}

/** What {@link SttResource.socket} lets you override; the rest it wires itself. */
export type SttSocketOptions = Omit<RealtimeSttSocketOptions, 'baseUrl' | 'session' | 'refreshTicket'> & {
  /** Override the wired refresher. Rarely useful — the default already calls {@link SttResource.refreshTicket}. */
  refreshTicket?: RealtimeSttSocketOptions['refreshTicket'];
};

const SESSION_BASE = 'audio/transcription-jobs/stream/session';

export class SttResource {
  constructor(private readonly transport: Transport) {}

  /**
   * `POST /api/v1/audio/transcription-jobs/stream/session` — open a session and
   * receive its WS coordinates plus the FIRST single-use ticket.
   *
   * Send `{}` (the default) to let the tenant's assignment cascade pick the ASR
   * agent, which is what an integration should normally do.
   *
   * **Never retried.** The route accepts no idempotency key, so a retried POST
   * would leak a second live session against the tenant's concurrency ceiling —
   * `core/retry.ts#shouldRetry` leaves non-idempotent POSTs alone.
   *
   * **One session per microphone (TASK-951).** A single session carries no
   * multiplexing of its own — to attribute captions to distinct mic sources,
   * open one UNMIXED session per microphone, each with its own
   * `request.context` naming which one it is (e.g.
   * `{ stream: { mic_ids: ['left'] } }`). HOPE echoes that object verbatim on
   * the response's `context` and on every transcript segment of that
   * session, so a caller re-associates a transcript with its source without
   * keeping an out-of-band map; `sessionEpochMs` on both is the wall-clock
   * anchor for aligning segments across sessions opened moments apart.
   */
  async createStreamSession(request: CreateStreamSessionRequest = {}, options: SttRequestOptions = {}): Promise<StreamSessionResponse> {
    return this.transport.request<StreamSessionResponse>({
      method: 'POST',
      path: SESSION_BASE,
      body: request,
      signal: options.signal,
    });
  }

  /**
   * `POST …/stream/session/:sessionId/refresh-ticket` — mint a fresh single-use
   * ticket for a live session.
   *
   * Needed on EVERY reconnect: the previous ticket was consumed by the previous
   * handshake. {@link RealtimeSttSocket} calls this for you when constructed
   * through {@link socket}.
   */
  async refreshTicket(sessionId: string, options: SttRequestOptions = {}): Promise<StreamTicketRefreshResponse> {
    return this.transport.request<StreamTicketRefreshResponse>({
      method: 'POST',
      path: `${SESSION_BASE}/${encodePathSegment(sessionId)}/refresh-ticket`,
      signal: options.signal,
    });
  }

  /**
   * `DELETE …/stream/session/:sessionId` — close the session server-side (204).
   *
   * Distinct from {@link RealtimeSttSocket.close}, which ends the SOCKET by
   * sending `{type:'close'}`. Call this when you never opened a socket, or to
   * be certain the session is torn down after an abnormal exit; the binding's
   * TTL (24h) is the only other thing that would.
   */
  async closeStreamSession(sessionId: string, options: SttRequestOptions = {}): Promise<void> {
    await this.transport.request<void>({
      method: 'DELETE',
      path: `${SESSION_BASE}/${encodePathSegment(sessionId)}`,
      signal: options.signal,
    });
  }

  /**
   * Build a {@link RealtimeSttSocket} for a session this client opened.
   *
   * This is the wiring method: it supplies the gateway origin (from the same
   * `baseUrl` the client was constructed with) and a ticket refresher bound to
   * {@link refreshTicket}. Constructing the socket directly is supported, but
   * then the refresher is yours to supply — and without one the socket can be
   * opened exactly once, because its ticket is consumed at that handshake.
   *
   * Opens nothing: call `connect()` when you are ready to stream.
   *
   * TASK-951 — two ways to label what you are streaming, and they answer different questions.
   * `createStreamSession({ context })` says what the SESSION is: fixed, echoed on every
   * transcript as `context`. {@link RealtimeSttSocket.setMetadata} says what is happening NOW:
   * it can change mid-recording, and comes back time-synced as each transcript's `metadata`
   * spans, clipped to that segment. A client streaming a mixed feed from a set of microphones
   * that opens and closes wants the second; one session per fixed microphone wants the first.
   * Using both is fine — they are independent.
   */
  socket(session: StreamSessionResponse, options: SttSocketOptions = {}): RealtimeSttSocket {
    // Destructured rather than spread LAST: an `options` object carrying an
    // explicit `refreshTicket: undefined` would otherwise erase the wired one
    // and leave a socket that cannot reconnect.
    const { refreshTicket, ...rest } = options;
    return new RealtimeSttSocket({
      ...rest,
      baseUrl: this.transport.baseUrl,
      session: { sessionId: session.sessionId, ticket: session.ticket, ticketExpiresAt: session.ticketExpiresAt, wsUrl: session.wsUrl },
      refreshTicket: refreshTicket ?? ((sessionId) => this.refreshTicket(sessionId)),
    });
  }
}
