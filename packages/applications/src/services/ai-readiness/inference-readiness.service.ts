import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AiDeploymentKind, AiModelAvailability, AiModelEntity, AiModelRepository, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../common/internal-service-headers';
import { IConfigService } from '../baseServices/_meta/config';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IRedisCacheService } from '../baseServices/redis';
import { IServiceHealthMonitoringService } from '../baseServices/serviceHealth';
import { DISCOVERABLE_AI_MODEL_PROVIDERS, derivedLocalPath } from '../ai-model/constants';
import { CLOUD_BYO_PROVIDERS, ENGINE_SERVED_PROVIDERS, ProviderService, isPlatformSelfHostProvider } from '../ai-provider-connection/constants';
import { IProviderConnectionService } from '../ai-provider-connection/IProviderConnectionService';
import { ProviderConnectionProbe } from '../ai-provider-connection/provider-connection-probe';
import { IInferenceReadinessService } from './IInferenceReadinessService';
import {
  HEARTBEAT_STALE_AFTER_SECONDS,
  INFERENCE_READINESS_CLOUD_PROBE_INTERVAL_KEY,
  INFERENCE_READINESS_DEFAULTS,
  INFERENCE_READINESS_ENABLED_KEY,
  INFERENCE_READINESS_INTERVAL_KEY,
  INFERENCE_READINESS_SNAPSHOT_KEY,
  INFERENCE_READINESS_TTL_INTERVALS,
  PLATFORM_SELF_HOST_SENTINEL,
  READINESS_SERVICE_KEYS,
  STATELESS_LISTING_ENGINES,
  normalizeEngineProvider,
} from './inference-readiness.constants';
import type {
  InferenceReadinessSnapshot,
  ModelReadiness,
  ReadinessEngineEntry,
  ReadinessModelEntry,
  ReadinessProviderClass,
  ReadinessServiceEntry,
} from './inference-readiness.types';

/** TEXT's probe reply, per provider (`ai-model-discovery.service.ts` shares this shape). */
interface TextProviderEntry {
  name: string;
  /**
   * TEXT's verdict on the ENGINE (`available` / `unavailable`) — distinct from
   * `probe_status`, which only says whether the probe CALL raised inside TEXT.
   */
  status?: string;
  models?: Array<{ name: string; state?: string | null }>;
  probe_status?: string;
  probe_latency_ms?: number;
  probe_error?: string | null;
}

/** One engine address in TEXT's `POST /providers/probe` wire shape. */
interface ProbeConnectionWire {
  base_url: string;
  api_key?: string;
}

/** The last cloud-connection resolution, cached against the vendor-call budget. */
interface CloudProbeMemo {
  at: number;
  readiness: ModelReadiness;
  detail: string | null;
}

/**
 * `AiModel.servedBy` → the connection SERVICE its credential lives under.
 *
 * `servedBy` names the HOPE deployable that serves the model; a connection row
 * is keyed by the capability plane. They coincide for speech, and everything
 * text-shaped (including the models NLP, guardrail and the harness reach
 * through TEXT) resolves on the `llm` plane, which is where those credentials
 * are actually written.
 */
const SERVED_BY_TO_PROVIDER_SERVICE: Readonly<Record<string, ProviderService>> = Object.freeze({
  text: 'llm',
  nlp: 'llm',
  guardrail: 'llm',
  harness: 'llm',
  stt: 'stt',
  tts: 'tts',
});

/**
 * `AiModel.servedBy` → the `IConfigService` key holding that deployable's base
 * URL, for the runtime-resolvability probe (TASK-890 J1 MAJOR-A).
 *
 * Only the three services that serve weights out of their own caches are here.
 * A `servedBy` outside this map is never asked, and its rows fall back to the
 * bucket measurement — which is the right answer for a row nothing self-hosts.
 * Rule 05: a downstream address comes from `IConfigService`, never `process.env`.
 */
const SERVED_BY_TO_URL_KEY: Readonly<Record<string, 'STT_URL' | 'NLP_URL' | 'TTS_URL'>> = Object.freeze({
  stt: 'STT_URL',
  nlp: 'NLP_URL',
  tts: 'TTS_URL',
});

/**
 * How long the sweep waits for ONE serving service's resolvability answer.
 *
 * Per service, not per sweep: the probes run under `Promise.all`, so this bounds
 * each service's own delay and never composes. It also sits ABOVE each service's
 * own internal budget (`DEFAULT_BUDGET_SECONDS` in `hope_runtime_models`), so a
 * service under a stalled filesystem answers "not measured" for its rows instead
 * of leaving the gateway to guess from a client-side timeout.
 */
const RUNTIME_RESOLVABLE_TIMEOUT_MS = 10_000;

/**
 * Is this row served by one of HOPE's own services out of its own storage?
 *
 * Extracted so the resolvability pre-pass and `classify` cannot disagree about
 * WHICH rows are self-hosted — asking a service about a row it does not serve,
 * or failing to ask about one it does, are both silent.
 */
function isPlatformSelfHostRow(row: AiModelEntity): boolean {
  const provider = row.provider?.trim() || null;
  if (!provider) return false;
  if (ENGINE_SERVED_PROVIDERS.has(provider)) return false;
  const service = SERVED_BY_TO_PROVIDER_SERVICE[row.servedBy ?? ''] ?? 'llm';
  return provider === PLATFORM_SELF_HOST_SENTINEL || isPlatformSelfHostProvider(service, provider);
}

/**
 * InferenceReadinessService — the platform's periodic answer to "could this
 * model have served?" (TASK-890 §3.12, OD-A / OD-L).
 *
 * ─── Why a stored snapshot and not a probe per read ────────────────────────
 * The tenant model catalogue stamps a readiness state on every row. Deriving
 * that per request would put a 15-second engine probe on a tenant's read path
 * and would let any tenant drive load against the platform's engines. So the
 * PLATFORM observes on a schedule, once, and every reader gets that one
 * observation with the time it was taken. `readinessCheckedAt` is not
 * decoration: it is what makes the answer honest.
 *
 * ─── What it does NOT do ───────────────────────────────────────────────────
 *  • It never talks to an engine. TEXT stays the SINGLE probe aggregator
 *    (invariant 4): one `POST /api/v1/providers/probe` per sweep, with the
 *    addresses the connection cascade resolved. Resolving an address is not
 *    opening a connection.
 *  • It never calls a cloud VENDOR. A vendor model listing is a metered call;
 *    a cloud row's verdict comes from whether the SYSTEM connection resolves
 *    with a key, re-resolved at most once per
 *    `inference.readiness.cloudProbeIntervalSeconds`.
 *  • It never writes to the registry. Readiness is an observation, not a state
 *    transition — the same posture `AiModelDiscoveryService` takes with
 *    `registered-missing-on-server`. A transient probe miss must not disable
 *    rows.
 *  • It reads NOTHING from `process.env`. `TEXT_URL` comes from
 *    `IConfigService` (rule 05); the heartbeat service's `process.env` reads
 *    are a known divergence owned by TASK-902 and are deliberately not copied.
 *
 * ─── Failure posture ───────────────────────────────────────────────────────
 * Every failure resolves to `unknown`, never to a verdict. An unreachable
 * aggregator means nobody looked; saying `engine_down` there would report an
 * outage in the engines when the fault is in the observer.
 */
@Injectable()
export class InferenceReadinessService implements IInferenceReadinessService {
  private readonly logger = new Logger(InferenceReadinessService.name);

  /** The last observation this process produced — the fallback when Redis is absent. */
  private lastSnapshot: InferenceReadinessSnapshot | null = null;

  /** Epoch ms of the last sweep, for the interval gate. */
  private lastSweepAt = 0;

  /** `service::provider` → the last cloud-connection verdict. */
  private readonly cloudMemo = new Map<string, CloudProbeMemo>();

  constructor(
    @Inject(IConfigService) private readonly configService: IConfigService,
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    @Inject(IProviderConnectionService) private readonly providerConnections: IProviderConnectionService,
    private readonly aiModelRepository: AiModelRepository,
    private readonly httpService: HttpService,
    @Inject(IServiceHealthMonitoringService) private readonly serviceHealth: IServiceHealthMonitoringService,
    @Inject(IRedisCacheService) private readonly redisCache: IRedisCacheService,
    @Optional() private readonly secretsService?: SecretsService,
    // TASK-890 §3.7 — the ephemeral vendor probe, now that it reports
    // `discoveredModels`. `@Optional()` and TRAILING: without it the cloud
    // verdict is the credential-only one this service already produced, which
    // is a weaker answer but never a wrong one.
    @Optional() private readonly connectionProbe?: ProviderConnectionProbe,
  ) {}

  // ── Schedule ─────────────────────────────────────────────────────────────

  /**
   * The heartbeat cadence, gated by settings.
   *
   * The tick is fixed at 30s (the `ServiceHealthMonitoringService` precedent)
   * and `inference.readiness.intervalSeconds` THINS it, rather than the
   * schedule being rewritten on every settings change: a cron that reschedules
   * itself has a window where it runs at neither rate.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async scheduledSweep(): Promise<void> {
    if (!this.config().enabled) return;
    if (Date.now() - this.lastSweepAt < this.config().intervalSeconds * 1000) return;

    try {
      await this.sweep();
    } catch (error) {
      // A sweep failure is an observability gap, never an outage: the previous
      // snapshot stands until it expires, and readers fall back to `unknown`.
      this.logger.warn({
        message: 'Inference-readiness sweep failed; the previous snapshot stands',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private config(): { enabled: boolean; intervalSeconds: number; cloudProbeIntervalSeconds: number } {
    return {
      enabled: this.appSettingsService.getValueWithDefault<boolean>(INFERENCE_READINESS_ENABLED_KEY, INFERENCE_READINESS_DEFAULTS.enabled),
      intervalSeconds: this.appSettingsService.getValueWithDefault<number>(
        INFERENCE_READINESS_INTERVAL_KEY,
        INFERENCE_READINESS_DEFAULTS.intervalSeconds,
      ),
      cloudProbeIntervalSeconds: this.appSettingsService.getValueWithDefault<number>(
        INFERENCE_READINESS_CLOUD_PROBE_INTERVAL_KEY,
        INFERENCE_READINESS_DEFAULTS.cloudProbeIntervalSeconds,
      ),
    };
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  async getSnapshot(): Promise<InferenceReadinessSnapshot | null> {
    if (this.redisCache.isConnected()) {
      try {
        const raw = await this.redisCache.get(INFERENCE_READINESS_SNAPSHOT_KEY);
        if (raw) return JSON.parse(raw) as InferenceReadinessSnapshot;
      } catch (error) {
        this.logger.warn({
          message: 'Readiness snapshot read failed; serving the in-process observation',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.lastSnapshot;
  }

  // ── Sweep ────────────────────────────────────────────────────────────────

  async sweep(): Promise<InferenceReadinessSnapshot> {
    this.lastSweepAt = Date.now();
    const checkedAt = new Date();

    const connections = await this.resolveEngineConnections();
    const live = await this.probeText(connections);
    const services = await this.readHeartbeats(checkedAt);
    const rows = await this.readSystemCatalogue();

    const engines = this.buildEngines(connections, live);
    const engineByProvider = new Map(engines.map((engine) => [engine.provider, engine]));
    const listingByProvider = new Map(live.map((entry) => [normalizeEngineProvider(entry.name), entry.models ?? []]));
    const serviceByKey = new Map(services.map((entry) => [entry.key, entry]));
    const runtime = await this.readRuntimeResolvable(rows);

    const models: Record<string, ReadinessModelEntry> = {};
    for (const row of rows) {
      models[row.id] = await this.classify(row, engineByProvider, listingByProvider, serviceByKey, runtime);
    }

    const snapshot: InferenceReadinessSnapshot = { checkedAt: checkedAt.toISOString(), engines, services, models };
    this.lastSnapshot = snapshot;
    await this.store(snapshot);

    this.logger.debug({
      message: 'Inference-readiness sweep completed',
      engines: engines.length,
      services: services.length,
      models: Object.keys(models).length,
    });

    return snapshot;
  }

  /**
   * WHICH ENGINE each provider means for the PLATFORM.
   *
   * The tenant argument is SYSTEM, passed EXPLICITLY: a cron has no tenant of
   * its own, and `resolveConnection` deliberately refuses to infer one (a
   * tenant-less resolve could only mean "read SYSTEM unconditionally", which is
   * the widen-without-absence bug the two-tier rule exists to prevent).
   *
   * Mirrors `AiModelDiscoveryService.resolveEngineConnections` and fails open
   * the same way: a resolver error sends no address for that provider and TEXT
   * probes its own service default, rather than the sweep dying.
   */
  private async resolveEngineConnections(): Promise<Record<string, ProbeConnectionWire>> {
    const connections: Record<string, ProbeConnectionWire> = {};

    let overrides: Record<string, { api_key: string; base_url?: string }> = {};
    try {
      overrides = (await this.providerConnections.resolveTenantCloudOverrides('llm', SYSTEM_TENANT_ID)).overrides as never;
    } catch (error) {
      this.logger.warn({
        message: 'Engine-connection resolution failed; the sweep probes the service defaults (fail-open)',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    for (const provider of DISCOVERABLE_AI_MODEL_PROVIDERS) {
      const keyed = overrides[provider];
      if (keyed?.base_url) {
        connections[provider] = { base_url: keyed.base_url, api_key: keyed.api_key };
        continue;
      }
      // No injectable credential: either no row, or the KEYLESS row that is the
      // normal shape for a self-hosted engine. Ask the cascade for the address
      // alone — there is nothing to decrypt.
      const row = await this.providerConnections.resolveConnection('llm', provider, SYSTEM_TENANT_ID).catch((error) => {
        this.logger.warn({
          message: 'Engine-connection resolution failed for one provider',
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      if (row?.baseUrl) connections[provider] = { base_url: row.baseUrl };
    }

    return connections;
  }

  /** ONE call to TEXT's aggregator; never throws — an unreachable TEXT is a result. */
  private async probeText(connections: Record<string, ProbeConnectionWire>): Promise<TextProviderEntry[]> {
    const base = this.configService.getConfigValue('TEXT_URL');
    const serviceToken = await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN');
    const headers = internalServiceHeaders({
      serviceToken,
      // A platform-wide sweep genuinely has no tenant, and says so rather than
      // omitting the header (which would be indistinguishable from one dropped
      // in transit).
      tenantId: null,
      tenantlessReason: TENANTLESS.PLATFORM_OPERATOR,
    });

    try {
      const response = await this.httpService.axiosRef.post(`${base}/api/v1/providers/probe`, { connections }, { headers, timeout: 15_000 });
      return (response.data ?? []) as TextProviderEntry[];
    } catch (error) {
      this.logger.warn({
        message: 'Readiness probe failed; every engine is UNKNOWN for this sweep',
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * ASK each serving service whether it can load its own rows' weights, without
   * fetching anything (TASK-890 J1 MAJOR-A).
   *
   * `GET|POST /api/v1/internal/models/resolvable` on `apps/{stt,nlp,tts}` reads
   * that process's caches and answers per row. ONE batch call per service, so a
   * catalogue of any size costs at most three requests per sweep.
   *
   * Failure posture, matching the rest of this file: an absent address, an
   * unreachable service or a malformed reply yields NO entry for those rows,
   * and an absent entry is `unknown` — never a verdict. One service's failure
   * cannot change another's rows, because each is asked independently.
   *
   * It resolves the address through `IConfigService` (rule 05) and sends the
   * platform-operator internal headers, the same way `probeText` does.
   */
  private async readRuntimeResolvable(rows: AiModelEntity[]): Promise<Map<string, boolean>> {
    const byService = new Map<string, AiModelEntity[]>();
    for (const row of rows) {
      if (!isPlatformSelfHostRow(row)) continue;
      const servedBy = row.servedBy ?? '';
      if (!(servedBy in SERVED_BY_TO_URL_KEY)) continue;
      const bucket = byService.get(servedBy);
      if (bucket) bucket.push(row);
      else byService.set(servedBy, [row]);
    }
    if (byService.size === 0) return new Map();

    const serviceToken = await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN');
    const headers = internalServiceHeaders({
      serviceToken,
      tenantId: null,
      tenantlessReason: TENANTLESS.PLATFORM_OPERATOR,
    });

    const verdicts = new Map<string, boolean>();
    await Promise.all(
      [...byService].map(async ([servedBy, serviceRows]) => {
        const base = this.configService.getConfigValue(SERVED_BY_TO_URL_KEY[servedBy]!);
        if (!base) {
          // No declared address is not a failure to report — it is a service
          // this deployment does not run. Its rows stay unmeasured.
          this.logger.debug({ message: 'No address for a serving service; its rows stay unknown', servedBy });
          return;
        }
        const body = {
          models: serviceRows.map((row) => ({
            id: row.id,
            sourceUri: row.sourceUri ?? null,
            library: row.libraryName ?? null,
            revision: row.sourceRevision ?? null,
            // A bucket-staged (`source = LOCAL`) row has no fetchable `sourceUri` —
            // its weights are already under the serving pod's `/mnt/models-bucket`
            // s3fs mount, and `localPath` is the ONLY field that says where. Omit it
            // and the service is asked about an `s3://…` URI it cannot resolve, so it
            // answers `not_cached` and a perfectly loadable row reports
            // `weights_missing` — which then fails the `MODEL_UNAVAILABLE` publish
            // gate. `ResolvableItem.localPath` has always been part of the wire
            // contract on the service side; the gateway simply never sent it.
            localPath: derivedLocalPath(row),
          })),
        };
        // Per SERVICE, not per sweep: each probe carries its own budget and its
        // own elapsed time, and `Promise.all` runs them side by side, so one
        // slow service delays neither its peers nor the rest of the document.
        // The elapsed time is logged either way — TASK-890 F3 spent its first
        // hour unable to tell a service that answered slowly from one that
        // never answered, because only the failure was timed.
        const startedAt = Date.now();
        try {
          const response = await this.httpService.axiosRef.post(`${base}/api/v1/internal/models/resolvable`, body, {
            headers,
            timeout: RUNTIME_RESOLVABLE_TIMEOUT_MS,
          });
          const results = (response.data?.results ?? []) as Array<{ id?: string; resolvable?: unknown }>;
          for (const result of results) {
            // Only a literal `true`/`false` counts. An absent or non-boolean
            // field — `null` is what a service sends for a row its own budget
            // could not measure — is an unmeasured row, not a negative one.
            if (typeof result?.id === 'string' && typeof result.resolvable === 'boolean') verdicts.set(result.id, result.resolvable);
          }
          this.logger.debug({
            message: 'Runtime resolvability probe answered',
            servedBy,
            asked: serviceRows.length,
            measured: results.filter((result) => typeof result?.resolvable === 'boolean').length,
            elapsedMs: Date.now() - startedAt,
          });
        } catch (error) {
          this.logger.warn({
            message: 'Runtime resolvability probe failed; those rows stay unknown for this sweep',
            servedBy,
            asked: serviceRows.length,
            elapsedMs: Date.now() - startedAt,
            timeoutMs: RUNTIME_RESOLVABLE_TIMEOUT_MS,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    return verdicts;
  }

  /**
   * The six heartbeats, through the monitoring service that owns them rather
   * than a second raw read of its Redis keys.
   */
  private async readHeartbeats(checkedAt: Date): Promise<ReadinessServiceEntry[]> {
    let uptime: Record<string, { status?: string; lastCheck?: string }> = {};
    try {
      uptime = (await this.serviceHealth.getUptime()).services as never;
    } catch (error) {
      this.logger.warn({
        message: 'Heartbeat read failed; every service is reported unseen for this sweep',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return READINESS_SERVICE_KEYS.map((key) => {
      const entry = uptime[key];
      const lastSeenAt = entry?.lastCheck ?? null;
      const ageMs = lastSeenAt ? checkedAt.getTime() - new Date(lastSeenAt).getTime() : Number.POSITIVE_INFINITY;
      // A heartbeat that says `up` but was written ten minutes ago is not
      // evidence the service is up now — the cron itself may have stopped.
      const healthy = entry?.status === 'healthy' && ageMs <= HEARTBEAT_STALE_AFTER_SECONDS * 1000;
      return { key, healthy, lastSeenAt };
    });
  }

  /** The SYSTEM catalogue — ENABLED and DISABLED rows, as the admin surface shows them. */
  private async readSystemCatalogue(): Promise<AiModelEntity[]> {
    return this.aiModelRepository.findAll({
      filters: {
        tenantId: SYSTEM_TENANT_ID,
        resourceStatus: { in: [ResourceStatusType.ENABLED, ResourceStatusType.DISABLED] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the repository filter type is narrower than the Prisma `where` it forwards
      } as any,
      sort: [{ name: 'asc' }],
    });
  }

  private buildEngines(connections: Record<string, ProbeConnectionWire>, live: TextProviderEntry[]): ReadinessEngineEntry[] {
    const liveByProvider = new Map(live.map((entry) => [normalizeEngineProvider(entry.name), entry]));

    return DISCOVERABLE_AI_MODEL_PROVIDERS.map((provider) => {
      const entry = liveByProvider.get(provider);
      const models = entry?.models ?? [];
      const probeStatus = entry?.probe_status;
      // TWO facts, both required. `probe_status` says whether the probe CALL
      // raised inside TEXT; `status` says whether the ENGINE answered. Every
      // adapter swallows a connection error into `status: "unavailable"` with
      // `probe_status: "ok"`, so reading the latter alone reported an engine
      // that does not even resolve as "Up · 0 ms" on `/ai-services`.
      const answered = entry?.status === undefined || entry.status === 'available';
      const status: ReadinessEngineEntry['status'] = probeStatus === undefined ? 'unknown' : probeStatus !== 'ok' ? 'down' : answered ? 'up' : 'down';

      return {
        provider,
        providerClass: 'engine-served' as ReadinessProviderClass,
        baseUrlHost: hostOf(connections[provider]?.base_url),
        status,
        latencyMs: typeof entry?.probe_latency_ms === 'number' ? entry.probe_latency_ms : null,
        loadedCount: models.filter((model) => model.state === 'loaded').length,
        listedCount: models.length,
        detail:
          entry?.probe_error ??
          (status === 'unknown' ? 'not probed this sweep' : status === 'down' && answered === false ? 'the engine did not answer the probe' : null),
      };
    });
  }

  // ── Classification ───────────────────────────────────────────────────────

  private async classify(
    row: AiModelEntity,
    engines: Map<string, ReadinessEngineEntry>,
    listings: Map<string, Array<{ name: string; state?: string | null }>>,
    services: Map<string, ReadinessServiceEntry>,
    runtime: Map<string, boolean>,
  ): Promise<ReadinessModelEntry> {
    const provider = row.provider?.trim() || null;
    const base = { id: row.id, slug: row.slug, taskType: String(row.taskType), provider };
    const service = SERVED_BY_TO_PROVIDER_SERVICE[row.servedBy ?? ''] ?? 'llm';

    if (provider && ENGINE_SERVED_PROVIDERS.has(provider)) {
      const engine = normalizeEngineProvider(provider);
      return { ...base, providerClass: 'engine-served', ...this.engineReadiness(row, engine, engines, listings) };
    }

    if (isPlatformSelfHostRow(row)) {
      return { ...base, providerClass: 'platform-self-host', ...this.selfHostReadiness(row, services, runtime) };
    }

    if (provider && (row.deploymentKind === AiDeploymentKind.CLOUD || CLOUD_BYO_PROVIDERS[service]?.includes(provider))) {
      return { ...base, providerClass: 'cloud-platform', ...(await this.cloudReadiness(service, provider)) };
    }

    // A row with no provider, or one outside the known vocabulary: nothing can
    // be said about it, and inventing a verdict would hide the real defect
    // (a registry row nothing can route).
    return { ...base, providerClass: null, readiness: 'unknown', detail: provider ? 'provider not recognised' : 'row has no provider' };
  }

  private engineReadiness(
    row: AiModelEntity,
    engine: string,
    engines: Map<string, ReadinessEngineEntry>,
    listings: Map<string, Array<{ name: string; state?: string | null }>>,
  ): { readiness: ModelReadiness; detail: string | null } {
    const state = engines.get(engine);
    if (!state || state.status === 'unknown') return { readiness: 'unknown', detail: 'engine not probed this sweep' };
    // A CURATED phrase, never `state.detail`. That field carries TEXT's raw
    // `probe_error` (`str(exc)` over a bare `except`), which for an httpx
    // failure renders as `... for url 'http://<engine-host>:<port>/v1/models'`.
    // The engine ENTRY keeps it — that document is super-admin-only — but a
    // MODEL entry's detail is stamped onto the tenant-facing catalogue
    // (`readinessDetail`), and platform topology is not a tenant's business.
    // It is also the one free-form string in this file; every sibling verdict
    // below is a fixed phrase, which is what makes it safe to project.
    if (state.status === 'down') return { readiness: 'engine_down', detail: 'the serving engine did not answer the last probe' };

    // The engine names a model by its wire id; the registry row carries that as
    // `sourceUri` (the slug is the fallback the discovery merge already uses).
    const listed = (listings.get(engine) ?? []).find((model) => model.name === row.sourceUri || model.name === row.slug);
    if (!listed) return { readiness: 'weights_missing', detail: 'the engine does not list this model' };

    if (listed.state === 'loaded') return { readiness: 'ready', detail: null };
    if (listed.state === 'not-loaded') return { readiness: 'loadable', detail: 'listed, not resident — the first call pays a load' };
    // vLLM and llama.cpp report no per-model state: they serve what they list.
    if (STATELESS_LISTING_ENGINES.has(engine)) return { readiness: 'ready', detail: null };
    return { readiness: 'loadable', detail: 'listed; the engine reported no load state' };
  }

  private selfHostReadiness(
    row: AiModelEntity,
    services: Map<string, ReadinessServiceEntry>,
    runtime: Map<string, boolean>,
  ): { readiness: ModelReadiness; detail: string | null } {
    const servedByName = row.servedBy ?? null;

    // ── The RUNTIME path wins, because it is the one that actually serves ──
    //
    // TASK-890 J1 MAJOR-A. This method used to read `availability` alone — a
    // measurement of the `hope-models` MinIO bucket, stamped MISSING on every
    // row with a NULL `bucketPrefix`. But `apps/stt` resolves `source_uri` into
    // the HuggingFace cache and `apps/nlp` does the same through `HF_HOME`;
    // neither reads that bucket for these rows. So the platform reported 21 of
    // 33 catalogue rows unusable with the weights on the serving host's disk.
    //
    // The serving process is now asked directly, and its YES is decisive: it is
    // the only party that can answer "could I load this without fetching?".
    const runtimeAnswer = runtime.get(row.id);
    if (runtimeAnswer === true) {
      return { readiness: 'ready', detail: servedByName ? `the ${servedByName} service can load these weights locally` : null };
    }

    const availability = row.availability;
    // NOT_APPLICABLE = the library ships its weights inside the Python package,
    // so there is nothing in the bucket to find and nothing to fetch.
    const bucketHasIt = availability === AiModelAvailability.AVAILABLE || availability === AiModelAvailability.NOT_APPLICABLE;

    // A runtime NO is only a verdict when the bucket has nothing either. A
    // bucket-AVAILABLE row the service has not fetched yet is still servable —
    // the first load pays a download — so downgrading it here would trade one
    // wrong answer for another.
    if (runtimeAnswer === false && !bucketHasIt) {
      return {
        readiness: 'weights_missing',
        detail: servedByName
          ? `the ${servedByName} service cannot resolve these weights locally, and the bucket has none`
          : 'the weights are nowhere',
      };
    }

    if (availability === AiModelAvailability.MISSING || availability === AiModelAvailability.PARTIAL) {
      // No runtime answer (service down, no address, or not asked) and an empty
      // bucket. Saying `weights_missing` here would claim more than was
      // measured, so it stays `unknown` — nobody who could answer was asked.
      if (runtimeAnswer === undefined && servedByName) {
        return { readiness: 'unknown', detail: `the bucket has no artifact and the ${servedByName} service did not answer this sweep` };
      }
      return { readiness: 'weights_missing', detail: `bucket inventory measured ${String(availability).toLowerCase()}` };
    }
    if (availability === AiModelAvailability.UNKNOWN || availability === null || availability === undefined) {
      return { readiness: 'unknown', detail: 'the bucket inventory has not measured this row' };
    }

    const servedBy = row.servedBy ?? null;
    const service = servedBy ? services.get(servedBy) : undefined;
    if (!service) return { readiness: 'unknown', detail: servedBy ? `no heartbeat for '${servedBy}'` : 'row names no serving service' };
    if (!service.healthy) return { readiness: 'engine_down', detail: `the ${servedBy} service heartbeat is not healthy` };

    // AVAILABLE, or NOT_APPLICABLE for a library whose weights ship inside the
    // Python package — in both cases there is nothing left to fetch.
    return {
      readiness: 'ready',
      detail: availability === AiModelAvailability.NOT_APPLICABLE ? 'served from the package; no bucket artifact required' : null,
    };
  }

  /**
   * A SYSTEM cloud row: does the platform hold a usable credential for it?
   *
   * NOT a vendor call. Listing a vendor's models is metered, so the verdict is
   * the CASCADE's answer — resolved, keyed, vetoed or absent — memoised for
   * `cloudProbeIntervalSeconds` because each resolve is a Vault decrypt.
   */
  private async cloudReadiness(service: ProviderService, provider: string): Promise<{ readiness: ModelReadiness; detail: string | null }> {
    const key = `${service}::${provider}`;
    const memo = this.cloudMemo.get(key);
    if (memo && Date.now() - memo.at < this.config().cloudProbeIntervalSeconds * 1000) {
      return { readiness: memo.readiness, detail: memo.detail };
    }

    let verdict: { readiness: ModelReadiness; detail: string | null };
    try {
      const row = await this.providerConnections.resolveConnection(service, provider, SYSTEM_TENANT_ID);
      if (!row) {
        verdict = { readiness: 'credential_missing', detail: 'no enabled platform connection for this provider' };
      } else if (!row.encryptedApiKey) {
        // "Resolves but never delivers": an enabled row with no key injects on
        // neither tier, so it is a setup that looks complete and serves nothing.
        verdict = { readiness: 'credential_missing', detail: 'the platform connection has no credential' };
      } else {
        verdict = await this.probedCloudVerdict(service, provider);
      }
    } catch (error) {
      verdict = { readiness: 'unknown', detail: 'the connection could not be resolved this sweep' };
      this.logger.warn({
        message: 'Cloud-connection resolution failed during the readiness sweep',
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.cloudMemo.set(key, { at: Date.now(), ...verdict });
    return verdict;
  }

  /**
   * Ask the vendor, when there is something to ask with (TASK-890 §3.7).
   *
   * Reached only for a connection that already RESOLVED WITH A KEY, so the
   * question is no longer "is one configured" but "does the vendor accept it" —
   * which is the case the credential-only verdict used to call `ready` and hide.
   * Memoised by the caller for `cloudProbeIntervalSeconds`, so a fleet of cloud
   * rows costs at most one vendor call per provider per interval.
   *
   * A failed REACHABILITY probe is `unknown`, not `engine_down`: a cloud row has
   * no engine of ours to be down, and an endpoint that did not answer says
   * nothing about the credential. Any error from the probe itself falls back to
   * the credential-only verdict rather than downgrading a working provider on a
   * fault of our own.
   */
  private async probedCloudVerdict(service: ProviderService, provider: string): Promise<{ readiness: ModelReadiness; detail: string | null }> {
    const credentialOnly = { readiness: 'ready' as ModelReadiness, detail: 'platform credential present (not vendor-probed)' };
    if (!this.connectionProbe) return credentialOnly;
    try {
      const outcome = await this.connectionProbe.test(service, provider, SYSTEM_TENANT_ID, {});
      if (outcome.ok) {
        const listed = outcome.discoveredModels?.length;
        return { readiness: 'ready', detail: listed ? `vendor answered; ${listed} model(s) listed` : 'vendor answered' };
      }
      // An AUTH probe that failed is the vendor refusing THIS key — actionable,
      // and the one verdict the old credential-only answer got wrong.
      if (outcome.probe === 'auth') return { readiness: 'credential_missing', detail: outcome.message };
      return { readiness: 'unknown', detail: outcome.message };
    } catch (error) {
      this.logger.warn({
        message: 'Vendor probe failed during the readiness sweep; falling back to the credential-only verdict',
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return credentialOnly;
    }
  }

  // ── Store ────────────────────────────────────────────────────────────────

  private async store(snapshot: InferenceReadinessSnapshot): Promise<void> {
    if (!this.redisCache.isConnected()) {
      // The heartbeat precedent: an absent Redis skips the WRITE, not the work.
      this.logger.debug({ message: 'Readiness snapshot not stored', reason: 'redis_unavailable' });
      return;
    }
    const ttl = Math.max(1, Math.round(this.config().intervalSeconds * INFERENCE_READINESS_TTL_INTERVALS));
    try {
      await this.redisCache.setex(INFERENCE_READINESS_SNAPSHOT_KEY, ttl, JSON.stringify(snapshot));
    } catch (error) {
      this.logger.warn({
        message: 'Readiness snapshot store failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Host only — an endpoint is operational information; a full URL can carry more. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
