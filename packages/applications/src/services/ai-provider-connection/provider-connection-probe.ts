import { BadRequestException, ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { AiProviderConnectionEntity, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { SecretsService } from '../baseServices/_meta/secrets/SecretsService';
import { decryptSecretField } from '../baseServices/_meta/secrets/secret-field.util';
import { AiProviderConnectionService } from './ai-provider-connection.service';
import { CONNECTION_ERROR_CODES, ProviderService, isKnownProviderId } from './constants';
import { TestProviderConnectionRequest, TestProviderConnectionResponse } from './dto';

/** Probe timeout — generous enough for a slow link, short enough for a synchronous admin click. */
export const TEST_CONNECTION_TIMEOUT_MS = 5_000;

/** Loopback / RFC1918 / link-local hostnames a tenant-supplied probe target may not resolve to literally. */
const PRIVATE_HOST_PATTERN = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0$|\[?::1]?$|localhost$)/i;

/** The fully-resolved inputs one probe runs against. */
interface ProbeTarget {
  apiKey: string | null;
  baseUrl: string | null;
  region: string | null;
  apiVersion: string | null;
  deploymentName: string | null;
  /**
   * TASK-958 — the VENDOR this probe talks to. In precedence order: the STORED
   * row (authoritative and immutable), the body's own `provider` (the create
   * dialog, before any row exists), or the path segment when that segment IS a
   * provider id (every pre-958 call). There is no fourth fallback: a connection
   * slug that names no vendor and has no row is a 400, not a probe of a vendor
   * nobody serves. See `resolveProbeVendor`.
   */
  provider: string;
  source: TestProviderConnectionResponse['source'];
}

type ProbeOutcome = Omit<TestProviderConnectionResponse, 'source'>;

/**
 * TASK-890 §3.7 — the vendor's own model list, kept instead of discarded.
 *
 * Every listing this probe already performs answers in the OpenAI shape
 * (`{ data: [{ id }] }`): Azure's deployment listing, OpenAI `/models` and
 * Anthropic `/v1/models` all do. Returns `undefined` — never `[]` — when the
 * body is not that shape, so an absent list is distinguishable from an empty
 * one and the response shape stays four fields for every other provider.
 */
function discoveredIdsOf(body: unknown): string[] | undefined {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  const ids = data.map((entry) => (entry as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/** Read a fetch response as JSON without assuming the double is a full `Response`. */
async function readJson(response: { json?: () => Promise<unknown> }): Promise<unknown> {
  if (typeof response.json !== 'function') return null;
  return response.json().catch(() => null);
}

/**
 * TASK-862 — the ephemeral "Test connection" probe behind
 * `POST admin/providers/:service/:provider/test`, generalised from the former
 * `admin/stt-config/credentials/:provider/test` (the only test route that
 * existed) to EVERY `(service, provider)`.
 *
 * Contract:
 *   - NEVER persists anything, never writes Vault, never logs the key.
 *   - A field the body omits is taken from the STORED row — the caller's own
 *     row, else the SYSTEM row (the same two tiers as resolution; a SYSTEM row
 *     is only read for a tenant when the tenant has no row). A stored key is
 *     decrypted for the probe and discarded.
 *   - A real AUTH probe where the vendor exposes an auth-only call (OpenAI
 *     `/models`, Anthropic `/v1/models`, Azure OpenAI deployment listing,
 *     classic Azure Speech STS token issuance, Qdrant `/collections`,
 *     HuggingFace `whoami`); a REACHABILITY smoke test where it does not
 *     (Sarvam, Azure Foundry, self-host engines with no auth) — the response
 *     says which, so the console never over-claims.
 *   - SSRF guard on every tenant-supplied URL: https only, no loopback /
 *     private / link-local literal host. Self-host engines (`lm-studio`,
 *     `vllm`, `llama-cpp`, `ollama`, `built-in`) are SYSTEM-only rows whose
 *     endpoints ARE in-cluster, so the guard is relaxed to "valid http(s)
 *     URL" for the SYSTEM tenant only.
 *
 * OD-1 note: a metadata probe from the gateway does not move INFERENCE into
 * NestJS — the vendor's inference calls stay in the Python services with
 * gateway-resolved credentials. This is the same class of call as the former
 * STT test route.
 */
@Injectable()
export class ProviderConnectionProbe {
  constructor(
    private readonly connections: AiProviderConnectionService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {}

  async test(service: ProviderService, slug: string, tenantId: string, dto: TestProviderConnectionRequest): Promise<TestProviderConnectionResponse> {
    this.connections.assertResolvable(service, slug, tenantId);

    // TASK-958 — the path segment is the connection SLUG, and which probe to run
    // is a property of the VENDOR. `resolveProbeVendor` (below) is the single
    // place that decides it: the stored row, else the body's `provider`, else
    // the slug when the slug IS a provider id — and a named 400 when none of
    // the three answers, rather than a probe of a vendor nobody serves.
    const target = await this.resolveTarget(service, slug, tenantId, dto);
    const provider = target.provider;
    const outcome = await this.run(service, provider, tenantId, target);
    return { ...outcome, source: target.source };
  }

  // ───────────────────────────── target resolution ─────────────────────────────

  private async resolveTarget(service: ProviderService, slug: string, tenantId: string, dto: TestProviderConnectionRequest): Promise<ProbeTarget> {
    const needsStored =
      dto.apiKey === undefined ||
      dto.baseUrl === undefined ||
      dto.region === undefined ||
      dto.apiVersion === undefined ||
      dto.deploymentName === undefined;

    // The caller's own row is looked up by SLUG — it may be a named sibling —
    // and UNCONDITIONALLY, even when the body supplies every field: the row is
    // what says which VENDOR this connection is, and a saved connection must
    // never need the caller to restate that (nor be allowed to contradict it).
    // It is still only the FIELD fallback when the body left something out, so
    // `source` below is unchanged for every pre-TASK-958 call.
    let row: AiProviderConnectionEntity | null = await this.connections.findRow(service, slug, tenantId);
    let tier: TestProviderConnectionResponse['source'] = row ? (tenantId === SYSTEM_TENANT_ID ? 'platform' : 'tenant') : 'request';

    // WHICH VENDOR (TASK-958). The row answers it when there is one; the body
    // answers it when there is not; the slug answers it when the slug is itself
    // a provider id, which is every call that predates named connections.
    const provider = this.resolveProbeVendor(service, slug, row, dto);

    if (needsStored && !row && tenantId !== SYSTEM_TENANT_ID) {
      // The platform fallback is read by the resolved VENDOR, never by the
      // slug: the platform tier holds one row per provider and knows nothing of
      // a tenant's names for its connections.
      row = await this.connections.findDefaultRow(service, provider, SYSTEM_TENANT_ID);
      tier = row ? 'platform' : 'request';
    }

    const clean = (v: string | null | undefined): string | null => {
      const s = v?.trim();
      return s ? s : null;
    };

    let apiKey = clean(dto.apiKey);
    if (apiKey === null && row?.encryptedApiKey?.length) {
      if (!this.secretsService) {
        throw new BadRequestException('The stored key cannot be decrypted (no secrets provider); supply `apiKey` to test.');
      }
      try {
        apiKey = await decryptSecretField(this.secretsService, row.encryptedApiKey);
      } catch {
        throw new BadRequestException('The stored key could not be decrypted; supply `apiKey` to test.');
      }
    }

    // A body that supplies nothing and finds no stored row has nothing to test.
    const source: TestProviderConnectionResponse['source'] = dto.apiKey !== undefined && dto.baseUrl !== undefined ? 'request' : tier;

    return {
      apiKey,
      baseUrl: clean(dto.baseUrl) ?? clean(row?.baseUrl),
      region: clean(dto.region) ?? clean(row?.region),
      apiVersion: clean(dto.apiVersion) ?? clean(row?.apiVersion),
      deploymentName: clean(dto.deploymentName) ?? clean(row?.deploymentName),
      provider,
      source,
    };
  }

  /**
   * The vendor this probe talks to — the one decision that selects WHICH probe
   * runs and, with it, which endpoint a stored key is presented to.
   *
   * ORDER, and why each step is where it is:
   *   1. A SAVED row is authoritative and its provider is immutable (the write
   *      path's own rule). A body that contradicts it is REFUSED, not ignored:
   *      quietly honouring `{provider:'anthropic'}` on an OpenAI row would send
   *      that row's decrypted key to a vendor that never issued it.
   *   2. The BODY, for a connection the operator has not saved yet — the create
   *      dialog's "Test connection" before "Save".
   *   3. The SLUG, when the slug is itself a provider id: every call that
   *      predates TASK-958, unchanged.
   *   4. Otherwise a named 400. `openai-research` is a connection name; guessing
   *      a vendor from it produced a "reachability" pass that proved nothing
   *      about the key just typed.
   *
   * `isKnownProviderId` is deliberately service-agnostic here, exactly as it is
   * on the write path: whether THIS tier may hold THIS (service, provider) is
   * the connection service's boundary to draw, not this probe's.
   */
  private resolveProbeVendor(
    service: ProviderService,
    slug: string,
    row: AiProviderConnectionEntity | null,
    dto: TestProviderConnectionRequest,
  ): string {
    const requested = dto.provider?.trim() || undefined;

    if (row) {
      if (requested !== undefined && requested !== row.provider) {
        throw new ConflictException({
          code: CONNECTION_ERROR_CODES.PROVIDER_IMMUTABLE,
          message:
            `Connection '${slug}' serves '${row.provider}', so it cannot be tested as '${requested}' — a connection never ` +
            'changes vendor. Drop `provider` to test the saved connection, or test the other vendor on its own connection.',
          slug,
          provider: row.provider,
          requestedProvider: requested,
        });
      }
      return row.provider;
    }

    if (requested !== undefined) {
      if (!isKnownProviderId(requested)) {
        throw new BadRequestException({
          code: CONNECTION_ERROR_CODES.PROVIDER_REQUIRED,
          message: `'${requested}' is not a provider this platform serves, so there is nothing to probe. Send the vendor id (for example \`openai\`).`,
          slug,
          service,
          provider: requested,
        });
      }
      return requested;
    }

    if (isKnownProviderId(slug)) return slug;

    throw new BadRequestException({
      code: CONNECTION_ERROR_CODES.PROVIDER_REQUIRED,
      message:
        `'${slug}' is a connection name, not a provider, and no connection by that name is saved yet — so this request does ` +
        'not say which vendor to test. Send `provider` (for example `{"provider": "openai"}`) alongside the credentials.',
      slug,
      service,
    });
  }

  // ───────────────────────────── the per-provider probes ─────────────────────────────

  private async run(service: ProviderService, provider: string, tenantId: string, t: ProbeTarget): Promise<ProbeOutcome> {
    const key = `${service}:${provider}`;
    switch (key) {
      case 'llm:openai':
      case 'embeddings:openai':
      case 'stt:openai':
        return this.probeBearerList(t, 'https://api.openai.com/v1', '/models', tenantId, 'key', true);
      case 'llm:anthropic':
        return this.probeAnthropic(t, tenantId);
      case 'llm:azure':
      case 'embeddings:azure':
        return this.probeAzureOpenAi(t, tenantId);
      case 'stt:azure-speech':
      case 'tts:azure':
        return this.probeAzureSpeech(t, tenantId);
      case 'stt:sarvam':
      case 'tts:sarvam':
        return this.probeReachability(
          t,
          'https://api.sarvam.ai',
          tenantId,
          { 'api-subscription-key': t.apiKey ?? '' },
          'Sarvam has no auth-only probe; the key is verified on first request',
        );
      case 'vector:qdrant':
        return this.probeQdrant(t, tenantId);
      case 'model-registry:huggingface':
        return this.probeBearerList(t, 'https://huggingface.co', '/api/whoami-v2', tenantId, 'token');
      case 'llm:bedrock':
      case 'llm:vertex':
        // Ambient-credential providers: nothing to probe from a static key.
        return {
          ok: true,
          message: `${provider} uses ambient cloud credentials; nothing to probe — verified on first request`,
          probe: 'reachability',
        };
      default:
        return this.probeReachability(t, null, tenantId, {}, `${provider} exposes no auth-only probe; the key is verified on first request`);
    }
  }

  /**
   * `GET {base}{path}` with `Authorization: Bearer <key>` — a real auth-only call.
   *
   * `collect` says whether the 200 body is a MODEL LISTING worth keeping
   * (TASK-890 §3.7): true for OpenAI `/models`, false for HuggingFace `whoami`,
   * which answers with an identity and not a catalogue.
   */
  private async probeBearerList(
    t: ProbeTarget,
    defaultBase: string,
    path: string,
    tenantId: string,
    keyLabel: string,
    collect = false,
  ): Promise<ProbeOutcome> {
    if (!t.apiKey) return this.noKey(keyLabel);
    const base = this.assertProbeUrl(t.baseUrl ?? defaultBase, 'baseUrl', tenantId);
    const target = new URL(`${base.origin}${base.pathname.replace(/\/$/, '')}${path}`);
    try {
      const response = await fetch(target, {
        headers: { Authorization: `Bearer ${t.apiKey}` },
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      });
      if (response.ok) {
        const discoveredModels = collect ? discoveredIdsOf(await readJson(response)) : undefined;
        return { ok: true, message: `Connected — ${keyLabel} accepted`, probe: 'auth', ...(discoveredModels ? { discoveredModels } : {}) };
      }
      if (response.status === 401 || response.status === 403) return { ok: false, message: `Rejected — invalid ${keyLabel}`, probe: 'auth' };
      return { ok: false, message: `Provider responded ${response.status}`, probe: 'auth' };
    } catch (error) {
      return { ok: false, message: `Could not reach provider: ${this.errorMessage(error)}`, probe: 'auth' };
    }
  }

  private async probeAnthropic(t: ProbeTarget, tenantId: string): Promise<ProbeOutcome> {
    if (!t.apiKey) return this.noKey('key');
    const base = this.assertProbeUrl(t.baseUrl ?? 'https://api.anthropic.com', 'baseUrl', tenantId);
    const target = new URL(`${base.origin}${base.pathname.replace(/\/$/, '')}/v1/models`);
    try {
      const response = await fetch(target, {
        headers: { 'x-api-key': t.apiKey, 'anthropic-version': t.apiVersion ?? '2023-06-01' },
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      });
      if (response.ok) {
        const discoveredModels = discoveredIdsOf(await readJson(response));
        return { ok: true, message: 'Connected — key accepted', probe: 'auth', ...(discoveredModels ? { discoveredModels } : {}) };
      }
      if (response.status === 401 || response.status === 403) return { ok: false, message: 'Rejected — invalid key', probe: 'auth' };
      return { ok: false, message: `Provider responded ${response.status}`, probe: 'auth' };
    } catch (error) {
      return { ok: false, message: `Could not reach provider: ${this.errorMessage(error)}`, probe: 'auth' };
    }
  }

  /** Azure OpenAI: list deployments (`api-key` header); verifies `deploymentName` against the list when given. */
  private async probeAzureOpenAi(t: ProbeTarget, tenantId: string): Promise<ProbeOutcome> {
    if (!t.apiKey) return this.noKey('key');
    if (!t.baseUrl) throw new BadRequestException('Provide `baseUrl` (the Azure OpenAI resource endpoint) to test');
    const base = this.assertProbeUrl(t.baseUrl, 'baseUrl', tenantId);
    const apiVersion = t.apiVersion ?? '2024-10-21';
    const target = new URL(`${base.origin}/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`);
    try {
      const response = await fetch(target, { headers: { 'api-key': t.apiKey }, signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS) });
      if (response.status === 401 || response.status === 403) return { ok: false, message: 'Rejected — invalid key', probe: 'auth' };
      if (!response.ok) return { ok: false, message: `Provider responded ${response.status}`, probe: 'auth' };
      // ONE read of the body, used for both jobs: validating the configured
      // deployment and (TASK-890 §3.7) keeping the listing the console derives
      // a model declaration from.
      const discoveredModels = discoveredIdsOf(await readJson(response));
      if (t.deploymentName && discoveredModels && !discoveredModels.includes(t.deploymentName)) {
        return { ok: false, message: `Connected, but deployment '${t.deploymentName}' is not listed on this resource`, probe: 'auth' };
      }
      return { ok: true, message: 'Connected — key accepted', probe: 'auth', ...(discoveredModels ? { discoveredModels } : {}) };
    } catch (error) {
      return { ok: false, message: `Could not reach provider: ${this.errorMessage(error)}`, probe: 'auth' };
    }
  }

  /**
   * Classic Azure Speech (region present): a real auth-only probe via the STS
   * token-issuance endpoint. Azure Foundry (endpoint present, no region): no
   * auth-only route exists, so this degrades to a reachability smoke test.
   */
  private async probeAzureSpeech(t: ProbeTarget, tenantId: string): Promise<ProbeOutcome> {
    if (!t.apiKey) return this.noKey('subscription key');
    if (t.region) {
      if (!/^[a-z0-9-]+$/i.test(t.region)) {
        throw new BadRequestException('region must be a simple region slug (e.g. eastus)');
      }
      const target = `https://${t.region}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`;
      try {
        const response = await fetch(target, {
          method: 'POST',
          headers: { 'Ocp-Apim-Subscription-Key': t.apiKey, 'Content-Length': '0' },
          signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
        });
        if (response.ok) return { ok: true, message: 'Connected — subscription key accepted', probe: 'auth' };
        if (response.status === 401 || response.status === 403)
          return { ok: false, message: 'Rejected — invalid subscription key or region', probe: 'auth' };
        return { ok: false, message: `Provider responded ${response.status}`, probe: 'auth' };
      } catch (error) {
        return { ok: false, message: `Could not reach provider: ${this.errorMessage(error)}`, probe: 'auth' };
      }
    }
    if (t.baseUrl) {
      return this.probeReachability(
        t,
        null,
        tenantId,
        {},
        'Endpoint reachable — Azure Foundry has no auth-only probe; the key is verified on first request',
      );
    }
    throw new BadRequestException('Provide a region (classic Azure Speech) or a baseUrl (Azure Foundry) to test');
  }

  private async probeQdrant(t: ProbeTarget, tenantId: string): Promise<ProbeOutcome> {
    if (!t.baseUrl) throw new BadRequestException('Provide `baseUrl` (the Qdrant endpoint) to test');
    const base = this.assertProbeUrl(t.baseUrl, 'baseUrl', tenantId);
    const target = new URL(`${base.origin}${base.pathname.replace(/\/$/, '')}/collections`);
    try {
      const response = await fetch(target, {
        headers: t.apiKey ? { 'api-key': t.apiKey } : {},
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      });
      if (response.ok) return { ok: true, message: t.apiKey ? 'Connected — key accepted' : 'Connected (no key)', probe: 'auth' };
      if (response.status === 401 || response.status === 403) return { ok: false, message: 'Rejected — invalid key', probe: 'auth' };
      return { ok: false, message: `Provider responded ${response.status}`, probe: 'auth' };
    } catch (error) {
      return { ok: false, message: `Could not reach provider: ${this.errorMessage(error)}`, probe: 'auth' };
    }
  }

  /** `HEAD` the endpoint — answers "is it there", never "is the key valid". */
  private async probeReachability(
    t: ProbeTarget,
    defaultBase: string | null,
    tenantId: string,
    headers: Record<string, string>,
    okMessage: string,
  ): Promise<ProbeOutcome> {
    const raw = t.baseUrl ?? defaultBase;
    if (!raw) throw new BadRequestException('Provide `baseUrl` to test this provider');
    const url = this.assertProbeUrl(raw, 'baseUrl', tenantId);
    try {
      const response = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS) });
      if (response.status >= 500) return { ok: false, message: `Provider responded ${response.status}`, probe: 'reachability' };
      return { ok: true, message: okMessage, probe: 'reachability' };
    } catch (error) {
      return { ok: false, message: `Could not reach endpoint: ${this.errorMessage(error)}`, probe: 'reachability' };
    }
  }

  // ───────────────────────────── guards ─────────────────────────────

  /**
   * SSRF guard for a tenant-supplied probe target: https only, and the hostname
   * may not be a loopback/private/link-local literal. The SYSTEM tenant's
   * self-host endpoints ARE in-cluster, so for SYSTEM the guard relaxes to "a
   * valid http(s) URL" — a super admin probing platform infrastructure.
   */
  private assertProbeUrl(raw: string, fieldLabel: string, tenantId: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException(`${fieldLabel} must be a valid URL`);
    }
    if (tenantId === SYSTEM_TENANT_ID) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BadRequestException(`${fieldLabel} must use http or https`);
      return url;
    }
    if (url.protocol !== 'https:') throw new BadRequestException(`${fieldLabel} must use https`);
    if (PRIVATE_HOST_PATTERN.test(url.hostname)) throw new BadRequestException(`${fieldLabel} may not target a private/loopback address`);
    return url;
  }

  private noKey(label: string): ProbeOutcome {
    return { ok: false, message: `No ${label} to test — supply \`apiKey\` or store one on the connection first`, probe: 'auth' };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
