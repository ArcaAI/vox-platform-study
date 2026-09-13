import {
  IConfigService,
  IEntitlementsService,
  IOriginRegistry,
  IUsageLedgerService,
  ProviderOverrides,
  SecretsService,
  TtsAgentResolverService,
  UsageIdempotencyKey,
  appendComputeAndByteUnits,
} from '@arcaai/applications';
import type { ResolvedTtsSpec, UsageEventBatchInput } from '@arcaai/applications';
import { AiCapability, AiUsageUnit } from '@arcaai/domains';
import { QuotaExceededException } from '@arcaai/exceptions';
import { Inject, Logger, Optional } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { isOriginEnforcementEnabled } from '../../cors.config';
import { StreamTicketService } from '../auth/stream-ticket.service';
// The classifier + self-hosted allow-list used to exist as a
// verbatim copy here AND in SpeechProxyController. One definition now.
import { recordUsageEmissionFailure } from '../../observability/usage-emission-metric';
import { classifyTtsProvider, isAttributableTtsProvider } from './tts-provider-classification';
import { resolveTtsRequestConfig } from './tts-tenant-config';

/** Shape of the `{"type":"usage",...}` control frame stream_ws.py sends at teardown. */
interface TtsUsageFrame {
  type: 'usage';
  characters: number;
  audioSeconds: number | null;
  interrupted: boolean;
  provider: string | null;
  /**
   * TASK-958 D-7 — the `AiProviderConnection` the winning candidate authenticated as.
   * OPTIONAL: an `apps/tts` that predates the field sends none, and the ledger row is
   * then unattributed rather than attributed to a guess.
   */
  connectionId?: string | null;
}

function isTtsUsageFrame(value: unknown): value is TtsUsageFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  // TASK-958 F10 — `connectionId` is written to the ledger, so it is TYPE-CHECKED here
  // rather than trusted: absent is the ordinary answer from a service that predates the
  // field, and anything that is not a string is a malformed frame, not an attribution.
  const connectionId = frame.connectionId;
  if (connectionId !== undefined && connectionId !== null && typeof connectionId !== 'string') return false;
  return frame.type === 'usage' && typeof frame.characters === 'number';
}

/**
 * WS-duplex TTS gateway. Bridges a browser WebSocket to the tts
 * streaming endpoint so a summary can be spoken while it is still generating.
 *
 * Posture mirrors `SttWsGateway`: the handshake is gated by a
 * single-use stream ticket (never a JWT in the URL), and EVERY rejection closes
 * with the same generic `4401` so a prober cannot enumerate sessions / tickets /
 * scopes — the real cause goes to the warn log only.
 *
 * Unlike STT there is no server-side session resource to own, so there is no
 * tenant-binding cross-check: the ticket is minted bound to the caller's active
 * tenant (`POST /auth/stream-ticket`, scope `tts_session:<sessionId>`) and
 * single-use consumption at handshake is the authorization. The gateway relays
 * frames verbatim (binary PCM passthrough — never re-encoded/compressed) and
 * injects `X-Service-Token` on the upstream hop only.
 */
export const TTS_WS_CLOSE_CODES = {
  AUTH_FAILED: 4401,
  UPSTREAM_ERROR: 1011,
  // Distinct from AUTH_FAILED on purpose: the ticket WAS
  // valid and the tenant IS identified here, so there is no enumeration
  // concern to hide behind a generic reason (unlike the handshake-failure
  // codes above). Private-use range (RFC 6455 4000-4999), loosely mirroring
  // HTTP 429.
  QUOTA_EXCEEDED: 4429,
} as const;

export const TTS_WS_GENERIC_AUTH_REASON = 'Authentication failed';

const TTS_SESSION_SCOPE_PREFIX = 'tts_session:';

/**
 * WS egress backpressure threshold. When the browser socket's `bufferedAmount`
 * exceeds this many bytes the upstream (tts) socket is paused until it drains,
 * so a slow consumer can't make the gateway buffer audio without bound. Default
 * 512 KiB; overridable via `TTS_WS_EGRESS_HIGH_WATERMARK_BYTES`.
 */
export const TTS_WS_EGRESS_HIGH_WATERMARK_BYTES = (() => {
  const raw = Number(process.env.TTS_WS_EGRESS_HIGH_WATERMARK_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 512 * 1024;
})();

const BACKPRESSURE_POLL_MS = 50;

interface Bridge {
  client: WebSocket;
  upstream: WebSocket;
  /** Client→upstream control frames received before the upstream socket opened. */
  pending: Array<{ data: WebSocket.RawData; isBinary: boolean }>;
  upstreamOpen: boolean;
  backpressureTimer?: ReturnType<typeof setInterval>;
  /** The resolved TEXT_TO_SPEECH agent injected into the init frame; null = none resolved. */
  spec: ResolvedTtsSpec | null;
  /** Decrypted BYO provider credentials injected into the init frame; null = none. */
  providerOverrides: ProviderOverrides | null;
  /** The client's first `init` frame is enriched with the tenant config exactly once. */
  initEnriched: boolean;
  // Carried so the usage-frame handler can build the ledger
  // event without threading extra params through the message callback.
  sessionId: string;
  tenantId: string | null;
  /**
   * TASK-959 §4.2 — bytes of upstream BINARY audio relayed to the browser so far. `stream_ws.py`'s
   * own `"usage"` control frame carries no device, timing, or byte count of its own (unlike the
   * REST `/audio/speech` headers) — this is the only observation this bridge can make, and it is
   * an APPLICATION-level proxy for what the client received, never the wire.
   */
  relayedBytes: number;
  /**
   * TASK-959 §3.2 — wall-clock start, set at the FIRST relayed binary frame. `stream_ws.py`
   * reports no device/timing of its own, but the compute RULE lives in `appendComputeAndByteUnits`
   * — this gateway still owes it a `totalMs` so a non-SELF_HOSTED (cloud/BYOK) session bills the
   * platform's own calling CPU exactly like the REST readers do.
   */
  firstAudioAtMs: number | null;
}

/** Byte length of a relayed WS frame, across every shape `ws` may hand back a binary message in. */
function relayedByteLength(data: WebSocket.RawData): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((sum, buf) => sum + buf.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return 0;
}

@WebSocketGateway({ path: '/ws/tts/stream' })
export class TtsWsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TtsWsGateway.name);
  private readonly bridges = new Map<WebSocket, Bridge>();

  /**
   * Factory for the upstream tts socket. Overridable in tests to inject a
   * fake without a live server.
   */
  createUpstreamSocket: (url: string, headers: Record<string, string>) => WebSocket = (url, headers) => new WebSocket(url, { headers });

  constructor(
    private readonly streamTicketService: StreamTicketService,
    @Inject(IConfigService) private readonly configService: IConfigService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Resolve the ticket tenant's TEXT_TO_SPEECH agent and inject the resolved spec into the
    // init frame.
    @Optional() private readonly ttsAgentResolver?: TtsAgentResolverService,
    // Emits CHARACTER + AUDIO_SECOND from tts's final "usage"
    // control frame. Optional/trailing so existing positional test fixtures
    // keep compiling; absent (or no tenantId on the ticket) ⇒ no emission.
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedger?: IUsageLedgerService,
    // PRE-FLIGHT monthlyTtsCharacters allowance check, before
    // the upstream tts socket ever opens. Optional/trailing so existing
    // positional test fixtures keep compiling; absent (or no tenantId on the
    // ticket) ⇒ no check.
    @Optional() @Inject(IEntitlementsService) private readonly entitlementsService?: IEntitlementsService,
    // CSWSH guard: registry-backed allow-list for the `Origin`
    // header, the same reverse index `cors.config.ts` consults. Optional and
    // TRAILING so existing positional test fixtures keep compiling; see
    // `isOriginAllowed` for the fail-CLOSED posture when it is absent.
    @Optional() @Inject(IOriginRegistry) private readonly originRegistry?: IOriginRegistry,
  ) {}

  /**
   * Registry lookup backing the CSWSH guard. Ported from
   * `SttWsGateway.isOriginAllowed` with identical semantics and the
   * identical, greppable log reasons — one operator vocabulary across all
   * three enforcement surfaces (HTTP CORS, STT WS, TTS WS).
   *
   * Fails CLOSED on an unavailable registry (absent / empty / throwing) under
   * the systemic `origin_registry_unavailable` reason, kept distinct from the
   * ordinary per-origin `origin_registry_miss` a populated registry's "no"
   * produces. A registry that is PRESENT but EMPTY (`size() === 0` — unseeded
   * table, every row deleted) "has nothing to say" and therefore denies
   * exactly as `has()` would for every origin; it only logs under the systemic
   * reason instead.
   *
   * THE ARGUMENT FOR ALIGNING THIS WITH THE HTTP CORS PATH is a property of
   * WEBSOCKETS, not of STT: browsers exempt the WS handshake from CORS
   * entirely, so nothing upstream has checked `Origin` by the time this
   * gateway runs — this is the one surface `cors.config.ts` cannot cover. (The
   * STT gateway's own comments argue for alignment with the HTTP path; they
   * never mention TTS. The reasoning transfers verbatim, but it is made here
   * for the first time.) `credentials: false` on the CORS side means a
   * cross-origin socket carries no ambient credentials to ride, so this is a
   * defence-in-depth layer rather than the tenant-isolation control — that
   * remains the single-use ticket consumed below.
   *
   * The enforcement switch is READ from `cors.config.ts` rather than resolved
   * here, so this gate can never disagree with the HTTP gate about whether
   * enforcement is on. While it is off, every origin is admitted and the
   * registry is never consulted.
   *
   * Runs only in `handleConnection`, on the initial handshake — established
   * sockets are never re-checked.
   */
  private isOriginAllowed(origin: string): boolean {
    if (!isOriginEnforcementEnabled()) {
      return true;
    }

    if (!this.originRegistry) {
      this.logger.warn({
        message: 'TTS WS handshake — origin registry unavailable, denying (no bootstrap fallback, aligned with the HTTP CORS path)',
        origin,
        reason: 'origin_registry_unavailable',
      });
      return false;
    }
    try {
      if (this.originRegistry.size() === 0) {
        this.logger.warn({
          message: 'TTS WS handshake — origin registry empty, denying (no bootstrap fallback, aligned with the HTTP CORS path)',
          origin,
          reason: 'origin_registry_unavailable',
        });
        return false;
      }
      const registered = this.originRegistry.has(origin);
      if (!registered) {
        this.logger.warn({
          message: 'TTS WS handshake — origin not registered',
          origin,
          reason: 'origin_registry_miss',
        });
      }
      return registered;
    } catch (err) {
      this.logger.warn({
        message: 'TTS WS handshake — origin registry lookup failed, denying (no bootstrap fallback, aligned with the HTTP CORS path)',
        origin,
        reason: 'origin_registry_unavailable',
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async handleConnection(client: WebSocket, req: IncomingMessage): Promise<void> {
    // CSWSH guard, FIRST, before sessionId/ticket parsing, so a
    // hostile origin never burns a ticket and never reaches the quota
    // pre-flight. Mirrors the CORS callback's pre-auth position.
    //
    // No `Origin` header → ALLOW. A missing header means a non-browser caller
    // (server-to-server, CLI); CSWSH is specifically an attack that rides a
    // VICTIM BROWSER's auto-attached `Origin`, so a request without one cannot
    // be that attack. This mirrors the HTTP CORS posture, which also lets
    // no-Origin through.
    const origin = req.headers?.origin;
    if (typeof origin === 'string' && origin.length > 0 && !this.isOriginAllowed(origin)) {
      // Through the ordinary `reject` helper so the close code and reason stay
      // the gateway's single generic 4401 — byte-identical to the
      // missing-ticket and scope-mismatch rejections (no enumeration signal),
      // and never the quota 4429.
      return this.reject(client, 'unregistered origin');
    }

    const url = new URL(req.url || '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    const ticket = url.searchParams.get('ticket');

    if (!sessionId) {
      return this.reject(client, 'missing sessionId');
    }
    if (!ticket) {
      return this.reject(client, 'missing ticket', sessionId);
    }

    const stored = await this.streamTicketService.consumeTicket(ticket);
    if (!stored) {
      return this.reject(client, 'invalid stream ticket', sessionId);
    }

    const expectedScope = `${TTS_SESSION_SCOPE_PREFIX}${sessionId}`;
    if (stored.scope !== expectedScope) {
      return this.reject(client, 'ticket scope mismatch', sessionId);
    }

    // PRE-FLIGHT monthlyTtsCharacters check, BEFORE the
    // upstream tts socket opens (before any synthesis can start). A WS
    // session streams text incrementally with no fixed total known upfront
    // (unlike the REST `synthesize` endpoint), so this uses `increment: 0` —
    // "is the tenant ALREADY over its allowance" — rather than predicting an
    // unbounded session's eventual character count. A block gets its own
    // close code (never the generic AUTH_FAILED): the ticket was valid and
    // the tenant is identified, so there is no enumeration concern to hide
    // behind a uniform reason here.
    if (this.entitlementsService && stored.tenantId) {
      try {
        await this.entitlementsService.assertMeterQuota(stored.tenantId, 'monthlyTtsCharacters', 0);
      } catch (err) {
        if (err instanceof QuotaExceededException) {
          return this.rejectQuota(client, sessionId);
        }
        throw err;
      }
    }

    await this.openBridge(client, sessionId, stored.tenantId);
  }

  handleDisconnect(client: WebSocket): void {
    this.teardown(client);
  }

  /** Uniform generic close (no enumeration signal); real cause to the warn log. */
  private reject(client: WebSocket, reason: string, sessionId?: string): void {
    this.logger.warn({ message: 'TTS WS handshake rejected', reason, ...(sessionId ? { sessionId } : {}) });
    try {
      client.close(TTS_WS_CLOSE_CODES.AUTH_FAILED, TTS_WS_GENERIC_AUTH_REASON);
    } catch {
      /* socket may already be closing */
    }
  }

  /**
   * Quota-block close. Deliberately NOT `reject`: the
   * ticket was valid and the tenant is already identified, so this is not an
   * auth failure and there is nothing to hide behind a generic reason.
   */
  private rejectQuota(client: WebSocket, sessionId: string): void {
    this.logger.warn({ message: 'TTS WS rejected — monthly character allowance exhausted', sessionId });
    try {
      client.close(TTS_WS_CLOSE_CODES.QUOTA_EXCEEDED, 'Quota exceeded');
    } catch {
      /* socket may already be closing */
    }
  }

  private async openBridge(client: WebSocket, sessionId: string, tenantId: string | null): Promise<void> {
    const headers: Record<string, string> = {};
    // The ONE shared `INTERNAL_ACCESS_TOKEN` (the `TTS_SERVICE_TOKEN` fallback was retired with its descriptor, TASK-879/880).
    const token = this.secretsService?.getSecretSync('INTERNAL_ACCESS_TOKEN') || '';
    if (token) {
      headers['X-Service-Token'] = token;
    }

    // Pre-resolve the tenant's TEXT_TO_SPEECH agent, injected into the first `init` frame the
    // browser sends.
    //
    // A resolve failure leaves BOTH null and the socket still opens. That is not the fail-open
    // the `TenantTtsConfig` fold had — `apps/tts` refuses an init frame with no spec, so the
    // session ends in a `provider_unavailable` error frame, which a browser client can render.
    // The alternative, refusing the handshake, would report an agent-configuration problem as an
    // authentication failure (this gateway's rejections are deliberately indistinguishable, so
    // the cause would be invisible to the operator AND to the user).
    let spec: ResolvedTtsSpec | null = null;
    let providerOverrides: ProviderOverrides | null = null;
    if (this.ttsAgentResolver && tenantId) {
      try {
        const resolved = await resolveTtsRequestConfig(tenantId, { ttsAgentResolver: this.ttsAgentResolver });
        spec = resolved.spec;
        providerOverrides = resolved.overrides;
      } catch (err) {
        this.logger.warn({
          message: 'Tenant TTS agent resolve failed; the session will end in a provider-unavailable frame',
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let upstream: WebSocket;
    try {
      upstream = this.createUpstreamSocket(this.ttsWsUrl(), headers);
    } catch (err) {
      this.logger.error({
        message: 'Failed to open upstream TTS socket',
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.reject(client, 'upstream unavailable', sessionId);
      return;
    }

    const bridge: Bridge = {
      client,
      upstream,
      pending: [],
      upstreamOpen: false,
      spec,
      providerOverrides,
      initEnriched: false,
      sessionId,
      tenantId,
      relayedBytes: 0,
      firstAudioAtMs: null,
    };
    this.bridges.set(client, bridge);

    upstream.on('open', () => {
      bridge.upstreamOpen = true;
      for (const frame of bridge.pending) {
        this.safeSend(upstream, frame.data, frame.isBinary);
      }
      bridge.pending = [];
    });

    // Upstream → browser: verbatim relay (binary PCM frames + JSON control),
    // with egress backpressure onto the upstream when the browser saturates —
    // EXCEPT the final "usage" control frame, which is an
    // internal signal between tts and this gateway: consumed here to emit the
    // ledger row, never forwarded (the browser client's protocol has no
    // "usage" message type).
    upstream.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary && this.maybeConsumeUsageFrame(bridge, data)) {
        return;
      }
      // TASK-959 §3.2/§4.2 — every binary frame relayed IS the audio the client receives;
      // accumulate bytes and set the wall-clock start here, since `stream_ws.py`'s usage frame
      // reports neither a byte count nor a timing of its own.
      if (isBinary) {
        if (bridge.firstAudioAtMs === null) bridge.firstAudioAtMs = Date.now();
        bridge.relayedBytes += relayedByteLength(data);
      }
      this.safeSend(client, data, isBinary);
      this.applyBackpressure(bridge);
    });
    upstream.on('close', () => this.closeClientAndTeardown(client));
    upstream.on('error', (err: Error) => {
      this.logger.warn({ message: 'Upstream TTS socket error', sessionId, error: err.message });
      this.closeClientAndTeardown(client, TTS_WS_CLOSE_CODES.UPSTREAM_ERROR);
    });

    // Browser → upstream: control frames (init/text/flush/end). Buffered until
    // the upstream socket is open (the client sends init immediately on connect).
    client.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      const frame = this.maybeEnrichInit(bridge, data, isBinary);
      if (bridge.upstreamOpen) {
        this.safeSend(upstream, frame, isBinary);
      } else {
        bridge.pending.push({ data: frame, isBinary });
      }
    });

    this.logger.log({ message: 'TTS WS bridge opened', sessionId });
  }

  /** Pause the upstream while the browser socket is over the egress watermark. */
  private applyBackpressure(bridge: Bridge): void {
    const buffered = (bridge.client as { bufferedAmount?: number }).bufferedAmount ?? 0;
    if (buffered <= TTS_WS_EGRESS_HIGH_WATERMARK_BYTES || bridge.backpressureTimer) {
      return;
    }
    bridge.upstream.pause?.();
    const timer = setInterval(() => {
      const bufferedNow = (bridge.client as { bufferedAmount?: number }).bufferedAmount ?? 0;
      if (bufferedNow <= TTS_WS_EGRESS_HIGH_WATERMARK_BYTES) {
        bridge.upstream.resume?.();
        clearInterval(timer);
        bridge.backpressureTimer = undefined;
      }
    }, BACKPRESSURE_POLL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    bridge.backpressureTimer = timer;
  }

  /**
   * Enrich the browser's first `init` frame with the tenant's resolved TEXT_TO_SPEECH agent.
   *
   * Binary frames, non-init frames, and everything after the first init pass through untouched;
   * a non-JSON frame is forwarded verbatim. What the enrichment carries changed with TASK-879:
   * `routing_en` / `routing_ml` / `allowed_providers` / `voice_bindings` were the `TenantTtsConfig`
   * fold and are gone, replaced by the resolved spec — which names the engine chain, the model,
   * its voices and the connection that serves each engine.
   */
  private maybeEnrichInit(bridge: Bridge, data: WebSocket.RawData, isBinary: boolean): WebSocket.RawData {
    if (isBinary || bridge.initEnriched || (!bridge.spec && !bridge.providerOverrides)) {
      return data;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return data;
    }
    if (!parsed || parsed.type !== 'init') {
      return data;
    }
    bridge.initEnriched = true;
    const enriched: Record<string, unknown> = { ...parsed };
    const spec = bridge.spec;
    if (spec) {
      // The agent's own speed is the default; a client that named one keeps it.
      enriched.speed = parsed.speed ?? spec.primary.parameters.speed ?? undefined;
      enriched.resolved_spec = spec;
    }
    if (bridge.providerOverrides && Object.keys(bridge.providerOverrides).length > 0) {
      enriched.provider_overrides = bridge.providerOverrides;
    }
    // Buffer (not string) to satisfy WebSocket.RawData; isBinary stays false, so
    // ws still ships it as a TEXT frame — tts parses it as JSON init.
    return Buffer.from(JSON.stringify(enriched));
  }

  /**
   * Consume tts's final ``{"type":"usage",...}`` frame and
   * emit CHARACTER + AUDIO_SECOND ledger rows. Fail-open throughout — a
   * malformed frame, a missing ledger, or a missing tenantId all just mean
   * "no emission", never a thrown error into the relay path.
   *
   * @returns true when `data` WAS a usage frame (whether or not emission
   *          happened) — the caller uses this to skip the client relay.
   */
  private maybeConsumeUsageFrame(bridge: Bridge, data: WebSocket.RawData): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return false;
    }
    if (!isTtsUsageFrame(parsed)) {
      return false;
    }

    // TASK-957 F-10 — no provider, no row. See `isAttributableTtsProvider`. Checked BEFORE the
    // ledger/tenant guard so the counter fires for the case it is about, and OUTSIDE the row
    // building entirely: this `return true` still consumes the frame, which is TTS's own control
    // framing and must never reach the client whether or not it produced a ledger row.
    if (!isAttributableTtsProvider(parsed.provider)) {
      recordUsageEmissionFailure('tts.synthesize', 'unattributable');
      this.logger.warn({
        message: 'TTS session reported no provider; recording no usage row for it',
        sessionId: bridge.sessionId,
      });
      return true;
    }

    if (this.usageLedger && bridge.tenantId) {
      // TASK-958 F9 — the served connection selects the override entry; the map is keyed
      // by connection key, and a sibling's entry is not under `provider`.
      const connectionId = parsed.connectionId || null;
      const { deployment, costBasis } = classifyTtsProvider(parsed.provider, bridge.providerOverrides, connectionId);
      const batch: UsageEventBatchInput = {
        common: {
          tenantId: bridge.tenantId,
          idempotencyKey: UsageIdempotencyKey.ttsRequest(bridge.sessionId),
          occurredAt: new Date(),
          capability: AiCapability.TTS,
          operation: 'tts.synthesize',
          provider: parsed.provider,
          model: null,
          deployment,
          ...(costBasis ? { costBasis } : {}),
          connectionId,
          requestId: bridge.sessionId,
          sessionId: bridge.sessionId,
          attributesJson: { interrupted: parsed.interrupted },
        },
        units: [
          { unit: AiUsageUnit.CHARACTER, quantity: parsed.characters },
          ...(parsed.audioSeconds !== null ? [{ unit: AiUsageUnit.AUDIO_SECOND, quantity: parsed.audioSeconds }] : []),
        ],
      };

      const onUsageError = (err: unknown): void => {
        // Never let a metering failure disrupt the bridge — synthesis
        // already happened; this is a side effect of work already done.
        this.logger.warn({
          message: 'TTS usage emission failed',
          sessionId: bridge.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      };

      // TASK-959 §3.2/§4.2 — `stream_ws.py`'s `"usage"` frame carries no device, synthesis
      // timing, or byte count of its own (confirmed against the Python source: `_SessionUsage`
      // tracks only characters/audio_bytes/provider/connection_id), so this bridge never has a
      // device to report and `device: null` always. `totalMs` (this bridge's own wall-clock,
      // first relayed audio frame → teardown) is still passed ALWAYS — the compute RULE is
      // `appendComputeAndByteUnits`'s: a non-SELF_HOSTED (cloud/BYOK) session still bills the
      // platform's calling CPU on that wall-clock; only a SELF_HOSTED session (no device
      // resolved) gets no compute row. The relayed byte count stands in as an application-level
      // proxy for what the client received.
      const wallClockMs = bridge.firstAudioAtMs !== null ? Date.now() - bridge.firstAudioAtMs : null;
      const { batch: augmented, platformBatch } = appendComputeAndByteUnits(batch, {
        device: null,
        totalMs: wallClockMs,
        responseBytes: bridge.relayedBytes > 0 ? bridge.relayedBytes : null,
        byteSource: bridge.relayedBytes > 0 ? 'app' : null,
      });
      this.usageLedger.recordUsage(augmented).catch(onUsageError);
      if (platformBatch) {
        this.usageLedger.recordUsage(platformBatch).catch(onUsageError);
      }
    }
    return true;
  }

  private safeSend(socket: WebSocket, data: WebSocket.RawData, isBinary: boolean): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(data, { binary: isBinary });
    }
  }

  private closeClientAndTeardown(client: WebSocket, code?: number): void {
    if (client.readyState === client.OPEN) {
      try {
        client.close(code);
      } catch {
        /* already closing */
      }
    }
    this.teardown(client);
  }

  private teardown(client: WebSocket): void {
    const bridge = this.bridges.get(client);
    if (!bridge) {
      return;
    }
    this.bridges.delete(client);
    if (bridge.backpressureTimer) {
      clearInterval(bridge.backpressureTimer);
      bridge.backpressureTimer = undefined;
    }
    if (bridge.upstream.readyState === bridge.upstream.OPEN || bridge.upstream.readyState === bridge.upstream.CONNECTING) {
      try {
        bridge.upstream.close();
      } catch {
        /* already closing */
      }
    }
  }

  /** TTS_URL (http[s]://host:port) → ws[s]://host:port/api/v1/audio/stream. */
  private ttsWsUrl(): string {
    const base = this.configService.getConfigValue('TTS_URL').replace(/\/+$/, '');
    return `${base.replace(/^http/, 'ws')}/api/v1/audio/stream`;
  }
}
