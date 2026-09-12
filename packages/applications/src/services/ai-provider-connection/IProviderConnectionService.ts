import { AiProviderConnectionEntity } from '@arcaai/domains';
import { ProviderService } from './constants';
import {
  AiProviderConnectionResponse,
  DeclareConnectionModelsRequest,
  PlatformDefaultConnectionsResponse,
  UpsertAiProviderConnectionRequest,
} from './dto';
import { ProviderExtraValue } from './provider-extras';

export type { ProviderService } from './constants';

/** The resolved connection plus which cascade tier supplied it. */
export interface ResolvedProviderConnection {
  service: ProviderService;
  provider: string;
  baseUrl: string | null;
  region: string | null;
  apiVersion: string | null;
  deploymentName: string | null;
  /**
   * Per-request timeout ceiling, seconds. `null` = no opinion (the consuming service's own
   * default applies). Surfaced here because a resolved connection is what a per-request runtime
   * spec is built from: `tts.sarvam.timeoutS` used to be a platform settings key, and a value the
   * row carries but the resolver drops is a ceiling nothing can enforce.
   */
  timeoutS: number | null;
  /** Ciphertext — gateway-side decrypt only; never leaves the server. */
  encryptedApiKey: Uint8Array | null;
  keyVersion: number | null;
  /** Which tier won: the caller's own row or the SYSTEM platform default. */
  source: 'tenant' | 'system';
}

/**
 * WHO PAID for a credential.
 *
 * `tenant` — the caller's own BYO row. Metered `BYOK` + `BYOK_NOTIONAL`: the
 * platform bore no vendor cost, so the call is rated notionally and not
 * invoiced.
 * `platform` — the SYSTEM-tenant platform default. The platform DID bear the
 * vendor cost, so the call meters `CLOUD` + `INTERNAL` , reaching the
 * COGS rollups and the premium SELL row.
 *
 * Getting this label wrong is silent: the wrong value still produces a
 * self-consistent deployment/costBasis pair, so no ledger guard fires and the
 * shadow-metering reconciliation (which filters to CLOUD) drops the event
 * entirely. It is therefore DERIVED from the row that supplied the credential
 * (`row.tenantId === SYSTEM_TENANT_ID`) inside the single private factory in
 * `AiProviderConnectionService`, never stamped by a call site.
 */
export type ProviderFunding = 'tenant' | 'platform';

/**
 * One decrypted BYO credential in the shape the Python services
 * consume. snake_case matches the frozen wire contract (C4) and the TTS
 * `provider_overrides` precedent.
 */
export interface ProviderOverrideEntry {
  api_key: string;
  /**
   * REQUIRED here, on purpose — strict where entries are CONSTRUCTED, lenient
   * where they are PARSED. Every consumer (`tts-provider-classification.ts`,
   * TEXT's `_used_byok_credential`, STT's `resolve_usage_attribution`) treats an
   * absent value as `tenant`, which is exact rather than merely conservative
   * for any sender that predates the cascade, and keeps in-flight requests
   * unchanged during a rolling deploy. Making it required on the internal type
   * turns a missing label into a COMPILE error instead of a silent mis-bill.
   */
  funding: ProviderFunding;
  base_url?: string;
  region?: string;
  api_version?: string;
  deployment_name?: string;
  /**
   * Providers whose per-request model/target lives in no dedicated column carry
   * it in the connection row's `extraJson` (the console writes it there): an
   * OpenAI/Anthropic/STT `model` override, and Vertex's GCP `project`/`location`.
   * Forwarded verbatim so the Python adapter can target the tenant's resource.
   *
   * These three are DECLARED rather than merely admitted by the index signature
   * below because they are the ones gateway code reads by name; they carry no
   * special forwarding rule of their own.
   */
  model?: string;
  project?: string;
  location?: string;

  /**
   * C.2 — every OTHER key of the row's `extraJson`, forwarded
   * VERBATIM after shape validation (`provider-extras.ts`).
   *
   * This index signature is the type-level statement of the fix: forwarding is
   * a VALIDATED PASSTHROUGH, not an allow-list, so a new per-endpoint quirk
   * (`json_response_format`, `reasoning_mode`, `no_think`, `adaptive_limits`)
   * needs a console write and NOTHING here. The four declared column-backed
   * fields above stay reserved — `extraJson` cannot supply them, so a row can
   * never restate the credential, the endpoint, or the derived `funding` label.
   */
  [extra: string]: ProviderExtraValue | undefined;
}

/** `provider → override`, keyed by the serving provider identifier. */
export type ProviderOverrides = Record<string, ProviderOverrideEntry>;

/**
 * WHY the SYSTEM (platform-default) tier did not contribute.
 *
 * Both facts are carried because both can be true at once, and they are not
 * alternatives: the veto is per `(service, provider)` while the entitlement
 * grant is per tenant. A tenant that vetoes `azure` and holds no grant must
 * still get the VETO error for `azure` (the more specific, more local fact) and
 * the entitlement error for every other provider.
 *
 * Absent from `ResolvedProviderOverrides` ⇒ the SYSTEM tier was consulted
 * normally and nothing was suppressed.
 */
export interface PlatformDefaultOutcome {
  /** The gate denied the whole SYSTEM tier: no `featurePlatformDefaultCredential`. */
  entitlementSuppressed: boolean;
  /** Providers the tenant explicitly vetoed by disabling its own row. */
  vetoed: string[];
}

/**
 * The injection resolver's result. `overrides` is the unchanged wire map (still
 * gateway-only — it carries plaintext key material); `platformDefault` is the
 * out-of-band reason a provider has no entry, so the call site can raise an
 * attributable 403/409 instead of letting a Python service report a generic
 * missing-credential 503. Pass the whole object to `assertProviderAvailable`.
 */
export interface ResolvedProviderOverrides {
  overrides: ProviderOverrides;
  platformDefault?: PlatformDefaultOutcome;
}

/**
 * the four outcomes a FAIL-CLOSED consumer needs from one credential
 * resolve, and the wire shape `/internal/*` routes return.
 *
 * Why four and not two. `absent` and `unavailable` MUST stay distinct:
 *
 *   `resolved` — a row supplied a credential. Use it.
 *   `absent` — no tier has an opinion (no row, or a keyless row). Proceed
 *                   UNAUTHENTICATED. For a PUBLIC model repo or an in-boundary
 *                   self-hosted endpoint this is the CORRECT resolved state,
 *                   and it is never a licence to read an environment variable.
 *   `denied` — the tenant VETOED this `(service, provider)` by disabling
 *                   its row, or the platform-default entitlement is not
 *                   granted. Fail closed; never fall through to another tier.
 *   `unavailable` — the resolve itself faulted. Fail closed. Collapsing this
 *                   into `absent` would turn a Vault or database outage into a
 *                   silent downgrade from an entitled fetch to an anonymous
 *                   one — which on a gated resource fails, and on a public one
 *                   quietly fetches something nobody authorised.
 */
export type ProviderCredentialOutcome = 'resolved' | 'absent' | 'denied' | 'unavailable';

/** One resolved credential, or the reason there is none. */
export interface ResolvedProviderCredential {
  outcome: ProviderCredentialOutcome;
  /** Cause for `denied` / `unavailable`. NEVER key material, and never a backend error string. */
  reason?: string;
  apiKey?: string;
  baseUrl?: string;
  region?: string;
  apiVersion?: string;
  deploymentName?: string;
  /**
   * The row's validated `extraJson`, minus every reserved key. This is how the
   * NON-SECRET half of a two-part credential travels — `accessKeyId` for
   * `model-registry:s3` — beside the secret half in `apiKey`.
   */
  extras?: Record<string, unknown>;
  /** DERIVED from the row that supplied the credential. Never stamped by a caller. */
  funding?: ProviderFunding;
  /**
   * TASK-932 D-7 — which PLANE answered, when it was not a connection row.
   *
   * Present only for `'platform-storage'`: the `model-registry:s3` built-in
   * default, whose endpoint and key pair come from the platform storage cascade
   * rather than from the row. ADDITIVE and optional so the existing consumer
   * (`apps/stt/src/stt/core/model_credentials.py`, which parses `apiKey`,
   * `baseUrl`, `extras.accessKeyId` and `funding`) is unchanged — it simply does
   * not read this field.
   */
  source?: 'platform-storage';
}

// C2 published aliases — the program doc names these; downstream lanes import them.
export type ProviderConnectionResponse = AiProviderConnectionResponse;
export type ResolvedConnection = ResolvedProviderConnection;
export type ProviderOverride = ProviderOverrideEntry;

// ── Deprecated pre-unification type names (kept one release) ────────────────
/** @deprecated Use `ProviderOverrideEntry`. */
export type LlmProviderOverrideEntry = ProviderOverrideEntry;
/** @deprecated Use `ProviderOverrides`. */
export type LlmProviderOverrides = ProviderOverrides;

/**
 * DI token for the unified provider-connection service. The pre-unification
 * `IAiProviderConnectionService` symbol below is an ALIAS to this same value, so
 * existing `@Inject(IAiProviderConnectionService)` sites (text-proxy) keep
 * resolving until it is repointed them.
 */
export const IProviderConnectionService = Symbol('IProviderConnectionService');

/** @deprecated Use `IProviderConnectionService` (same symbol value). */
export const IAiProviderConnectionService = IProviderConnectionService;

export interface IProviderConnectionService {
  /** Every ENABLED connection row for a (service, tenant), masked. */
  list(service: ProviderService, tenantId?: string): Promise<AiProviderConnectionResponse[]>;

  /** One (service, tenant, provider) row, masked; a `version: 0` placeholder when absent. */
  getRow(service: ProviderService, provider: string, tenantId?: string): Promise<AiProviderConnectionResponse>;

  /**
   * TASK-954 — the platform fallback a TENANT inherits for one service, READ-ONLY.
   *
   * The SYSTEM tier's cloud BYO rows (masked, one entry per cloud provider of
   * the service — a placeholder where the platform has no row), each annotated
   * with the cascade's verdict for the scoped tenant (`resolution`) and the
   * tenant's entitlement to platform vendor accounts. Built on the ONE cascade
   * (`cascadeRows`), so the veto set and the entitlement gate are the same ones
   * a real request meets. The SYSTEM tier itself is refused (400): the platform
   * row is the top of the cascade and inherits nothing.
   */
  listPlatformDefaults(service: ProviderService, tenantId?: string): Promise<PlatformDefaultConnectionsResponse>;

  /**
   * Create-or-CAS-update one (service, tenant, provider) row. `expectedVersion`
   * is the optimistic-concurrency token (C2). When omitted it falls back to
   * `dto.expectedVersion`, so the gateway may pass it either way.
   */
  upsertRow(
    service: ProviderService,
    provider: string,
    dto: UpsertAiProviderConnectionRequest,
    tenantId?: string,
    expectedVersion?: number,
  ): Promise<AiProviderConnectionResponse>;

  /**
   * TASK-932 R-3 — restore ONE platform-managed row to its built-in default
   * (`BUILT_IN_CONNECTION_DEFAULTS`). SUPER_ADMIN-only, SYSTEM tier only.
   *
   * Not a DELETE: a deleted SYSTEM engine row is a 503 in `apps/text`, not a
   * return to the default, because the base URL travels only through the
   * injected override fold. No `If-Match` — the whole point is "whatever it says
   * now, put it back", so a stale token would refuse exactly the caller who most
   * needs it.
   */
  resetRow(service: ProviderService, provider: string, tenantId?: string): Promise<AiProviderConnectionResponse>;

  /**
   * TASK-890 §3.7a (OD-A) — declare the models this tenant's connection serves.
   *
   * A full REPLACEMENT of the list: each entry becomes (or stays) a
   * TENANT-OWNED `AiModel` row carrying `sourceConnectionId`; an entry that
   * left the list is soft-deleted. Refuses the SYSTEM tier (403 — platform
   * models are declared in `/admin/ai-models`), a provider the tenant may not
   * hold a row for (403), and a generated slug that would shadow a platform row
   * (409 `BYO_SLUG_SHADOWS_PLATFORM`, nothing written).
   */
  declareModels(
    service: ProviderService,
    provider: string,
    dto: DeclareConnectionModelsRequest,
    tenantId?: string,
  ): Promise<AiProviderConnectionResponse>;

  /** Soft-delete one (service, tenant, provider) row. */
  deleteRow(service: ProviderService, provider: string, tenantId?: string, expectedVersion?: number): Promise<void>;

  /**
   * The resolution cascade for one (service, provider): ENABLED tenant row →
   * ENABLED SYSTEM row → null. `null` is the "no DB opinion — use the service's
   * env configuration" signal. Server-side only; the result carries ciphertext
   * and is never serialized to a client.
   *
   * Shares ONE cascade helper with `resolveTenantCloudOverrides`
   * ), so the veto and the entitlement gate apply here too
   * there is exactly one `if` in the codebase deciding whether a tenant may see
   * the platform default. The gate applies to CLOUD BYO providers only: a
   * SYSTEM row for a self-host engine is platform INFRASTRUCTURE, not platform
   * SPEND, and must stay reachable for every tenant.
   */
  resolveConnection(service: ProviderService, provider: string, tenantId: string): Promise<ResolvedProviderConnection | null>;

  /** Raw entity accessor for gateway resolution paths that need the row itself. */
  findRow(service: ProviderService, provider: string, tenantId: string): Promise<AiProviderConnectionEntity | null>;

  /**
   * Decrypt the ENABLED **cloud BYO** connections that serve one service for one
   * tenant into the injectable `provider_overrides` map the gateway folds into
   * the Python service body. Gateway-only: the result carries plaintext key
   * material and is NEVER returned by any read API.
   *
   * TWO TIERS, merged PER PROVIDER: the caller's own rows over the
   * SYSTEM-tenant platform default. A tenant holding an `azure` key but no
   * `sarvam` key still receives platform `sarvam` — never a whole-map
   * "tenant if non-empty" short-circuit. Every entry carries `funding`, derived
   * from the row that supplied it.
   *
   * THREE STATES per (service, provider), evaluated on the caller's own row:
   *   - **absent** ⇒ the platform default applies, subject to the entitlement
   *     gate (`featurePlatformDefaultCredential`);
   *   - **present, enabled, keyed** ⇒ the tenant's own credential wins and the
   *     SYSTEM tier is not consulted for that provider (an ENABLED but KEYLESS
   *     row is an incomplete setup, treated as absent — not a veto);
   *   - **present, disabled** ⇒ a **VETO**: no credential from either tier, no
   *     fall-through to another provider, and `platformDefault.vetoed` records
   *     it so the call site can raise a 409.
   *

   * FAILS OPEN PER CREDENTIAL, on decrypt error only: a credential whose
   * ciphertext will not decrypt (Vault down, key rotated badly, corrupt bytes)
   * is skipped with a non-secret `warn` ({tenantId, service, provider,
   * keyVersion}) so the request proceeds on the SYSTEM/env platform credentials.
   * Model/provider SELECTION stays fail-closed elsewhere — different failure
   * classes.
   *
   * The 1-arg overload is a `@deprecated` transition shim (assumes
   * `service='llm'`) so the text-proxy keeps compiling until it
   * repoints; removes it.
   */
  resolveTenantCloudOverrides(service: ProviderService, tenantId: string): Promise<ResolvedProviderOverrides>;
  /** @deprecated 1-arg form assumes `service='llm'`; kept for the text-proxy transition (removes it). */
  resolveTenantCloudOverrides(tenantId: string): Promise<ResolvedProviderOverrides>;

  /**
   * ONE credential, projected onto the four-outcome contract above.
   *
   * For a consumer that holds no DB handle and receives no request to fold a
   * `provider_overrides` envelope into — the STT worker fetching model weights,
   * a Temporal activity — the gateway is the only channel. This is what an
   * `/internal/*` route returns.
   *
   * It does NOT reimplement the cascade. `resolveTenantCloudOverrides` remains
   * the single place tenant-vs-SYSTEM precedence, the veto set, the entitlement
   * gate and derived funding live; this only maps its result.
   *
   * `tenantId` is REQUIRED. A tenant-less resolve could only mean "read SYSTEM
   * unconditionally", which is the widen-without-absence bug the two-tier rule
   * exists to prevent — a caller with no tenant of its own passes SYSTEM
   * EXPLICITLY.
   */
  resolveCredential(service: ProviderService, provider: string, tenantId: string): Promise<ResolvedProviderCredential>;
}

/** @deprecated Use `IProviderConnectionService`. */
export type IAiProviderConnectionService = IProviderConnectionService;
