/**
 * The SERVICE ACCOUNT — HOPE's third credential class, and the only machine
 * path to the `/api/v1/admin/*` plane (TASK-762 issued it; TASK-757 closed the
 * API-key path to administration for good).
 *
 * ─── What an integrator actually has to know ────────────────────────────────
 *
 * You configure two values — `clientId` and `clientSecret` — and this module
 * does the rest. There is one thing it cannot do for you, and it is the one
 * place your intuition from the API-key path is WRONG:
 *
 *   **`workingTenantId` binds at EXCHANGE time, not per request.**
 *
 * With a tenant API key you send `X-Tenant-Id` on every call and may vary it
 * call by call. A service-account token has its working tenant baked into the
 * token itself: the gateway resolves it once, in `exchangeToken`
 * (`service-account.service.ts#resolveWorkingTenant`), stores it beside the
 * token in Redis, and reads it from there on every subsequent request. A
 * per-request `X-Tenant-Id` is therefore not merely ignored — it is a
 * different, conflicting statement of tenancy, so this SDK never sends one
 * alongside a service-account token, and `HopeClient` refuses `tenantId` and
 * `serviceAccount` together at construction. To act on a different tenant you
 * construct a second client with a different `workingTenantId` (and the
 * account's allow-list must permit it, or the exchange 403s).
 *
 * A platform account that asks for no working tenant resolves the SYSTEM
 * tenant — never a customer tenant, and explicitly never `50000000-…`
 * ("Global", which is a customer playground, not a config tier).
 *
 * ─── The wire contract ──────────────────────────────────────────────────────
 *
 *   POST /api/v1/auth/service-token
 *     → { clientId, clientSecret, workingTenantId? }
 *     ← { accessToken, tokenType, expiresIn, scopes, tenantId }
 *
 * `accessToken` is OPAQUE — a random 256-bit string recorded in Redis under
 * its own hash, never a JWT. Two consequences this module is built around:
 *
 *   1. There is nothing to decode. Expiry is known only from `expiresIn`
 *      (seconds) as measured against the local clock at the moment of the
 *      exchange, which is why refresh happens on a SKEW MARGIN rather than at
 *      a decoded `exp`.
 *   2. Revocation is a Redis DELETE and takes effect IMMEDIATELY — it is not
 *      bounded by the TTL. A token that was valid a second ago can be dead
 *      now (`revoke` purges live tokens; a narrowing scope update does too).
 *      A token lifecycle that only tracks expiry would surface that as a hard
 *      401 in the middle of a long-running job, so {@link
 *      ServiceAccountTokenProvider.authenticatedFetch} re-exchanges once and
 *      retries the call once.
 *
 * Despite `tokenType: 'Bearer'` in the response, the token is presented in the
 * dedicated `X-Service-Account-Token` header and NEVER as
 * `Authorization: Bearer` — `UnifiedAuthGuard` selects its credential branch on
 * the header, and a guard that has to guess which class it is looking at is an
 * authentication bypass. The gateway also refuses any request carrying two
 * credential classes at once, so this token is never co-sent with `X-API-Key`.
 */

import { redact, NODE_INSPECT_CUSTOM, type RedactedValue } from './redact';
// Type-only: erased at compile time, so `transport.ts`'s runtime import of
// SERVICE_ACCOUNT_TOKEN_HEADER (below) does not create an import CYCLE.
import type { Transport } from './transport';

/**
 * The header the token is presented in on every subsequent request.
 * `SERVICE_ACCOUNT_TOKEN_HEADER` in
 * `packages/applications/src/authorization/unified-auth.guard.ts` is the
 * authority; HTTP header names are case-insensitive, so the casing here is
 * cosmetic.
 */
export const SERVICE_ACCOUNT_TOKEN_HEADER = 'X-Service-Account-Token';

/** The one route that ever accepts a client secret. Gets the ordinary `api/v1` prefix — it is not a v1-compat path. */
export const SERVICE_ACCOUNT_TOKEN_PATH = 'auth/service-token';

/**
 * How long before expiry a cached token is replaced. One minute against a
 * 15-minute default TTL: long enough to cover a slow exchange plus clock skew
 * between this process and the gateway, short enough that it costs ~7% of the
 * token's life.
 */
const DEFAULT_REFRESH_SKEW_MS = 60_000;

/** The credential pair, plus the tenant the resulting token is BOUND to. */
export interface ServiceAccountCredentials {
  /** Public client identifier (`hope_svc_…`). Not a secret — it appears in gateway logs. */
  clientId: string;
  /** Issued exactly once, at creation or rotation. Never logged, never in a URL, never in an error. */
  clientSecret: string;
  /**
   * PLATFORM accounts only: the tenant this client acts on, **bound at token
   * exchange and fixed for the life of the token** — see this module's header.
   * Must be in the account's allow-list (otherwise the exchange 403s). Omit to
   * resolve the SYSTEM tenant. Ignored by the gateway for a tenant-bound
   * account, which may only ever act on its own tenant.
   */
  workingTenantId?: string;
}

/** The `POST /api/v1/auth/service-token` response body. */
export interface ServiceAccountTokenExchangeResponse {
  /** Opaque, server-validated. Presented in `X-Service-Account-Token`, never as a bearer JWT. */
  accessToken: string;
  /** Always `'Bearer'`. Descriptive only — see the header note in this module's header. */
  tokenType: string;
  /** Seconds until expiry (gateway default 900, hard-capped at 3600). */
  expiresIn: number;
  /** The `svc:*` scopes this token carries — useful when diagnosing a 403. */
  scopes: string[];
  /** The working tenant that was bound at this exchange. */
  tenantId: string;
}

/** Construction options for {@link ServiceAccountTokenProvider}. */
export interface ServiceAccountTokenProviderOptions {
  /**
   * A transport carrying NO credentials of its own, used solely for the
   * exchange call. Credential-less deliberately: the gateway rejects a request
   * presenting two credential classes, and the exchange route establishes a
   * credential rather than consuming one.
   */
  transport: Transport;
  credentials: ServiceAccountCredentials;
  /** Default {@link DEFAULT_REFRESH_SKEW_MS}. Clamped to half the token's lifetime — see {@link ServiceAccountTokenProvider}. */
  refreshSkewMs?: number;
  /** Injectable clock (ms). Defaults to `Date.now`. Tests must inject; never assert against a real clock. */
  now?: () => number;
}

interface CachedToken {
  /** Wrapped so the provider cannot leak it through logging/serialization — see `core/redact.ts`. */
  readonly token: RedactedValue<string>;
  /** Local-clock ms at which this token is replaced (expiry minus the skew margin). */
  readonly refreshAtMs: number;
}

function readServiceAccountToken(init: RequestInit | undefined): string | null {
  if (!init?.headers) return null;
  const value = new Headers(init.headers).get(SERVICE_ACCOUNT_TOKEN_HEADER);
  return value && value.trim() ? value : null;
}

/** Release the connection held by a response we are about to discard. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed or already errored — there is nothing left to release.
  }
}

/**
 * Owns the token lifecycle for ONE service account: lazy exchange, cached
 * reuse, refresh on a skew margin, single-flight under concurrency, and
 * single-shot recovery from a mid-flight revocation.
 *
 * Four properties are load-bearing, and each exists because of a specific way
 * a machine workload differs from a browser session:
 *
 * **Lazy.** The exchange happens on FIRST USE, never in the constructor —
 * `HopeClient` construction touching the network is an existing invariant of
 * this package (a client built at module load in a serverless handler must not
 * make a network call to be constructed).
 *
 * **Refreshed early.** A token is replaced `refreshSkewMs` BEFORE it expires,
 * not when a request fails. The margin is clamped to half the token's lifetime
 * so a deliberately short-lived account (`tokenTtlSeconds` below the skew)
 * does not degenerate into one exchange per request.
 *
 * **Single-flight.** A script fanning out 50 concurrent admin reads across the
 * refresh boundary would otherwise fire 50 exchanges — against an endpoint
 * rate-limited to 10/min, which turns a working integration into a 429 storm.
 * All concurrent callers await ONE in-flight exchange.
 *
 * **Recoverable, not poisoned.** A failed exchange (gateway down, secret being
 * rotated) rejects the calls waiting on it and clears the in-flight slot; the
 * next call tries again. There is no permanent failure state to restart a
 * process out of.
 */
export class ServiceAccountTokenProvider {
  readonly #transport: Transport;
  readonly #credentials: RedactedValue<ServiceAccountCredentials>;
  readonly #clientId: string;
  readonly #refreshSkewMs: number;
  readonly #now: () => number;

  #cached: CachedToken | null = null;
  /** The single in-flight exchange, if one is running. THE single-flight latch. */
  #inflight: Promise<string> | null = null;

  constructor(options: ServiceAccountTokenProviderOptions) {
    this.#transport = options.transport;
    this.#credentials = redact(options.credentials);
    this.#clientId = options.credentials.clientId;
    this.#refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The current token, exchanging or refreshing as needed. Safe to call on
   * every request — the common path is a clock comparison and a field read.
   */
  async getToken(): Promise<string> {
    const cached = this.#cached;
    if (cached && this.#now() < cached.refreshAtMs) return cached.token.reveal();
    return this.#exchangeOnce();
  }

  /**
   * Drop `staleToken` from the cache, but ONLY if it is still the token the
   * cache holds. The conditional is what stops a stampede: when several
   * in-flight requests all 401 on the same revoked token, the first one
   * invalidates and re-exchanges, and the rest — arriving with a token that is
   * no longer cached — leave the fresh token alone and simply use it.
   */
  invalidate(staleToken: string): void {
    if (this.#cached?.token.reveal() === staleToken) this.#cached = null;
  }

  /**
   * Wrap a `fetch` so a 401 carrying THIS credential is retried once against a
   * freshly exchanged token.
   *
   * **Why here and not in `Transport`.** Revocation is immediate, so a 401 is
   * not always "your credentials are wrong" — it can mean "the token you were
   * holding died between two requests", which is recoverable and belongs to
   * whoever owns the token lifecycle. Putting it in the fetch layer keeps
   * `Transport` credential-agnostic (it just writes a header) and puts the
   * retry BENEATH `core/retry.ts` — correctly, because a token refresh is not
   * a backoff retry: it must not consume a retry budget, must not sleep, and
   * must happen exactly once regardless of the request's method (401 recovery
   * on a POST is safe here in a way a blind POST retry never is, because the
   * first attempt was REJECTED — the gateway did no work).
   *
   * Requests that carry no service-account token are passed through untouched,
   * as is a second 401: one refresh, one retry, then the caller sees the error.
   */
  authenticatedFetch(inner: typeof fetch): typeof fetch {
    return async (input, init) => {
      const response = await inner(input, init);
      if (response.status !== 401) return response;

      const presented = readServiceAccountToken(init);
      if (!presented) return response;

      this.invalidate(presented);

      let refreshed: string;
      try {
        refreshed = await this.getToken();
      } catch {
        // The re-exchange failed (bad/rotated secret, gateway down). The
        // caller is better served by the ORIGINAL 401 from the route they
        // asked for than by an error about a request they never made.
        return response;
      }
      // Another concurrent caller may already have refreshed; if the token did
      // not actually change there is nothing to retry with.
      if (refreshed === presented) return response;

      await discardBody(response);
      const headers = new Headers(init?.headers);
      headers.set(SERVICE_ACCOUNT_TOKEN_HEADER, refreshed);
      return inner(input, { ...init, headers });
    };
  }

  /**
   * Single-flight gate. The assignment to `#inflight` happens SYNCHRONOUSLY,
   * before `#exchange()` can reach its first `await` and yield — that is what
   * makes the collapse airtight rather than merely likely: every caller in the
   * same tick, and every caller until the exchange settles, sees the latch.
   */
  #exchangeOnce(): Promise<string> {
    const inflight = this.#inflight;
    if (inflight) return inflight;

    const started: Promise<string> = this.#exchange().finally(() => {
      // Cleared on SUCCESS AND FAILURE — a failed exchange must not become a
      // permanent state. The identity check keeps a slow, already-superseded
      // exchange from clearing a newer one's latch.
      if (this.#inflight === started) this.#inflight = null;
    });
    this.#inflight = started;
    return started;
  }

  async #exchange(): Promise<string> {
    const credentials = this.#credentials.reveal();
    const response = await this.#transport.request<ServiceAccountTokenExchangeResponse>({
      method: 'POST',
      path: SERVICE_ACCOUNT_TOKEN_PATH,
      // Not retried: `core/retry.ts` never retries a POST without an
      // idempotency key, which is the behavior we want here — the endpoint is
      // rate-limited to 10/min and each exchange mints a new Redis-backed token.
      body: {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        // Omitted entirely when unset: the gateway distinguishes "no opinion"
        // (resolve SYSTEM) from a presented value it must check the allow-list for.
        ...(credentials.workingTenantId ? { workingTenantId: credentials.workingTenantId } : {}),
      },
    });

    const token = typeof response?.accessToken === 'string' ? response.accessToken.trim() : '';
    const expiresInSeconds = typeof response?.expiresIn === 'number' ? response.expiresIn : 0;
    if (!token || expiresInSeconds <= 0) {
      // Caching a blank token would turn one malformed response into an
      // unauthenticated client that never recovers.
      throw new Error('The service-token exchange returned no usable token (expected `accessToken` and a positive `expiresIn`).');
    }

    const lifetimeMs = expiresInSeconds * 1000;
    // Clamp: with a skew wider than the token's own lifetime, `expiry - skew`
    // is already in the past on arrival and every call re-exchanges.
    const skewMs = Math.min(this.#refreshSkewMs, lifetimeMs / 2);
    this.#cached = { token: redact(token), refreshAtMs: this.#now() + lifetimeMs - skewMs };
    return token;
  }

  // ─── Redaction ────────────────────────────────────────────────────────────
  // The secret and the token are held inside `RedactedValue`s, so neither is
  // reachable through this object even before these hooks run. The hooks exist
  // so the provider still renders as something USEFUL — the public client id —
  // when a client is passed to a logger or `JSON.stringify`d wholesale.

  toString(): string {
    return `ServiceAccountTokenProvider(clientId=${this.#clientId})`;
  }

  toJSON(): string {
    return this.toString();
  }

  [NODE_INSPECT_CUSTOM](): string {
    return this.toString();
  }
}
