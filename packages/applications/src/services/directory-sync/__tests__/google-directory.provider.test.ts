import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn(() => 'signed-jwt-assertion') },
}));

import { GoogleDirectoryProvider } from '../google-directory.provider';

const CREDENTIALS = {
  serviceAccountEmail: 'sync@acme.iam.gserviceaccount.com',
  privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
  delegatedAdminEmail: 'admin@acme.com',
  customerId: 'my_customer',
};

function makeProvider() {
  const post = vi.fn();
  const get = vi.fn();
  const httpService = { axiosRef: { post, get } };
  const provider = new GoogleDirectoryProvider(httpService as never);
  return { provider, post, get };
}

describe('GoogleDirectoryProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  // The availability test that was here asserted a platform-wide env var frozen in
  // this class's constructor. TASK-870 item 12 moved that decision to the two
  // callers that hold a `tenantId` — this class never did, so it could not have
  // answered per tenant. Coverage lives in
  // `directory-sync.feature-gate.task870.test.ts`.

  it('exchanges a signed JWT assertion for an access token, then lists users with group memberships', async () => {
    const { provider, post, get } = makeProvider();
    post.mockResolvedValue({ data: { access_token: 'google-token', expires_in: 3600, token_type: 'Bearer' } });
    get
      .mockResolvedValueOnce({
        data: { users: [{ id: 'u1', name: { fullName: 'Doc One' }, primaryEmail: 'doc1@acme.com' }] },
      })
      .mockResolvedValueOnce({ data: { groups: [{ name: 'acme-clinicians' }] } });

    const page = await provider.fetchUsers(CREDENTIALS);

    expect(post).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.stringContaining('assertion=signed-jwt-assertion'),
      expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded' }) }),
    );
    const usersCallUrl = get.mock.calls[0][0] as string;
    expect(usersCallUrl).toContain('https://admin.googleapis.com/admin/directory/v1/users');
    expect(usersCallUrl).toContain('customer=my_customer');
    const usersCallHeaders = get.mock.calls[0][1] as { headers: Record<string, string> };
    expect(usersCallHeaders.headers.Authorization).toBe('Bearer google-token');

    expect(page.users).toHaveLength(1);
    expect(page.users[0]).toMatchObject({ externalId: 'u1', email: 'doc1@acme.com', displayName: 'Doc One', groups: ['acme-clinicians'] });
  });

  it('reuses the cached token across pages within its TTL (no re-auth per page)', async () => {
    const { provider, post, get } = makeProvider();
    post.mockResolvedValue({ data: { access_token: 'google-token', expires_in: 3600, token_type: 'Bearer' } });
    get.mockResolvedValue({ data: { users: [] } });

    await provider.fetchUsers(CREDENTIALS);
    await provider.fetchUsers(CREDENTIALS, 'a-page-token');

    expect(post).toHaveBeenCalledTimes(1);
  });

  it('propagates Google Directory nextPageToken', async () => {
    const { provider, post, get } = makeProvider();
    post.mockResolvedValue({ data: { access_token: 'google-token', expires_in: 3600, token_type: 'Bearer' } });
    get.mockResolvedValueOnce({ data: { users: [], nextPageToken: 'next-page' } });

    const page = await provider.fetchUsers(CREDENTIALS);

    expect(page.nextPageToken).toBe('next-page');
  });
});
