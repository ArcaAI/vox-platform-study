import {
  ApiKeyEntity,
  ApiKeyFactory,
  ApiKeyRepository,
  ApiKeyStatus,
  ApiKeyType,
  AuditAction,
  EntityId,
  ResourceType,
  SysEventType,
  UserDepartmentRepository,
  UserRepository,
  UserRoleAssignmentRepository,
} from '@arcaai/domains';
import { ArgumentInvalidException, InternalServerErrorException } from '@arcaai/exceptions';
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, createHmac, randomBytes } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../common';
import { assertUserBelongsToTenant } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import { SUPER_ADMIN_ROLE } from '../tenant/constants';
import { CreateApiKeyResult, IApiKeyService } from './IApiKeyService';
import { CreateApiKeyRequest, UpdateApiKeyRequest } from './dto';

/**
 * Key prefix used for all generated API keys.
 * Format: hope_{keyType}_{randomHex}_{checksum}
 */
const KEY_SERVICE_PREFIX = 'hope';

/**
 * Map ApiKeyType enum to short prefix codes used in the raw key string.
 */
const KEY_TYPE_PREFIX: Record<ApiKeyType, string> = {
  [ApiKeyType.SDK]: 'sk',
  [ApiKeyType.WEBHOOK]: 'wh',
  [ApiKeyType.INTEGRATION]: 'int',
  [ApiKeyType.SERVICE_ACCOUNT]: 'sa',
};

/**
 * Minimum length for a structurally valid API key.
 * e.g. "hope_sk_<32-hex>_<6-checksum>" = ~50 chars
 */
const MIN_KEY_LENGTH = 20;

/**
 * Regex for the expected raw key format:
 *   {service}_{typePrefix}_{hex(32+)}_{checksum(6)}
 */
const KEY_FORMAT_REGEX = /^[a-z]+_[a-z]+_[a-f0-9]{32,}_[a-f0-9]{6}$/;

/**
 * API Key Service
 *
 * Implements secure API key management following industry best practices:
 * - SHA-256 hashing for key storage (irretrievable keys)
 * - Checksum validation for fast rejection
 * - Cryptographically secure key generation
 * - Full CRUD lifecycle with audit logging
 * - IP allowlist and scope enforcement helpers
 *
 * Key Format: {service}_{type}_{random}_{checksum}
 * Example: hope_sk_a5c5e56x54c4437fbd6ce7dee9xxxx_631238
 */
@Injectable()
export class ApiKeyService extends BaseService implements IApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    private readonly apiKeyRepository: ApiKeyRepository,
    // TASK-305 D.5.2 — needed by `assertUserBelongsToTenant` to enforce that
    // the user the key is being issued for actually has a role-assignment in
    // the effective tenant.
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    // TASK-305 Phase F — membership is role + department; the guard needs the
    // department join table and the User table. Service-account API keys
    // (`ApiKeyType.SERVICE_ACCOUNT`) are issued to service-account users, which
    // are exempt from the department half via the User lookup.
    private readonly userDepartmentRepository: UserDepartmentRepository,
    private readonly userRepository: UserRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // TASK-302 Phase 3 Task 3.3 — API_KEY_PEPPER now arrives via the
    // SecretsService (cache-warmed at boot). Optional so legacy test
    // fixtures that construct ApiKeyService directly still work (they
    // get plain SHA-256 with no pepper, matching the existing fallback).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // TASK-392 (Phase 3, C6) — optional (append-only DI); enforces the plan
    // `maxApiKeys` quota on create (kill-switch-gated, no-op when OFF).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
  ) {
    super(eventEmitter, clsService, ResourceType.ApiKey);
  }

  // ─── Key Generation Utilities ───────────────────────────────────────

  /**
   * Generate a cryptographically secure raw API key.
   *
   * Format: {service}_{typePrefix}_{randomHex(32)}_{checksum(6)}
   * The checksum is the first 6 hex characters of the SHA-256 hash of the
   * random portion, allowing fast client-side rejection without a DB lookup.
   */
  static generateRawKey(keyType: ApiKeyType = ApiKeyType.SDK): string {
    const typePrefix = KEY_TYPE_PREFIX[keyType] || 'sk';
    const randomPart = randomBytes(32).toString('hex'); // 64 hex chars
    const checksum = createHash('sha256').update(randomPart).digest('hex').substring(0, 6);

    return `${KEY_SERVICE_PREFIX}_${typePrefix}_${randomPart}_${checksum}`;
  }

  /**
   * Hash an API key using SHA-256, optionally peppered with HMAC.
   *
   * Pure function: takes the pepper as an explicit parameter instead of
   * reading process.env. The instance-method counterpart `hashKeyForStorage`
   * resolves the pepper from SecretsService (TASK-302 Phase 3 Task 3.3).
   * Kept static so direct callers (tests, future tools) can compute a
   * hash deterministically given a known pepper.
   */
  static hashKey(rawKey: string, pepper?: string): string {
    if (pepper) {
      return createHmac('sha256', pepper).update(rawKey).digest('hex');
    }
    return createHash('sha256').update(rawKey).digest('hex');
  }

  /**
   * Instance-method wrapper around the static hashKey. Resolves
   * API_KEY_PEPPER from SecretsService (cache-warmed at boot). When
   * SecretsService is not provided (legacy tests), falls back to plain
   * SHA-256 — same behavior as the pre-migration static method when
   * env was unset.
   */
  async hashKeyForStorage(rawKey: string): Promise<string> {
    const pepper = (await this.secretsService?.getSecretOptional('API_KEY_PEPPER')) ?? undefined;
    return ApiKeyService.hashKey(rawKey, pepper);
  }

  /**
   * Extract the key prefix (first 12 characters) for safe identification.
   */
  static extractPrefix(rawKey: string): string {
    return rawKey.substring(0, 12);
  }

  /**
   * Extract checksum from a key (last segment after final underscore).
   */
  static extractChecksum(rawKey: string): string | null {
    const parts = rawKey.split('_');
    if (parts.length >= 2) {
      return parts[parts.length - 1];
    }
    return null;
  }

  /**
   * Validate key format against the expected structure.
   * Expected format: {service}_{type}_{randomHex(32+)}_{checksum(6)}
   */
  static isValidKeyFormat(rawKey: string): boolean {
    if (!rawKey || rawKey.length < MIN_KEY_LENGTH) {
      return false;
    }

    // Must have at least 4 segments: service_type_random_checksum
    const parts = rawKey.split('_');
    if (parts.length < 4) {
      return false;
    }

    // Validate the overall structure with regex
    return KEY_FORMAT_REGEX.test(rawKey);
  }

  /**
   * Validate checksum for fast rejection without DB lookup.
   */
  validateChecksum(rawKey: string, storedChecksum: string | null): boolean {
    if (!storedChecksum) {
      // If no checksum stored, skip validation (backward compatibility)
      return true;
    }
    const extractedChecksum = ApiKeyService.extractChecksum(rawKey);
    return extractedChecksum === storedChecksum;
  }

  // ─── CRUD Operations ────────────────────────────────────────────────

  /**
   * Create a new API key.
   *
   * 1. Generates a cryptographically secure raw key
   * 2. Hashes the raw key with SHA-256 for storage
   * 3. Stores the hash, prefix, and checksum (never the raw key)
   * 4. Returns the raw key exactly once — it cannot be retrieved later
   */
  async create(request: CreateApiKeyRequest): Promise<CreateApiKeyResult> {
    const keyType = request.keyType ?? ApiKeyType.SDK;

    // TASK-305 D.5.2 (audit C-8 / M-1) — pin the working tenantId to CLS
    // unless the caller is SUPER_ADMIN and explicitly overrides via the DTO
    // (legitimate cross-tenant support flow). Anyone else passing a different
    // `request.tenantId` is attempting privilege escalation.
    const callerTenantId = this.tenantId ?? null;
    const requestedTenantId = request.tenantId;
    const isExplicitCrossTenant = requestedTenantId !== undefined && requestedTenantId !== null && requestedTenantId !== callerTenantId;

    let effectiveTenantId: string | null;
    if (isExplicitCrossTenant) {
      if (!this.isSuperAdmin()) {
        throw new ForbiddenException('Cross-tenant API key creation is not permitted');
      }
      effectiveTenantId = requestedTenantId;
    } else {
      effectiveTenantId = callerTenantId;
    }

    if (!effectiveTenantId && keyType !== ApiKeyType.SERVICE_ACCOUNT) {
      throw new ArgumentInvalidException(
        'API keys must be created within a tenant context. ' + 'Only SERVICE_ACCOUNT keys can be created without a tenant.',
      );
    }

    const userId = this.requestUser?.id ?? null;
    if (!userId && keyType !== ApiKeyType.SERVICE_ACCOUNT) {
      throw new ArgumentInvalidException(
        'API keys must be linked to the creating user. ' + 'Only SERVICE_ACCOUNT keys can be created without a user context.',
      );
    }

    // TASK-305 D.5.2 (audit C-8) — verify that the caller's userId actually
    // has an enabled role-assignment in the tenant the key is scoped to. The
    // SUPER_ADMIN bypass exists for cross-tenant support flows (super_admin
    // is rarely a member of every tenant they administer). SERVICE_ACCOUNT
    // keys skip the check because they may have no associated user at all.
    if (userId && effectiveTenantId && keyType !== ApiKeyType.SERVICE_ACCOUNT && !this.isSuperAdmin()) {
      await assertUserBelongsToTenant(
        this.userRoleAssignmentRepository,
        this.userDepartmentRepository,
        this.userRepository,
        userId,
        effectiveTenantId,
      );
    }

    // TASK-392 (Phase 3, C6) — plan quota precheck. Scoped to a concrete tenant
    // (tenantless SERVICE_ACCOUNT keys are ungated). Kill-switch-gated (Q9); the
    // COUNT only runs when enforcement is ON, and `assertQuantityQuota` throws
    // `QuotaExceededException` (→ 409) if issuing one more exceeds `maxApiKeys`.
    if (effectiveTenantId && this.entitlements?.isEnforcementEnabled()) {
      const currentCount = await this.apiKeyRepository.count({ where: { tenantId: effectiveTenantId } });
      await this.entitlements.assertQuantityQuota(effectiveTenantId, 'maxApiKeys', currentCount);
    }

    // eslint-disable-next-line turbo/no-undeclared-env-vars
    const maxLifetimeDays = process.env.API_KEY_MAX_LIFETIME_DAYS ? parseInt(process.env.API_KEY_MAX_LIFETIME_DAYS, 10) : null;

    let expiresAt = request.expiresAt ? new Date(request.expiresAt) : null;

    if (maxLifetimeDays && maxLifetimeDays > 0) {
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + maxLifetimeDays);

      if (expiresAt && expiresAt > maxDate) {
        throw new ArgumentInvalidException(`API key expiration exceeds maximum allowed lifetime of ${maxLifetimeDays} days`);
      }

      if (!expiresAt) {
        expiresAt = maxDate;
      }
    }

    const rawKey = ApiKeyService.generateRawKey(keyType);
    const keyHash = await this.hashKeyForStorage(rawKey);
    const keyPrefix = ApiKeyService.extractPrefix(rawKey);
    const keyChecksum = ApiKeyService.extractChecksum(rawKey);

    const newApiKey = ApiKeyFactory.CreateApiKey({
      keyName: request.keyName,
      keyHash,
      keyPrefix,
      keyChecksum,
      keyType,
      keyStatus: ApiKeyStatus.ACTIVE,
      scopes: request.scopes ?? null,
      allowedIps: request.allowedIps ?? null,
      rateLimit: request.rateLimit ?? 0,
      expiresAt,
      usageCount: 0,
      description: request.description ?? null,
      environment: request.environment ?? null,
      userId,
      tenantId: effectiveTenantId ?? null,
      createdBy: userId,
    });

    const apiKey = await this.apiKeyRepository.create(newApiKey);

    if (!apiKey) {
      throw new InternalServerErrorException(`Failed to create API key: ${request.keyName}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: apiKey.id,
      createdAt: apiKey.createdAt,
      data: {
        keyName: apiKey.keyName,
        keyPrefix: apiKey.keyPrefix,
        keyType: apiKey.keyType,
        environment: apiKey.environment,
        userId: apiKey.userId,
      },
    });

    this.logger.log({
      message: 'API key created',
      keyId: apiKey.id,
      keyName: apiKey.keyName,
      keyPrefix: apiKey.keyPrefix,
      keyType: apiKey.keyType,
    });

    return { apiKey, rawKey };
  }

  /**
   * Fetch all API keys with pagination.
   *
   * TASK-305 D.5.2 (audit M-1) — scoped to the caller's CLS tenantId so a
   * Tenant-A admin cannot enumerate Tenant-B keys. SUPER_ADMIN bypasses.
   */
  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<ApiKeyEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
    const tenantScopedWhere = this.buildTenantWhere();

    const [apiKeys, count] = await Promise.all([
      this.apiKeyRepository.findAll({
        ...withFormattedPaginatedProps(props),
        where: tenantScopedWhere,
      }),
      this.apiKeyRepository.count({
        ...withFormattedCountProps(props),
        where: tenantScopedWhere,
      }),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: apiKeys.map((key: ApiKeyEntity) => key.id),
      },
    });

    return new FetchResponse<ApiKeyEntity>({
      data: apiKeys,
      count,
      limit,
      page,
    });
  }

  /**
   * Fetch all API keys scoped to a specific tenant.
   *
   * TASK-306 P1.5 (audit AC-7 / NEW-4) — refuse cross-tenant list reads
   * driven by the DTO `tenantId`. Pre-guard, a Tenant-A admin could
   * enumerate Tenant-B API keys by passing a foreign `tenantId`.
   * SUPER_ADMIN bypasses for admin-tooling cross-tenant listing.
   */
  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<ApiKeyEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { tenantId, limit, page, search } = props;

    if (tenantId !== this.tenantId && !this.isSuperAdmin()) {
      throw new NotFoundException('Resource not found');
    }

    const apiKeys = await this.apiKeyRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: { tenantId },
    });

    const count = await this.apiKeyRepository.count({
      ...withFormattedCountProps(props),
      where: { tenantId },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        tenantId,
        items: apiKeys.map((key: ApiKeyEntity) => key.id),
      },
    });

    return new FetchResponse<ApiKeyEntity>({
      data: apiKeys,
      count,
      limit,
      page,
    });
  }

  /**
   * Fetch all API keys belonging to a specific user.
   *
   * TASK-305 D.5.2 — `userId` filter is merged with the caller's CLS
   * tenantId so a Tenant-A admin cannot enumerate keys belonging to that
   * user in Tenant-B. SUPER_ADMIN bypasses.
   */
  async fetchAllByUserId(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<ApiKeyEntity>> {
    const { userId, limit, page } = props;
    const tenantScopedWhere = this.buildTenantWhere({ userId });

    const [apiKeys, count] = await Promise.all([
      this.apiKeyRepository.findAll({
        ...withFormattedPaginatedProps(props),
        where: tenantScopedWhere,
      }),
      this.apiKeyRepository.count({
        ...withFormattedCountProps(props),
        where: tenantScopedWhere,
      }),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        userId,
        items: apiKeys.map((key: ApiKeyEntity) => key.id),
      },
    });

    return new FetchResponse<ApiKeyEntity>({
      data: apiKeys,
      count,
      limit,
      page,
    });
  }

  /**
   * Fetch a single API key by ID.
   *
   * TASK-305 D.5.2 (audit M-1) — load-then-assert. Cross-tenant ids throw
   * `NotFoundException` (never `Forbidden`) so existence is not leaked.
   */
  async fetchById(id: EntityId): Promise<ApiKeyEntity> {
    const apiKey = await this.apiKeyRepository.findById(id);
    this.assertKeyAccess(apiKey, id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: apiKey.id,
      data: {
        keyName: apiKey.keyName,
        keyPrefix: apiKey.keyPrefix,
        keyType: apiKey.keyType,
      },
    });

    return apiKey;
  }

  /**
   * Update an existing API key.
   * Uses entity change tracking — only modified fields are persisted.
   */
  async update(id: EntityId, request: UpdateApiKeyRequest): Promise<ApiKeyEntity> {
    const apiKey = await this.apiKeyRepository.findById(id);
    this.assertKeyAccess(apiKey, id);

    const previousData = {
      keyName: apiKey.keyName,
      keyStatus: apiKey.keyStatus,
      scopes: apiKey.scopes,
      allowedIps: apiKey.allowedIps,
      rateLimit: apiKey.rateLimit,
      description: apiKey.description,
      environment: apiKey.environment,
    };

    // Apply changes using entity change tracking
    await this.updateEntity(apiKey, {
      ...(request.keyName !== undefined && { keyName: request.keyName }),
      ...(request.keyStatus !== undefined && { keyStatus: request.keyStatus }),
      ...(request.scopes !== undefined && { scopes: request.scopes }),
      ...(request.allowedIps !== undefined && { allowedIps: request.allowedIps }),
      ...(request.rateLimit !== undefined && { rateLimit: request.rateLimit }),
      ...(request.expiresAt !== undefined && { expiresAt: new Date(request.expiresAt) }),
      ...(request.description !== undefined && { description: request.description }),
      ...(request.environment !== undefined && { environment: request.environment }),
    });

    if (!apiKey.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    const updatedApiKey = await this.apiKeyRepository.update(id, apiKey);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedApiKey.id,
      data: apiKey.changes,
      previousData,
    });

    this.logger.log({
      message: 'API key updated',
      keyId: updatedApiKey.id,
      keyName: updatedApiKey.keyName,
      changes: Object.keys(apiKey.changes),
    });

    return updatedApiKey;
  }

  /**
   * Soft-delete an API key.
   *
   * TASK-305 D.5.2 — load-then-assert-then-soft-delete so a Tenant-A admin
   * cannot delete a Tenant-B key by id. Throws `NotFoundException` for
   * cross-tenant ids.
   */
  async deleteById(id: EntityId): Promise<ApiKeyEntity> {
    const existing = await this.apiKeyRepository.findById(id);
    this.assertKeyAccess(existing, id);

    const apiKey = await this.apiKeyRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: apiKey.id,
      data: {
        keyName: apiKey.keyName,
        keyPrefix: apiKey.keyPrefix,
        keyType: apiKey.keyType,
      },
    });

    this.logger.log({
      message: 'API key deleted',
      keyId: apiKey.id,
      keyName: apiKey.keyName,
    });

    return apiKey;
  }

  /**
   * Revoke an API key — sets status to REVOKED with an audit trail.
   * A revoked key can never be reactivated.
   */
  async revokeKey(id: EntityId): Promise<ApiKeyEntity> {
    const apiKey = await this.apiKeyRepository.findById(id);
    this.assertKeyAccess(apiKey, id);

    if (apiKey.keyStatus === ApiKeyStatus.REVOKED) {
      throw new ArgumentInvalidException('API key is already revoked.');
    }

    const previousStatus = apiKey.keyStatus;
    apiKey.keyStatus = ApiKeyStatus.REVOKED;
    if (this.requestUser) {
      apiKey.updatedBy = this.requestUser.id;
    }

    const revokedApiKey = await this.apiKeyRepository.update(id, apiKey);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: revokedApiKey.id,
      data: {
        action: 'revoke',
        keyName: revokedApiKey.keyName,
        keyPrefix: revokedApiKey.keyPrefix,
        previousStatus,
        newStatus: ApiKeyStatus.REVOKED,
      },
    });

    this.logger.warn({
      message: 'API key revoked',
      keyId: revokedApiKey.id,
      keyName: revokedApiKey.keyName,
      previousStatus,
    });

    return revokedApiKey;
  }

  // ─── Key Rotation ────────────────────────────────────────────────────

  /**
   * Rotate an API key — creates a new key inheriting the old key's configuration,
   * links them via rotatedFromKeyId/rotatedToKeyId, and sets a 24-hour overlap
   * window during which both keys are valid.
   */
  async rotateKey(apiKeyId: string): Promise<{ newRawKey: string; newApiKey: ApiKeyEntity }> {
    const oldKey = await this.apiKeyRepository.findById(apiKeyId);
    if (!oldKey) {
      throw new NotFoundException(`API key ${apiKeyId} not found`);
    }
    // TASK-305 D.5.2 — block cross-tenant rotation. Without this a Tenant-A
    // admin could mint a Tenant-B-tagged key by rotating one (the new key
    // inherits `oldKey.tenantId`). TASK-390 follow-up — `assertKeyAccess` also
    // enforces owner-scope: an owner-only caller (no `manage:ApiKey`) cannot
    // rotate another user's key even within the same tenant.
    this.assertKeyAccess(oldKey, apiKeyId);

    if (oldKey.keyStatus === ApiKeyStatus.REVOKED) {
      throw new ArgumentInvalidException('Cannot rotate a revoked API key');
    }
    if (oldKey.keyStatus === ApiKeyStatus.EXPIRED) {
      throw new ArgumentInvalidException('Cannot rotate an expired API key');
    }

    const keyType = oldKey.keyType ?? ApiKeyType.SDK;
    const rawKey = ApiKeyService.generateRawKey(keyType);
    const keyHash = await this.hashKeyForStorage(rawKey);
    const keyPrefix = ApiKeyService.extractPrefix(rawKey);
    const keyChecksum = ApiKeyService.extractChecksum(rawKey);

    const newKeyData = ApiKeyFactory.CreateApiKey({
      tenantId: oldKey.tenantId,
      userId: oldKey.userId,
      keyName: `${oldKey.keyName} (rotated)`,
      keyHash,
      keyPrefix,
      keyChecksum,
      keyType,
      keyStatus: ApiKeyStatus.ACTIVE,
      scopes: (oldKey.scopes as string[]) ?? [],
      allowedIps: (oldKey.allowedIps as string[]) ?? [],
      rateLimit: oldKey.rateLimit ?? 0,
      expiresAt: oldKey.expiresAt,
      usageCount: 0,
      description: oldKey.description,
      environment: oldKey.environment,
      rotatedFromKeyId: oldKey.id,
      originalCreatorId: oldKey.userId,
      createdBy: this.requestUser?.id ?? oldKey.userId,
    });

    const newApiKey = await this.apiKeyRepository.create(newKeyData);
    if (!newApiKey) {
      throw new InternalServerErrorException('Failed to create rotated API key');
    }

    oldKey.rotatedToKeyId = newApiKey.id;
    oldKey.rotationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await this.apiKeyRepository.update(oldKey.id, oldKey);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: newApiKey.id,
      data: {
        action: 'rotate',
        oldKeyId: oldKey.id,
        newKeyId: newApiKey.id,
      },
    });

    this.logger.log({
      message: 'API key rotated',
      oldKeyId: oldKey.id,
      newKeyId: newApiKey.id,
      keyPrefix: newApiKey.keyPrefix,
    });

    return { newRawKey: rawKey, newApiKey };
  }

  // ─── Authentication-Support Operations ──────────────────────────────

  /**
   * Find API key by hashing the provided key and looking up the hash.
   */
  async getByKeyHash(rawKey: string): Promise<ApiKeyEntity | null> {
    const keyHash = await this.hashKeyForStorage(rawKey);

    try {
      return await this.apiKeyRepository.findFirst({
        where: { keyHash },
      });
    } catch {
      return null;
    }
  }

  /**
   * Update usage statistics for an API key.
   * Broadcasts a ResourceUpdated event for audit trailing of key usage.
   */
  async updateUsage(apiKeyId: string, ipAddress?: string): Promise<void> {
    try {
      await this.apiKeyRepository['db'].update({
        where: { id: apiKeyId },
        data: {
          usageCount: { increment: 1 },
          lastUsedAt: new Date(),
        },
      });

      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: apiKeyId,
        disableAuditLog: true,
        data: { ipAddress },
      });
    } catch (error) {
      this.logger.warn({
        message: 'Failed to update API key usage',
        keyId: apiKeyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if API key is valid (status and expiration).
   */
  isKeyValid(apiKey: ApiKeyEntity): { valid: boolean; reason?: string } {
    // Check status
    if (apiKey.keyStatus !== ApiKeyStatus.ACTIVE) {
      return { valid: false, reason: `API key is ${apiKey.keyStatus.toLowerCase()}` };
    }

    // Check expiration
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      return { valid: false, reason: 'API key has expired' };
    }

    return { valid: true };
  }

  /**
   * Validate that the request IP is allowed by the API key's allowedIps list.
   * Returns true if no allowedIps are configured (allow all by default).
   */
  isIpAllowed(apiKey: ApiKeyEntity, ipAddress: string): boolean {
    const allowedIps = apiKey.allowedIps as string[] | null;

    // No IP restrictions configured — allow all
    if (!allowedIps || !Array.isArray(allowedIps) || allowedIps.length === 0) {
      return true;
    }

    // Normalize the incoming IP for comparison
    const normalizedIp = ipAddress.trim();

    return allowedIps.some((allowed) => {
      const normalizedAllowed = allowed.trim();

      // Exact match
      if (normalizedIp === normalizedAllowed) {
        return true;
      }

      // CIDR notation support (e.g. 192.168.1.0/24)
      if (normalizedAllowed.includes('/')) {
        return this.isIpInCidr(normalizedIp, normalizedAllowed);
      }

      // Wildcard support (e.g. 192.168.1.*)
      if (normalizedAllowed.includes('*')) {
        const pattern = normalizedAllowed.replace(/\./g, '\\.').replace(/\*/g, '.*');
        return new RegExp(`^${pattern}$`).test(normalizedIp);
      }

      return false;
    });
  }

  /**
   * Check if the API key's scopes grant access to the requested scope.
   * Deny-all by default: keys with no scopes have no access.
   * Use wildcard '*' scope for unrestricted access.
   */
  hasScope(apiKey: ApiKeyEntity, requiredScope: string): boolean {
    const scopes = apiKey.scopes as string[] | null;

    if (!scopes || !Array.isArray(scopes) || scopes.length === 0) {
      return false;
    }

    // Wildcard scope grants everything
    if (scopes.includes('*')) {
      return true;
    }

    // Check for exact match or parent scope (e.g. "stt" matches "stt:transcribe")
    return scopes.some((scope) => {
      if (requiredScope === scope) {
        return true;
      }
      // Parent scope: "stt" grants "stt:transcribe", "stt:anything"
      if (requiredScope.startsWith(`${scope}:`)) {
        return true;
      }
      return false;
    });
  }

  /**
   * Log API key event to audit log.
   */
  async logKeyEvent(apiKey: ApiKeyEntity, action: AuditAction, eventData: Record<string, unknown>, ipAddress?: string): Promise<void> {
    try {
      const sysEventType = this.mapAuditActionToSysEventType(action);

      this.broadcastSysEvent(sysEventType, {
        resourceId: apiKey.id,
        data: {
          ...eventData,
          keyPrefix: apiKey.keyPrefix,
          keyType: apiKey.keyType,
          tenantId: apiKey.tenantId,
          ipAddress,
        },
      });
    } catch (error) {
      this.logger.warn({
        message: 'Failed to log API key event',
        keyId: apiKey.id,
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ─── Request Authentication & Extraction ──────────────────────────

  /**
   * Authenticate a request by raw API key.
   * Full validation pipeline: hash → lookup → status/expiry → IP allowlist.
   */
  async authenticateByRawKey(rawKey: string, ipAddress?: string): Promise<ApiKeyEntity> {
    if (!rawKey) {
      throw new UnauthorizedException('API key is required');
    }

    const apiKeyEntity = await this.getByKeyHash(rawKey);

    if (!apiKeyEntity) {
      this.logger.warn({
        message: 'API key authentication failed',
        reason: 'invalid_key',
        keyPrefix: rawKey.substring(0, 12),
        ip: ipAddress,
      });
      throw new UnauthorizedException('Invalid API key');
    }

    const validation = this.isKeyValid(apiKeyEntity);
    if (!validation.valid) {
      throw new UnauthorizedException(validation.reason);
    }

    if (ipAddress) {
      if (!this.isIpAllowed(apiKeyEntity, ipAddress)) {
        this.logger.warn({
          message: 'API key IP not allowed',
          keyId: apiKeyEntity.id,
          ip: ipAddress,
        });
        throw new ForbiddenException('Request IP address is not allowed for this API key');
      }
    }

    this.updateUsage(apiKeyEntity.id, ipAddress).catch(() => {});

    this.logger.debug({
      message: 'API key authenticated',
      keyId: apiKeyEntity.id,
      keyName: apiKeyEntity.keyName,
      tenantId: apiKeyEntity.tenantId,
    });

    return apiKeyEntity;
  }

  extractApiKeyFromRequest(request: {
    headers: Record<string, string | string[] | undefined>;
    query?: Record<string, string | string[] | undefined>;
    url?: string;
  }): string | null {
    const apiKey =
      (request.headers['apikey'] as string) ||
      (request.headers['api-key'] as string) ||
      (request.headers['x-api-key'] as string) ||
      (request.headers['x-internal-service-key'] as string);

    if (!apiKey && request.query?.apiKey) {
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      const allowQueryParam = process.env.API_KEY_ALLOW_QUERY_PARAM === 'true';
      if (!allowQueryParam) {
        this.logger.warn({
          message: 'API key in query parameter rejected',
          reason: 'query_param_disabled',
          path: request.url,
        });
        return null;
      }
      return request.query.apiKey as string;
    }

    return apiKey || null;
  }

  extractApiKeyFromWebSocket(request: { headers: Record<string, string | string[] | undefined>; url?: string }): string | null {
    const apiKey =
      (request.headers['apikey'] as string) ||
      (request.headers['api-key'] as string) ||
      (request.headers['x-api-key'] as string) ||
      (request.headers['x-internal-service-key'] as string);

    if (!apiKey && request.url) {
      const url = new URL(request.url, 'http://localhost');
      const apiKeyFromQuery = url.searchParams.get('apiKey') || url.searchParams.get('api-key');
      if (apiKeyFromQuery) {
        return apiKeyFromQuery;
      }
    }

    return apiKey || null;
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  /**
   * Map AuditAction to SysEventType.
   */
  private mapAuditActionToSysEventType(action: AuditAction): SysEventType {
    switch (action) {
      case AuditAction.CREATE:
        return SysEventType.ResourceCreated;
      case AuditAction.READ:
        return SysEventType.ResourceViewed;
      case AuditAction.UPDATE:
        return SysEventType.ResourceUpdated;
      case AuditAction.DELETE:
        return SysEventType.ResourceDeleted;
      case AuditAction.ARCHIVE:
        return SysEventType.ResourceArchived;
      default:
        return SysEventType.ResourceViewed;
    }
  }

  /**
   * Check if an IP address falls within a CIDR range.
   * Supports IPv4 CIDR notation (e.g. 192.168.1.0/24).
   */
  private isIpInCidr(ip: string, cidr: string): boolean {
    try {
      const [rangeIp, prefixLengthStr] = cidr.split('/');
      const prefixLength = parseInt(prefixLengthStr, 10);

      if (isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
        return false;
      }

      const ipNum = this.ipToNumber(ip);
      const rangeNum = this.ipToNumber(rangeIp);

      if (ipNum === null || rangeNum === null) {
        return false;
      }

      const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;
      return (ipNum & mask) === (rangeNum & mask);
    } catch {
      return false;
    }
  }

  /**
   * Convert an IPv4 address string to a 32-bit unsigned number.
   */
  private ipToNumber(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      return null;
    }

    let result = 0;
    for (const part of parts) {
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 0 || num > 255) {
        return null;
      }
      result = (result << 8) | num;
    }
    return result >>> 0; // Ensure unsigned
  }

  /**
   * True when the active request user carries the SUPER_ADMIN role. Mirrors
   * the strict-default behaviour in `TenantService.isSuperAdmin()` and
   * `AuditLogService` — falls back to `false` whenever the role list is
   * missing.
   */
  private isSuperAdmin(): boolean {
    const roles = this.requestUser?.roles;
    return Array.isArray(roles) && roles.includes(SUPER_ADMIN_ROLE);
  }

  /**
   * TASK-305 D.5.2 — build a Prisma `where` clause that always scopes to the
   * caller's CLS tenantId, unless the caller is SUPER_ADMIN. Throws
   * `NotFoundException` when a non-super-admin caller has no tenantId in CLS
   * so the query never widens to all tenants by accident (Prisma treats
   * `tenantId: undefined` as "no filter"). Mirrors `AuditLogService.buildTenantWhere`.
   */
  private buildTenantWhere<T extends object>(extra?: T): T & { tenantId?: string } {
    const base = extra ?? ({} as T);
    if (this.isSuperAdmin()) {
      return { ...base } as T & { tenantId?: string };
    }
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new NotFoundException('API key scope unavailable');
    }
    return { ...base, tenantId } as T & { tenantId?: string };
  }

  /**
   * TASK-305 D.5.2 (audit M-1) — assert the loaded entity belongs to the
   * caller's tenant. SUPER_ADMIN bypasses. Throws `NotFoundException` (not
   * `ForbiddenException`) so the API never reveals that a record exists for
   * another tenant.
   */
  private assertTenantOwnership(apiKey: ApiKeyEntity, id: string): void {
    if (this.isSuperAdmin()) return;
    if (apiKey.tenantId !== this.tenantId) {
      throw new NotFoundException(`API key ${id} not found`);
    }
  }

  /**
   * TASK-390 follow-up (owner-scope) — true when the caller may act on ANY key
   * in scope: a tenant admin holding the tenant-wide `manage:ApiKey` grant, or
   * SUPER_ADMIN (`manage:all`). Owner-only callers hold just the seeded
   * `api-key-own-manage` grants (`read`/`update`/`delete` conditioned on
   * `userId`) and therefore CANNOT `manage` — they are confined to their own
   * keys. Mirrors the CASL-ability check in
   * `PromptManagementService.callerCanManageTemplates()`: read the compiled
   * `userAbility` the guard pins to CLS and probe the broad `manage` grant.
   */
  private callerCanManageAllKeys(): boolean {
    if (this.isSuperAdmin()) return true;
    const ability = this.clsService.get('userAbility') as { can?: (action: string, subject: string) => boolean } | undefined;
    return !!ability && typeof ability.can === 'function' && ability.can('manage', 'ApiKey');
  }

  /**
   * TASK-390 follow-up — access gate for by-id key operations
   * (fetch/update/delete/revoke/rotate). Layers the owner-scope check on top of
   * the tenant gate: a caller WITHOUT the tenant-wide `manage:ApiKey` grant
   * (i.e. holding only `api-key-own-manage`) may act ONLY on keys they own.
   * Throws `NotFoundException` — never `Forbidden` — matching the module's
   * existing not-authorized convention (`assertTenantOwnership`) so we never
   * leak that another user's key exists.
   */
  private assertKeyAccess(apiKey: ApiKeyEntity, id: string): void {
    this.assertTenantOwnership(apiKey, id);
    if (this.callerCanManageAllKeys()) return;
    if (apiKey.userId !== this.requestUserId) {
      throw new NotFoundException(`API key ${id} not found`);
    }
  }
}
