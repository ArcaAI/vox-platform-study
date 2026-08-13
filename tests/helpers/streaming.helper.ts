/**
 * Shared streaming e2e helper.
 *
 * Mints a real STT streaming session + one-shot ticket through the API
 * gateway and opens an AUTHENTICATED WebSocket to `/ws/stt/stream`, plus a
 * realtime PCM frame feeder. Used by the `task-455-streaming-*.spec.ts` suite
 * (resume-after-drop, backpressure recovery, ticket-refresh mid-session).
 *
 * This helper exercises the REALTIME LOOP end to end over a real socket:
 *
 *   mic frames → WS `/ws/stt/stream` → Redis `stt:audio` → STT
 *              → Redis `stt:result` → WS caption messages
 *
 * Wire protocol (verified against `apps/api/src/modules/streaming/stt-ws.gateway.ts`
 * + `packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts`):
 *
 *   Client → Server:
 *     - binary PCM frame (Int16 LE mono)         → audio (server assigns seq)
 *     - { type:'audio', seq, data:<base64> }     → audio (client-supplied seq)
 *     - { type:'stop' }                          → finalize
 *     - { type:'resume', sessionId, lastSeq }    → resumability handshake (D-17)
 *     - { type:'close' }                         → close session
 *   Server → Client:
 *     - { type:'transcript', seq, text, startTime, endTime, isFinal, ... }
 *     - { type:'status', status:'closed'|..., message }
 *     - { type:'resumed', sessionId, fromSeq }
 *     - { type:'resume_failed', sessionId, reason, minAvailableSeq? }
 *     - { type:'error', code, message }
 *
 * Session mint: `POST /api/v1/audio/transcription-jobs/stream/session`
 * (`transcription-job.controller.ts#createStreamSession`) returns
 * `{ sessionId, wsUrl, ticket, ticketExpiresAt }`. The gateway consumes the
 * ticket on first open (one-shot); reconnects mint a fresh one via
 * `POST .../stream/session/:sessionId/refresh-ticket`.
 *
 * MODULE-RESOLUTION NOTE: the `ws` package resolves from spec files under
 * `apps/api/tests/e2e/` (via `apps/api/node_modules`) but NOT from this root
 * `tests/helpers/` directory. So this helper NEVER imports `ws` at runtime —
 * the spec injects the `ws` default export (a `StreamWsCtor`) into
 * `openStreamSocket`. Keeps the helper transport-agnostic and touches no
 * root dependency manifest.
 */

import type { APIRequestContext } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DEFAULT_TENANT_KEY, loginUser, SEEDED_USERS } from './e2e.helper';

// =============================================================================
// Constants
// =============================================================================

export const STREAM_SAMPLE_RATE = 16000;

/**
 * Default ASR pipeline for streaming e2e.
 *
 * Must be a pipeline the seeded `__GLOBAL__` (tenant `50000000-…0000`) callers
 * OWN — `createStreamSession` runs `assertPipelineOwnership` (a tenant-scoped
 * `pipelineService.getById`, 404-over-403). The SYSTEM-tenant `best-practice-*`
 * pipelines are NOT resolvable by a `__GLOBAL__` caller on this path, so we use
 * the `__GLOBAL__`-owned `turbo-whisper-large-v3` (id `…402`), whose ASR model
 * is `openai/whisper-large-v3-turbo` — the same Whisper-Turbo model as
 * `best-practice-realtime` and one that is cached on the offline test volume.
 * Override with `STREAM_E2E_PIPELINE_ID`.
 */
export const DEFAULT_STREAM_PIPELINE_ID = process.env.STREAM_E2E_PIPELINE_ID?.trim() || '81000000-0000-0000-0001-000000000402';

/**
 * Committed 16 kHz mono PCM16 fixture (≈107 s real Malayalam speech). Override
 * with `STREAM_E2E_WAV`. Resolved relative to THIS file so the path is stable
 * regardless of the Playwright working directory.
 */
export const STREAM_FIXTURE_WAV =
  process.env.STREAM_E2E_WAV?.trim() || resolve(__dirname, '../../apps/stt/tests/e2e/fixtures/20260205_52886591770282917_ml.wav');

const WAV_HEADER_BYTES = 44;

// =============================================================================
// WebSocket structural types (the `ws` default export satisfies these)
// =============================================================================

export interface WsLike {
  readyState: number;
  send(data: string | Buffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  // ws is an EventEmitter; a permissive signature accepts its overloaded `on`.
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface StreamWsCtor {
  new (url: string): WsLike;
  readonly OPEN: number;
}

// =============================================================================
// HTTP: login / session mint / ticket refresh / close
// =============================================================================

export interface StreamSessionInfo {
  sessionId: string;
  /** Relative WS path returned by the API (`/ws/stt/stream`). */
  wsUrl: string;
  /** `ws://host` origin (WS path sits OUTSIDE the `/api/v1` prefix). */
  wsOrigin: string;
  /** Fully-qualified `ws://host/ws/stt/stream?sessionId=…&ticket=…`. */
  wsFullUrl: string;
  ticket: string;
  ticketExpiresAt: number;
  status: string;
}

export type CreateStreamResult = { ok: true; session: StreamSessionInfo } | { ok: false; status: number; reason: string };

/**
 * Derive the `ws://host` origin from the HTTP API base URL. The WS gateway is
 * mounted at `/ws/stt/stream`, OUTSIDE the global `/api/v1` prefix.
 */
export function wsOriginFromApiUrl(apiUrl?: string): string {
  const base = apiUrl || process.env.API_URL || 'http://localhost:8968/api/v1';
  return base.replace(/^http/, 'ws').replace(/\/api\/v1\/?$/, '');
}

export function streamWsUrl(wsOrigin: string, sessionId: string, ticket: string): string {
  return `${wsOrigin}/ws/stt/stream?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`;
}

/**
 * Log in a seeded user and return a bearer token. Defaults to `doctor` in the
 * `__GLOBAL__` tenant (the pattern used by `task-450-stt-session-cross-tenant`).
 * Throws with an actionable message when the login fails (empty/unseeded DB).
 */
export async function loginStreamUser(
  request: APIRequestContext,
  opts: { username?: string; password?: string; tenantKey?: string } = {},
): Promise<string> {
  const username = opts.username ?? SEEDED_USERS.doctor.username;
  const password = opts.password ?? SEEDED_USERS.doctor.password;
  const tenantKey = opts.tenantKey ?? DEFAULT_TENANT_KEY;
  const result = await loginUser(request, username, password, tenantKey);
  if (!result?.token) {
    throw new Error(`loginStreamUser: login failed for ${username}/${tenantKey}. Is the test DB seeded (pnpm test:db:seed)?`);
  }
  return result.token;
}

/**
 * Mint a streaming session + one-shot ticket through the API gateway.
 *
 * Returns `{ ok:false, status, reason }` (never throws) for the two expected
 * "cannot proceed" outcomes so specs can `test.skip(...)` cleanly:
 *   - 404 → pipeline not owned/visible to the caller (or STT unreachable
 *     behind the gateway on the ownership read),
 *   - 503 → STT streaming service at capacity / not initialized.
 */
export async function createStreamSession(
  request: APIRequestContext,
  opts: {
    token: string;
    pipelineId?: string;
    sampleRate?: number;
    consultationId?: string;
    apiUrl?: string;
  },
): Promise<CreateStreamResult> {
  const pipelineId = opts.pipelineId ?? DEFAULT_STREAM_PIPELINE_ID;
  const sampleRate = opts.sampleRate ?? STREAM_SAMPLE_RATE;

  const response = await request.post('/api/v1/audio/transcription-jobs/stream/session', {
    headers: { Authorization: `Bearer ${opts.token}` },
    data: { pipelineId, sampleRate, ...(opts.consultationId ? { consultationId: opts.consultationId } : {}) },
  });

  const status = response.status();
  if (status !== 201) {
    const body = (await response.text()).slice(0, 200);
    return {
      ok: false,
      status,
      reason: `POST stream/session → ${status}: ${body} (pipeline=${pipelineId}; is STT running + the pipeline owned by the caller?)`,
    };
  }

  const body = (await response.json()) as {
    sessionId: string;
    status: string;
    wsUrl: string;
    ticket: string;
    ticketExpiresAt: number;
  };
  const wsOrigin = wsOriginFromApiUrl(opts.apiUrl);
  return {
    ok: true,
    session: {
      sessionId: body.sessionId,
      wsUrl: body.wsUrl,
      wsOrigin,
      wsFullUrl: streamWsUrl(wsOrigin, body.sessionId, body.ticket),
      ticket: body.ticket,
      ticketExpiresAt: body.ticketExpiresAt,
      status: body.status,
    },
  };
}

/**
 * Mint a FRESH one-shot ticket for an existing session. Each
 * reconnect needs one because the previous ticket was consumed on first open.
 */
export async function refreshStreamTicket(
  request: APIRequestContext,
  token: string,
  sessionId: string,
): Promise<{ status: number; ticket?: string; ticketExpiresAt?: number }> {
  const response = await request.post(`/api/v1/audio/transcription-jobs/stream/session/${encodeURIComponent(sessionId)}/refresh-ticket`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const status = response.status();
  if (status !== 200) return { status };
  const body = (await response.json()) as { ticket: string; ticketExpiresAt: number };
  return { status, ticket: body.ticket, ticketExpiresAt: body.ticketExpiresAt };
}

/** Best-effort session teardown (the binding TTL reclaims it regardless). */
export async function closeStreamSession(request: APIRequestContext, token: string, sessionId: string): Promise<void> {
  await request
    .delete(`/api/v1/audio/transcription-jobs/stream/session/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    .catch(() => undefined);
}

// =============================================================================
// WebSocket wrapper
// =============================================================================

export interface CapturedTranscript {
  /** ms since socket construction (monotonic `performance.now()` clock). */
  at: number;
  seq?: number;
  isFinal: boolean;
  text: string;
  startTime: number;
  endTime: number;
}

export interface CapturedMessage {
  at: number;
  raw: Record<string, unknown>;
}

/**
 * Thin wrapper around an injected `ws` socket that captures every server
 * message (with a monotonic receive timestamp) and exposes the small client
 * verbs the streaming protocol needs. All timing uses `performance.now()`
 * offset from construction — a single clock, immune to skew.
 */
export class StreamSocket {
  readonly messages: CapturedMessage[] = [];
  readonly transcripts: CapturedTranscript[] = [];
  readonly errors: Array<Record<string, unknown>> = [];
  /** Per-frame audio send times: `{ seq, at }` (monotonic ms). */
  readonly sentFrames: Array<{ seq: number; at: number }> = [];
  closeInfo?: { code: number; reason: string };

  private readonly openCtor: StreamWsCtor;
  private readonly t0 = performance.now();
  private audioSeq = 0;

  constructor(
    readonly raw: WsLike,
    ctor: StreamWsCtor,
  ) {
    this.openCtor = ctor;
    raw.on('message', (data: Buffer | string) => this.onMessage(data));
    raw.on('close', (code: number, reason: Buffer | string) => {
      this.closeInfo = { code, reason: reason?.toString?.() ?? String(reason ?? '') };
    });
    raw.on('error', () => {
      /* surfaced via waitOpen / close; never throw off the event loop */
    });
  }

  /** ms since construction on the wrapper's monotonic clock. */
  now(): number {
    return performance.now() - this.t0;
  }

  private onMessage(data: Buffer | string): void {
    const at = this.now();
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      return; // non-JSON frames are not part of this protocol
    }
    this.messages.push({ at, raw });
    if (raw.type === 'transcript') {
      this.transcripts.push({
        at,
        seq: typeof raw.seq === 'number' ? raw.seq : undefined,
        isFinal: raw.isFinal === true || raw.is_final === '1' || raw.is_final === true,
        text: typeof raw.text === 'string' ? raw.text : '',
        startTime: numOf(raw.startTime ?? raw.start_time),
        endTime: numOf(raw.endTime ?? raw.end_time),
      });
    } else if (raw.type === 'error') {
      this.errors.push(raw);
    }
  }

  waitOpen(timeoutMs = 8000): Promise<void> {
    return new Promise((res, rej) => {
      if (this.raw.readyState === this.openCtor.OPEN) return res();
      const timer = setTimeout(() => rej(new Error(`WS open timed out after ${timeoutMs}ms`)), timeoutMs);
      this.raw.on('open', () => {
        clearTimeout(timer);
        res();
      });
      this.raw.on('close', (code: number) => {
        clearTimeout(timer);
        rej(new Error(`WS closed before open (code ${code})`));
      });
      this.raw.on('error', (err: Error) => {
        clearTimeout(timer);
        rej(err);
      });
    });
  }

  /** Send a binary PCM frame (server assigns the audio seq). */
  sendAudioFrame(pcm: Buffer | Uint8Array): void {
    this.audioSeq += 1;
    this.sentFrames.push({ seq: this.audioSeq, at: this.now() });
    this.raw.send(pcm);
  }

  sendStop(): void {
    this.raw.send(JSON.stringify({ type: 'stop' }));
  }

  sendClose(): void {
    this.raw.send(JSON.stringify({ type: 'close' }));
  }

  /** D-17 resumability handshake. */
  sendResume(sessionId: string, lastSeq: number): void {
    this.raw.send(JSON.stringify({ type: 'resume', sessionId, lastSeq }));
  }

  /** Abrupt transport drop — no close frame (simulates a network cut). */
  drop(): void {
    this.raw.terminate();
  }

  close(code = 1000): void {
    try {
      this.raw.close(code);
    } catch {
      /* ignore */
    }
  }

  /** Max transcript `seq` observed so far (0 when none). */
  lastSeq(): number {
    let max = 0;
    for (const t of this.transcripts) if (typeof t.seq === 'number' && t.seq > max) max = t.seq;
    return max;
  }

  /**
   * Resolve once a server message matching `predicate` arrives (scanning both
   * already-captured and future messages), or `null` on timeout.
   */
  waitForMessage(predicate: (raw: Record<string, unknown>) => boolean, timeoutMs = 15000): Promise<Record<string, unknown> | null> {
    const existing = this.messages.find((m) => predicate(m.raw));
    if (existing) return Promise.resolve(existing.raw);
    return new Promise((res) => {
      const start = this.messages.length;
      const timer = setInterval(() => {
        for (let i = start; i < this.messages.length; i++) {
          if (predicate(this.messages[i]!.raw)) {
            clearInterval(timer);
            clearTimeout(deadline);
            return res(this.messages[i]!.raw);
          }
        }
      }, 25);
      const deadline = setTimeout(() => {
        clearInterval(timer);
        res(null);
      }, timeoutMs);
    });
  }

  /** Resolve once at least `min` transcripts have arrived, or `null` on timeout. */
  async waitForTranscripts(min = 1, timeoutMs = 20000): Promise<boolean> {
    if (this.transcripts.length >= min) return true;
    const found = await this.waitForMessage(() => this.transcripts.length >= min, timeoutMs);
    return found !== null || this.transcripts.length >= min;
  }

  waitForClosedStatus(timeoutMs = 20000): Promise<Record<string, unknown> | null> {
    return this.waitForMessage((raw) => raw.type === 'status' && (raw.status === 'closed' || raw.status === 'cancelled'), timeoutMs);
  }
}

export interface HandshakeOutcome {
  outcome: 'accepted' | 'closed';
  code?: number;
  reason?: string;
}

/**
 * Probe ONLY the handshake: report whether the gateway kept the socket open or
 * closed it (e.g. the generic `4401` auth-failed close). The gateway upgrades
 * first and runs the ticket/binding gate AFTER open, so a rejection surfaces as
 * an immediate post-open close — we wait a short grace window before declaring
 * the handshake accepted. Mirrors `task-450-stt-session-cross-tenant`'s probe.
 */
export function probeStreamHandshake(
  WebSocketCtor: StreamWsCtor,
  url: string,
  opts: { graceMs?: number; timeoutMs?: number } = {},
): Promise<HandshakeOutcome> {
  const graceMs = opts.graceMs ?? 750;
  const timeoutMs = opts.timeoutMs ?? 8000;
  return new Promise((res, rej) => {
    const socket = new WebSocketCtor(url);
    let settled = false;
    const settle = (o: HandshakeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (o.outcome === 'accepted') {
        try {
          socket.close(1000);
        } catch {
          /* ignore */
        }
      }
      res(o);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.terminate();
      } catch {
        /* ignore */
      }
      rej(new Error(`WS handshake to ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on('open', () => {
      setTimeout(() => {
        if (!settled && socket.readyState === WebSocketCtor.OPEN) settle({ outcome: 'accepted' });
      }, graceMs);
    });
    socket.on('close', (code: number, reason: Buffer | string) => {
      settle({ outcome: 'closed', code, reason: reason?.toString?.() ?? String(reason ?? '') });
    });
    socket.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rej(err);
    });
  });
}

/** Construct + open a `StreamSocket` from an injected `ws` ctor. */
export async function openStreamSocket(
  WebSocketCtor: StreamWsCtor,
  opts: { wsOrigin?: string; sessionId: string; ticket: string; wsFullUrl?: string; timeoutMs?: number },
): Promise<StreamSocket> {
  const url = opts.wsFullUrl ?? streamWsUrl(opts.wsOrigin ?? wsOriginFromApiUrl(), opts.sessionId, opts.ticket);
  const raw = new WebSocketCtor(url);
  const socket = new StreamSocket(raw, WebSocketCtor);
  await socket.waitOpen(opts.timeoutMs);
  return socket;
}

// =============================================================================
// Audio: fixture load + realtime frame feed
// =============================================================================

/** Read a 16-bit PCM mono WAV, strip the 44-byte header, cap at `maxSeconds`. */
export function loadPcm16(wavPath: string = STREAM_FIXTURE_WAV, opts: { maxSeconds?: number } = {}): Buffer {
  const raw = readFileSync(wavPath);
  const body = raw.subarray(WAV_HEADER_BYTES);
  const maxSeconds = opts.maxSeconds ?? 0;
  if (maxSeconds > 0) {
    const maxBytes = Math.floor(maxSeconds * STREAM_SAMPLE_RATE) * 2;
    return body.subarray(0, Math.min(body.length, maxBytes));
  }
  return body;
}

export function frameBytes(frameMs: number, sampleRate = STREAM_SAMPLE_RATE): number {
  return Math.floor((sampleRate * frameMs) / 1000) * 2;
}

/**
 * Feed PCM as binary frames. `realtime: true` (default) paces to a drift-free
 * absolute schedule (like the real mic path); `realtime: false` floods as fast
 * as possible (for overload / backpressure probes). Returns frames sent.
 */
export async function feedFramesRealtime(
  socket: StreamSocket,
  pcm: Buffer,
  opts: { frameMs?: number; realtime?: boolean; sampleRate?: number } = {},
): Promise<number> {
  const frameMs = opts.frameMs ?? 80;
  const realtime = opts.realtime ?? true;
  const sampleRate = opts.sampleRate ?? STREAM_SAMPLE_RATE;
  const fb = frameBytes(frameMs, sampleRate);
  const nFrames = Math.ceil(pcm.length / fb);
  const start = performance.now();

  for (let i = 0; i < nFrames; i++) {
    if (realtime) {
      const target = start + i * frameMs;
      const wait = target - performance.now();
      if (wait > 0) await sleep(wait);
    }
    socket.sendAudioFrame(pcm.subarray(i * fb, (i + 1) * fb));
  }
  return nFrames;
}

function numOf(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
