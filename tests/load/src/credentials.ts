/**
 * Acquiring the three credential classes the platform actually serves.
 *
 * The machine plane is not a garnish on this harness. `TieredThrottlerGuard`
 * resolves a bucket from the credential and, for ranks 1-3, keys it
 * `t:<tenantId>` with NO route and NO principal component — so a tenant's API
 * keys and service accounts spend the SAME budget as its 100 doctors. A run
 * that only simulates humans measures a tenant that does not exist.
 *
 * Three classes, three headers, and one trap worth stating: a service-account
 * token binds its working tenant AT EXCHANGE, so `X-Tenant-Id` must NOT be sent
 * alongside it. Sending both is the most common way to make a machine lane look
 * broken when it is the caller that is wrong.
 */
import { issue, type Credential } from './http';
import type { PrincipalKind } from './types';

export interface AcquireContext {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly pgConnectTimeoutMs: number;
  readonly t0Ms: number;
}

/** The unauthenticated credential used to bootstrap the others. */
const ANONYMOUS: Credential = { kind: 'human', tenantId: '-', label: 'anonymous', headers: {} };

export class CredentialError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'CredentialError';
  }
}

/**
 * A human session.
 *
 * `tenantKey` is required for everyone except a super admin — a tenant user who
 * omits it authenticates against the wrong tenant or not at all. `workingTenantId`
 * adds `X-Tenant-Id`, which is how a super admin acts on a tenant's data.
 */
export async function loginHuman(
  ctx: AcquireContext,
  input: { username: string; password: string; tenantKey?: string; tenantId: string; workingTenantId?: string },
): Promise<Credential> {
  const result = await issue({
    baseUrl: ctx.baseUrl,
    credential: ANONYMOUS,
    method: 'POST',
    path: 'auth/login',
    body: { username: input.username, password: input.password, ...(input.tenantKey ? { tenantKey: input.tenantKey } : {}) },
    timeoutMs: ctx.timeoutMs,
    pgConnectTimeoutMs: ctx.pgConnectTimeoutMs,
    t0Ms: ctx.t0Ms,
  });

  const token = (result.body as { token?: string } | null)?.token;
  if (!token) {
    // A 429 here is worth naming explicitly: `POST auth/login` carries a
    // decorator value of 5/min on an IP-keyed bucket (TASK-993 D-1/§2.2), so a
    // harness that logs 1,000 users in from one host locks itself out before the
    // run starts. `bootstrapCredentials` paces around it; this message is what
    // tells you when the pacing was not enough.
    throw new CredentialError(`login failed for ${input.username} (HTTP ${result.sample.status ?? 'transport'})`, result.sample.status);
  }

  return {
    kind: 'human',
    tenantId: input.tenantId,
    label: input.username,
    headers: {
      authorization: `Bearer ${token}`,
      ...(input.workingTenantId ? { 'x-tenant-id': input.workingTenantId } : {}),
    },
  };
}

/** An API key is presented verbatim; there is nothing to exchange. */
export function apiKeyCredential(input: { key: string; tenantId: string; label: string }): Credential {
  return { kind: 'api_key', tenantId: input.tenantId, label: input.label, headers: { 'x-api-key': input.key } };
}

/**
 * Exchange a service account's `clientId`/`clientSecret` for the opaque
 * `X-Service-Account-Token`.
 *
 * Deliberately emits NO `X-Tenant-Id`: the working tenant is bound by this
 * exchange, and sending the header alongside the token is the API-key intuition
 * that does not transfer.
 */
export async function exchangeServiceAccount(
  ctx: AcquireContext,
  input: { clientId: string; clientSecret: string; tenantId: string; workingTenantId?: string; label: string },
): Promise<Credential> {
  const result = await issue({
    baseUrl: ctx.baseUrl,
    credential: ANONYMOUS,
    method: 'POST',
    path: 'auth/service-token',
    body: {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      ...(input.workingTenantId ? { workingTenantId: input.workingTenantId } : {}),
    },
    timeoutMs: ctx.timeoutMs,
    pgConnectTimeoutMs: ctx.pgConnectTimeoutMs,
    t0Ms: ctx.t0Ms,
  });

  const accessToken = (result.body as { accessToken?: string } | null)?.accessToken;
  if (!accessToken) {
    throw new CredentialError(
      `service-token exchange failed for ${input.clientId} (HTTP ${result.sample.status ?? 'transport'})`,
      result.sample.status,
    );
  }

  return {
    kind: 'service_account',
    tenantId: input.tenantId,
    label: input.label,
    headers: { 'x-service-account-token': accessToken },
  };
}

/**
 * A human session WITHOUT paying for a login.
 *
 * The bootstrap problem is real: `auth/login` is 5/min on a bucket shared by
 * every caller from this host, so acquiring 1,000 distinct sessions honestly
 * takes 200 minutes. Two ways out, and the harness supports both:
 *
 *   - `reuse` (default): log in ONCE per tenant and let that tenant's virtual
 *     users share the token. The tenant bucket — the thing under test — is
 *     unaffected, because it is keyed `t:<tenantId>` with no principal
 *     component. What it CANNOT exercise is a per-principal bucket, which is
 *     exactly what OD-2 proposes to add, so a run against a platform that has
 *     adopted OD-2 must use `distinct`.
 *   - `distinct`: one login per user, paced under the limit. Correct, and slow.
 *
 * The choice is recorded in the report so a reader can never mistake a `reuse`
 * run for evidence about per-principal bucketing.
 */
export type SessionStrategy = 'reuse' | 'distinct';

export interface PrincipalSpec {
  readonly kind: PrincipalKind;
  readonly tenantId: string;
  readonly label: string;
  readonly username?: string;
  readonly password?: string;
  readonly tenantKey?: string;
  readonly apiKey?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly workingTenantId?: string;
}

export async function acquire(ctx: AcquireContext, spec: PrincipalSpec): Promise<Credential> {
  switch (spec.kind) {
    case 'human':
      if (!spec.username || !spec.password) throw new CredentialError(`human principal ${spec.label} needs username+password`, null);
      return loginHuman(ctx, {
        username: spec.username,
        password: spec.password,
        tenantKey: spec.tenantKey,
        tenantId: spec.tenantId,
        workingTenantId: spec.workingTenantId,
      });
    case 'api_key':
      if (!spec.apiKey) throw new CredentialError(`api_key principal ${spec.label} needs apiKey`, null);
      return apiKeyCredential({ key: spec.apiKey, tenantId: spec.tenantId, label: spec.label });
    case 'service_account':
      if (!spec.clientId || !spec.clientSecret) throw new CredentialError(`service_account ${spec.label} needs clientId+clientSecret`, null);
      return exchangeServiceAccount(ctx, {
        clientId: spec.clientId,
        clientSecret: spec.clientSecret,
        tenantId: spec.tenantId,
        workingTenantId: spec.workingTenantId,
        label: spec.label,
      });
  }
}
