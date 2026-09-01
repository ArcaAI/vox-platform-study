import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateRoutingPolicy,
  deleteRoutingPolicy,
  exportRoutingPolicies,
  getEffectiveRoutingPolicy,
  listRoutingPolicies,
  promoteRoutingPolicy,
  setRoutingPolicyDefault,
  updateRoutingPolicy,
} from '../client';
import { routingPolicyKeys } from '../keys';
import { preferredModelStoreBucket } from '../model-store-client';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function installFetchMock(response: () => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return response();
    }),
  );
  return calls;
}

const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

afterEach(() => {
  vi.unstubAllGlobals();
});

const SYSTEM = '00000000-0000-0000-0000-000000000000';
const TENANT = '50000000-0000-0000-0000-000000000000';

describe('routingPolicyKeys', () => {
  it('separates two tenants at the same task key', () => {
    // The screen switches tenancy without navigating, so a key that omitted the
    // tenant would serve one tenant's configurations under another's heading.
    expect(routingPolicyKeys.list(SYSTEM)).not.toEqual(routingPolicyKeys.list(TENANT));
    expect(routingPolicyKeys.effective(SYSTEM, 'text.finalize')).not.toEqual(routingPolicyKeys.effective(TENANT, 'text.finalize'));
  });

  it('separates task keys within one tenant, and is stable for equal inputs', () => {
    expect(routingPolicyKeys.list(SYSTEM, 'text.live')).not.toEqual(routingPolicyKeys.list(SYSTEM, 'text.finalize'));
    expect(routingPolicyKeys.list(SYSTEM, 'text.live')).toEqual(routingPolicyKeys.list(SYSTEM, 'text.live'));
    expect(routingPolicyKeys.list(SYSTEM)).toEqual(routingPolicyKeys.list(SYSTEM, undefined));
  });
});

describe('routing-policy client', () => {
  it('targets the tenant by query parameter on every read', async () => {
    const calls = installFetchMock(() => jsonResponse([]));

    await listRoutingPolicies(TENANT, 'text.finalize');
    await getEffectiveRoutingPolicy(TENANT, 'text.finalize');

    expect(calls[0].url).toContain('admin/routing-policies');
    expect(calls[0].url).toContain(`tenantId=${encodeURIComponent(TENANT)}`);
    expect(calls[0].url).toContain('taskKey=text.finalize');
    expect(calls[1].url).toContain('admin/routing-policies/effective');
    expect(calls[1].url).toContain(`tenantId=${encodeURIComponent(TENANT)}`);
  });

  it('omits an empty taskKey rather than sending taskKey= (the gateway 400s on an unknown key)', async () => {
    const calls = installFetchMock(() => jsonResponse([]));

    await listRoutingPolicies(SYSTEM);

    expect(calls[0].url).not.toContain('taskKey=');
  });

  it('sends If-Match on the election and derives expectedVersion from the ETag on PATCH', async () => {
    const calls = installFetchMock(() => jsonResponse({ id: 'p-1' }, { etag: '"7"' }));

    await setRoutingPolicyDefault(TENANT, 'p-1', '"7"');
    await activateRoutingPolicy(TENANT, 'p-1', '"7"');
    await updateRoutingPolicy(TENANT, 'p-1', { displayName: 'renamed' }, '"7"');

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/p-1/default');
    expect(calls[0].headers.get('if-match')).toBe('"7"');
    expect(calls[1].url).toContain('/p-1/activate');
    expect(calls[1].headers.get('if-match')).toBe('"7"');
    expect(calls[2].method).toBe('PATCH');
    expect(calls[2].headers.get('if-match')).toBe('"7"');
    expect(calls[2].body).toMatchObject({ displayName: 'renamed', expectedVersion: 7 });
  });

  it('names both tenants on a promotion — the source scopes the row, the target receives the copy', async () => {
    const calls = installFetchMock(() => jsonResponse({ id: 'p-2' }));

    await promoteRoutingPolicy(SYSTEM, 'p-1', TENANT);

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/p-1/promote');
    expect(calls[0].url).toContain(`tenantId=${encodeURIComponent(SYSTEM)}`);
    expect(calls[0].url).toContain(`targetTenantId=${encodeURIComponent(TENANT)}`);
  });

  it('scopes a delete by tenant so a foreign id answers 404 rather than deleting anything', async () => {
    const calls = installFetchMock(() => jsonResponse({ id: 'p-1' }));

    await deleteRoutingPolicy(TENANT, 'p-1');

    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain(`tenantId=${encodeURIComponent(TENANT)}`);
  });

  it('comma-joins export task keys and omits the parameter entirely when none are named', async () => {
    const calls = installFetchMock(() => jsonResponse({ formatVersion: 1, configurations: [] }));

    await exportRoutingPolicies(SYSTEM, ['text.live', 'text.finalize']);
    await exportRoutingPolicies(SYSTEM, []);

    expect(decodeURIComponent(calls[0].url)).toContain('taskKeys=text.live,text.finalize');
    expect(calls[1].url).not.toContain('taskKeys=');
  });
});

describe('preferredModelStoreBucket', () => {
  it('prefers a model-ish bucket from the list the server returned', () => {
    expect(preferredModelStoreBucket([{ name: 'hope-media' }, { name: 'hope-models' }])).toBe('hope-models');
  });

  it('falls back to the first listed bucket, and never invents a name', () => {
    expect(preferredModelStoreBucket([{ name: 'hope-media' }])).toBe('hope-media');
    expect(preferredModelStoreBucket([])).toBeNull();
  });
});
