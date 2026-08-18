/**
 * TASK-756 — privilege ceiling on API-key minting.
 *
 * `create()` and `update()` used to persist `request.scopes` verbatim. The only
 * validation was `ValidScopesConstraint`, which checks membership in
 * `API_KEY_SCOPE_REGISTRY` and nothing else — so a TENANT ADMIN (gated by the
 * class-level `@CanManage('ApiKey')` on `ApiKeyController`, NOT by SUPER_ADMIN)
 * could mint a key carrying `admin:*` or the bare `'*'`.
 *
 * The ceiling closes the MINTING side. The request-time side —
 * `UnifiedAuthGuard.enforceApiKeyAbilities()`, which evaluates the route's CASL
 * metadata against the key's BOUND USER — is untouched: scope and ability remain
 * a conjunction, never a fallback.
 */

import { ApiKeyStatus, ApiKeyType, ResourceStatusType } from '@arcaai/domains';
import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on the resolver so a "no scopes touched → no ceiling check at all" claim
// can be asserted directly rather than inferred.
vi.mock('../apikey-scopes.registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../apikey-scopes.registry')>();
  return { ...actual, resolveImpliedPermissions: vi.fn(actual.resolveImpliedPermissions) };
});

import { resolveImpliedPermissions } from '../apikey-scopes.registry';
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

/** CLS for a caller authenticated by JWT whose compiled CASL ability is `can`. */
const setCaller = (opts: { can?: (action: string, subject: string) => boolean; roles?: string[]; noAbility?: boolean }) => {
  mockClsService.get.mockImplementation((key: string) => {
    switch (key) {
      case 'user':
        return { id: 'caller-1', roles: opts.roles ?? [] };
      case 'tenantId':
        return 'tenant-1';
      case 'userAbility':
        return opts.noAbility ? undefined : { can: opts.can ?? (() => false) };
      default:
        return null;
    }
  });
};

/** A tenant admin: `manage:ApiKey` and the rest of `tenant-full-access`, but no `manage:all`. */
const tenantAdminAbility = (action: string, subject: string) =>
  action === 'manage' && ['ApiKey', 'User', 'Consultation', 'Webhook', 'Storage'].includes(subject);

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

describe('TASK-756 — ApiKeyService minting privilege ceiling', () => {
  let service: ApiKeyService;

  beforeEach(() => {
    vi.clearAllMocks();
    setCaller({ can: tenantAdminAbility });
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

  // ─── create() ──────────────────────────────────────────────────────────

  describe('create()', () => {
    // T3
    it('rejects a scope whose implied ability the caller does not hold', async () => {
      setCaller({ can: (action, subject) => !(subject === 'Tenant') && tenantAdminAbility(action, subject) });

      await expect(service.create({ keyName: 'escalate', scopes: ['admin:tenant:write'] } as never)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockApiKeyRepository.create).not.toHaveBeenCalled();
    });

    // T4
    it("rejects 'admin:*' for a caller holding only manage:ApiKey", async () => {
      setCaller({ can: (action, subject) => action === 'manage' && subject === 'ApiKey' });

      await expect(service.create({ keyName: 'admin-wildcard', scopes: ['admin:*'] } as never)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockApiKeyRepository.create).not.toHaveBeenCalled();
    });

    // T5
    it("rejects the bare '*' for a non-SUPER_ADMIN", async () => {
      setCaller({ can: tenantAdminAbility });

      await expect(service.create({ keyName: 'god-key', scopes: ['*'] } as never)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockApiKeyRepository.create).not.toHaveBeenCalled();
    });

    // T6 — regression guard against over-tightening: the ordinary SDK-key path
    // must keep working. GREEN both before and after the fix.
    it('admits an ordinary SDK scope the caller does hold', async () => {
      setCaller({ can: (action, subject) => subject === 'Consultation' && action === 'create' });

      await expect(service.create({ keyName: 'sdk', scopes: ['consultation:session:write'] } as never)).resolves.toBeDefined();
      expect(mockApiKeyRepository.create).toHaveBeenCalled();
    });

    // T7 — the API-key-authenticated minting path. `UnifiedAuthGuard`
    // deliberately does NOT publish the ability to CLS on the API-key path, so
    // a caller who authenticated WITH an API key has no `userAbility` at all.
    // Fail closed.
    it('rejects when no compiled ability is present in CLS (fail closed)', async () => {
      setCaller({ noAbility: true });

      await expect(service.create({ keyName: 'no-ability', scopes: ['consultation:session:read'] } as never)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockApiKeyRepository.create).not.toHaveBeenCalled();
    });

    // T8
    it('lets a SUPER_ADMIN mint any scope array', async () => {
      setCaller({ roles: ['SUPER_ADMIN'], noAbility: true });

      await expect(service.create({ keyName: 'platform', scopes: ['*', 'admin:*', 'internal:stt:worker'] } as never)).resolves.toBeDefined();
      expect(mockApiKeyRepository.create).toHaveBeenCalled();
    });

    it('performs no ceiling check when no scopes are requested', async () => {
      setCaller({ can: () => false });

      await expect(service.create({ keyName: 'scopeless' } as never)).resolves.toBeDefined();
      expect(vi.mocked(resolveImpliedPermissions)).not.toHaveBeenCalled();
    });

    it('rejects a scope that is not in the registry at all (fail closed, never silently allowed)', async () => {
      setCaller({ can: () => true });

      await expect(service.create({ keyName: 'typo', scopes: ['admin:tenant:writ'] } as never)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockApiKeyRepository.create).not.toHaveBeenCalled();
    });
  });

  // ─── update() ──────────────────────────────────────────────────────────

  describe('update()', () => {
    // T9a — only the ADDED scope is gated.
    it('rejects a PATCH that WIDENS the key with a scope the caller does not hold', async () => {
      mockApiKeyRepository.findById.mockResolvedValue(storedKey(['consultation:session:read']));
      setCaller({ can: tenantAdminAbility });

      await expect(service.update('key-1', { scopes: ['consultation:session:read', 'admin:*'] } as never)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockApiKeyRepository.update).not.toHaveBeenCalled();
    });

    // T9b — a PATCH that does not touch `scopes` runs no ceiling check at all.
    it('performs no ceiling check when the PATCH omits `scopes`', async () => {
      mockApiKeyRepository.findById.mockResolvedValue(storedKey(['admin:*']));
      setCaller({ can: tenantAdminAbility });

      await service.update('key-1', { keyName: 'renamed' } as never);

      expect(vi.mocked(resolveImpliedPermissions)).not.toHaveBeenCalled();
    });

    // T9c — narrowing an already-broad array must not fail on what the key
    // already carries.
    it('admits a PATCH that NARROWS an already-broad scope array', async () => {
      mockApiKeyRepository.findById.mockResolvedValue(storedKey(['admin:*', 'consultation:session:read']));
      setCaller({ can: tenantAdminAbility });

      await expect(service.update('key-1', { scopes: ['admin:*'] } as never)).resolves.toBeDefined();
      expect(mockApiKeyRepository.update).toHaveBeenCalled();
    });
  });
});
