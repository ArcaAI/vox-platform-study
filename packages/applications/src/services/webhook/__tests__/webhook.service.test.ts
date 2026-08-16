/**
 * WebhookService Unit Tests
 *
 * Tests for the WebhookService that handles webhook management operations.
 *
 * Testing Strategy:
 * - Tests verify actual behavior outcomes, not just that mocks were called
 * - Mocks are complete representations of real entity structures
 * - Edge cases and error scenarios are thoroughly covered
 * - Tests focus on service logic, not repository implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebhookService } from '../webhook.service';
import { SysEventType, ResourceStatusType } from '@arcaai/domains';

// Mock ClsService - represents the request context
const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

// Mock EventEmitter - captures system events
const mockEventEmitter = {
  emit: vi.fn(),
};

// Mock WebhookRepository - simulates database operations
const mockWebhookRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  // `update()` now writes via CAS. The
  // legacy `update` stays on the mock so we can assert it is NOT
  // called from the OCC-migrated path.
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
};

// Delivery-log reads (`fetchRunHistory`).
const mockWebhookRunHistoryRepository = {
  findAll: vi.fn(),
  count: vi.fn(),
};

/**
 * Creates a complete mock webhook entity matching the real WebhookEntity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockWebhookEntity = (
  overrides: Partial<{
    id: string;
    tenantId: string;
    name: string;
    url: string;
    hashedSecret: string | null;
    resourceTypeName: string;
    resourceId: string | null;
    subscriptionMetadata: Record<string, unknown> | null;
    resourceStatus: ResourceStatusType;
    createdBy: string | null;
    updatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    hasChanges: boolean;
    changes: Record<string, unknown>;
    version: number;
  }> = {},
) => {
  const entity = {
    id: overrides.id ?? 'webhook-id-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    name: overrides.name ?? 'Test Webhook',
    url: overrides.url ?? 'https://example.com/webhook',
    hashedSecret: overrides.hashedSecret ?? null,
    resourceTypeName: overrides.resourceTypeName ?? 'User',
    resourceId: overrides.resourceId ?? null,
    subscriptionMetadata: overrides.subscriptionMetadata ?? null,
    resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
    createdBy: overrides.createdBy ?? null,
    updatedBy: overrides.updatedBy ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
    deletedAt: overrides.deletedAt ?? null,
    hasChanges: overrides.hasChanges ?? false,
    changes: overrides.changes ?? {},
    // `_version` is required for the
    // CAS write path. Default = first-write (1).
    version: overrides.version ?? 1,
    toObject: vi.fn(),
  };
  // Make toObject return a complete representation
  entity.toObject.mockReturnValue({
    id: entity.id,
    tenantId: entity.tenantId,
    name: entity.name,
    url: entity.url,
    hashedSecret: entity.hashedSecret,
    resourceTypeName: entity.resourceTypeName,
    resourceId: entity.resourceId,
    subscriptionMetadata: entity.subscriptionMetadata,
    resourceStatus: entity.resourceStatus,
    createdBy: entity.createdBy,
    updatedBy: entity.updatedBy,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    deletedAt: entity.deletedAt,
  });
  return entity;
};

// Mock WebhookFactory - simulates entity creation
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    WebhookFactory: {
      CreateWebhook: vi.fn((data) => ({
        ...data,
        id: 'new-webhook-id',
        resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        toObject: vi.fn().mockReturnValue({
          id: 'new-webhook-id',
          ...data,
          resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
        }),
      })),
    },
  };
});

describe('WebhookService', () => {
  let service: WebhookService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: return valid user from CLS - complete user context
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return {
            id: 'current-user-id',
            firstName: 'Test',
            lastName: 'User',
            email: 'test@example.com',
          };
        case 'tenantId':
          return 'tenant-1';
        case 'tenantCode':
          return 'TENANT_1';
        case 'correlationId':
          return 'corr-123';
        case 'requestIp':
          return '192.168.1.1';
        default:
          return null;
      }
    });

    // Create service instance with mocks
    service = new WebhookService(
      mockWebhookRepository as any,
      mockWebhookRunHistoryRepository as any,
      mockEventEmitter as any,
      mockClsService as any,
    );
  });

  describe('create', () => {
    it('should create a new webhook with all required fields', async () => {
      const newWebhook = createMockWebhookEntity({
        id: 'new-webhook-id',
        tenantId: 'tenant-1',
        name: 'New Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });
      mockWebhookRepository.create.mockResolvedValue(newWebhook);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'New Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });

      // Verify the returned entity has correct data
      expect(result.webhook.id).toBe('new-webhook-id');
      expect(result.webhook.tenantId).toBe('tenant-1');
      expect(result.webhook.name).toBe('New Webhook');
      expect(result.webhook.url).toBe('https://example.com/webhook');
      expect(result.webhook.resourceTypeName).toBe('User');
    });

    it('should emit ResourceCreated event with complete event data', async () => {
      const newWebhook = createMockWebhookEntity({ id: 'new-webhook-id' });
      mockWebhookRepository.create.mockResolvedValue(newWebhook);

      await service.create({
        tenantId: 'tenant-1',
        name: 'New Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'new-webhook-id',
          createdAt: newWebhook.createdAt,
          responsibleEntityId: 'current-user-id',
          responsibleIp: '192.168.1.1',
          correlationId: 'corr-123',
          tenantId: 'tenant-1',
        }),
      );
    });

    it('should throw InternalServerErrorException when repository returns null', async () => {
      mockWebhookRepository.create.mockResolvedValue(null);

      await expect(
        service.create({
          tenantId: 'tenant-1',
          name: 'New Webhook',
          url: 'https://example.com/webhook',
          resourceTypeName: 'User',
        }),
      ).rejects.toThrow('Failed to create WebhookEntity');
    });

    it('should create webhook with subscription metadata', async () => {
      const metadata = { events: ['user.created', 'user.updated'], priority: 'high' };
      const newWebhook = createMockWebhookEntity({
        id: 'new-webhook-id',
        subscriptionMetadata: metadata,
      });
      mockWebhookRepository.create.mockResolvedValue(newWebhook);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'New Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
        subscriptionMetadata: metadata,
      });

      expect(result.webhook.subscriptionMetadata).toEqual(metadata);
    });

    it('should create webhook for specific resource', async () => {
      const newWebhook = createMockWebhookEntity({
        id: 'new-webhook-id',
        resourceTypeName: 'Consultation',
        resourceId: 'consultation-123',
      });
      mockWebhookRepository.create.mockResolvedValue(newWebhook);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'Consultation Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'Consultation',
        resourceId: 'consultation-123',
      });

      expect(result.webhook.resourceTypeName).toBe('Consultation');
      expect(result.webhook.resourceId).toBe('consultation-123');
    });

    it('should handle repository errors gracefully', async () => {
      mockWebhookRepository.create.mockRejectedValue(new Error('Database connection failed'));

      await expect(
        service.create({
          tenantId: 'tenant-1',
          name: 'New Webhook',
          url: 'https://example.com/webhook',
          resourceTypeName: 'User',
        }),
      ).rejects.toThrow('Database connection failed');
    });
  });

  // =========================================================================
  // TASK-727: server-generated, peppered-HMAC webhook secrets.
  // `CreateWebhookRequest` no longer accepts a caller-supplied `hashedSecret`
  // — the raw secret is always minted server-side and returned exactly once.
  // =========================================================================
  describe('create — server-generated signing secret (TASK-727)', () => {
    it('returns a raw secret matching the expected shape, distinct from the stored hash', async () => {
      // No SecretsService wired ⇒ un-peppered SHA-256 fallback (legacy-fixture
      // shape, same as ApiKeyService's own fallback when secretsService is
      // undefined). WebhookFactory.CreateWebhook is mocked to echo back
      // whatever hashedSecret the service computed.
      const newWebhook = createMockWebhookEntity({ id: 'new-webhook-id' });
      mockWebhookRepository.create.mockImplementation(async () => newWebhook);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'Secure Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });

      expect(result.rawSecret).toMatch(/^[0-9a-f]{64}$/);

      const factoryInput = mockWebhookRepository.create.mock.calls[0][0];
      // Stored form is REVERSIBLE (AES-256-GCM), never the raw secret and
      // never a bare hash — but it must decrypt back to the exact raw
      // secret, since the delivery processor needs it to sign outbound
      // payloads (see WebhookService's class doc for why this can't be a
      // one-way hash).
      expect(factoryInput.hashedSecret).not.toBe(result.rawSecret);
      expect(WebhookService.decryptSecret(factoryInput.hashedSecret)).toBe(result.rawSecret);
    });

    it('produces a different raw secret on a second create call', async () => {
      mockWebhookRepository.create.mockResolvedValue(createMockWebhookEntity({ id: 'wh-a' }));
      const first = await service.create({
        tenantId: 'tenant-1',
        name: 'Webhook A',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });

      mockWebhookRepository.create.mockResolvedValue(createMockWebhookEntity({ id: 'wh-b' }));
      const second = await service.create({
        tenantId: 'tenant-1',
        name: 'Webhook B',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });

      expect(first.rawSecret).not.toBe(second.rawSecret);
    });

    it('never accepts a caller-supplied hashedSecret — the DTO carries no such field', async () => {
      const newWebhook = createMockWebhookEntity({ id: 'new-webhook-id' });
      mockWebhookRepository.create.mockImplementation(async () => newWebhook);

      await service.create({
        tenantId: 'tenant-1',
        name: 'Sneaky Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
        // A caller attempting to smuggle a value in past the TS type (as a
        // real HTTP request would be rejected by forbidNonWhitelisted).
        ...({ hashedSecret: 'caller-supplied-plaintext' } as object),
      } as never);

      const factoryInput = mockWebhookRepository.create.mock.calls[0][0];
      // The server-generated value wins — never the caller-supplied string.
      expect(factoryInput.hashedSecret).not.toBe('caller-supplied-plaintext');
      expect(WebhookService.decryptSecret(factoryInput.hashedSecret)).not.toBe('caller-supplied-plaintext');
    });

    it('encrypts with WEBHOOK_SECRET_PEPPER-derived key material when SecretsService resolves one (never API_KEY_PEPPER)', async () => {
      const mockSecretsService = { getSecretOptional: vi.fn().mockResolvedValue('dedicated-webhook-pepper') };
      const pepperedService = new WebhookService(
        mockWebhookRepository as any,
        mockWebhookRunHistoryRepository as any,
        mockEventEmitter as any,
        mockClsService as any,
        mockSecretsService as any,
      );
      mockWebhookRepository.create.mockImplementation(async () => createMockWebhookEntity({ id: 'peppered' }));

      const result = await pepperedService.create({
        tenantId: 'tenant-1',
        name: 'Peppered Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });

      // Never the API-key pepper name — this MUST be the dedicated secret.
      expect(mockSecretsService.getSecretOptional).toHaveBeenCalledWith('WEBHOOK_SECRET_PEPPER');
      expect(mockSecretsService.getSecretOptional).not.toHaveBeenCalledWith('API_KEY_PEPPER');

      const factoryInput = mockWebhookRepository.create.mock.calls[0][0];
      // Decrypts correctly under the resolved pepper...
      expect(WebhookService.decryptSecret(factoryInput.hashedSecret, 'dedicated-webhook-pepper')).toBe(result.rawSecret);
      // ...but fails loudly (GCM auth-tag mismatch) under the WRONG pepper —
      // proves the ciphertext is actually keyed by the pepper, not ignoring it.
      expect(() => WebhookService.decryptSecret(factoryInput.hashedSecret, 'some-other-pepper')).toThrow();
      // ...and under no pepper at all (the un-peppered local fallback key).
      expect(() => WebhookService.decryptSecret(factoryInput.hashedSecret)).toThrow();
    });
  });

  describe('fetchById / fetchAll never re-expose hashedSecret (TASK-727)', () => {
    it('fetchById result carries the peppered hash internally but WebhookDtoMapper never surfaces it', async () => {
      // WebhookDtoMapper is exercised in its own dto-mapper suite; here we
      // pin the entity-level contract the mapper relies on: hashedSecret is
      // still present on the domain entity (needed for the delivery
      // processor's signing step) but is never a field on WebhookResponse —
      // see webhook.dto.mapper.test.ts / webhook.response.ts.
      const webhook = createMockWebhookEntity({ id: 'webhook-123', hashedSecret: 'stored-hash' });
      mockWebhookRepository.findById.mockResolvedValue(webhook);

      const result = await service.fetchById('webhook-123');

      expect(result.hashedSecret).toBe('stored-hash');
    });
  });

  /**
   * `WebhookService.create`
   * previously persisted the caller-supplied `request.tenantId` as-is, so a
   * Tenant-A user could create webhooks attributed to Tenant-B by simply
   * setting the DTO field. The `resolveEffectiveTenantId` helper mirrors
   * the NotificationService pattern at the structural level:
   *   - Non-SUPER_ADMIN: silently pin to CLS `tenantId` (ignore the DTO field)
   *   - SUPER_ADMIN: honor `request.tenantId` for cross-tenant impersonation
   *     (admin UI flows / migration tooling)
   *   - Both branches throw `BadRequestException` if no tenant context resolves
   *
   * NOTE: this differs from NotificationService semantically — Notification
   * THROWS ForbiddenException on a non-super-admin explicit mismatch (PHI
   * dispatch is more sensitive). Webhook follows the verification
   * contract ("row created with tenant-A") which mandates silent pinning.
   */
  describe('create resolves effective tenantId', () => {
    // Helper mirrors the NotificationService / TenantService test convention:
    // re-installs the CLS mock so the active user carries the given roles
    // without leaking state into sibling tests (each `beforeEach` wipes it).
    const setRequestUserRoles = (roles: string[] | undefined) => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return {
              id: 'current-user-id',
              firstName: 'Test',
              lastName: 'User',
              email: 'test@example.com',
              roles,
            };
          case 'tenantId':
            return 'tenant-1';
          case 'tenantCode':
            return 'TENANT_1';
          case 'correlationId':
            return 'corr-123';
          case 'requestIp':
            return '192.168.1.1';
          default:
            return null;
        }
      });
    };

    it('pins tenantId to CLS when a non-SUPER_ADMIN caller passes a cross-tenant request.tenantId', async () => {
      const persistedWebhook = createMockWebhookEntity({ id: 'webhook-new', tenantId: 'tenant-1' });
      mockWebhookRepository.create.mockResolvedValue(persistedWebhook);

      await service.create({
        tenantId: 'tenant-B',
        name: 'Sneaky Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });

      const factoryInput = mockWebhookRepository.create.mock.calls[0][0];
      expect(factoryInput.tenantId).toBe('tenant-1');
    });

    it('pins tenantId to CLS when a non-SUPER_ADMIN caller omits request.tenantId', async () => {
      const persistedWebhook = createMockWebhookEntity({ id: 'webhook-new', tenantId: 'tenant-1' });
      mockWebhookRepository.create.mockResolvedValue(persistedWebhook);

      await service.create({
        name: 'No-Tenant Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });

      const factoryInput = mockWebhookRepository.create.mock.calls[0][0];
      expect(factoryInput.tenantId).toBe('tenant-1');
    });

    it('honors request.tenantId for SUPER_ADMIN callers (cross-tenant impersonation)', async () => {
      setRequestUserRoles(['SUPER_ADMIN']);
      const persistedWebhook = createMockWebhookEntity({ id: 'webhook-new', tenantId: 'tenant-B' });
      mockWebhookRepository.create.mockResolvedValue(persistedWebhook);

      await service.create({
        tenantId: 'tenant-B',
        name: 'Cross-Tenant Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });

      const factoryInput = mockWebhookRepository.create.mock.calls[0][0];
      expect(factoryInput.tenantId).toBe('tenant-B');
    });
  });

  /**
   * `WebhookService.resolveEffectiveTenantId`
   * silently coerces a non-SUPER_ADMIN cross-tenant create attempt to
   * the CLS tenant. Persistence is correct, but
   * SOC has no observability for the coercion event — a foreign-tenant
   * DTO `tenantId` produces an identical persisted state to a properly-
   * formed request, so audit logs cannot distinguish the two.
   *
   * The fix adds a one-shot `logger.warn` ONLY on the cross-tenant
   * coercion branch. Same-tenant and tenantId-omitted writes stay
   * silent (those are benign / expected); SUPER_ADMIN cross-tenant
   * writes also stay silent (those are explicitly allowed).
   */
  describe('resolveEffectiveTenantId observability', () => {
    const setRequestUserRoles = (roles: string[] | undefined) => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return {
              id: 'current-user-id',
              firstName: 'Test',
              lastName: 'User',
              email: 'test@example.com',
              roles,
            };
          case 'tenantId':
            return 'tenant-1';
          case 'tenantCode':
            return 'TENANT_1';
          case 'correlationId':
            return 'corr-123';
          case 'requestIp':
            return '192.168.1.1';
          default:
            return null;
        }
      });
    };

    it('logs a warn when a non-SUPER_ADMIN passes a foreign tenantId (silent coercion observability)', async () => {
      const warnSpy = vi.spyOn(service['logger'], 'warn');
      const persistedWebhook = createMockWebhookEntity({ id: 'webhook-new', tenantId: 'tenant-1' });
      mockWebhookRepository.create.mockResolvedValue(persistedWebhook);

      await service.create({
        tenantId: 'tenant-OTHER',
        name: 'Sneaky Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });

      expect(warnSpy).toHaveBeenCalledWith(
        'Webhook cross-tenant attempt coerced to CLS',
        expect.objectContaining({
          requestedTenantId: 'tenant-OTHER',
          callerTenantId: 'tenant-1',
          userId: 'current-user-id',
        }),
      );
    });

    it('does NOT log a warn when a non-SUPER_ADMIN omits request.tenantId (benign happy path)', async () => {
      const warnSpy = vi.spyOn(service['logger'], 'warn');
      const persistedWebhook = createMockWebhookEntity({ id: 'webhook-new', tenantId: 'tenant-1' });
      mockWebhookRepository.create.mockResolvedValue(persistedWebhook);

      await service.create({
        name: 'No-Tenant Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does NOT log a warn when a SUPER_ADMIN cross-tenant creates (explicit allow)', async () => {
      setRequestUserRoles(['SUPER_ADMIN']);
      const warnSpy = vi.spyOn(service['logger'], 'warn');
      const persistedWebhook = createMockWebhookEntity({ id: 'webhook-new', tenantId: 'tenant-B' });
      mockWebhookRepository.create.mockResolvedValue(persistedWebhook);

      await service.create({
        tenantId: 'tenant-B',
        name: 'Cross-Tenant Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  /**
   * `WebhookService` was previously
   * tenant-blind on every read/write surface except `create`.
   * This block exercises the full sweep across the remaining 5 methods:
   *   - fetchAll: inject `{ tenantId: this.tenantId }` filter
   *     (SUPER_ADMIN bypass)
   *   - fetchById: load-then-assert via assertEqualTenants
   *   - update: assert tenant after the pre-write findById
   *   - deleteById: load + assert + softDelete
   *   - fetchAllByTenantId: CLS gate (refuse cross-tenant DTO
   *     tenantId for non-SUPER_ADMIN — mirrors the
   *     Notification/ApiKey pattern)
   *
   * The CLS default in `beforeEach` is `tenant-1`. Tests use `tenant-2`
   * for cross-tenant probes. The local `setRequestUserRoles` helper
   * re-installs the CLS mock with the requested role list.
   */
  describe('Webhook tenant-guard sweep', () => {
    const setRequestUserRoles = (roles: string[] | undefined) => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return {
              id: 'current-user-id',
              firstName: 'Test',
              lastName: 'User',
              email: 'test@example.com',
              roles,
            };
          case 'tenantId':
            return 'tenant-1';
          case 'tenantCode':
            return 'TENANT_1';
          case 'correlationId':
            return 'corr-123';
          case 'requestIp':
            return '192.168.1.1';
          default:
            return null;
        }
      });
    };

    describe('fetchAll (5.3.2)', () => {
      it('injects the CLS tenantId into the findAll + count where clauses for non-SUPER_ADMIN callers', async () => {
        mockWebhookRepository.findAll.mockResolvedValue([]);
        mockWebhookRepository.count.mockResolvedValue(0);

        await service.fetchAll({ limit: 10, page: 1 });

        expect(mockWebhookRepository.findAll).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-1' }) }),
        );
        expect(mockWebhookRepository.count).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-1' }) }),
        );
      });

      it('omits the tenant filter when the caller is a SUPER_ADMIN (cross-tenant list)', async () => {
        setRequestUserRoles(['SUPER_ADMIN']);
        mockWebhookRepository.findAll.mockResolvedValue([]);
        mockWebhookRepository.count.mockResolvedValue(0);

        await service.fetchAll({ limit: 10, page: 1 });

        const findAllArgs = mockWebhookRepository.findAll.mock.calls[0][0];
        const countArgs = mockWebhookRepository.count.mock.calls[0][0];
        expect(findAllArgs.where?.tenantId).toBeUndefined();
        expect(countArgs.where?.tenantId).toBeUndefined();
      });
    });

    describe('fetchById (5.3.3)', () => {
      it('returns the webhook when the loaded row belongs to the caller (same-tenant)', async () => {
        const webhook = createMockWebhookEntity({ id: 'webhook-1', tenantId: 'tenant-1' });
        mockWebhookRepository.findById.mockResolvedValue(webhook);

        const result = await service.fetchById('webhook-1');

        expect(result.id).toBe('webhook-1');
      });

      it('throws NotFoundException for cross-tenant non-admin reads', async () => {
        const { NotFoundException } = await import('@nestjs/common');
        const otherWebhook = createMockWebhookEntity({ id: 'webhook-foreign', tenantId: 'tenant-2' });
        mockWebhookRepository.findById.mockResolvedValue(otherWebhook);

        await expect(service.fetchById('webhook-foreign')).rejects.toThrow(NotFoundException);

        // Pin "no audit-log leak on denied read":
        // the assertEqualTenants throw must short-circuit BEFORE the
        // ResourceViewed broadcast. Structurally guaranteed by the
        // guard's throw position, but the explicit negative-assertion
        // makes the contract self-evident at the test level (matches
        // the existing update/deleteById denial-test pattern).
        expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.anything());
      });

      it('returns the cross-tenant webhook when the caller is a SUPER_ADMIN (admin bypass)', async () => {
        setRequestUserRoles(['SUPER_ADMIN']);
        const otherWebhook = createMockWebhookEntity({ id: 'webhook-foreign', tenantId: 'tenant-2' });
        mockWebhookRepository.findById.mockResolvedValue(otherWebhook);

        const result = await service.fetchById('webhook-foreign');

        expect(result.id).toBe('webhook-foreign');
        expect(result.tenantId).toBe('tenant-2');
      });
    });

    describe('update (5.3.4)', () => {
      it('updates when the loaded webhook belongs to the caller (same-tenant)', async () => {
        const webhook = createMockWebhookEntity({
          id: 'webhook-1',
          tenantId: 'tenant-1',
          hasChanges: true,
          changes: { name: 'Updated' },
          version: 4,
        });
        mockWebhookRepository.findById.mockResolvedValue(webhook);
        mockWebhookRepository.updateWithVersion.mockResolvedValue({ ...webhook, version: 5 });

        const result = await service.update('webhook-1', { name: 'Updated', expectedVersion: 4 } as never);

        expect(result.id).toBe('webhook-1');
        expect(mockWebhookRepository.updateWithVersion).toHaveBeenCalled();
      });

      it('throws NotFoundException + does not mutate for cross-tenant non-admin updates', async () => {
        const { NotFoundException } = await import('@nestjs/common');
        const otherWebhook = createMockWebhookEntity({
          id: 'webhook-foreign',
          tenantId: 'tenant-2',
          hasChanges: true,
          changes: { name: 'Updated' },
          version: 4,
        });
        mockWebhookRepository.findById.mockResolvedValue(otherWebhook);

        await expect(service.update('webhook-foreign', { name: 'Updated', expectedVersion: 4 } as never)).rejects.toThrow(NotFoundException);
        // Guard short-circuits BEFORE the CAS write fires.
        expect(mockWebhookRepository.updateWithVersion).not.toHaveBeenCalled();
      });

      it('updates a cross-tenant webhook when the caller is a SUPER_ADMIN (admin bypass)', async () => {
        setRequestUserRoles(['SUPER_ADMIN']);
        const otherWebhook = createMockWebhookEntity({
          id: 'webhook-foreign',
          tenantId: 'tenant-2',
          hasChanges: true,
          changes: { name: 'Updated' },
          version: 4,
        });
        mockWebhookRepository.findById.mockResolvedValue(otherWebhook);
        mockWebhookRepository.updateWithVersion.mockResolvedValue({ ...otherWebhook, version: 5 });

        const result = await service.update('webhook-foreign', { name: 'Updated', expectedVersion: 4 } as never);

        expect(result.id).toBe('webhook-foreign');
        expect(mockWebhookRepository.updateWithVersion).toHaveBeenCalled();
      });
    });

    describe('deleteById (5.3.5)', () => {
      it('deletes when the loaded webhook belongs to the caller (same-tenant)', async () => {
        const webhook = createMockWebhookEntity({ id: 'webhook-1', tenantId: 'tenant-1' });
        mockWebhookRepository.findById.mockResolvedValue(webhook);
        mockWebhookRepository.softDelete.mockResolvedValue({ ...webhook, deletedAt: new Date() });

        const result = await service.deleteById('webhook-1');

        expect(result.id).toBe('webhook-1');
        expect(mockWebhookRepository.softDelete).toHaveBeenCalledWith('webhook-1');
      });

      it('throws NotFoundException + does not soft-delete for cross-tenant non-admin requests', async () => {
        const { NotFoundException } = await import('@nestjs/common');
        const otherWebhook = createMockWebhookEntity({ id: 'webhook-foreign', tenantId: 'tenant-2' });
        mockWebhookRepository.findById.mockResolvedValue(otherWebhook);

        await expect(service.deleteById('webhook-foreign')).rejects.toThrow(NotFoundException);
        // Guard short-circuits BEFORE the soft-delete fires.
        expect(mockWebhookRepository.softDelete).not.toHaveBeenCalled();
      });

      it('deletes a cross-tenant webhook when the caller is a SUPER_ADMIN (admin bypass)', async () => {
        setRequestUserRoles(['SUPER_ADMIN']);
        const otherWebhook = createMockWebhookEntity({ id: 'webhook-foreign', tenantId: 'tenant-2' });
        mockWebhookRepository.softDelete.mockResolvedValue({ ...otherWebhook, deletedAt: new Date() });

        const result = await service.deleteById('webhook-foreign');

        expect(result.id).toBe('webhook-foreign');
        expect(mockWebhookRepository.softDelete).toHaveBeenCalledWith('webhook-foreign');
      });
    });

    describe('fetchAllByTenantId (5.3.6)', () => {
      it('returns rows when the DTO tenantId matches the caller CLS tenant', async () => {
        const webhooks = [createMockWebhookEntity({ id: 'webhook-1', tenantId: 'tenant-1' })];
        mockWebhookRepository.findAll.mockResolvedValue(webhooks);
        mockWebhookRepository.count.mockResolvedValue(1);

        const result = await service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: 'tenant-1' });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].tenantId).toBe('tenant-1');
      });

      it('throws NotFoundException for cross-tenant non-admin reads', async () => {
        const { NotFoundException } = await import('@nestjs/common');

        await expect(service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: 'tenant-2' })).rejects.toThrow(NotFoundException);
        // Guard short-circuits BEFORE hitting the repository.
        expect(mockWebhookRepository.findAll).not.toHaveBeenCalled();
      });

      it('returns rows for a cross-tenant SUPER_ADMIN read (bypass)', async () => {
        setRequestUserRoles(['SUPER_ADMIN']);
        const webhooks = [createMockWebhookEntity({ id: 'webhook-x', tenantId: 'tenant-2' })];
        mockWebhookRepository.findAll.mockResolvedValue(webhooks);
        mockWebhookRepository.count.mockResolvedValue(1);

        const result = await service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: 'tenant-2' });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].tenantId).toBe('tenant-2');
      });
    });
  });

  describe('fetchAll', () => {
    it('should return paginated webhooks with correct pagination metadata', async () => {
      const webhooks = [
        createMockWebhookEntity({ id: 'webhook-1', name: 'Webhook 1' }),
        createMockWebhookEntity({ id: 'webhook-2', name: 'Webhook 2' }),
      ];
      mockWebhookRepository.findAll.mockResolvedValue(webhooks);
      mockWebhookRepository.count.mockResolvedValue(2);

      const result = await service.fetchAll({ limit: 10, page: 1 });

      expect(result.data).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(1);
      // Verify actual webhook data is returned
      expect(result.data[0].name).toBe('Webhook 1');
      expect(result.data[1].name).toBe('Webhook 2');
    });

    it('coerces Webhook-typed filter values via the model registry', async () => {
      mockWebhookRepository.findAll.mockResolvedValue([]);
      mockWebhookRepository.count.mockResolvedValue(0);

      await service.fetchAll({ limit: 10, page: 1, filters: 'version[gte]:2;subscriptionMetadata.event[equals]:consultation.created' });

      // version (Int) coerces; subscriptionMetadata (Json) takes a dotted-path filter.
      const expectedFilters = {
        version: { gte: 2 },
        subscriptionMetadata: { path: ['event'], equals: 'consultation.created' },
      };
      expect(mockWebhookRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ filters: expectedFilters }));
      expect(mockWebhookRepository.count).toHaveBeenCalledWith(expect.objectContaining({ filters: expectedFilters }));
    });

    it('should return empty result when no webhooks exist', async () => {
      mockWebhookRepository.findAll.mockResolvedValue([]);
      mockWebhookRepository.count.mockResolvedValue(0);

      const result = await service.fetchAll({ limit: 10, page: 1 });

      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('should emit ResourceViewed event with webhook IDs', async () => {
      const webhooks = [createMockWebhookEntity({ id: 'webhook-1' }), createMockWebhookEntity({ id: 'webhook-2' })];
      mockWebhookRepository.findAll.mockResolvedValue(webhooks);
      mockWebhookRepository.count.mockResolvedValue(2);

      await service.fetchAll({ limit: 10, page: 1 });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { items: ['webhook-1', 'webhook-2'] },
        }),
      );
    });

    it('should pass search parameter to repository', async () => {
      mockWebhookRepository.findAll.mockResolvedValue([]);
      mockWebhookRepository.count.mockResolvedValue(0);

      await service.fetchAll({ limit: 10, page: 1, search: 'user-webhook' });

      expect(mockWebhookRepository.count).toHaveBeenCalledWith(expect.objectContaining({ search: 'user-webhook' }));
    });
  });

  describe('fetchAllByTenantId', () => {
    it('should return webhooks filtered by tenant ID', async () => {
      const webhooks = [createMockWebhookEntity({ id: 'webhook-1', tenantId: 'tenant-1' })];
      mockWebhookRepository.findAll.mockResolvedValue(webhooks);
      mockWebhookRepository.count.mockResolvedValue(1);

      const result = await service.fetchAllByTenantId({
        limit: 10,
        page: 1,
        tenantId: 'tenant-1',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].tenantId).toBe('tenant-1');
      expect(mockWebhookRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-1' },
        }),
      );
    });

    it('should emit event with tenantId in data', async () => {
      const webhooks = [createMockWebhookEntity({ id: 'webhook-1', tenantId: 'tenant-1' })];
      mockWebhookRepository.findAll.mockResolvedValue(webhooks);
      mockWebhookRepository.count.mockResolvedValue(1);

      await service.fetchAllByTenantId({
        limit: 10,
        page: 1,
        tenantId: 'tenant-1',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { tenantId: 'tenant-1', items: ['webhook-1'] },
        }),
      );
    });

    it('should return empty result when no webhooks match tenant', async () => {
      // `fetchAllByTenantId` now refuses
      // cross-tenant reads. Align this empty-result probe with the
      // CLS default (`tenant-1`) so the new guard does not
      // short-circuit and the assertion still validates the
      // "no rows" branch the original test was protecting.
      mockWebhookRepository.findAll.mockResolvedValue([]);
      mockWebhookRepository.count.mockResolvedValue(0);

      const result = await service.fetchAllByTenantId({
        limit: 10,
        page: 1,
        tenantId: 'tenant-1',
      });

      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
    });
  });

  describe('fetchAllCreatedByUser', () => {
    it('should return webhooks created by specific user', async () => {
      const webhooks = [createMockWebhookEntity({ id: 'webhook-1', createdBy: 'creator-id' })];
      mockWebhookRepository.findAll.mockResolvedValue(webhooks);
      mockWebhookRepository.count.mockResolvedValue(1);

      const result = await service.fetchAllCreatedByUser({
        limit: 10,
        page: 1,
        userId: 'creator-id',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].createdBy).toBe('creator-id');
      expect(mockWebhookRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdBy: 'creator-id' },
        }),
      );
    });

    it('should emit event with createdBy in data', async () => {
      const webhooks = [createMockWebhookEntity({ id: 'webhook-1', createdBy: 'creator-id' })];
      mockWebhookRepository.findAll.mockResolvedValue(webhooks);
      mockWebhookRepository.count.mockResolvedValue(1);

      await service.fetchAllCreatedByUser({
        limit: 10,
        page: 1,
        userId: 'creator-id',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { createdBy: 'creator-id', items: ['webhook-1'] },
        }),
      );
    });
  });

  describe('fetchById', () => {
    it('should return webhook by ID with complete data', async () => {
      const webhook = createMockWebhookEntity({
        id: 'webhook-123',
        name: 'Test Webhook',
        url: 'https://api.example.com/hook',
        resourceTypeName: 'Consultation',
      });
      mockWebhookRepository.findById.mockResolvedValue(webhook);

      const result = await service.fetchById('webhook-123');

      expect(result.id).toBe('webhook-123');
      expect(result.name).toBe('Test Webhook');
      expect(result.url).toBe('https://api.example.com/hook');
      expect(result.resourceTypeName).toBe('Consultation');
    });

    it('should emit ResourceViewed event with webhook data', async () => {
      const webhook = createMockWebhookEntity({ id: 'webhook-123' });
      mockWebhookRepository.findById.mockResolvedValue(webhook);

      await service.fetchById('webhook-123');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          responsibleEntityId: 'current-user-id',
        }),
      );
    });

    it('should propagate repository errors', async () => {
      mockWebhookRepository.findById.mockRejectedValue(new Error('Webhook not found'));

      await expect(service.fetchById('non-existent')).rejects.toThrow('Webhook not found');
    });
  });

  describe('update', () => {
    it('should update webhook successfully via updateWithVersion (Stream D Phase)', async () => {
      const existingWebhook = createMockWebhookEntity({
        id: 'webhook-123',
        name: 'Old Name',
        hasChanges: true,
        changes: { name: 'Updated Webhook' },
        version: 4,
      });
      mockWebhookRepository.findById.mockResolvedValue(existingWebhook);
      mockWebhookRepository.updateWithVersion.mockResolvedValue({ ...existingWebhook, version: 5 });

      const result = await service.update('webhook-123', { name: 'Updated Webhook', expectedVersion: 4 } as never);

      expect(result.id).toBe('webhook-123');
      // CAS-only — the legacy non-versioned write MUST NOT fire.
      expect(mockWebhookRepository.updateWithVersion).toHaveBeenCalledWith('webhook-123', existingWebhook, 4);
      expect(mockWebhookRepository.update).not.toHaveBeenCalled();
    });

    it('should emit ResourceUpdated event with previousVersion + newVersion (Stream D Phase)', async () => {
      const existingWebhook = createMockWebhookEntity({
        id: 'webhook-123',
        hasChanges: true,
        changes: { name: 'Updated Webhook' },
        version: 9,
      });
      mockWebhookRepository.findById.mockResolvedValue(existingWebhook);
      mockWebhookRepository.updateWithVersion.mockResolvedValue({ ...existingWebhook, version: 10 });

      await service.update('webhook-123', { name: 'Updated Webhook', expectedVersion: 9 } as never);

      // Same audit shape as Phase C.8 / E.1 / E.2 / E.3 / E.4.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'webhook-123',
          data: expect.objectContaining({
            name: 'Updated Webhook',
            previousVersion: 9,
            newVersion: 10,
          }),
        }),
      );
    });

    it('should throw ArgumentInvalidException when no changes detected', async () => {
      const existingWebhook = createMockWebhookEntity({
        id: 'webhook-123',
        hasChanges: false,
      });
      mockWebhookRepository.findById.mockResolvedValue(existingWebhook);

      await expect(service.update('webhook-123', { name: 'Same Name', expectedVersion: 1 } as never)).rejects.toThrow('No changes to write to');
    });

    it('should update multiple fields at once', async () => {
      const existingWebhook = createMockWebhookEntity({
        id: 'webhook-123',
        hasChanges: true,
        changes: { name: 'New Name', url: 'https://new.example.com/hook' },
      });
      mockWebhookRepository.findById.mockResolvedValue(existingWebhook);
      mockWebhookRepository.updateWithVersion.mockResolvedValue(existingWebhook);

      await service.update('webhook-123', {
        name: 'New Name',
        url: 'https://new.example.com/hook',
        expectedVersion: 1,
      } as never);

      expect(mockWebhookRepository.updateWithVersion).toHaveBeenCalled();
    });

    // TASK-727: `hashedSecret` is no longer settable via the general PATCH —
    // secrets rotate ONLY through `rotateSecret`. `UpdateWebhookRequest` no
    // longer declares the field (enforced at the HTTP edge by
    // forbidNonWhitelisted); this pins the service-level defense-in-depth
    // guard for callers that bypass the DTO type (Bull jobs, internal
    // service-to-service writes).
    it('rejects an update request that smuggles hashedSecret, before touching the repository', async () => {
      mockWebhookRepository.findById.mockResolvedValue(createMockWebhookEntity({ id: 'webhook-123' }));

      await expect(
        service.update('webhook-123', { hashedSecret: 'sneaky-value', expectedVersion: 1 } as never),
      ).rejects.toThrow('hashedSecret cannot be set via update');
      expect(mockWebhookRepository.findById).not.toHaveBeenCalled();
      expect(mockWebhookRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('propagates OptimisticConcurrencyException from the repository CAS write (Stream D Phase)', async () => {
      const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
      const existingWebhook = createMockWebhookEntity({
        id: 'webhook-123',
        hasChanges: true,
        changes: { name: 'Stale write' },
        version: 9,
      });
      mockWebhookRepository.findById.mockResolvedValue(existingWebhook);
      mockWebhookRepository.updateWithVersion.mockRejectedValue(
        new OptimisticConcurrencyException('Webhook', 'webhook-123', {
          expectedVersion: 9,
          currentVersion: 10,
        }),
      );

      await expect(service.update('webhook-123', { name: 'Stale write', expectedVersion: 9 } as never)).rejects.toThrow(
        OptimisticConcurrencyException,
      );

      // Audit MUST NOT broadcast on a failed CAS write.
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());
    });
  });

  // =========================================================================
  // rotateSecret (TASK-727): the ONLY write path that may set `hashedSecret`.
  // Same OCC/tenant-guard shape as `update`, but always mints a fresh raw
  // secret and returns it exactly once.
  // =========================================================================
  describe('rotateSecret', () => {
    it('mints a new raw secret, CAS-writes the reversibly-encrypted form, and returns the raw secret once', async () => {
      const existingWebhook = createMockWebhookEntity({ id: 'webhook-123', tenantId: 'tenant-1', version: 3 });
      mockWebhookRepository.findById.mockResolvedValue(existingWebhook);
      mockWebhookRepository.updateWithVersion.mockResolvedValue({ ...existingWebhook, version: 4 });

      const result = await service.rotateSecret('webhook-123', 3);

      expect(result.rawSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(mockWebhookRepository.updateWithVersion).toHaveBeenCalledWith('webhook-123', existingWebhook, 3);
      // The entity handed to updateWithVersion carries the freshly computed,
      // reversibly-encrypted form — never the raw secret, but it decrypts
      // back to exactly it.
      expect(existingWebhook.hashedSecret).not.toBe(result.rawSecret);
      expect(WebhookService.decryptSecret(existingWebhook.hashedSecret)).toBe(result.rawSecret);
    });

    it('emits ResourceUpdated without leaking the secret material', async () => {
      const existingWebhook = createMockWebhookEntity({ id: 'webhook-123', version: 3 });
      mockWebhookRepository.findById.mockResolvedValue(existingWebhook);
      mockWebhookRepository.updateWithVersion.mockResolvedValue({ ...existingWebhook, version: 4 });

      await service.rotateSecret('webhook-123', 3);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'webhook-123',
          data: expect.objectContaining({ rotatedSecret: true, previousVersion: 3, newVersion: 4 }),
        }),
      );
      const [, payload] = (mockEventEmitter.emit as ReturnType<typeof vi.fn>).mock.calls.find(([type]) => type === SysEventType.ResourceUpdated) as [
        string,
        { data: Record<string, unknown> },
      ];
      expect(JSON.stringify(payload.data)).not.toMatch(/[0-9a-f]{64}/);
    });

    it('throws NotFoundException + does not rotate for a cross-tenant non-admin caller', async () => {
      const otherWebhook = createMockWebhookEntity({ id: 'webhook-foreign', tenantId: 'tenant-2', version: 1 });
      mockWebhookRepository.findById.mockResolvedValue(otherWebhook);

      await expect(service.rotateSecret('webhook-foreign', 1)).rejects.toThrow('Resource not found');
      expect(mockWebhookRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('allows a SUPER_ADMIN to rotate a cross-tenant webhook secret', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'user') return { id: 'admin-1', roles: ['SUPER_ADMIN'] };
        if (key === 'tenantId') return 'tenant-9';
        return null;
      });
      const otherWebhook = createMockWebhookEntity({ id: 'webhook-foreign', tenantId: 'tenant-2', version: 1 });
      mockWebhookRepository.findById.mockResolvedValue(otherWebhook);
      mockWebhookRepository.updateWithVersion.mockResolvedValue({ ...otherWebhook, version: 2 });

      const result = await service.rotateSecret('webhook-foreign', 1);

      expect(result.rawSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(mockWebhookRepository.updateWithVersion).toHaveBeenCalled();
    });

    it('propagates OptimisticConcurrencyException on version drift', async () => {
      const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
      const existingWebhook = createMockWebhookEntity({ id: 'webhook-123', version: 3 });
      mockWebhookRepository.findById.mockResolvedValue(existingWebhook);
      mockWebhookRepository.updateWithVersion.mockRejectedValue(
        new OptimisticConcurrencyException('Webhook', 'webhook-123', { expectedVersion: 3, currentVersion: 4 }),
      );

      await expect(service.rotateSecret('webhook-123', 3)).rejects.toThrow(OptimisticConcurrencyException);
    });
  });

  describe('deleteById', () => {
    it('should soft delete webhook and return deleted entity', async () => {
      const deletedWebhook = createMockWebhookEntity({
        id: 'webhook-123',
        deletedAt: new Date(),
      });
      mockWebhookRepository.softDelete.mockResolvedValue(deletedWebhook);

      const result = await service.deleteById('webhook-123');

      expect(result.id).toBe('webhook-123');
      expect(mockWebhookRepository.softDelete).toHaveBeenCalledWith('webhook-123');
    });

    it('should emit ResourceDeleted event with complete data', async () => {
      const deletedWebhook = createMockWebhookEntity({ id: 'webhook-123' });
      mockWebhookRepository.softDelete.mockResolvedValue(deletedWebhook);

      await service.deleteById('webhook-123');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceDeleted,
        expect.objectContaining({
          resourceId: 'webhook-123',
          responsibleEntityId: 'current-user-id',
        }),
      );
    });

    it('should propagate repository errors on delete', async () => {
      mockWebhookRepository.softDelete.mockRejectedValue(new Error('Delete failed'));

      await expect(service.deleteById('webhook-123')).rejects.toThrow('Delete failed');
    });
  });

  describe('edge cases', () => {
    it('should handle service creation without user context', async () => {
      // `create` now requires a CLS `tenantId` (or DTO
      // tenantId via SUPER_ADMIN). Preserve the original test intent
      // ("no user") by still surfacing a valid tenantId from CLS — the
      // missing-tenant edge case is independently covered by the
      // helper test below.
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return null;
          case 'tenantId':
            return 'tenant-1';
          default:
            return null;
        }
      });

      const newWebhook = createMockWebhookEntity({ id: 'new-webhook-id' });
      mockWebhookRepository.create.mockResolvedValue(newWebhook);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'New Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
      });

      expect(result.webhook.id).toBe('new-webhook-id');
    });

    it('should handle empty search results gracefully', async () => {
      mockWebhookRepository.findAll.mockResolvedValue([]);
      mockWebhookRepository.count.mockResolvedValue(0);

      const result = await service.fetchAll({ limit: 10, page: 1 });

      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
    });

    it('should handle large pagination values', async () => {
      mockWebhookRepository.findAll.mockResolvedValue([]);
      mockWebhookRepository.count.mockResolvedValue(1000);

      const result = await service.fetchAll({ limit: 100, page: 10 });

      expect(result.limit).toBe(100);
      expect(result.page).toBe(10);
      expect(result.count).toBe(1000);
    });

    it('should handle webhooks with complex subscription metadata', async () => {
      const complexMetadata = {
        events: ['user.created', 'user.updated', 'user.deleted'],
        filters: {
          status: ['active', 'pending'],
          roles: ['admin', 'user'],
        },
        retryPolicy: {
          maxRetries: 3,
          backoffMs: 1000,
        },
      };
      const newWebhook = createMockWebhookEntity({
        id: 'new-webhook-id',
        subscriptionMetadata: complexMetadata,
      });
      mockWebhookRepository.create.mockResolvedValue(newWebhook);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'Complex Webhook',
        url: 'https://example.com/webhook',
        resourceTypeName: 'User',
        subscriptionMetadata: complexMetadata,
      });

      expect(result.webhook.subscriptionMetadata).toEqual(complexMetadata);
    });

    it('should handle URLs with special characters', async () => {
      const newWebhook = createMockWebhookEntity({
        id: 'new-webhook-id',
        url: 'https://example.com/webhook?param=value&other=test',
      });
      mockWebhookRepository.create.mockResolvedValue(newWebhook);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'URL Test Webhook',
        url: 'https://example.com/webhook?param=value&other=test',
        resourceTypeName: 'User',
      });

      expect(result.webhook.url).toBe('https://example.com/webhook?param=value&other=test');
    });
  });

  // =========================================================================
  // Delivery log (`fetchRunHistory`): webhook-scoped read
  // of WebhookRunHistory. The run-history rows carry no tenantId; tenancy is
  // enforced through the parent webhook (load-then-assert, 404 cross-tenant).
  // =========================================================================
  describe('fetchRunHistory (item 2)', () => {
    const runRow = {
      id: 'run-1',
      status: 'SUCCESS',
      response: { ok: true },
      responeStatusCode: 200,
      webhookId: 'webhook-id-1',
      createdAt: new Date('2026-07-01T00:00:00Z'),
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    };

    it('returns the paginated delivery log for an owned webhook (newest-first)', async () => {
      mockWebhookRepository.findById.mockResolvedValue(createMockWebhookEntity());
      mockWebhookRunHistoryRepository.findAll.mockResolvedValue([runRow]);
      mockWebhookRunHistoryRepository.count.mockResolvedValue(3);

      const result = await service.fetchRunHistory('webhook-id-1', { page: 1, limit: 10 });

      expect(mockWebhookRunHistoryRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ where: { webhookId: 'webhook-id-1' }, sort: [{ createdAt: 'desc' }], page: 1, limit: 10 }),
      );
      expect(mockWebhookRunHistoryRepository.count).toHaveBeenCalledWith({ where: { webhookId: 'webhook-id-1' } });
      expect(result.count).toBe(3);
      expect(result.data).toEqual([runRow]);
    });

    it('throws NotFoundException on a cross-tenant webhook id (no delivery read fires)', async () => {
      mockWebhookRepository.findById.mockResolvedValue(createMockWebhookEntity({ tenantId: 'tenant-2' }));

      await expect(service.fetchRunHistory('webhook-id-1', {})).rejects.toThrow('Resource not found');
      expect(mockWebhookRunHistoryRepository.findAll).not.toHaveBeenCalled();
    });

    it('lets SUPER_ADMIN read another tenant delivery log (admin tooling bypass)', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'user') return { id: 'admin-1', roles: ['SUPER_ADMIN'] };
        if (key === 'tenantId') return 'tenant-9';
        return null;
      });
      mockWebhookRepository.findById.mockResolvedValue(createMockWebhookEntity({ tenantId: 'tenant-2' }));
      mockWebhookRunHistoryRepository.findAll.mockResolvedValue([]);
      mockWebhookRunHistoryRepository.count.mockResolvedValue(0);

      const result = await service.fetchRunHistory('webhook-id-1', {});
      expect(result.count).toBe(0);
    });
  });
});
