import { BadRequestException, Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { DirectoryCredentials, DirectoryUser, DirectoryUserPage, IDirectoryProvider } from './IDirectoryProvider';

interface GoogleDirectoryCredentials {
  serviceAccountEmail: string;
  privateKey: string;
  /** Domain-wide-delegation impersonation target — a Workspace super-admin (or a role with directory read scope). */
  delegatedAdminEmail: string;
  customerId?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DIRECTORY_BASE_URL = 'https://admin.googleapis.com/admin/directory/v1';
const DIRECTORY_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
].join(' ');
const JWT_ASSERTION_TTL_SECONDS = 3600;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/**
 * TASK-498 P3 — Google Workspace Directory provider. Domain-wide-delegated
 * service account, JWT-bearer OAuth2 grant (RFC 7523) — the tenant provisions
 * its own service account + delegates the two read-only directory scopes to
 * it in the Workspace admin console; `delegatedAdminEmail` is the
 * impersonation target the JWT's `sub` claim carries. Gated by
 * `TENANT_IDP_GOOGLE_DIRECTORY_ENABLED` (default OFF).
 */
@Injectable()
export class GoogleDirectoryProvider implements IDirectoryProvider {
  readonly key = 'google-directory' as const;
  private readonly enabled: boolean;
  private tokenCache?: CachedToken;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
  ) {
    this.enabled = String(configService.get('TENANT_IDP_GOOGLE_DIRECTORY_ENABLED') ?? '').toLowerCase() === 'true';
  }

  async fetchUsers(credentials: DirectoryCredentials, pageToken?: string): Promise<DirectoryUserPage> {
    if (!this.enabled) {
      throw new BadRequestException('Google Directory sync is disabled (TENANT_IDP_GOOGLE_DIRECTORY_ENABLED=false)');
    }
    const creds = credentials as unknown as GoogleDirectoryCredentials;
    const accessToken = await this.resolveAccessToken(creds);

    const params = new URLSearchParams({ customer: creds.customerId ?? 'my_customer', maxResults: '100', projection: 'basic' });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${DIRECTORY_BASE_URL}/users?${params.toString()}`;

    const response = await this.httpService.axiosRef.get<{
      users?: Array<{ id: string; primaryEmail?: string; name?: { fullName?: string } }>;
      nextPageToken?: string;
    }>(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    const users: DirectoryUser[] = [];
    for (const raw of response.data.users ?? []) {
      const groups = await this.fetchGroupNames(raw.id, accessToken, creds.customerId);
      users.push({ externalId: raw.id, email: raw.primaryEmail, displayName: raw.name?.fullName, groups });
    }

    return { users, nextPageToken: response.data.nextPageToken };
  }

  /** One `groups?userKey=` call per user — same admin-triggered-bulk-pull tradeoff as the Graph provider. */
  private async fetchGroupNames(userId: string, accessToken: string, customerId?: string): Promise<string[]> {
    const params = new URLSearchParams({ userKey: userId, customer: customerId ?? 'my_customer' });
    const response = await this.httpService.axiosRef.get<{ groups?: Array<{ name?: string }> }>(`${DIRECTORY_BASE_URL}/groups?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return (response.data.groups ?? []).map((g) => g.name).filter((name): name is string => Boolean(name));
  }

  private async resolveAccessToken(credentials: GoogleDirectoryCredentials): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.accessToken;
    }

    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      {
        iss: credentials.serviceAccountEmail,
        scope: DIRECTORY_SCOPES,
        aud: TOKEN_URL,
        sub: credentials.delegatedAdminEmail,
        iat: now,
        exp: now + JWT_ASSERTION_TTL_SECONDS,
      },
      credentials.privateKey,
      { algorithm: 'RS256' },
    );

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString();

    const response = await this.httpService.axiosRef.post<{ access_token: string; expires_in: number; token_type: string }>(TOKEN_URL, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    this.tokenCache = {
      accessToken: response.data.access_token,
      expiresAt: Date.now() + response.data.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS,
    };
    return this.tokenCache.accessToken;
  }
}
