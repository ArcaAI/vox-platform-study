import {
  AiModelService,
  CreateModelRequest,
  DISCOVERABLE_AI_MODEL_PROVIDERS,
  IConfigService,
  IProviderConnectionService,
  RegisterDiscoveredModelRequest,
  SecretsService,
  TENANTLESS,
  internalServiceHeaders,
  resolveInternalAccessToken,
} from '@arcaai/applications';
import { AiModelFormat, AiModelSource, ModelCategory, ModelTaskType, ModelType } from '@arcaai/domains';
import { HttpService } from '@nestjs/axios';
import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';

/** Providers whose models live on a server we can enumerate. */
const SERVER_MANAGED_PROVIDERS: readonly string[] = DISCOVERABLE_AI_MODEL_PROVIDERS;

/**
 * Artifact format a discovered model is recorded with. Ollama / LM Studio /
 * llama.cpp all serve GGUF weights; vLLM serves safetensors. Informational
 * only — nothing routes on it — but a discovered row should not lie.
 */
const PROVIDER_FORMAT: Record<string, AiModelFormat> = {
  ollama: AiModelFormat.GGUF,
  'lm-studio': AiModelFormat.GGUF,
  'llama-cpp': AiModelFormat.GGUF,
  vllm: AiModelFormat.SAFETENSOR,
};

const MAX_SLUG_LENGTH = 100;

/**
 * Deterministic `modelName` → slug normalization.
 *
 * Server-side model names routinely violate the slug grammar
 * (`llama3.1:8b-instruct-q4_K_M`, `org/repo-GGUF`). Lowercase, collapse every
 * non-alphanumeric run to a single hyphen, trim the edges, cap at 100 chars.
 * There is deliberately NO collision suffixing — a taken slug surfaces as an
 * actionable 400 so the admin names the governance row on purpose.
 */
export function normalizeModelSlug(modelName: string): string {
  const slug = modelName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
  return slug.replace(/-+$/, '');
}

export type DiscoveryEntryStatus = 'registered' | 'discovered' | 'registered-missing-on-server';
export type DiscoveryLoadState = 'loaded' | 'not-loaded' | 'unknown';
export type DiscoveryProbeStatus = 'ok' | 'timeout' | 'error' | 'skipped';
export type DiscoveryConnectionSource = 'tenant' | 'system';

/**
 * One engine to enumerate, in TEXT's `POST /providers/probe` wire shape.
 * `api_key` is ABSENT for a keyless self-hosted row, which is the normal shape —
 * see `resolveEngineConnections` below.
 */
interface ProbeConnectionWire {
  base_url: string;
  api_key?: string;
}

export class DiscoveryRegisteredModel {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() resourceStatus: string;
}

export class DiscoveryEntry {
  @ApiProperty({ description: 'TEXT provider registry key, e.g. `lm-studio`.' })
  provider: string;

  @ApiProperty({ description: 'Model name exactly as the engine (or the registry row) names it.' })
  modelName: string;

  @ApiProperty({ enum: ['registered', 'discovered', 'registered-missing-on-server'] })
  status: DiscoveryEntryStatus;

  @ApiProperty({ enum: ['loaded', 'not-loaded', 'unknown'] })
  loadState: DiscoveryLoadState;

  @ApiPropertyOptional({ type: DiscoveryRegisteredModel })
  registeredModel?: DiscoveryRegisteredModel;

  @ApiPropertyOptional({ description: 'Engine-native metadata (quantization, max context length, …).' })
  engineMeta?: Record<string, unknown>;
}

export class DiscoveryProbe {
  @ApiProperty() provider: string;
  @ApiProperty({ enum: ['ok', 'timeout', 'error', 'skipped'] }) probeStatus: DiscoveryProbeStatus;
  @ApiPropertyOptional() latencyMs?: number;
  @ApiPropertyOptional() error?: string;

  @ApiPropertyOptional({
    enum: ['tenant', 'system'],
    description:
      "Which tier of the connection cascade supplied the engine that was probed — the caller's own row, or the " +
      'SYSTEM-tenant platform default. Absent when no connection resolved, in which case TEXT probed whatever ' +
      'endpoint it last served a generation from. DERIVED from the resolved row, never stamped by the call site.',
  })
  connectionSource?: DiscoveryConnectionSource;
}

export class DiscoveryResponse {
  @ApiProperty({ type: [DiscoveryEntry] }) entries: DiscoveryEntry[];
  @ApiProperty({ type: [DiscoveryProbe] }) probes: DiscoveryProbe[];
  @ApiProperty({ description: 'ISO timestamp the probe completed — feeds the console staleness indicator.' })
  probedAt: string;
}

/** The subset of TEXT's `ProviderInfo` this merge consumes. */
interface TextProviderEntry {
  name: string;
  models?: Array<{ name: string; state?: string | null; engine_native?: Record<string, unknown> | null }>;
  probe_status?: string;
  probe_latency_ms?: number;
  probe_error?: string | null;
}

/**
 * Merges the DB `AiModel` registry with the LIVE engine listing TEXT
 * aggregates, and turns one discovered entry into a governed row.
 *
 * Deliberate posture:
 * - TEXT is the SINGLE probe aggregator; the gateway never talks to an engine
 *   directly. It now RESOLVES which engine each provider means for the calling
 *   tenant (tenant → SYSTEM, through the one `AiProviderConnection` cascade) and
 *   hands that address down to TEXT — exactly as `/generate` hands down
 *   `provider_overrides`. Resolving an address is not opening a connection: TEXT
 *   is still the only process that speaks to an engine.
 * - Discovery NEVER mutates the registry. `registered-missing-on-server` is a
 *   warning tag, not a state transition — a transient probe miss must not
 *   disable rows, and a server-side experiment must not enter governance
 *   silently. The only `discovered` → `registered` path is `register()`.
 * - Register DELEGATES to `AiModelService.create`, inheriting the factory,
 *   the `broadcastSysEvent(ResourceCreated)` and the slug-collision behavior.
 */
@Injectable()
export class AiModelDiscoveryService {
  private readonly logger = new Logger(AiModelDiscoveryService.name);

  constructor(
    private readonly httpService: HttpService,
    @Inject(IConfigService) private readonly configService: IConfigService,
    private readonly aiModelService: AiModelService,
    @Optional() private readonly secretsService?: SecretsService,
    @Optional() private readonly clsService?: ClsService,
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnections?: IProviderConnectionService,
  ) {}

  async discover(provider?: string): Promise<DiscoveryResponse> {
    const wanted = (key: string) => SERVER_MANAGED_PROVIDERS.includes(key) && (!provider || key === provider);
    const wantedProviders = SERVER_MANAGED_PROVIDERS.filter(wanted);

    const { connections, sources } = await this.resolveEngineConnections(wantedProviders);
    const [live, probes] = await this.probeText(connections, sources);
    const rows = await this.aiModelService.getAllForAdmin();

    const liveByProvider = new Map(live.filter((p) => wanted(p.name)).map((p) => [p.name, p]));
    const probeByProvider = new Map(probes.map((p) => [p.provider, p]));

    const entries: DiscoveryEntry[] = [];
    const claimed = new Set<string>();

    // 1. Registry rows first — a registered row wins its live counterpart.
    for (const row of rows) {
      const key = row.provider?.trim();
      if (!key || !wanted(key)) continue;

      const liveProvider = liveByProvider.get(key);
      // A provider whose probe did not succeed is UNKNOWN, never "missing": no
      // false alarms from a hung or restarting engine.
      const probeOk = (probeByProvider.get(key)?.probeStatus ?? 'error') === 'ok';
      const match = liveProvider?.models?.find((m) => m.name === row.sourceUri || m.name === row.slug);

      if (match) claimed.add(`${key}\0${match.name}`);

      entries.push({
        provider: key,
        modelName: match?.name ?? row.sourceUri ?? row.slug,
        status: match ? 'registered' : probeOk ? 'registered-missing-on-server' : 'registered',
        loadState: match ? normalizeLoadState(match.state) : 'unknown',
        registeredModel: { id: row.id, slug: row.slug, resourceStatus: String(row.resourceStatus) },
        ...(match?.engine_native ? { engineMeta: match.engine_native } : {}),
      });
    }

    // 2. Everything the engines reported that no registry row claimed.
    for (const [key, entry] of liveByProvider) {
      for (const model of entry.models ?? []) {
        if (claimed.has(`${key}\0${model.name}`)) continue;
        entries.push({
          provider: key,
          modelName: model.name,
          status: 'discovered',
          loadState: normalizeLoadState(model.state),
          ...(model.engine_native ? { engineMeta: model.engine_native } : {}),
        });
      }
    }

    return {
      entries,
      probes: provider ? probes.filter((p) => p.provider === provider) : probes,
      probedAt: new Date().toISOString(),
    };
  }

  /**
   * @deprecated TASK-860 — removed in R3. The controller refuses the route with
   * 410; this method is retained only until the removal release. It also
   * hard-codes `category: NLP` / `taskType: TEXT_GENERATION` for every engine
   * row — the catalogue is the registration surface now.
   */
  async register(dto: RegisterDiscoveredModelRequest) {
    const slug = dto.slug ?? normalizeModelSlug(dto.modelName);
    if (!slug) {
      throw new BadRequestException(`Cannot derive a slug from model name '${dto.modelName}' — supply an explicit \`slug\`.`);
    }

    const request: CreateModelRequest = {
      name: dto.name ?? dto.modelName,
      slug,
      description: dto.description,
      category: ModelCategory.NLP,
      taskType: ModelTaskType.TEXT_GENERATION,
      modelType: ModelType.BASE_MODEL,
      // The weights are resident on the engine host; the gateway never fetches
      // them or orchestrates downloads from this route.
      source: AiModelSource.LOCAL,
      sourceUri: dto.modelName,
      format: PROVIDER_FORMAT[dto.provider] ?? AiModelFormat.GGUF,
      provider: dto.provider,
    } as CreateModelRequest;

    try {
      return await this.aiModelService.create(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/already exists/i.test(message)) {
        // Deliberately no silent suffixing — tell the admin which slug
        // is taken and that an explicit one is now required.
        throw new BadRequestException(`The slug '${slug}' is already taken. Re-run register with an explicit \`slug\` for '${dto.modelName}'.`);
      }
      throw err;
    }
  }

  /**
   * WHICH ENGINE each provider means FOR THIS CALLER — the caller's own row, or
   * the SYSTEM-tenant platform default, resolved by the ONE cascade.
   *
   * Before this, discovery had no tenant in it at all: TEXT probed
   * `_last_base_url`, the endpoint its process last served a generation from, so
   * a tenant running its own LM Studio or Ollama was shown the PLATFORM's models
   * and could register a governance row for a model its own engine does not
   * serve.
   *
   * The cascade is NOT reimplemented here. Both calls land in
   * `AiProviderConnectionService.cascadeRows`, so there stays exactly one
   * precedence rule, one veto set and one entitlement gate in the codebase — and
   * `source`/`funding` is DERIVED from the row that answered, never stamped:
   *
   * - `resolveTenantCloudOverrides` supplies KEYED rows, decrypted, with the
   *   funding label. It is the same resolver `/generate` uses, so a discovery
   *   probe can never reach an engine a generation could not.
   * - `resolveConnection` covers the KEYLESS row. A keyless row deliberately
   *   injects on NEITHER tier — that guard is what stops a `baseUrl` being
   *   mistaken for a credential — but a keyless self-hosted engine is the NORMAL
   *   shape and must still be enumerable, unauthenticated. Only its endpoint is
   *   read; nothing is decrypted, because there is nothing to decrypt.
   *
   * FAIL OPEN, like `applyTenantProviderOverrides`: a resolver failure sends no
   * connection and the probe degrades to TEXT's own memo, rather than taking the
   * admin listing down. A broken config read must not look like a dead engine.
   */
  private async resolveEngineConnections(
    wantedProviders: readonly string[],
  ): Promise<{ connections: Record<string, ProbeConnectionWire>; sources: Record<string, DiscoveryConnectionSource> }> {
    const empty = { connections: {}, sources: {} };
    const tenantId = this.clsService?.get('tenantId');
    if (!this.providerConnections || !tenantId || wantedProviders.length === 0) return empty;

    // TEXT is the LLM capability, so the service discriminator is always `llm`.
    let overrides: Record<string, { api_key: string; base_url?: string; funding: 'tenant' | 'platform' }>;
    try {
      overrides = (await this.providerConnections.resolveTenantCloudOverrides('llm', tenantId)).overrides as never;
    } catch (error) {
      // Non-secret log only — the resolver logs its own per-credential failures.
      this.logger.warn({
        message: 'Engine-connection resolution failed; discovery probes the service default (fail-open)',
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }

    const connections: Record<string, ProbeConnectionWire> = {};
    const sources: Record<string, DiscoveryConnectionSource> = {};

    for (const key of wantedProviders) {
      const entry = overrides[key];
      if (entry?.base_url) {
        connections[key] = { base_url: entry.base_url, api_key: entry.api_key };
        sources[key] = entry.funding === 'platform' ? 'system' : 'tenant';
        continue;
      }
      // No injectable credential for this provider. Either there is no row at
      // all, or the row is keyless — ask the cascade for the ENDPOINT alone.
      const row = await this.providerConnections.resolveConnection('llm', key, tenantId).catch((error) => {
        this.logger.warn({
          message: 'Engine-connection resolution failed for one provider; it probes the service default (fail-open)',
          provider: key,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      if (!row?.baseUrl) continue;
      connections[key] = { base_url: row.baseUrl };
      sources[key] = row.source;
    }

    return { connections, sources };
  }

  /**
   * One call to TEXT's aggregator; never throws — an unreachable TEXT is a probe
   * result.
   *
   * The AGGREGATOR POSTURE IS UNCHANGED and is the reason this posts an address
   * rather than opening a socket: TEXT is still the only process that holds an
   * engine connection, and the gateway still never speaks to an engine. What
   * moved is only WHICH engine TEXT is told to describe. `POST` rather than the
   * former `GET` because the body can carry a keyed self-hosted engine's
   * credential, which must never travel in a URL or query string.
   *
   * `X-Tenant-Id` is MANDATORY here: it was omitted UNCONDITIONALLY,
   * so TEXT's own `ServiceAuthMiddleware` 428'd every probe (`/api/v1/providers/probe`
   * is not in TEXT's `EXEMPT_PATHS`) — and the catch below turned that 428 into a
   * false "Unreachable" for every engine, even ones never actually contacted. A
   * SUPER_ADMIN driving this listing with no working tenant selected genuinely has
   * no tenant; that case DECLARES itself with the `tenantless:platform-operator`
   * marker rather than sending nothing.
   *
   * D-D: the token is the ONE shared `INTERNAL_ACCESS_TOKEN`; `TEXT_SERVICE_TOKEN`
   * is consulted only as the migration fallback (TEXT no longer accepts it alone).
   */
  private async probeText(
    connections: Record<string, ProbeConnectionWire>,
    sources: Record<string, DiscoveryConnectionSource>,
  ): Promise<[TextProviderEntry[], DiscoveryProbe[]]> {
    const base = this.configService.getConfigValue('TEXT_URL');
    const serviceToken = await resolveInternalAccessToken(this.secretsService, 'TEXT_SERVICE_TOKEN');
    const headers = internalServiceHeaders({
      serviceToken,
      tenantId: this.clsService?.get('tenantId'),
      tenantlessReason: TENANTLESS.PLATFORM_OPERATOR,
    });

    try {
      const response = await this.httpService.axiosRef.post(`${base}/api/v1/providers/probe`, { connections }, { headers, timeout: 15_000 });
      const live = (response.data ?? []) as TextProviderEntry[];
      return [
        live,
        live.map((p) => ({
          provider: p.name,
          probeStatus: normalizeProbeStatus(p.probe_status),
          ...(typeof p.probe_latency_ms === 'number' ? { latencyMs: p.probe_latency_ms } : {}),
          ...(p.probe_error ? { error: p.probe_error } : {}),
          ...(sources[p.name] ? { connectionSource: sources[p.name] } : {}),
        })),
      ];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ message: 'TEXT provider probe failed; discovery degrades to registry-only', error: message });
      // Every server-managed provider is UNKNOWN rather than missing.
      return [[], SERVER_MANAGED_PROVIDERS.map((provider) => ({ provider, probeStatus: 'error' as const, error: message }))];
    }
  }
}

function normalizeLoadState(state: string | null | undefined): DiscoveryLoadState {
  return state === 'loaded' || state === 'not-loaded' ? state : 'unknown';
}

function normalizeProbeStatus(status: string | undefined): DiscoveryProbeStatus {
  return status === 'ok' || status === 'timeout' || status === 'error' || status === 'skipped' ? status : 'ok';
}
