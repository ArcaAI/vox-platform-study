/**
 * One page of directory users, paginated by an opaque
 * provider-specific cursor (`nextPageToken`; MS Graph calls this `@odata.nextLink`,
 * Google Directory calls it `nextPageToken` — both normalized to this shape).
 */
export interface DirectoryUser {
  /** The directory's own user id — becomes `FederatedIdentity.subject`, matching the OIDC `sub` claim space for the SAME IdP tenant. */
  externalId: string;
  email?: string;
  displayName?: string;
  /** Group display names — matched against `TenantIdentityProvider.config.groupToRoleMap`, same key space as the OIDC login-time `groups` claim. */
  groups: string[];
}

export interface DirectoryUserPage {
  users: DirectoryUser[];
  nextPageToken?: string;
}

/**
 * A tenant-supplied directory-API credential bundle, sealed as
 * `TenantIdentityProvider.directoryCredentialsRef` (Vault Transit ciphertext
 * of the JSON-stringified object). Shape is provider-specific; each
 * `IDirectoryProvider` implementation validates its own fields.
 */
export type DirectoryCredentials = Record<string, unknown>;

/** One directory API integration (MS Graph, Google Directory, ...). */
export interface IDirectoryProvider {
  readonly key: 'ms-graph' | 'google-directory';
  fetchUsers(credentials: DirectoryCredentials, pageToken?: string): Promise<DirectoryUserPage>;
}
