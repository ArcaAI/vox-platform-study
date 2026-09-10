import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { DirectoryCredentials, DirectoryUser, DirectoryUserPage, IDirectoryProvider } from './IDirectoryProvider';

interface MsGraphCredentials {
  azureTenantId: string;
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
// Refresh a little before the IdP's own expiry to avoid a request racing an
// about-to-expire token.
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/**
 * Microsoft Graph directory provider. App-only access via the
 * OAuth2 client-credentials grant (tenant's own Azure AD app registration —
 * distinct from the OIDC login-time client; directory-pull scopes are
 * `User.Read.All`/`GroupMember.Read.All`, application-permission, admin-consented).
 * Availability is decided by the CALLER — `DirectorySyncService.enqueueSync` and
 * `DirectorySyncProcessor` both resolve the per-tenant feature gate, which is the
 * only place a `tenantId` is in hand (TASK-870 item 12).
 */
@Injectable()
export class MsGraphDirectoryProvider implements IDirectoryProvider {
  readonly key = 'ms-graph' as const;
  private tokenCache?: CachedToken;

  constructor(private readonly httpService: HttpService) {}

  async fetchUsers(credentials: DirectoryCredentials, pageToken?: string): Promise<DirectoryUserPage> {
    const creds = credentials as unknown as MsGraphCredentials;
    const accessToken = await this.resolveAccessToken(creds);

    const url = pageToken ?? `${GRAPH_BASE_URL}/users?$select=id,displayName,mail,userPrincipalName&$top=100`;
    const response = await this.httpService.axiosRef.get<{
      value: Array<{ id: string; displayName?: string; mail?: string; userPrincipalName?: string }>;
      '@odata.nextLink'?: string;
    }>(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    const users: DirectoryUser[] = [];
    for (const raw of response.data.value) {
      const groups = await this.fetchGroupNames(raw.id, accessToken);
      users.push({
        externalId: raw.id,
        email: raw.mail ?? raw.userPrincipalName,
        displayName: raw.displayName,
        groups,
      });
    }

    return { users, nextPageToken: response.data['@odata.nextLink'] };
  }

  /** One `memberOf` call per user — acceptable for admin-triggered bulk pulls; a future optimization could switch to `$expand=memberOf` where the tenant's Graph plan supports it. */
  private async fetchGroupNames(userId: string, accessToken: string): Promise<string[]> {
    const response = await this.httpService.axiosRef.get<{ value: Array<{ displayName?: string }> }>(
      `${GRAPH_BASE_URL}/users/${userId}/memberOf?$select=displayName`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    return response.data.value.map((g) => g.displayName).filter((name): name is string => Boolean(name));
  }

  private async resolveAccessToken(credentials: MsGraphCredentials): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: GRAPH_SCOPE,
    }).toString();

    const response = await this.httpService.axiosRef.post<{ access_token: string; expires_in: number; token_type: string }>(
      `https://login.microsoftonline.com/${credentials.azureTenantId}/oauth2/v2.0/token`,
      body,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    this.tokenCache = {
      accessToken: response.data.access_token,
      expiresAt: Date.now() + response.data.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS,
    };
    return this.tokenCache.accessToken;
  }
}
