/**
 * TASK-757 (policy A2) — reserved scopes are refused at GRANT time.
 *
 * A2 makes `/api/v1/admin/*` JWT-only, so every `admin:*` and `webhook:*` scope
 * is inert at request time (`@ForbidApiKey()` is checked BEFORE the scope check
 * in `UnifiedAuthGuard`, so not even the bare `'*'` wildcard rescues a key).
 * The strings are kept as vocabulary for TASK-762's service-account plane and
 * so pre-existing stored keys stay readable — but they must stop being
 * GRANTABLE, or the platform keeps minting credentials it will always refuse.
 *
 * The rule splits in two, and the split is forced rather than stylistic:
 *
 * - **create** — every scope is new, so a DTO-level constraint
 *   (`NoReservedScopesConstraint`) is correct and sufficient. The service
 *   check here is the defence-in-depth half, and covers callers that reach the
 *   service without the DTO pipe.
 * - **update** — the rule is a DELTA rule. A class-validator constraint cannot
 *   see the stored key, so a membership-style constraint on the update DTO
 *   would fail every `PATCH` on a pre-existing key whose stored array contains
 *   `admin:*`, on a field the caller never touched. The delta check therefore
 *   lives in `ApiKeyService.update()`.
 *
 * Unlike TASK-756's privilege ceiling, this rule has **no SUPER_ADMIN fast
 * path**. The ceiling asks "may this caller grant this much power?"; A2 asks
 * "may a long-lived static bearer credential reach the admin plane at all?",
 * and the answer is no for everyone until TASK-762 lands a real machine
 * credential class.
 */

import { ApiKeyStatus, ApiKeyType, ResourceStatusType } from '@arcaai/domains';
import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiKeyService } from '../apikey.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockApiKeyRepository = {
  findFirst: vi.fn(),
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  db: { update: vi.fn() },
};
const mockUserRoleAssignmentRepository = { findFirst: vi.fn() };
const mockUserDepartmentRepository = { findFirst: vi.fn() };
const mockUserRepository = { findFirst: vi.fn() };

const setCaller = (opts: { can?: (action: string, subject: string) => boolean; roles?: string[] }) => {
  mockClsService.get.mockImplementation((key: string) => {
    switch (key) {
      case 'user':
        return { id: 'caller-1', roles: opts.roles ?? [] };
      case 'tenantId':
        return 'tenant-1';
      case 'userAbility':
        return { can: opts.can ?? (() => true) };
      default:
        return null;
    }
  });
};

const storedKey = (scopes: string[] | null) => ({
  id: 'key-1',
  tenantId: 'tenant-1',
  userId: 'caller-1',
  keyName: 'Existing Key',
  keyStatus: ApiKeyStatus.ACTIVE,
  keyType: ApiKeyType.SDK,
  scopes,
  allowedIps: null,
  rateLimit: 0,
  description: null,
  environment: null,
  hasChanges: true,
  changes: { keyName: 'x' },
  setProperty: vi.fn(),
});

describe('TASK-757 — ApiKeyService refuses to grant reserved scopes', () => {
  let service: ApiKeyService;

  beforeEach(() => {
    vi.clearAllMocks();
    // SUPER_ADMIN with an unrestricted ability: the most privileged caller the
    // platform has. Even this caller must not be able to grant a reserved scope.
    setCaller({ can: () => true, roles: ['SUPER_ADMIN'] });
    mockUserRoleAssignmentRepository.findFirst.mockResolvedValue({
      id: 'ura-1',
      userId: 'caller-1',
      tenantId: 'tenant-1',
      resourceStatus: ResourceStatusType.ENABLED,
    });
    mockUserDepartmentRepository.findFirst.mockResolvedValue({
      id: 'ud-1',
      userId: 'caller-1',
      tenantId: 'tenant-1',
      resourceStatus: ResourceStatusType.ENABLED,
    });
    mockUserRepository.findFirst.mockResolvedValue({ id: 'caller-1', isServiceAccount: false });
    mockApiKeyRepository.count.mockResolvedValue(0);
    mockApiKeyRepository.create.mockImplementation(async (entity: unknown) => entity);
    mockApiKeyRepository.update.mockImplementation(async (_id: string, entity: unknown) => entity);

    service = new ApiKeyService(
      mockApiKeyRepository as never,
      mockUserRoleAssignmentRepository as never,
      mockUserDepartmentRepository as never,
      mockUserRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
    );
  });

  describe('create()', () => {
    it('refuses an admin: scope even for a SUPER_ADMIN caller', async () => {
      await expect(service.create({ keyName: 'k', scopes: ['admin:tenant:write'] } as never)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockApiKeyRepository.create).not.toHaveBeenCalled();
    });

    it("refuses the admin:* wildcard — it sits outside the contiguous admin block and must not be missed", async () => {
      await expect(service.create({ keyName: 'k', scopes: ['admin:*'] } as never)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a webhook: scope — WebhookController lives at admin/webhooks', async () => {
      await expect(service.create({ keyName: 'k', scopes: ['webhook:event:write'] } as never)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("admits the bare '*' — the platform SERVICE_ACCOUNT wildcard for /internal/*", async () => {
      await expect(service.create({ keyName: 'k', scopes: ['*'] } as never)).resolves.toBeDefined();
    });

    it('admits an ordinary business-plane scope', async () => {
      await expect(service.create({ keyName: 'k', scopes: ['consultation:session:read'] } as never)).resolves.toBeDefined();
    });
  });

  describe('update() — DELTA rule, not a membership rule', () => {
    it('refuses a PATCH that ADDS a reserved scope', async () => {
      mockApiKeyRepository.findById.mockResolvedValue(storedKey(['consultation:session:read']));

      await expect(service.update('key-1', { scopes: ['consultation:session:read', 'admin:*'] } as never)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockApiKeyRepository.update).not.toHaveBeenCalled();
    });

    /**
     * The over-tightening guard. A dev-seeded key already carries `admin:*`;
     * renaming it must not fail on a field the caller never touched.
     */
    it('ADMITS a PATCH whose scope array is unchanged and already contains a reserved scope', async () => {
      mockApiKeyRepository.findById.mockResolvedValue(storedKey(['admin:*', 'consultation:session:read']));

      await expect(service.update('key-1', { scopes: ['admin:*', 'consultation:session:read'] } as never)).resolves.toBeDefined();
      expect(mockApiKeyRepository.update).toHaveBeenCalled();
    });

    it('ADMITS a PATCH that omits `scopes` entirely on a key holding a reserved scope', async () => {
      mockApiKeyRepository.findById.mockResolvedValue(storedKey(['admin:*']));

      await expect(service.update('key-1', { keyName: 'renamed' } as never)).resolves.toBeDefined();
    });

    it('ADMITS a PATCH that NARROWS away a reserved scope', async () => {
      mockApiKeyRepository.findById.mockResolvedValue(storedKey(['admin:*', 'consultation:session:read']));

      await expect(service.update('key-1', { scopes: ['consultation:session:read'] } as never)).resolves.toBeDefined();
    });
  });
});
