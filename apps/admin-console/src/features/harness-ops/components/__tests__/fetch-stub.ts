import { vi } from 'vitest';

export interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

export type FetchHandler = (call: RecordedCall) => Response | unknown;

/** The SafeSession the WorkingTenantGate reads from /api/auth/session. */
export function sessionPayload(overrides: { isElevated?: boolean; workingTenantId?: string | null } = {}) {
  const isElevated = overrides.isElevated ?? true;
  const workingTenantId = overrides.workingTenantId === undefined ? 'tnt-1' : overrides.workingTenantId;
  const user = { id: 'u-1', username: 'admin', email: 'a@x.io', roles: isElevated ? ['GLOBAL_ADMIN'] : ['TENANT_ADMIN'] };
  return {
    user,
    isElevated,
    workingTenantId,
    workingTenantName: workingTenantId ? 'Sunrise Medical Group' : null,
    impersonatingUserId: null,
    impersonatingUsername: null,
    // WorkingTenantGate now reads the effective identity; these
    // fixtures never impersonate, so it mirrors the operator fields.
    effectiveUser: { ...user, tenantId: null, departmentId: null },
    effectiveIsElevated: isElevated,
    effectiveTenantId: workingTenantId,
  };
}

/**
 * Stubs global fetch (per the feature-api test pattern): records every call
 * and lets the test branch on URL/method. Return a Response for full control
 * or any JSON-serializable value for a 200. Callers unstub in afterEach.
 */
export function installFetchStub(handle: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const result = handle(call);
      return result instanceof Response ? result : Response.json(result ?? { success: true });
    }),
  );
  return calls;
}
