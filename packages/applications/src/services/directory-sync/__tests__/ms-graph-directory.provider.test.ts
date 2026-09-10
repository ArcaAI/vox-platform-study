import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MsGraphDirectoryProvider } from '../ms-graph-directory.provider';

const CREDENTIALS = { azureTenantId: 'aad-tenant-1', clientId: 'client-abc', clientSecret: 'secret-xyz' };

function makeProvider() {
  const post = vi.fn();
  const get = vi.fn();
  const httpService = { axiosRef: { post, get } };
  const provider = new MsGraphDirectoryProvider(httpService as never);
  return { provider, post, get };
}

describe('MsGraphDirectoryProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  // The availability test that was here asserted a platform-wide env var frozen in
  // this class's constructor. TASK-870 item 12 moved that decision to the two
  // callers that hold a `tenantId` — this class never did, so it could not have
  // answered per tenant. Coverage lives in
  // `directory-sync.feature-gate.task870.test.ts`.

  it('fetches a client-credentials token, then lists users with group memberships', async () => {
    const { provider, post, get } = makeProvider();
    post.mockResolvedValue({ data: { access_token: 'graph-token', expires_in: 3600, token_type: 'Bearer' } });
    get
      .mockResolvedValueOnce({
        data: {
          value: [{ id: 'u1', displayName: 'Doc One', mail: 'doc1@acme.com' }],
        },
      })
      .mockResolvedValueOnce({ data: { value: [{ displayName: 'acme-clinicians' }] } });

    const page = await provider.fetchUsers(CREDENTIALS);

    expect(post).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/aad-tenant-1/oauth2/v2.0/token',
      expect.stringContaining('client_id=client-abc'),
      expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded' }) }),
    );
    const usersCallUrl = get.mock.calls[0][0] as string;
    expect(usersCallUrl).toContain('https://graph.microsoft.com/v1.0/users');
    const usersCallHeaders = get.mock.calls[0][1] as { headers: Record<string, string> };
    expect(usersCallHeaders.headers.Authorization).toBe('Bearer graph-token');

    expect(page.users).toHaveLength(1);
    expect(page.users[0]).toMatchObject({ externalId: 'u1', email: 'doc1@acme.com', displayName: 'Doc One', groups: ['acme-clinicians'] });
    expect(page.nextPageToken).toBeUndefined();
  });

  it('reuses the cached token across pages within its TTL (no re-auth per page)', async () => {
    const { provider, post, get } = makeProvider();
    post.mockResolvedValue({ data: { access_token: 'graph-token', expires_in: 3600, token_type: 'Bearer' } });
    get.mockResolvedValue({ data: { value: [] } });

    await provider.fetchUsers(CREDENTIALS);
    await provider.fetchUsers(CREDENTIALS, 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc');

    expect(post).toHaveBeenCalledTimes(1);
  });

  it('propagates the full @odata.nextLink as nextPageToken for the next page', async () => {
    const { provider, post, get } = makeProvider();
    post.mockResolvedValue({ data: { access_token: 'graph-token', expires_in: 3600, token_type: 'Bearer' } });
    get.mockResolvedValueOnce({
      data: { value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=next-page' },
    });

    const page = await provider.fetchUsers(CREDENTIALS);

    expect(page.nextPageToken).toBe('https://graph.microsoft.com/v1.0/users?$skiptoken=next-page');
  });

  it('uses the pageToken verbatim as the request URL when paging', async () => {
    const { provider, post, get } = makeProvider();
    post.mockResolvedValue({ data: { access_token: 'graph-token', expires_in: 3600, token_type: 'Bearer' } });
    get.mockResolvedValue({ data: { value: [] } });

    await provider.fetchUsers(CREDENTIALS, 'https://graph.microsoft.com/v1.0/users?$skiptoken=page2');

    expect(get.mock.calls[0][0]).toBe('https://graph.microsoft.com/v1.0/users?$skiptoken=page2');
  });
});
