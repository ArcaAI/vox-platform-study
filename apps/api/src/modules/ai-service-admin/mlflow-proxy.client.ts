import { IAppSettingsService } from '@arcaai/applications';
import { HttpService } from '@nestjs/axios';
import { HttpException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { isAxiosError } from 'axios';

import { describeCauseForOperator } from '../../filters/downstream-error';

/** TASK-768 — opaque stand-ins. The cause goes to the log; the client gets these. */
const UPSTREAM_ERROR_MESSAGE = 'The MLflow tracking server returned an error.';
const TRANSPORT_ERROR_MESSAGE = 'The MLflow tracking server is temporarily unavailable. Please retry.';

/**
 * WHERE THE GATEWAY reaches MLflow. `global-kv` tier, not env: the address can
 * change without a gateway restart (an operator points the console at a
 * port-forward, then at the in-cluster Service), and the value is neither a
 * secret nor part of the bootstrap floor that gets the process to its database.
 * Written through the existing `/admin/settings` surface — no new env var, no
 * `turbo.json#globalEnv` entry, no redeploy.
 */
export const MLFLOW_BASE_URL_SETTING = 'MLFLOW_URL';

/**
 * WHERE A BROWSER reaches the MLflow UI, when such an address exists at all.
 * Deliberately a SECOND key rather than a reuse of {@link MLFLOW_BASE_URL_SETTING}:
 * the gateway's address is an in-cluster Service name that no browser can
 * resolve, and TASK-822 §9.4 shipped MLflow with NO Ingress, so on a stock
 * deployment there is no browser-reachable URL and this key is legitimately
 * absent. Absent ⇒ the console renders no deep link, rather than a dead one.
 */
export const MLFLOW_UI_URL_SETTING = 'MLFLOW_UI_URL';

/** Local-dev transport address (`infrastructure/docker/docker-compose.dev.yml`, `mlflow` profile). */
const DEFAULT_MLFLOW_URL = 'http://localhost:5000';
const DEFAULT_TIMEOUT_MS = 10_000;

export type MlflowProbeStatus = 'ok' | 'timeout' | 'error';

/** Paging/filter window forwarded verbatim to MLflow's own search verbs. */
export interface MlflowSearchWindow {
  filter?: string;
  maxResults?: number;
  pageToken?: string;
  orderBy?: string;
}

/**
 * Reachability + embeddability of the tracking server.
 *
 * `frameOptions` is READ OFF THE LIVE RESPONSE rather than assumed, because
 * MLflow's clickjacking default is a knob (`MLFLOW_SERVER_X_FRAME_OPTIONS`,
 * `SAMEORIGIN` since 3.5.0). An operator who sets it to `NONE` flips
 * `embeddable` here without any code change, and a future MLflow that changes
 * its default is observed rather than mis-reported.
 */
export class MlflowStatusResponse {
  @ApiProperty({ description: 'Address the GATEWAY calls. Never a browser address.' })
  baseUrl: string;

  @ApiPropertyOptional({ nullable: true, description: 'Browser-reachable MLflow UI, or null when none is configured (the default — MLflow ships with no Ingress).' })
  uiUrl: string | null;

  @ApiProperty() reachable: boolean;

  @ApiProperty({ enum: ['ok', 'timeout', 'error'] })
  probeStatus: MlflowProbeStatus;

  @ApiPropertyOptional() latencyMs?: number;

  @ApiPropertyOptional({ description: 'Operator-facing failure summary. Never carries the internal host:port (TASK-768).' })
  error?: string;

  @ApiPropertyOptional({ description: 'MLflow `GET /version`, when the server answered it.' })
  version?: string;

  @ApiProperty({ nullable: true, description: 'The `X-Frame-Options` header value OBSERVED on the probe, or null when the server sent none.' })
  frameOptions: string | null;

  @ApiProperty({ description: 'Whether the console may render MLflow in an iframe. False whenever the server frames-denies, or when no browser-reachable UI URL exists.' })
  embeddable: boolean;

  @ApiProperty({ nullable: true, description: 'Why framing is refused, in operator language. Null when `embeddable` is true.' })
  embedBlockedReason: string | null;
}

/**
 * MlflowProxyClient — the outbound half of the `/admin/ai-services/mlflow` READ
 * plane.
 *
 * ─── Why a server-side proxy and not an iframe ──────────────────────────────
 *
 * Three independent facts, each sufficient on its own, rule out embedding the
 * MLflow UI directly in the console:
 *
 *  1. **MLflow frame-denies by default.** From 3.5.0 its server sets
 *     `X-Frame-Options: SAMEORIGIN` on every response
 *     (`MLFLOW_SERVER_X_FRAME_OPTIONS`, default `"SAMEORIGIN"`, applied in an
 *     `after_request` hook). The deployed image is `v3.15.2-full`, so the header
 *     is on and a frame from the console's origin is blocked by the browser.
 *  2. **MLflow has no authentication of its own** (TASK-822 §9.4 —
 *     `--app-name basic-auth` is deliberately off), and the console's session is
 *     an httpOnly cookie on the CONSOLE's origin that does not extend to a
 *     different-origin frame. The ruling in §9.4c fronts MLflow with Cloudflare
 *     Access (`originRequest.access.required = true`), whose IdP redirect cannot
 *     complete inside a third-party frame.
 *  3. **There is no browser-reachable URL yet.** §9.4 shipped MLflow without an
 *     Ingress; §9.4c's tunnel route, DNS record and Access application are
 *     operator steps, not code.
 *
 * The gateway has none of those problems: it reaches the tracking server
 * in-cluster, and the console's own `manage:all` + `@ForbidApiKey` +
 * service-account scope govern who may read. So the console renders MLflow's
 * data NATIVELY and this client is how it gets it.
 *
 * ─── Read-only by construction ──────────────────────────────────────────────
 *
 * Only `httpService.axiosRef.get` is ever called. MLflow's experiment, registered-
 * model and model-version searches each register a GET endpoint, so the entire
 * surface the console needs is reachable without a single state-changing verb.
 * MLflow's own destructive verbs (delete, transition-stage, `mlflow gc`) are
 * deliberately not proxied: erasure is a PHI control (TASK-822 §5A.5/F-4/F-5)
 * and belongs to the CronJob that owns it, not to a console button.
 */
@Injectable()
export class MlflowProxyClient {
  private readonly logger = new Logger(MlflowProxyClient.name);

  constructor(
    private readonly httpService: HttpService,
    // Optional so unit fixtures compile without the global AppSettingsModule.
    @Optional() @Inject(IAppSettingsService) private readonly appSettings?: IAppSettingsService,
  ) {}

  /**
   * Reachability, version and the OBSERVED framing posture.
   *
   * Never throws: an unreachable registry is a status document, not a 503. The
   * screen's normal state on a stock deployment is "not reachable" (MLflow is
   * an opt-in compose profile locally and has no Ingress in-cluster), so a
   * failed probe must render as information rather than as a broken screen.
   */
  async status(): Promise<MlflowStatusResponse> {
    const baseUrl = this.baseUrl();
    const uiUrl = this.uiUrl();
    const startedAt = Date.now();

    try {
      // `/health` is one of MLflow's two host-validation-exempt endpoints, so it
      // answers even when `--allowed-hosts` would 403 a DNS-named client.
      const health = await this.httpService.axiosRef.get<unknown>(`${baseUrl}/health`, { timeout: DEFAULT_TIMEOUT_MS });
      const latencyMs = Date.now() - startedAt;
      const frameOptions = headerValue(health.headers, 'x-frame-options');
      const version = await this.version(baseUrl);

      return {
        baseUrl,
        uiUrl,
        reachable: true,
        probeStatus: 'ok',
        latencyMs,
        ...(version ? { version } : {}),
        ...this.describeEmbeddability(frameOptions, uiUrl),
      };
    } catch (error) {
      const probeStatus: MlflowProbeStatus = isTimeout(error) ? 'timeout' : 'error';
      this.logger.warn({ message: 'MLflow probe failed', probeStatus, ...describeCauseForOperator(error) });
      return {
        baseUrl,
        uiUrl,
        reachable: false,
        probeStatus,
        latencyMs: Date.now() - startedAt,
        // TASK-768: the cause went to the log; the client gets a capability
        // statement, never the internal address the gateway dialled.
        error: probeStatus === 'timeout' ? 'The MLflow tracking server did not answer within the probe timeout.' : TRANSPORT_ERROR_MESSAGE,
        ...this.describeEmbeddability(null, uiUrl),
      };
    }
  }

  /** `GET /api/2.0/mlflow/experiments/search`. */
  async searchExperiments(window: MlflowSearchWindow): Promise<Record<string, unknown>> {
    return this.read('/api/2.0/mlflow/experiments/search', window);
  }

  /** `GET /api/2.0/mlflow/registered-models/search`. */
  async searchRegisteredModels(window: MlflowSearchWindow): Promise<Record<string, unknown>> {
    return this.read('/api/2.0/mlflow/registered-models/search', window);
  }

  /** `GET /api/2.0/mlflow/model-versions/search`. */
  async searchModelVersions(window: MlflowSearchWindow): Promise<Record<string, unknown>> {
    return this.read('/api/2.0/mlflow/model-versions/search', window);
  }

  /**
   * Framing verdict. Two independent blockers, reported one at a time so the
   * console can tell the operator WHICH one to clear first.
   */
  private describeEmbeddability(frameOptions: string | null, uiUrl: string | null): Pick<MlflowStatusResponse, 'frameOptions' | 'embeddable' | 'embedBlockedReason'> {
    const framesDenied = frameOptions !== null && frameOptions.trim().toUpperCase() !== 'NONE';
    if (framesDenied) {
      return {
        frameOptions,
        embeddable: false,
        embedBlockedReason:
          `MLflow answers with X-Frame-Options: ${frameOptions}, so a browser refuses to render it inside the console. ` +
          'Clearing it means setting MLFLOW_SERVER_X_FRAME_OPTIONS=NONE on the MLflow deployment — an owner decision, not a console setting.',
      };
    }
    if (!uiUrl) {
      return {
        frameOptions,
        embeddable: false,
        embedBlockedReason:
          `There is no browser-reachable MLflow URL configured (${MLFLOW_UI_URL_SETTING}). MLflow ships with no Ingress, so the gateway ` +
          'reaches it in-cluster and a browser cannot. Set that setting once an authenticated public route exists.',
      };
    }
    return { frameOptions, embeddable: true, embedBlockedReason: null };
  }

  /** Best-effort `GET /version`; a server that does not answer it is still healthy. */
  private async version(baseUrl: string): Promise<string | undefined> {
    try {
      const response = await this.httpService.axiosRef.get<unknown>(`${baseUrl}/version`, { timeout: DEFAULT_TIMEOUT_MS });
      return typeof response.data === 'string' ? response.data.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private baseUrl(): string {
    const configured = this.appSettings?.getValueWithDefault<string>(MLFLOW_BASE_URL_SETTING, DEFAULT_MLFLOW_URL) ?? DEFAULT_MLFLOW_URL;
    return trimTrailingSlash(typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : DEFAULT_MLFLOW_URL);
  }

  private uiUrl(): string | null {
    const configured = this.appSettings?.getValueWithDefault<string | null>(MLFLOW_UI_URL_SETTING, null) ?? null;
    if (typeof configured !== 'string' || configured.trim().length === 0) return null;
    return trimTrailingSlash(configured.trim());
  }

  private async read(path: string, window: MlflowSearchWindow): Promise<Record<string, unknown>> {
    const params = pruneUndefined({
      filter: window.filter,
      max_results: window.maxResults,
      page_token: window.pageToken,
      order_by: window.orderBy,
    });

    try {
      const response = await this.httpService.axiosRef.get<Record<string, unknown>>(`${this.baseUrl()}${path}`, {
        timeout: DEFAULT_TIMEOUT_MS,
        params,
      });
      return response.data ?? {};
    } catch (error) {
      throw this.toHttpError(error, `GET ${path}`);
    }
  }

  /**
   * Same contract as `AiServiceProxyClient`/`HarnessOpsClient`: an upstream HTTP
   * error passes through with its own status; a transport failure becomes 503
   * with the cause in the log only.
   */
  private toHttpError(error: unknown, action: string): HttpException {
    if (isAxiosError(error) && error.response) {
      this.logger.warn({ message: 'MLflow upstream error', action, status: error.response.status });
      const body = error.response.data ?? { message: UPSTREAM_ERROR_MESSAGE };
      return new HttpException(body as string | Record<string, unknown>, error.response.status);
    }
    this.logger.error({ message: 'MLflow transport error', action, ...describeCauseForOperator(error) });
    return new ServiceUnavailableException(TRANSPORT_ERROR_MESSAGE);
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.replace(/\/+$/, '') : value;
}

/** Axios normalizes response header names to lower case; be defensive anyway. */
function headerValue(headers: unknown, name: string): string | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const record = headers as Record<string, unknown>;
  const hit = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  if (Array.isArray(hit)) return hit.length > 0 ? String(hit[0]) : null;
  return typeof hit === 'string' && hit.length > 0 ? hit : null;
}

function isTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT';
}

/** An absent window field must not become `?filter=` — MLflow parses that as an empty filter. */
function pruneUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}
