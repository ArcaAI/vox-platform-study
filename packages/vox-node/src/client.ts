/**
 * `HopeClient` — the top-level entry point for `@arcaai/vox-node`. Wires one
 * `core/transport.ts#Transport` instance (connection-level config: base URL,
 * credentials, retry/timeout defaults) into every resource
 * (`src/resources/**`), which is the only thing this module does — no
 * request logic lives here.
 *
 * Named `HopeClient` (a client for the HOPE gateway), not `VoxNodeClient` —
 * by design, the package brand (`@arcaai/vox-node`) and the
 * client class name are deliberately different: the package name carries
 * brand continuity with the browser `@arcaai/vox` SDK, while the class name
 * says what it actually talks to.
 */

import { ServiceAccountTokenProvider } from './core/service-account-token';
import type { ServiceAccountCredentials } from './core/service-account-token';
import { Transport } from './core/transport';
import { AdminNamespace, ConsultationsResource, JobsResource, SummarizationResource, TenantsResource } from './resources';

/**
 * Structured logger hook for `HopeClient`. Every method is optional so a
 * partial logger (e.g. only `error`) is valid.
 *
 * **PHI safety**: `HopeClient` never passes a request or response BODY to
 * any `HopeLogger` method — transcripts and summaries are PHI
 * (`.claude/rules/00-project-context.md`). `meta`, when present, carries only
 * non-content fields (method, path, status, requestId).
 *
 * Not yet wired to `core/transport.ts#Transport`, which has no logging hook
 * of its own (verified against the already-frozen transport core). Accepted
 * here for forward compatibility with the `HopeClient` constructor shape;
 * currently inert.
 */
export interface HopeLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

/** Constructor options for {@link HopeClient}. */
export interface HopeClientOptions {
  /** e.g. `http://localhost:8868`. */
  baseUrl: string;
  /** Sent as `X-API-Key` on every request. Mutually exclusive with {@link serviceAccount}. */
  apiKey?: string;
  /**
   * Authenticate as a SERVICE ACCOUNT — HOPE's machine credential, and the
   * only machine path to the `/api/v1/admin/*` plane (a tenant API key is
   * refused there by policy, not by omission).
   *
   * The SDK exchanges `(clientId, clientSecret)` for a short-lived opaque
   * token on first use and keeps it fresh; you never handle the token.
   *
   * **`workingTenantId` binds at TOKEN EXCHANGE, not per request** — unlike
   * `tenantId`, which travels on every API-key request. One client acts on one
   * working tenant for its lifetime; construct a second client to act on
   * another. Full rationale in `core/service-account-token.ts`.
   *
   * Mutually exclusive with both {@link apiKey} (the gateway refuses two
   * credential classes on one request) and {@link tenantId} (which would be a
   * second, conflicting statement of tenancy). Both combinations throw at
   * construction.
   */
  serviceAccount?: ServiceAccountCredentials;
  /** Sent as `X-Tenant-Id` on every request — super-admin API keys only. Not used with {@link serviceAccount}. */
  tenantId?: string;
  /** Default `2`. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default `60_000`. */
  timeout?: number;
  /** Injectable for tests/proxies; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** See {@link HopeLogger}. */
  logger?: HopeLogger;
}

/**
 * The HOPE Node SDK client. Construction never touches the network — it only
 * builds the shared `Transport` and the resource instances hanging off it.
 *
 * ```ts
 * const hope = new HopeClient({ baseUrl: process.env.HOPE_API_URL!, apiKey: process.env.HOPE_API_KEY! });
 * const { summary } = await hope.summarization.summary({ session_data: {...} });
 * ```
 */
export class HopeClient {
  /** P0 — stateless, v1-compat pre-summary/summary (`POST /api/smr/api/v1/{presummary,summary/sync}`). */
  readonly summarization: SummarizationResource;
  /** P0.5 — minimal consultation read + consultation-bound summarization (`.summaries`). */
  readonly consultations: ConsultationsResource;
  /** P0.5 — async job get/cancel/stream/waitFor. */
  readonly jobs: JobsResource;
  /**
   * The caller's OWN tenant (`/api/v1/tenants/me/*`) — read-only, business
   * plane. Today: consultation context-schema discovery, the bundle a
   * schema-aware {@link ConsultationsResource.addContext} write pins against.
   */
  readonly tenants: TenantsResource;
  /**
   * The `/api/v1/admin/**` administration plane — 52 areas, one property per
   * `svc:admin:*` scope (TASK-773).
   *
   * Requires a {@link HopeClientOptions.serviceAccount} credential. The plane
   * refuses a tenant API key by POLICY, not by omission (`@ForbidApiKey()` on
   * every admin controller), so an api-key client that reaches for
   * `hope.admin` gets 401/403 from the gateway, not a missing method. The
   * namespace is still constructed either way: which credential is on the wire
   * is a transport concern, and pretending the surface does not exist would
   * only turn a clear runtime refusal into a confusing `undefined`.
   */
  readonly admin: AdminNamespace;

  constructor(options: HopeClientOptions) {
    if (!options.baseUrl) {
      throw new Error('HopeClient requires a non-empty `baseUrl` (e.g. "http://localhost:8868").');
    }
    // The gateway rejects a request presenting two credential classes
    // (`UnifiedAuthGuard`), and would rather 401 than silently prefer one.
    // Failing HERE turns that runtime refusal into a programming error the
    // integrator sees on the first construction rather than the first call.
    if (options.apiKey && options.serviceAccount) {
      throw new Error(
        'HopeClient accepts exactly one credential: `apiKey` OR `serviceAccount`, never both — the gateway rejects a request carrying two credential classes.',
      );
    }
    // Not an oversight to be lenient about: an integrator setting `tenantId`
    // alongside a service account is acting on the API-key intuition that
    // tenancy is per-request. It is not — it is bound at token exchange — so
    // this option would be silently ignored, which is the worst outcome.
    if (options.tenantId && options.serviceAccount) {
      throw new Error(
        '`tenantId` is not used with a service account: the working tenant is bound at TOKEN EXCHANGE, not per request. Set `serviceAccount.workingTenantId` instead.',
      );
    }

    const serviceAccountTokens = options.serviceAccount
      ? new ServiceAccountTokenProvider({
          // A SEPARATE, credential-less transport for the exchange call, given
          // the RAW `fetch` rather than the 401-recovering wrapper below — an
          // exchange that 401s must surface as "bad credentials", never
          // trigger another exchange.
          transport: new Transport({
            baseUrl: options.baseUrl,
            maxRetries: options.maxRetries,
            timeoutMs: options.timeout,
            fetch: options.fetch,
          }),
          credentials: options.serviceAccount,
        })
      : undefined;

    const transport = new Transport({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      getServiceAccountToken: serviceAccountTokens && (() => serviceAccountTokens.getToken()),
      tenantId: options.tenantId,
      maxRetries: options.maxRetries,
      timeoutMs: options.timeout,
      // The wrapper re-exchanges once and retries once on a 401 — the
      // mid-flight-revocation path; see `ServiceAccountTokenProvider.authenticatedFetch`.
      fetch: serviceAccountTokens ? serviceAccountTokens.authenticatedFetch(options.fetch ?? fetch) : options.fetch,
    });

    this.summarization = new SummarizationResource(transport);
    this.consultations = new ConsultationsResource(transport);
    this.jobs = new JobsResource(transport);
    this.tenants = new TenantsResource(transport);
    this.admin = new AdminNamespace(transport);
  }
}
