import { ApiKeyEntity, AuditAction, EntityId } from '@arcaai/domains';
import { IBaseService } from '../../interfaces';
import { FetchResponse, PaginatedQuery } from '../../common';
import { CreateApiKeyRequest, UpdateApiKeyRequest } from './dto';

export interface CreateApiKeyResult {
  /** The persisted API key entity (keyHash stored, raw key NOT stored) */
  apiKey: ApiKeyEntity;
  /** The raw API key — returned ONLY at creation time. Cannot be retrieved later. */
  rawKey: string;
}

export interface IApiKeyService extends IBaseService {
  // ─── CRUD Operations ────────────────────────────────────────────────

  /**
   * Create a new API key.
   * Generates a cryptographically secure raw key, hashes it with SHA-256,
   * stores the hash, and returns the raw key exactly once.
   *
   * @param request The creation request DTO
   * @returns The persisted entity and the raw key (shown once)
   */
  create(request: CreateApiKeyRequest): Promise<CreateApiKeyResult>;

  /**
   * Fetch all API keys with pagination.
   * Never exposes keyHash in the response.
   */
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<ApiKeyEntity>>;

  /**
   * Fetch all API keys scoped to a tenant.
   */
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<ApiKeyEntity>>;

  /**
   * Fetch all API keys belonging to a specific user.
   */
  fetchAllByUserId(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<ApiKeyEntity>>;

  /**
   * Fetch a single API key by ID.
   */
  fetchById(id: EntityId): Promise<ApiKeyEntity>;

  /**
   * Update an existing API key (name, scopes, allowedIps, rateLimit, status, etc.).
   * Uses change tracking — only modified fields are persisted.
   */
  update(id: EntityId, request: UpdateApiKeyRequest): Promise<ApiKeyEntity>;

  /**
   * Soft-delete an API key.
   */
  deleteById(id: EntityId): Promise<ApiKeyEntity>;

  /**
   * Revoke an API key (sets status to REVOKED with audit trail).
   */
  revokeKey(id: EntityId): Promise<ApiKeyEntity>;

  /**
   * Rotate an API key — creates a new key inheriting the old key's configuration,
   * links them via rotatedFromKeyId/rotatedToKeyId, and sets a 24-hour overlap window.
   *
   * @param apiKeyId The ID of the key to rotate
   * @returns The new raw key (shown once) and the persisted new key entity
   */
  rotateKey(apiKeyId: string): Promise<{ newRawKey: string; newApiKey: ApiKeyEntity }>;

  // ─── Authentication-Support Operations ──────────────────────────────

  /**
   * Find API key by hashing the provided raw key and looking up the hash
   * @param rawKey The raw API key provided by the client
   */
  getByKeyHash(rawKey: string): Promise<ApiKeyEntity | null>;

  /**
   * Update usage statistics for an API key
   * @param apiKeyId The API key ID
   * @param ipAddress Optional IP address of the request
   */
  updateUsage(apiKeyId: string, ipAddress?: string): Promise<void>;

  /**
   * Check if API key is valid (status and expiration)
   * @param apiKey The API key entity
   */
  isKeyValid(apiKey: ApiKeyEntity): { valid: boolean; reason?: string };

  /**
   * Validate that the request IP is allowed by the API key's allowedIps list.
   * Returns true if no allowedIps are configured (allow all).
   */
  isIpAllowed(apiKey: ApiKeyEntity, ipAddress: string): boolean;

  /**
   * Check if the API key's scopes grant access to the requested scope.
   * Deny-all by default: keys with no scopes have no access.
   * Use wildcard '*' scope for unrestricted access.
   */
  hasScope(apiKey: ApiKeyEntity, requiredScope: string): boolean;

  /**
   * Log API key event to audit log
   */
  logKeyEvent(apiKey: ApiKeyEntity, action: AuditAction, eventData: Record<string, unknown>, ipAddress?: string): Promise<void>;

  /**
   * Authenticate a request by raw API key.
   * Hashes the key, looks it up, validates status/expiration, and checks IP allowlist.
   * Updates usage statistics asynchronously.
   *
   * @param rawKey The raw API key string from the request header
   * @param ipAddress Optional client IP address for allowlist enforcement
   * @returns The validated API key entity
   * @throws UnauthorizedException if key is invalid or not found
   * @throws ForbiddenException if IP is not allowed
   */
  authenticateByRawKey(rawKey: string, ipAddress?: string): Promise<ApiKeyEntity>;

  /**
   * Extract API key from an HTTP request.
   * Checks headers: apikey, api-key, x-api-key.
   * Query parameter extraction gated by API_KEY_ALLOW_QUERY_PARAM env var.
   */
  extractApiKeyFromRequest(request: {
    headers: Record<string, string | string[] | undefined>;
    query?: Record<string, string | string[] | undefined>;
    url?: string;
  }): string | null;

  /**
   * Extract API key from a WebSocket upgrade request.
   * Checks headers and URL query parameters.
   */
  extractApiKeyFromWebSocket(request: { headers: Record<string, string | string[] | undefined>; url?: string }): string | null;
}
export const IApiKeyService = Symbol('IApiKeyService');
