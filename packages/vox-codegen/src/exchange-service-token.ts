/**
 * `POST /api/v1/auth/service-token` — the SERVICE-ACCOUNT credential exchange
 * (TASK-933).
 *
 * ## Why this tool needs it
 *
 * `--tenant` mode reads a tenant's consultation context schema so an integrator
 * can generate types for it. Until TASK-933 the only credential that route
 * accepted was a SUPER-ADMIN JWT — a human's token, with a human's expiry,
 * which is the wrong thing to put in a build pipeline. The owner opened
 * `GET tenants/me/context-schema` to a service account holding
 * `svc:tenant:context-schema:read`, and this is the half that turns a
 * `(clientId, clientSecret)` pair into the token that reads it.
 *
 * ## Two things that are easy to get wrong
 *
 * 1. **The working tenant binds HERE, not per request.** The token carries its
 *    tenant, resolved once at exchange, so the discovery read that follows must
 *    NOT send `X-Tenant-Id` — a second, conflicting statement of tenancy.
 * 2. **The token is presented in `X-Service-Account-Token`, never as
 *    `Authorization: Bearer`**, despite `tokenType: 'Bearer'` in the response.
 *    The gateway selects its credential branch on WHICH HEADER arrived.
 *
 * The client secret never appears in an error message here. A failed exchange
 * reports the status and the gateway's body; a tool that echoed the secret into
 * CI logs would be a worse outcome than the failure it was reporting.
 */

import { CodegenError } from './errors';

const API_PREFIX = '/api/v1';

/** The service-account credential pair, plus the tenant to bind the token to. */
export interface ExchangeServiceAccountTokenOptions {
  /** Gateway origin. May include a trailing `/api/v1` — normalized away. */
  baseUrl: string;
  /** Public client identifier (`hope_svc_…`). Not a secret. */
  clientId: string;
  /** Issued once, at creation or rotation. Never logged, never in a URL, never in an error. */
  clientSecret: string;
  /**
   * PLATFORM accounts only: the tenant this token acts on. Must be in the
   * account's allow-list, or the exchange 403s. Omitted resolves the SYSTEM
   * tenant — which has no consultation context schema, so a codegen run wants
   * this set. Ignored by the gateway for a tenant-bound account.
   */
  workingTenantId?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The `POST /api/v1/auth/service-token` response body. */
export interface ServiceAccountToken {
  /** Opaque — a server-validated random string, never a JWT. There is nothing to decode. */
  accessToken: string;
  tokenType: string;
  /** Seconds until expiry (gateway default 900). */
  expiresIn: number;
  /** The `svc:*` scopes the token carries — the first thing to read when a later call 403s. */
  scopes: string[];
  /** The working tenant bound at this exchange. */
  tenantId: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith(API_PREFIX) ? base.slice(0, -API_PREFIX.length) : base;
}

/** Exchange the credential pair for a short-lived opaque token. Throws {@link CodegenError} on any failure. */
export async function exchangeServiceAccountToken(options: ExchangeServiceAccountTokenOptions): Promise<ServiceAccountToken> {
  const url = `${normalizeBaseUrl(options.baseUrl)}${API_PREFIX}/auth/service-token`;
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        ...(options.workingTenantId ? { workingTenantId: options.workingTenantId } : {}),
      }),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new CodegenError(`Failed to reach ${url}: ${reason}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new CodegenError(
      `POST ${url} returned ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}. ` +
        'Check the client id, the secret, and that the account is allowed to act on this working tenant.',
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new CodegenError(`POST ${url} returned a body that could not be parsed as JSON: ${reason}`);
  }

  const parsed = raw as Partial<ServiceAccountToken> | null;
  if (!parsed || typeof parsed.accessToken !== 'string' || parsed.accessToken === '') {
    throw new CodegenError(`POST ${url} returned no \`accessToken\` — the response was not a service-token exchange result.`);
  }

  return {
    accessToken: parsed.accessToken,
    tokenType: typeof parsed.tokenType === 'string' ? parsed.tokenType : 'Bearer',
    expiresIn: typeof parsed.expiresIn === 'number' ? parsed.expiresIn : 0,
    scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
    tenantId: typeof parsed.tenantId === 'string' ? parsed.tenantId : '',
  };
}
