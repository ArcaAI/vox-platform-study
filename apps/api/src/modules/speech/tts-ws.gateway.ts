import {
  EffectiveTtsConfigResponse,
  IConfigService,
  IEntitlementsService,
  IProviderConnectionService,
  ITenantTtsConfigService,
  IUsageLedgerService,
  ProviderOverrides,
  SecretsService,
  UsageIdempotencyKey,
} from '@arcaai/applications';
import { AiCapability, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';
import { QuotaExceededException } from '@arcaai/exceptions';
import { Inject, Logger, Optional } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { StreamTicketService } from '../auth/stream-ticket.service';
// TASK-643 OD-4: the classifier + self-hosted allow-list used to exist as a
// verbatim copy here AND in SpeechProxyController. One definition now.
import { classifyTtsProvider } from './tts-provider-classification';

/** Shape of the `{"type":"usage",...}` control frame stream_ws.py sends at teardown. */
interface TtsUsageFrame {
  type: 'usage';
  characters: number;
  audioSeconds: number | null;
  interrupted: boolean;
  provider: string | null;
}

function isTtsUsageFrame(value: unknown): value is TtsUsageFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).type === 'usage' &&
    typeof (value as Record<string, unknown>).characters === 'number'
  );
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
  // TASK-615 WS-H — distinct from AUTH_FAILED on purpose: the ticket WAS
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
  /** Resolved tenant TTS spec injected into the init frame; null = none. */
  effectiveConfig: EffectiveTtsConfigResponse | null;
  /** Decrypted BYO provider credentials injected into the init frame; null = none. */
  providerOverrides: ProviderOverrides | null;
  /** The client's first `init` frame is enriched with the tenant config exactly once. */
  initEnriched: boolean;
  // TASK-615 WS-E: carried so the usage-frame handler can build the ledger
  // event without threading extra params through the message callback.
  sessionId: string;
  tenantId: string | null;
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
    // Resolve the ticket tenant's TTS spec and inject it into the init frame.
    @Optional() @Inject(ITenantTtsConfigService) private readonly tenantTtsConfig?: ITenantTtsConfigService,
    // BYO provider credential injection (`service='tts'`, TASK-570) — the
    // unified provider-connection plane.
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnectionService?: IProviderConnectionService,
    // TASK-615 WS-E: emits CHARACTER + AUDIO_SECOND from tts's final "usage"
    // control frame. Optional/trailing so existing positional test fixtures
    // keep compiling; absent (or no tenantId on the ticket) ⇒ no emission.
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedger?: IUsageLedgerService,
    // TASK-615 WS-H: PRE-FLIGHT monthlyTtsCharacters allowance check, before
    // the upstream tts socket ever opens. Optional/trailing so existing
    // positional test fixtures keep compiling; absent (or no tenantId on the
    // ticket) ⇒ no check.
    @Optional() @Inject(IEntitlementsService) private readonly entitlementsService?: IEntitlementsService,
  ) {}

  async handleConnection(client: WebSocket, req: IncomingMessage): Promise<void> {
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

    // TASK-615 WS-H — PRE-FLIGHT monthlyTtsCharacters check, BEFORE the
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
   * TASK-615 WS-H — quota-block close. Deliberately NOT `reject()`: the
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
    const token = this.secretsService?.getSecretSync('TTS_SERVICE_TOKEN');
    if (token) {
      headers['X-Service-Token'] = token;
    }

    // Pre-resolve the tenant's effective TTS spec (fail-open: a lookup
    // error leaves it null → tts uses its own settings). Injected into the
    // first `init` frame the browser sends.
    let effectiveConfig: EffectiveTtsConfigResponse | null = null;
    let providerOverrides: ProviderOverrides | null = null;
    if (this.tenantTtsConfig && tenantId) {
      try {
        // TASK-643 — two tiers (tenant rows over the SYSTEM-tenant platform
        // default); each entry carries the `funding` label the teardown usage
        // stamp reads back.
        const [eff, resolved] = await Promise.all([
          this.tenantTtsConfig.getEffective(tenantId),
          this.providerConnectionService
            ? this.providerConnectionService.resolveTenantCloudOverrides('tts', tenantId)
            : Promise.resolve({ overrides: {} as ProviderOverrides }),
        ]);
        effectiveConfig = eff;
        providerOverrides = resolved.overrides;
      } catch (err) {
        this.logger.warn({
          message: 'Tenant TTS config resolve failed; init frame not enriched',
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
      effectiveConfig,
      providerOverrides,
      initEnriched: false,
      sessionId,
      tenantId,
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
    // EXCEPT the final "usage" control frame (TASK-615 WS-E), which is an
    // internal signal between tts and this gateway: consumed here to emit the
    // ledger row, never forwarded (the browser client's protocol has no
    // "usage" message type).
    upstream.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary && this.maybeConsumeUsageFrame(bridge, data)) {
        return;
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
   * Enrich the browser's first `init` frame with the tenant's resolved
   * routing chains + whitelist (and default speed when omitted). Binary frames,
   * non-init frames, and everything after the first init pass through untouched.
   * Fail-open: a non-JSON frame is forwarded verbatim.
   */
  private maybeEnrichInit(bridge: Bridge, data: WebSocket.RawData, isBinary: boolean): WebSocket.RawData {
    if (isBinary || bridge.initEnriched || (!bridge.effectiveConfig && !bridge.providerOverrides)) {
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
    const eff = bridge.effectiveConfig;
    if (eff) {
      enriched.speed = parsed.speed ?? eff.defaultSpeed;
      enriched.routing_en = eff.routingEn;
      enriched.routing_ml = eff.routingMl;
      enriched.allowed_providers = eff.allowedProviders;
      // Resolved voice bindings; only injected when non-empty so
      // tts keeps its built-in DEFAULT_VOICES otherwise.
      if (eff.voiceBindings && Object.keys(eff.voiceBindings).length > 0) {
        enriched.voice_bindings = eff.voiceBindings;
      }
    }
    if (bridge.providerOverrides && Object.keys(bridge.providerOverrides).length > 0) {
      enriched.provider_overrides = bridge.providerOverrides;
    }
    // Buffer (not string) to satisfy WebSocket.RawData; isBinary stays false, so
    // ws still ships it as a TEXT frame — tts parses it as JSON init.
    return Buffer.from(JSON.stringify(enriched));
  }

  /**
   * TASK-615 WS-E: consume tts's final ``{"type":"usage",...}`` frame and
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

    if (this.usageLedger && bridge.tenantId) {
      const { deployment, costBasis } = parsed.provider
        ? classifyTtsProvider(parsed.provider, bridge.providerOverrides)
        : { deployment: AiDeploymentKind.SELF_HOSTED, costBasis: undefined };
      this.usageLedger
        .recordUsage({
          common: {
            tenantId: bridge.tenantId,
            idempotencyKey: UsageIdempotencyKey.ttsRequest(bridge.sessionId),
            occurredAt: new Date(),
            capability: AiCapability.TTS,
            operation: 'tts.synthesize',
            provider: parsed.provider ?? 'none',
            model: null,
            deployment,
            ...(costBasis ? { costBasis } : {}),
            requestId: bridge.sessionId,
            sessionId: bridge.sessionId,
            attributesJson: { interrupted: parsed.interrupted },
          },
          units: [
            { unit: AiUsageUnit.CHARACTER, quantity: parsed.characters },
            ...(parsed.audioSeconds !== null ? [{ unit: AiUsageUnit.AUDIO_SECOND, quantity: parsed.audioSeconds }] : []),
          ],
        })
        .catch((err: unknown) => {
          // Never let a metering failure disrupt the bridge — synthesis
          // already happened; this is a side effect of work already done.
          this.logger.warn({
            message: 'TTS usage emission failed',
            sessionId: bridge.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
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
