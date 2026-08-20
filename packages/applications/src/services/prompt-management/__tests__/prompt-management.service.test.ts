/**
 * PromptManagementService Unit Tests
 *
 * Tests for prompt template CRUD, versioning, and department assignment.
 * Mocks only at boundaries: repositories (database) and event emitter.
 * Verifies actual service behavior, return values, and side effects.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SysEventType, ResourceStatusType, PromptTemplateFactory } from '@arcaai/domains';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { PromptManagementService } from '../prompt-management.service';

// ─── Mock Factories ─────────────────────────────────────────────────
// Each mock factory returns an object matching the real repository interface.
// Only methods actually used by the service are included.

const createMockClsService = () => ({
  get: vi.fn(),
  set: vi.fn(),
});

const createMockEventEmitter = () => ({
  emit: vi.fn(),
});

const createMockQueryBuilder = () => {
  const mockWhere = vi.fn().mockReturnThis();
  const mockWhereOr = vi.fn().mockReturnThis();
  const mockToList = vi.fn().mockResolvedValue([]);
  return {
    Where: mockWhere,
    WhereOr: mockWhereOr,
    ToList: mockToList,
  };
};

const createMockDepartmentService = () => ({
  updatePromptConfig: vi.fn(),
  getAll: vi.fn(),
  getById: vi.fn(),
  getByCode: vi.fn(),
  getRootDepartments: vi.fn(),
  getChildren: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteById: vi.fn(),
});

const createMockPromptTemplateRepository = () => ({
  findById: vi.fn(),
  findByName: vi.fn(),
  findByDepartment: vi.fn(),
  findByCategory: vi.fn(),
  findMyPersonalForDepartment: vi.fn(),
  findAll: vi.fn(),
  findPaginated: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  // `updatePromptTemplate` now writes via
  // Compare-And-Set (`updateWithVersion`). Legacy `.update` stays on
  // the mock for assertions that confirm it is NOT called.
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
  $: vi.fn(),
  // Encrypt-on-write helper (declaration-merged onto the
  // generated repo). Default no-op so the legacy fixtures (no SecretsService
  // wired) never invoke it.
  encryptFieldsIntoEntity: vi.fn(async () => undefined),
});

const createMockPromptVersionRepository = () => ({
  findByTemplate: vi.fn(),
  findByVersionNumber: vi.fn(),
  create: vi.fn(),
  // Max-version helper queried inside the OCC transaction so the
  // next versionNumber is max(existing)+1, never a recomputed duplicate.
  findMaxVersionNumber: vi.fn().mockResolvedValue(0),
  // Latest snapshot — approval blesses this row when it already matches the
  // template's live content, instead of minting a duplicate version.
  findLatestVersion: vi.fn().mockResolvedValue(null),
});

const createMockPromptUsageRecordRepository = () => ({
  findByTemplate: vi.fn().mockResolvedValue([]),
  findByDepartment: vi.fn().mockResolvedValue([]),
  // Analytics groupBy aggregations
  groupByDepartment: vi.fn().mockResolvedValue([]),
  groupByDoctor: vi.fn().mockResolvedValue([]),
  groupByDay: vi.fn().mockResolvedValue([]),
  // Paginated raw run listing (Agent Jobs surface)
  findAll: vi.fn().mockResolvedValue([]),
  count: vi.fn().mockResolvedValue(0),
});

// TEXT/text-generation client is an injected dependency
// (HttpService) so the prompt-test path is unit-testable with a mock; the
// live TEXT call is verified in CI against the running Python service.
const createMockHttpService = (responseData: Record<string, unknown>) => ({
  axiosRef: {
    post: vi.fn().mockResolvedValue({ data: responseData }),
  },
});

const createMockConfigService = (textUrl = 'http://text.local:8862') => ({
  get: vi.fn().mockReturnValue(textUrl),
});

const wordsOfLength = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

// `updatePromptTemplate` wraps the version-row insert + the OCC
// compare-and-set in `databaseService.baseClient.$transaction(callback)` so
// they commit/roll back atomically (mirrors TenantService / UserService).
// The mock invokes the callback with a stub tx client so the body executes;
// tests assert the create + CAS receive that tx client and that a thrown
// conflict propagates without a ResourceUpdated broadcast.
const mockTxClient = { __tx: true } as const;
const mockDatabaseService = {
  baseClient: {
    $transaction: vi.fn().mockImplementation(async (callback: (tx: typeof mockTxClient) => Promise<unknown>) => callback(mockTxClient)),
  },
};

// ─── Entity Helpers ─────────────────────────────────────────────────
// Complete mock entities matching real entity structure for mapper compatibility.

const createMockTemplateEntity = (overrides: Record<string, unknown> = {}) => {
  let _changed = false;
  const entity: Record<string, unknown> = {
    id: overrides.id ?? 'template-id-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    name: overrides.name ?? 'Test Prompt',
    description: 'description' in overrides ? overrides.description : 'A test prompt template',
    content: overrides.content ?? 'You are a clinical assistant.',
    category: overrides.category ?? 'SYSTEM',
    status: 'status' in overrides ? overrides.status : 'DRAFT',
    variables: 'variables' in overrides ? overrides.variables : null,
    currentVersionNumber: 'currentVersionNumber' in overrides ? overrides.currentVersionNumber : 1,
    departmentId: 'departmentId' in overrides ? overrides.departmentId : null,
    scope: 'scope' in overrides ? overrides.scope : 'TENANT_DEFAULT',
    ownerUserId: 'ownerUserId' in overrides ? overrides.ownerUserId : null,
    tags: 'tags' in overrides ? overrides.tags : [],
    resourceStatus: overrides.resourceStatus ?? 'ENABLED',
    createdAt: overrides.createdAt ?? new Date('2026-02-18T10:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-02-18T10:00:00Z'),
    createdBy: overrides.createdBy ?? 'user-id-1',
    updatedBy: overrides.updatedBy ?? null,
    changes: overrides.changes ?? {},
    // `_version` is required for the CAS
    // write path. Default = first-write (1); override per-test as needed.
    // Distinct from `currentVersionNumber` (the human-meaningful
    // PromptVersion history counter).
    version: 'version' in overrides ? overrides.version : 1,
    isActive: () => (overrides.resourceStatus ?? 'ENABLED') === 'ENABLED',
    incrementVersion: vi.fn().mockImplementation(() => {
      _changed = true;
    }),
    enable: vi.fn().mockImplementation(() => {
      _changed = true;
    }),
    disable: vi.fn().mockImplementation(() => {
      _changed = true;
    }),
    toObject: vi.fn().mockReturnValue(overrides),
  };
  const trackedKeys = new Set(['name', 'description', 'content', 'status', 'variables', 'tags', 'resourceStatus', 'scope', 'ownerUserId']);
  return new Proxy(entity, {
    set(target, prop, value) {
      if (trackedKeys.has(prop as string)) _changed = true;
      target[prop as string] = value;
      return true;
    },
    get(target, prop) {
      if (prop === 'hasChanges') return _changed;
      return target[prop as string];
    },
  });
};

const createMockVersionEntity = (overrides: Record<string, unknown> = {}) => ({
  id: overrides.id ?? 'version-id-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  promptTemplateId: overrides.promptTemplateId ?? 'template-id-1',
  versionNumber: overrides.versionNumber ?? 1,
  content: overrides.content ?? 'You are a clinical assistant.',
  variables: overrides.variables ?? null,
  changeReason: overrides.changeReason ?? 'Initial version',
  changedBy: overrides.changedBy ?? 'user-id-1',
  createdAt: overrides.createdAt ?? new Date('2026-02-18T10:00:00Z'),
});

// Mock domain factories — return complete entities
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    PromptTemplateFactory: {
      CreatePromptTemplate: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        id: 'new-template-id',
        currentVersionNumber: 1,
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
        resourceStatus: 'ENABLED',
        isActive: () => true,
        incrementVersion: vi.fn(),
        toObject: vi.fn().mockReturnValue(data),
      })),
    },
    PromptVersionFactory: {
      CreatePromptVersion: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        id: 'new-version-id',
        createdAt: new Date('2026-02-18T10:00:00Z'),
      })),
    },
  };
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('PromptManagementService', () => {
  let service: PromptManagementService;
  let mockTemplateRepo: ReturnType<typeof createMockPromptTemplateRepository>;
  let mockVersionRepo: ReturnType<typeof createMockPromptVersionRepository>;
  let mockUsageRepo: ReturnType<typeof createMockPromptUsageRecordRepository>;
  let mockClsService: ReturnType<typeof createMockClsService>;
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
  let mockDepartmentService: ReturnType<typeof createMockDepartmentService>;
  let abilityCan: ReturnType<typeof vi.fn>;

  const defaultClsContext = {
    user: { id: 'user-id-1', firstName: 'Test', lastName: 'User', email: 'test@test.com' },
    tenantId: 'tenant-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockTemplateRepo = createMockPromptTemplateRepository();
    mockVersionRepo = createMockPromptVersionRepository();
    mockUsageRepo = createMockPromptUsageRecordRepository();
    mockClsService = createMockClsService();
    mockEventEmitter = createMockEventEmitter();
    mockDepartmentService = createMockDepartmentService();
    abilityCan = vi.fn().mockReturnValue(true); // default: caller can manage; override per-test

    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return defaultClsContext.user;
        case 'tenantId':
          return defaultClsContext.tenantId;
        case 'userAbility':
          return { can: abilityCan };
        default:
          return null;
      }
    });

    service = new PromptManagementService(
      mockTemplateRepo as never,
      mockVersionRepo as never,
      mockUsageRepo as never,
      mockDepartmentService as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDatabaseService as never,
    );
  });

  // ─── createPromptTemplate ───────────────────────────────────

  describe('createPromptTemplate', () => {
    it('should create template and return response with correct fields on success', async () => {
      mockTemplateRepo.findByName.mockResolvedValue(null);
      const savedEntity = createMockTemplateEntity({
        id: 'template-id-1',
        name: 'New Prompt',
        category: 'DNA_ANALYSIS',
        content: 'Analyze writing style.',
      });
      mockTemplateRepo.create.mockResolvedValue(savedEntity);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      const result = await service.createPromptTemplate({
        name: 'New Prompt',
        content: 'Analyze writing style.',
        category: 'DNA_ANALYSIS',
      });

      expect(result.id).toBe('template-id-1');
      expect(result.name).toBe('New Prompt');
      expect(result.category).toBe('DNA_ANALYSIS');
      expect(result.content).toBe('Analyze writing style.');
      expect(result.currentVersionNumber).toBe(1);
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    it('should create initial PromptVersion v1 alongside template', async () => {
      mockTemplateRepo.findByName.mockResolvedValue(null);
      mockTemplateRepo.create.mockResolvedValue(createMockTemplateEntity());
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      await service.createPromptTemplate({
        name: 'Test',
        content: 'Content',
        category: 'SYSTEM',
      });

      expect(mockVersionRepo.create).toHaveBeenCalledTimes(1);
      expect(mockVersionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          versionNumber: 1,
          content: 'Content',
          changeReason: 'Initial version',
        }),
      );
    });

    it('should throw BadRequestException when name already exists (duplicate name)', async () => {
      mockTemplateRepo.findByName.mockResolvedValue(createMockTemplateEntity());

      await expect(
        service.createPromptTemplate({
          name: 'Duplicate',
          content: 'x',
          category: 'SYSTEM',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.createPromptTemplate({
          name: 'Duplicate',
          content: 'x',
          category: 'SYSTEM',
        }),
      ).rejects.toThrow("Prompt template with name 'Duplicate' already exists");

      expect(mockTemplateRepo.create).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? null : defaultClsContext.user));
      mockTemplateRepo.findByName.mockResolvedValue(null);

      await expect(service.createPromptTemplate({ name: 'Test', content: 'x', category: 'SYSTEM' })).rejects.toThrow(BadRequestException);

      await expect(service.createPromptTemplate({ name: 'Test', content: 'x', category: 'SYSTEM' })).rejects.toThrow('Tenant ID is required');

      expect(mockTemplateRepo.create).not.toHaveBeenCalled();
    });

    it('should include optional fields when provided (description, variables, departmentId, tags)', async () => {
      mockTemplateRepo.findByName.mockResolvedValue(null);
      const savedEntity = createMockTemplateEntity({
        id: 'tpl-1',
        name: 'Full Prompt',
        description: 'A detailed prompt',
        variables: { format: 'SOAP' },
        departmentId: 'dept-1',
        tags: ['clinical', 'soap'],
      });
      mockTemplateRepo.create.mockResolvedValue(savedEntity);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      const result = await service.createPromptTemplate({
        name: 'Full Prompt',
        content: 'Content',
        category: 'SUMMARY',
        description: 'A detailed prompt',
        variables: { format: 'SOAP' },
        departmentId: 'dept-1',
        tags: ['clinical', 'soap'],
      });

      expect(result.id).toBe('tpl-1');
      expect(result.name).toBe('Full Prompt');
      expect(result.description).toBe('A detailed prompt');
      expect(result.variables).toEqual({ format: 'SOAP' });
      expect(result.departmentId).toBe('dept-1');
      expect(result.tags).toEqual(['clinical', 'soap']);
    });

    it('should create template without optional fields when omitted', async () => {
      mockTemplateRepo.findByName.mockResolvedValue(null);
      const savedEntity = createMockTemplateEntity({
        name: 'Minimal',
        description: null,
        variables: null,
        departmentId: null,
        tags: [],
      });
      mockTemplateRepo.create.mockResolvedValue(savedEntity);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      const result = await service.createPromptTemplate({
        name: 'Minimal',
        content: 'Minimal content',
        category: 'CUSTOM',
      });

      expect(result.name).toBe('Minimal');
      expect(result.description).toBeUndefined();
      expect(result.variables).toBeUndefined();
      expect(result.departmentId).toBeUndefined();
      expect(result.tags).toEqual([]);
    });

    it('should broadcast ResourceCreated event', async () => {
      mockTemplateRepo.findByName.mockResolvedValue(null);
      mockTemplateRepo.create.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1' }));
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      await service.createPromptTemplate({
        name: 'Test',
        content: 'x',
        category: 'SYSTEM',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'tpl-1',
          data: { name: 'Test', category: 'SYSTEM' },
        }),
      );
    });

    // Publication status threaded to the factory.
    it('should pass the provided status to the factory', async () => {
      mockTemplateRepo.findByName.mockResolvedValue(null);
      mockTemplateRepo.create.mockResolvedValue(createMockTemplateEntity({ status: 'PUBLISHED' }));
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      const result = await service.createPromptTemplate({
        name: 'Published Prompt',
        content: 'x',
        category: 'SYSTEM',
        status: 'PUBLISHED',
      } as never);

      expect(PromptTemplateFactory.CreatePromptTemplate).toHaveBeenCalledWith(expect.objectContaining({ status: 'PUBLISHED' }));
      expect(result.status).toBe('PUBLISHED');
    });

    it('should default status to DRAFT when omitted', async () => {
      mockTemplateRepo.findByName.mockResolvedValue(null);
      mockTemplateRepo.create.mockResolvedValue(createMockTemplateEntity({ status: 'DRAFT' }));
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      const result = await service.createPromptTemplate({
        name: 'Drafty',
        content: 'x',
        category: 'SYSTEM',
      });

      expect(PromptTemplateFactory.CreatePromptTemplate).toHaveBeenCalledWith(expect.objectContaining({ status: 'DRAFT' }));
      expect(result.status).toBe('DRAFT');
    });
  });

  // ─── updatePromptTemplate ───────────────────────────────────

  describe('updatePromptTemplate', () => {
    it('should create new version snapshot and increment version number on success', async () => {
      const existing = createMockTemplateEntity({ currentVersionNumber: 2, version: 4 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      // Next version is max(existing)+1; history max here is 2 → 3.
      mockVersionRepo.findMaxVersionNumber.mockResolvedValue(2);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ currentVersionNumber: 3, version: 5 }));
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 3 }));

      const result = await service.updatePromptTemplate('template-id-1', {
        content: 'Updated content',
        changeReason: 'Improved prompt',
        expectedVersion: 4,
      } as never);

      expect(mockVersionRepo.create).toHaveBeenCalledTimes(1);
      expect(mockVersionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          versionNumber: 3,
          content: 'Updated content',
          changeReason: 'Improved prompt',
        }),
        mockTxClient,
      );
      expect(existing.incrementVersion).toHaveBeenCalled();
      expect(result.currentVersionNumber).toBe(3);
      // CAS-only — the legacy non-versioned write MUST NOT fire.
      expect(mockTemplateRepo.update).not.toHaveBeenCalled();
      expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalledWith('template-id-1', existing, 4, mockTxClient);
    });

    it('should throw NotFoundException when template does not exist', async () => {
      mockTemplateRepo.findById.mockResolvedValue(null);

      await expect(service.updatePromptTemplate('nonexistent', { content: 'x', expectedVersion: 1 } as never)).rejects.toThrow(NotFoundException);

      await expect(service.updatePromptTemplate('nonexistent', { content: 'x', expectedVersion: 1 } as never)).rejects.toThrow(
        'Prompt template nonexistent not found',
      );

      expect(mockVersionRepo.create).not.toHaveBeenCalled();
    });

    it('should perform partial update (only content)', async () => {
      const existing = createMockTemplateEntity({
        name: 'Original',
        content: 'Original content',
      });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(existing);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      const result = await service.updatePromptTemplate('template-id-1', {
        content: 'New content',
        expectedVersion: 1,
      } as never);

      expect(existing.content).toBe('New content');
      expect(existing.name).toBe('Original');
      expect(result.content).toBe('New content');
    });

    it('should perform partial update (only name)', async () => {
      const existing = createMockTemplateEntity({
        name: 'Original',
        content: 'Original content',
      });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(existing);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      await service.updatePromptTemplate('template-id-1', { name: 'Renamed', expectedVersion: 1 } as never);

      expect(existing.name).toBe('Renamed');
      expect(existing.content).toBe('Original content');
    });

    it('should perform partial update (only tags)', async () => {
      const existing = createMockTemplateEntity({
        name: 'Original',
        tags: ['old'],
      });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(existing);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      await service.updatePromptTemplate('template-id-1', { tags: ['new', 'tags'], expectedVersion: 1 } as never);

      expect(existing.tags).toEqual(['new', 'tags']);
    });

    // A status-only change is a mutating edit (no new
    // PromptVersion snapshot, but the OCC write still proceeds).
    it('should apply a status change without creating a new version snapshot', async () => {
      const existing = createMockTemplateEntity({ status: 'DRAFT', version: 3 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ status: 'PUBLISHED', version: 4 }));

      const result = await service.updatePromptTemplate('template-id-1', {
        status: 'PUBLISHED',
        expectedVersion: 3,
      } as never);

      expect(existing.status).toBe('PUBLISHED');
      // status-only edits don't spawn a PromptVersion row
      expect(mockVersionRepo.create).not.toHaveBeenCalled();
      // but the OCC write must still fire (status counts as a change)
      expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalledWith('template-id-1', existing, 3, mockTxClient);
      expect(result.status).toBe('PUBLISHED');
    });

    it('should increment version from null when currentVersionNumber is null', async () => {
      const existing = createMockTemplateEntity({ currentVersionNumber: null });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ currentVersionNumber: 1 }));
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 1 }));

      await service.updatePromptTemplate('template-id-1', { content: 'Updated', expectedVersion: 1 } as never);

      expect(mockVersionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          versionNumber: 1,
        }),
        mockTxClient,
      );
    });

    it('should include changeReason when provided', async () => {
      const existing = createMockTemplateEntity();
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(existing);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      await service.updatePromptTemplate('template-id-1', {
        content: 'Updated',
        changeReason: 'Bug fix',
        expectedVersion: 1,
      } as never);

      expect(mockVersionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          changeReason: 'Bug fix',
        }),
        mockTxClient,
      );
    });

    it('should handle update without changeReason', async () => {
      const existing = createMockTemplateEntity();
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(existing);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      await service.updatePromptTemplate('template-id-1', { content: 'Updated', expectedVersion: 1 } as never);

      expect(mockVersionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          changeReason: null,
        }),
        mockTxClient,
      );
    });

    it('should broadcast ResourceUpdated event with previousVersion + newVersion (Stream D Phase)', async () => {
      const existing = createMockTemplateEntity({ version: 9 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ version: 10 }));
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      await service.updatePromptTemplate('template-id-1', {
        content: 'Updated',
        changeReason: 'Improvement',
        expectedVersion: 9,
      } as never);

      // Same audit shape as Phase C.8 / E.1 / E.2: the SysEvent carries
      // both versions so downstream observers can correlate the change
      // with the row's prior state.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'template-id-1',
          data: expect.objectContaining({
            changeReason: 'Improvement',
            previousVersion: 9,
            newVersion: 10,
          }),
        }),
      );
    });

    it('flags a live content edit of an APPROVED template with wasApprovedLiveEdit (F-33)', async () => {
      const existing = createMockTemplateEntity({ status: 'APPROVED', version: 9 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockVersionRepo.findMaxVersionNumber.mockResolvedValue(3);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 4 }));
      mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ status: 'APPROVED', version: 10 }));

      await service.updatePromptTemplate('template-id-1', { content: 'Edited after approval', expectedVersion: 9 } as never);

      // Downstream audit can distinguish a live edit of an APPROVED template
      // from a routine DRAFT edit. The new version is NOT served until
      // re-approval (resolution serves approvedVersionNumber).
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          data: expect.objectContaining({ wasApprovedLiveEdit: true, status: 'APPROVED' }),
        }),
      );
    });

    it('does NOT flag a content edit of a DRAFT template as a live edit (F-33 control)', async () => {
      const existing = createMockTemplateEntity({ status: 'DRAFT', version: 2 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockVersionRepo.findMaxVersionNumber.mockResolvedValue(1);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 2 }));
      mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ status: 'DRAFT', version: 3 }));

      await service.updatePromptTemplate('template-id-1', { content: 'draft edit', expectedVersion: 2 } as never);

      const call = mockEventEmitter.emit.mock.calls.find(([type]: unknown[]) => type === SysEventType.ResourceUpdated);
      expect(call).toBeDefined();
      expect((call![1] as { data: Record<string, unknown> }).data).not.toHaveProperty('wasApprovedLiveEdit');
    });

    it('propagates OptimisticConcurrencyException from the repository CAS write (Stream D Phase)', async () => {
      // When the row drifted between read and write, the repository's
      // `updateWithVersion` predicate matches 0 rows and throws. The
      // service must surface that exception unwrapped so the
      // `ExceptionInterceptor` can map it to 412 Precondition Failed.
      const existing = createMockTemplateEntity({ version: 9 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockRejectedValue(
        new OptimisticConcurrencyException('PromptTemplate', 'template-id-1', {
          expectedVersion: 9,
          currentVersion: 10,
        }),
      );

      await expect(
        service.updatePromptTemplate('template-id-1', {
          content: 'Stale write',
          expectedVersion: 9,
        } as never),
      ).rejects.toThrow(OptimisticConcurrencyException);

      // Audit-log MUST NOT broadcast on a failed CAS write — otherwise
      // observers would see "update" events for changes that never
      // landed.
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());
    });

    // ─── Transactional OCC writes ────────────────────────────
    // The version-history insert and the OCC compare-and-set must run in
    // ONE transaction. A rejected CAS (stale expectedVersion) must roll
    // back the version row so no orphan persists, and the next version
    // number must be max(existing)+1 — never a recomputed duplicate that
    // would trip the (promptTemplateId, versionNumber) unique constraint.
    it('rolls back the version-history insert inside the transaction when the OCC update is rejected', async () => {
      const existing = createMockTemplateEntity({ currentVersionNumber: 1, version: 9 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockVersionRepo.findMaxVersionNumber.mockResolvedValue(1);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 2 }));
      mockTemplateRepo.updateWithVersion.mockRejectedValue(
        new OptimisticConcurrencyException('PromptTemplate', 'template-id-1', {
          expectedVersion: 9,
          currentVersion: 10,
        }),
      );

      await expect(
        service.updatePromptTemplate('template-id-1', {
          content: 'Stale write',
          changeReason: 'probe',
          expectedVersion: 9,
        } as never),
      ).rejects.toThrow(OptimisticConcurrencyException);

      // The version insert and the CAS both ran INSIDE a single
      // transaction (received the same tx client); a real $transaction
      // rolls the version row back when the CAS throws.
      expect(mockDatabaseService.baseClient.$transaction).toHaveBeenCalledTimes(1);
      expect(mockVersionRepo.create).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: 2, changeReason: 'probe' }), mockTxClient);
      expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalledWith('template-id-1', existing, 9, mockTxClient);
      // A rolled-back write emits NO audit event — the row never committed.
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());
    });

    it('computes the next version as max(existing versionNumber)+1, not currentVersionNumber+1', async () => {
      // History already holds a HIGHER version than the row counter (e.g.
      // a prior orphaned/partial write). currentVersionNumber+1 (=2) would
      // recompute an existing versionNumber and brick further edits; the
      // service must use max(existing)+1 (=6) instead.
      const existing = createMockTemplateEntity({ currentVersionNumber: 1, version: 3 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockVersionRepo.findMaxVersionNumber.mockResolvedValue(5);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 6 }));
      mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ version: 4 }));

      await service.updatePromptTemplate('template-id-1', {
        content: 'New content',
        expectedVersion: 3,
      } as never);

      // The max query is issued inside the transaction (tx client).
      expect(mockVersionRepo.findMaxVersionNumber).toHaveBeenCalledWith('template-id-1', mockTxClient);
      expect(mockVersionRepo.create).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: 6 }), mockTxClient);
    });
  });

  // ─── getPromptTemplate ──────────────────────────────────────

  describe('getPromptTemplate', () => {
    it('should return template response when found', async () => {
      mockTemplateRepo.findById.mockResolvedValue(createMockTemplateEntity());

      const result = await service.getPromptTemplate('template-id-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('template-id-1');
      expect(result!.name).toBe('Test Prompt');
      expect(result!.content).toBe('You are a clinical assistant.');
      expect(result!.category).toBe('SYSTEM');
    });

    it('should return null when template not found', async () => {
      mockTemplateRepo.findById.mockResolvedValue(null);

      const result = await service.getPromptTemplate('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ─── listPromptTemplates ────────────────────────────────────

  describe('listPromptTemplates', () => {
    // / R1 — regression lock. `PromptTemplate` is now a
    // SYSTEM-shared READ model, so a read that supplies no `tenantId` gets
    // `tenantId IN [caller, SYSTEM]` injected and would surface the 13 SYSTEM
    // golden templates plus the platform defaults inside tenant pickers. An
    // EXPLICIT caller pin is preserved verbatim by the shared-read merge, so
    // this assertion is what keeps the list contents unchanged. Do not delete it
    // as "redundant with tenant scoping" — it is not, since the widening landed.
    it('B-12: pins an explicit caller tenantId so SYSTEM-shared rows never leak into the list', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      await service.listPromptTemplates();

      expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    });

    it('should return all templates when no filters provided', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([createMockTemplateEntity({ id: 't1' }), createMockTemplateEntity({ id: 't2' })]);

      const result = await service.listPromptTemplates();

      expect(mockTemplateRepo.$).toHaveBeenCalled();
      expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
      expect(mockQb.Where).toHaveBeenCalledWith({ resourceStatus: ResourceStatusType.ENABLED });
      expect(mockQb.Where).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
    });

    it('should filter by category when provided', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([createMockTemplateEntity({ id: 't1', category: 'DNA_ANALYSIS' })]);

      const result = await service.listPromptTemplates({ category: 'DNA_ANALYSIS' });

      expect(mockQb.Where).toHaveBeenCalledWith({ category: 'DNA_ANALYSIS' });
      expect(result).toHaveLength(1);
      expect(result[0].category).toBe('DNA_ANALYSIS');
    });

    it('should filter by departmentId when provided', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([createMockTemplateEntity({ id: 't1', departmentId: 'dept-1' })]);

      const result = await service.listPromptTemplates({ departmentId: 'dept-1' });

      expect(mockQb.Where).toHaveBeenCalledWith({ departmentId: 'dept-1' });
      expect(result).toHaveLength(1);
    });

    // Server-side status filter.
    it('should filter by status when provided', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([createMockTemplateEntity({ id: 't1', status: 'PUBLISHED' })]);

      const result = await service.listPromptTemplates({ status: 'PUBLISHED' });

      expect(mockQb.Where).toHaveBeenCalledWith({ status: 'PUBLISHED' });
      expect(result).toHaveLength(1);
    });

    it('should apply both category and departmentId filters simultaneously', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([
        createMockTemplateEntity({
          id: 't1',
          category: 'SUMMARY',
          departmentId: 'dept-1',
        }),
      ]);

      const result = await service.listPromptTemplates({
        category: 'SUMMARY',
        departmentId: 'dept-1',
      });

      expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
      expect(mockQb.Where).toHaveBeenCalledWith({ resourceStatus: ResourceStatusType.ENABLED });
      expect(mockQb.Where).toHaveBeenCalledWith({ category: 'SUMMARY' });
      expect(mockQb.Where).toHaveBeenCalledWith({ departmentId: 'dept-1' });
      expect(mockQb.Where).toHaveBeenCalledTimes(4);
      expect(result).toHaveLength(1);
      expect(result[0].category).toBe('SUMMARY');
      expect(result[0].departmentId).toBe('dept-1');
    });

    it('should return empty array when no templates match', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      const result = await service.listPromptTemplates({ category: 'DNA_ANALYSIS' });

      expect(result).toEqual([]);
    });

    it('should always filter by tenantId from ClsService context', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      await service.listPromptTemplates();

      expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    });

    it('should include tenantId filter alongside category filter', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      await service.listPromptTemplates({ category: 'DNA_ANALYSIS' });

      expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
      expect(mockQb.Where).toHaveBeenCalledWith({ category: 'DNA_ANALYSIS' });
    });

    it('should include tenantId filter alongside departmentId filter', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      await service.listPromptTemplates({ departmentId: 'dept-1' });

      expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
      expect(mockQb.Where).toHaveBeenCalledWith({ departmentId: 'dept-1' });
    });

    it('should throw BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? null : defaultClsContext.user));

      await expect(service.listPromptTemplates()).rejects.toThrow(BadRequestException);
    });

    it('should include descriptive message in BadRequestException for missing tenantId', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? null : defaultClsContext.user));

      await expect(service.listPromptTemplates()).rejects.toThrow('Tenant ID is required');
    });

    it('should filter by resourceStatus ENABLED by default when includeDisabled is not set', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      await service.listPromptTemplates();

      expect(mockQb.Where).toHaveBeenCalledWith(expect.objectContaining({ resourceStatus: ResourceStatusType.ENABLED }));
    });

    it('should not filter by resourceStatus when includeDisabled is true', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([
        createMockTemplateEntity({ id: 't1', resourceStatus: 'ENABLED' }),
        createMockTemplateEntity({ id: 't2', resourceStatus: 'DISABLED' }),
      ]);

      const result = await service.listPromptTemplates({ includeDisabled: true });

      expect(mockQb.Where).not.toHaveBeenCalledWith(expect.objectContaining({ resourceStatus: ResourceStatusType.ENABLED }));
      expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
      expect(result).toHaveLength(2);
    });

    it('should filter by resourceStatus ENABLED when includeDisabled is explicitly false', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      await service.listPromptTemplates({ includeDisabled: false });

      expect(mockQb.Where).toHaveBeenCalledWith(expect.objectContaining({ resourceStatus: ResourceStatusType.ENABLED }));
    });

    it('should return mixed ENABLED and DISABLED templates when includeDisabled is true', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([
        createMockTemplateEntity({ id: 't1', name: 'Active Prompt', resourceStatus: 'ENABLED' }),
        createMockTemplateEntity({ id: 't2', name: 'Disabled Prompt', resourceStatus: 'DISABLED' }),
        createMockTemplateEntity({ id: 't3', name: 'Another Active', resourceStatus: 'ENABLED' }),
      ]);

      const result = await service.listPromptTemplates({ includeDisabled: true });

      expect(result).toHaveLength(3);
      expect(result.find((t) => t.id === 't2')).toBeDefined();
    });

    it('should not filter out all-DISABLED results when includeDisabled is true', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([
        createMockTemplateEntity({ id: 't1', resourceStatus: 'DISABLED' }),
        createMockTemplateEntity({ id: 't2', resourceStatus: 'DISABLED' }),
      ]);

      const result = await service.listPromptTemplates({ includeDisabled: true });

      expect(result).toHaveLength(2);
      expect(mockQb.Where).not.toHaveBeenCalledWith(expect.objectContaining({ resourceStatus: ResourceStatusType.ENABLED }));
    });

    it('should include resourceStatus in response DTOs', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([createMockTemplateEntity({ id: 't1', resourceStatus: 'DISABLED' })]);

      const result = await service.listPromptTemplates({ includeDisabled: true });

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('resourceStatus');
    });

    it('should combine includeDisabled with category filter', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([createMockTemplateEntity({ id: 't1', category: 'SUMMARY', resourceStatus: 'DISABLED' })]);

      const result = await service.listPromptTemplates({
        category: 'SUMMARY',
        includeDisabled: true,
      });

      expect(mockQb.Where).toHaveBeenCalledWith({ category: 'SUMMARY' });
      expect(mockQb.Where).not.toHaveBeenCalledWith(expect.objectContaining({ resourceStatus: ResourceStatusType.ENABLED }));
      expect(result).toHaveLength(1);
    });

    it('should filter by search term with case-insensitive partial match', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([createMockTemplateEntity({ id: 't1', name: 'Clinical Summary' })]);

      const result = await service.listPromptTemplates({ search: 'clinical' });

      expect(mockQb.Where).toHaveBeenCalledWith({ name: { contains: 'clinical', mode: 'insensitive' } });
      expect(result).toHaveLength(1);
    });

    it('should apply search filter alongside category and departmentId', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      await service.listPromptTemplates({
        category: 'SUMMARY',
        departmentId: 'dept-1',
        search: 'genetics',
      });

      expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
      expect(mockQb.Where).toHaveBeenCalledWith({ resourceStatus: ResourceStatusType.ENABLED });
      expect(mockQb.Where).toHaveBeenCalledWith({ category: 'SUMMARY' });
      expect(mockQb.Where).toHaveBeenCalledWith({ departmentId: 'dept-1' });
      expect(mockQb.Where).toHaveBeenCalledWith({ name: { contains: 'genetics', mode: 'insensitive' } });
      expect(mockQb.Where).toHaveBeenCalledTimes(5);
    });

    it('should not apply search filter when search is not provided', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      await service.listPromptTemplates({ category: 'SYSTEM' });

      expect(mockQb.Where).not.toHaveBeenCalledWith(expect.objectContaining({ name: expect.anything() }));
    });
  });

  // ─── getVersions ────────────────────────────────────────────

  describe('getVersions', () => {
    beforeEach(() => {
      mockTemplateRepo.findById.mockResolvedValue(createMockTemplateEntity({ id: 'template-id-1', tenantId: 'tenant-1' }));
    });

    it('should return version history for a template', async () => {
      mockVersionRepo.findByTemplate.mockResolvedValue([
        createMockVersionEntity({ id: 'v2', versionNumber: 2 }),
        createMockVersionEntity({ id: 'v1', versionNumber: 1 }),
      ]);

      const result = await service.getVersions('template-id-1');

      expect(mockVersionRepo.findByTemplate).toHaveBeenCalledWith('template-id-1');
      expect(result).toHaveLength(2);
      expect(result[0].versionNumber).toBe(2);
      expect(result[1].versionNumber).toBe(1);
    });

    it('should return empty array when no versions exist', async () => {
      mockVersionRepo.findByTemplate.mockResolvedValue([]);

      const result = await service.getVersions('template-id-1');

      expect(result).toEqual([]);
    });

    // F-07: a nonexistent or cross-tenant template must 404, never a silent
    // `200 []`.
    it('throws NotFound when the template does not exist', async () => {
      mockTemplateRepo.findById.mockResolvedValue(null);

      await expect(service.getVersions('missing')).rejects.toThrow(NotFoundException);
      expect(mockVersionRepo.findByTemplate).not.toHaveBeenCalled();
    });

    it('throws NotFound (never leaks) for a cross-tenant template', async () => {
      mockTemplateRepo.findById.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-x', tenantId: 'other-tenant' }));

      await expect(service.getVersions('tpl-x')).rejects.toThrow(NotFoundException);
      expect(mockVersionRepo.findByTemplate).not.toHaveBeenCalled();
    });
  });

  // ─── getVersion ───────────────────────────────────────────

  describe('getVersion', () => {
    it('should return a specific version by template ID and version number', async () => {
      mockVersionRepo.findByVersionNumber.mockResolvedValue(
        createMockVersionEntity({ promptTemplateId: 'tpl-1', versionNumber: 2, content: 'v2 content' }),
      );

      const result = await service.getVersion('tpl-1', 2);

      expect(result).not.toBeNull();
      expect(result!.versionNumber).toBe(2);
      expect(result!.content).toBe('v2 content');
      expect(mockVersionRepo.findByVersionNumber).toHaveBeenCalledWith('tpl-1', 2);
    });

    it('should return null when version does not exist', async () => {
      mockVersionRepo.findByVersionNumber.mockResolvedValue(null);

      const result = await service.getVersion('tpl-1', 99);

      expect(result).toBeNull();
      expect(mockVersionRepo.findByVersionNumber).toHaveBeenCalledWith('tpl-1', 99);
    });

    it('should pass exact templateId and versionNumber to repository', async () => {
      mockVersionRepo.findByVersionNumber.mockResolvedValue(null);

      await service.getVersion('template-abc', 5);

      expect(mockVersionRepo.findByVersionNumber).toHaveBeenCalledWith('template-abc', 5);
    });
  });

  // ─── diffVersions ────────────────────────────

  describe('diffVersions', () => {
    const setupVersions = () => {
      mockTemplateRepo.findById.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1', tenantId: 'tenant-1' }));
      mockVersionRepo.findByVersionNumber.mockImplementation(async (_id: string, n: number) => {
        if (n === 1)
          return createMockVersionEntity({ promptTemplateId: 'tpl-1', versionNumber: 1, content: 'line a\nline b', variables: { fmt: 'SOAP' } });
        if (n === 2)
          return createMockVersionEntity({ promptTemplateId: 'tpl-1', versionNumber: 2, content: 'line a\nline c', variables: { fmt: 'NARRATIVE' } });
        return null;
      });
    };

    it('returns a combined content+variables line diff with stats', async () => {
      setupVersions();

      const result = await service.diffVersions('tpl-1', 1, 2);

      expect(result.promptTemplateId).toBe('tpl-1');
      expect(result.fromVersion).toBe(1);
      expect(result.toVersion).toBe(2);
      // combined diff has real segments and non-zero add/remove counts
      expect(Array.isArray(result.changes)).toBe(true);
      expect(result.changes.some((c) => c.added)).toBe(true);
      expect(result.changes.some((c) => c.removed)).toBe(true);
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.stats.deletions).toBeGreaterThan(0);
      expect(typeof result.patch).toBe('string');
    });

    it('breaks the diff down per field (content + variables), flagging which changed', async () => {
      setupVersions();

      const result = await service.diffVersions('tpl-1', 1, 2);

      const content = result.fields.find((f) => f.field === 'content');
      const variables = result.fields.find((f) => f.field === 'variables');
      expect(content?.changed).toBe(true);
      expect(variables?.changed).toBe(true);
      expect(content?.stats.additions).toBeGreaterThan(0);
    });

    it('throws NotFound when the template does not exist', async () => {
      mockTemplateRepo.findById.mockResolvedValue(null);

      await expect(service.diffVersions('missing', 1, 2)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFound for a cross-tenant template (tenant guard)', async () => {
      mockTemplateRepo.findById.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-x', tenantId: 'other-tenant' }));

      await expect(service.diffVersions('tpl-x', 1, 2)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFound when a requested version is missing', async () => {
      mockTemplateRepo.findById.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1', tenantId: 'tenant-1' }));
      mockVersionRepo.findByVersionNumber.mockImplementation(async (_id: string, n: number) =>
        n === 1 ? createMockVersionEntity({ versionNumber: 1 }) : null,
      );

      await expect(service.diffVersions('tpl-1', 1, 99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── softDeletePromptTemplate ───────────────────────────────

  describe('softDeletePromptTemplate', () => {
    it('should soft delete and return deleted template', async () => {
      const entity = createMockTemplateEntity();
      mockTemplateRepo.findById.mockResolvedValue(entity);
      mockTemplateRepo.softDelete.mockResolvedValue(createMockTemplateEntity({ resourceStatus: 'DELETED' }));

      const result = await service.softDeletePromptTemplate('template-id-1');

      expect(mockTemplateRepo.softDelete).toHaveBeenCalledWith('template-id-1');
      expect(result.id).toBe('template-id-1');
    });

    it('should throw NotFoundException when template not found', async () => {
      mockTemplateRepo.findById.mockResolvedValue(null);

      await expect(service.softDeletePromptTemplate('nonexistent')).rejects.toThrow(NotFoundException);

      await expect(service.softDeletePromptTemplate('nonexistent')).rejects.toThrow('Prompt template nonexistent not found');

      expect(mockTemplateRepo.softDelete).not.toHaveBeenCalled();
    });

    it('should broadcast ResourceDeleted event', async () => {
      mockTemplateRepo.findById.mockResolvedValue(createMockTemplateEntity());
      mockTemplateRepo.softDelete.mockResolvedValue(createMockTemplateEntity());

      await service.softDeletePromptTemplate('template-id-1');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceDeleted,
        expect.objectContaining({
          resourceId: 'template-id-1',
        }),
      );
    });
  });

  // ─── Cross-Tenant Isolation ──────────────────────────────────

  describe('Cross-Tenant Isolation', () => {
    it('listPromptTemplates should use calling tenant context, not a hardcoded value', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-X';
        if (key === 'userAbility') return { can: abilityCan };
        return defaultClsContext.user;
      });

      const tenantXService = new PromptManagementService(
        mockTemplateRepo as never,
        mockVersionRepo as never,
        mockUsageRepo as never,
        mockDepartmentService as never,
        mockEventEmitter as never,
        mockClsService as never,
        mockDatabaseService as never,
      );

      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      await tenantXService.listPromptTemplates();

      expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-X' });
      expect(mockQb.Where).not.toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    });

    it('createPromptTemplate should embed calling tenant into entity', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-Y';
        if (key === 'user') return { id: 'user-Y' };
        if (key === 'userAbility') return { can: abilityCan };
        return null;
      });

      const tenantYService = new PromptManagementService(
        mockTemplateRepo as never,
        mockVersionRepo as never,
        mockUsageRepo as never,
        mockDepartmentService as never,
        mockEventEmitter as never,
        mockClsService as never,
        mockDatabaseService as never,
      );

      mockTemplateRepo.findByName.mockResolvedValue(null);
      mockTemplateRepo.create.mockResolvedValue(createMockTemplateEntity({ tenantId: 'tenant-Y' }));
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      await tenantYService.createPromptTemplate({
        name: 'Cross-tenant test',
        content: 'Content',
        category: 'SYSTEM',
      });

      expect(mockTemplateRepo.findByName).toHaveBeenCalledWith('tenant-Y', 'Cross-tenant test');
    });
  });

  describe('getUsageStats', () => {
    beforeEach(() => {
      mockTemplateRepo.findById.mockResolvedValue(createMockTemplateEntity({ id: 'template-1', tenantId: 'tenant-1' }));
    });

    // F-07: a nonexistent or cross-tenant template must 404, never a silent
    // `200` empty-stats response.
    it('throws NotFound when the template does not exist', async () => {
      mockTemplateRepo.findById.mockResolvedValue(null);

      await expect(service.getUsageStats('missing')).rejects.toThrow(NotFoundException);
      expect(mockUsageRepo.findByTemplate).not.toHaveBeenCalled();
    });

    it('throws NotFound (never leaks) for a cross-tenant template', async () => {
      mockTemplateRepo.findById.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-x', tenantId: 'other-tenant' }));

      await expect(service.getUsageStats('tpl-x')).rejects.toThrow(NotFoundException);
      expect(mockUsageRepo.findByTemplate).not.toHaveBeenCalled();
    });

    it('should return total usages and last used timestamp when records exist', async () => {
      const now = new Date('2026-02-20T10:00:00Z');
      const earlier = new Date('2026-02-19T08:00:00Z');
      mockUsageRepo.findByTemplate.mockResolvedValue([
        { id: 'rec-1', createdAt: now },
        { id: 'rec-2', createdAt: earlier },
      ]);

      const result = await service.getUsageStats('template-1');

      expect(mockUsageRepo.findByTemplate).toHaveBeenCalledWith('template-1');
      expect(result).toEqual({
        totalUsages: 2,
        lastUsedAt: now.toISOString(),
      });
    });

    it('should return zero usages and null lastUsedAt when no records exist', async () => {
      mockUsageRepo.findByTemplate.mockResolvedValue([]);

      const result = await service.getUsageStats('template-no-usage');

      expect(mockUsageRepo.findByTemplate).toHaveBeenCalledWith('template-no-usage');
      expect(result).toEqual({
        totalUsages: 0,
        lastUsedAt: null,
      });
    });

    it('should handle records with missing CreatedAt gracefully', async () => {
      mockUsageRepo.findByTemplate.mockResolvedValue([{ id: 'rec-1', CreatedAt: undefined }]);

      const result = await service.getUsageStats('template-bad-date');

      expect(result).toEqual({
        totalUsages: 1,
        lastUsedAt: null,
      });
    });
  });

  // ─── Authorization & tenant scope ───────────────────

  describe('Authorization & tenant scope', () => {
    describe('updatePromptTemplate', () => {
      it('throws NotFoundException when template tenant does not match caller tenant', async () => {
        const foreign = createMockTemplateEntity({ id: 'tpl-X', tenantId: 'tenant-OTHER' });
        mockTemplateRepo.findById.mockResolvedValue(foreign);

        await expect(service.updatePromptTemplate('tpl-X', { content: 'edit', expectedVersion: 1 } as never)).rejects.toThrow(NotFoundException);
        // Neither legacy nor CAS writers may fire on
        // a foreign-tenant row.
        expect(mockTemplateRepo.update).not.toHaveBeenCalled();
        expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
      });

      it('throws ForbiddenException on USER_PERSONAL owned by a different user', async () => {
        const personal = createMockTemplateEntity({
          id: 'tpl-P',
          tenantId: 'tenant-1',
          scope: 'USER_PERSONAL',
          ownerUserId: 'someone-else',
        });
        mockTemplateRepo.findById.mockResolvedValue(personal);

        await expect(service.updatePromptTemplate('tpl-P', { content: 'edit', expectedVersion: 1 } as never)).rejects.toThrow(ForbiddenException);
      });

      it('throws ForbiddenException on TENANT_DEFAULT when caller lacks manage ability', async () => {
        abilityCan.mockReturnValue(false);
        const tpl = createMockTemplateEntity({ id: 'tpl-D', tenantId: 'tenant-1', scope: 'TENANT_DEFAULT' });
        mockTemplateRepo.findById.mockResolvedValue(tpl);

        await expect(service.updatePromptTemplate('tpl-D', { content: 'edit', expectedVersion: 1 } as never)).rejects.toThrow(ForbiddenException);
      });

      it('allows caller to update own USER_PERSONAL template', async () => {
        abilityCan.mockReturnValue(false); // even without manage, owner can mutate
        const personal = createMockTemplateEntity({
          id: 'tpl-mine',
          tenantId: 'tenant-1',
          scope: 'USER_PERSONAL',
          ownerUserId: 'user-id-1',
        });
        mockTemplateRepo.findById.mockResolvedValue(personal);
        mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());
        mockTemplateRepo.updateWithVersion.mockResolvedValue(personal);

        await service.updatePromptTemplate('tpl-mine', { content: 'new content', expectedVersion: 1 } as never);

        expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalled();
      });
    });

    describe('getPromptTemplate', () => {
      it('returns null on cross-tenant lookup (no existence leak)', async () => {
        const foreign = createMockTemplateEntity({ id: 'tpl-X', tenantId: 'tenant-OTHER' });
        mockTemplateRepo.findById.mockResolvedValue(foreign);

        const result = await service.getPromptTemplate('tpl-X');

        expect(result).toBeNull();
      });

      it('returns the template when tenant matches', async () => {
        const tpl = createMockTemplateEntity({ id: 'tpl-1', tenantId: 'tenant-1' });
        mockTemplateRepo.findById.mockResolvedValue(tpl);

        const result = await service.getPromptTemplate('tpl-1');

        expect(result).not.toBeNull();
      });

      it('returns null when a NON-admin caller is not the owner of a USER_PERSONAL template', async () => {
        // The end-user (no manage:PromptTemplate) path stays
        // strictly owner-bound: a peer's personal prompt is never disclosed.
        abilityCan.mockReturnValue(false);
        const personal = createMockTemplateEntity({
          id: 'tpl-P',
          tenantId: 'tenant-1',
          scope: 'USER_PERSONAL',
          ownerUserId: 'someone-else',
        });
        mockTemplateRepo.findById.mockResolvedValue(personal);

        const result = await service.getPromptTemplate('tpl-P');

        expect(result).toBeNull();
      });

      // An admin (manage:PromptTemplate) MAY read another
      // in-tenant user's USER_PERSONAL prompt (admin cross-owner read).
      it('returns the template when an ADMIN reads another user USER_PERSONAL in-tenant', async () => {
        abilityCan.mockReturnValue(true);
        const personal = createMockTemplateEntity({
          id: 'tpl-P',
          tenantId: 'tenant-1',
          scope: 'USER_PERSONAL',
          ownerUserId: 'someone-else',
        });
        mockTemplateRepo.findById.mockResolvedValue(personal);

        const result = await service.getPromptTemplate('tpl-P');

        expect(result).not.toBeNull();
        expect(result!.id).toBe('tpl-P');
      });

      // Admin cross-owner read does NOT cross tenants
      // (manage:PromptTemplate is tenant-scoped): a foreign-tenant personal
      // prompt is still hidden even for a manage-capable caller.
      it('returns null for a cross-tenant USER_PERSONAL even for an admin', async () => {
        abilityCan.mockReturnValue(true);
        const foreign = createMockTemplateEntity({
          id: 'tpl-XP',
          tenantId: 'tenant-OTHER',
          scope: 'USER_PERSONAL',
          ownerUserId: 'someone-else',
        });
        mockTemplateRepo.findById.mockResolvedValue(foreign);

        const result = await service.getPromptTemplate('tpl-XP');

        expect(result).toBeNull();
      });
    });

    describe('softDeletePromptTemplate', () => {
      it('throws NotFoundException on cross-tenant delete attempt', async () => {
        const foreign = createMockTemplateEntity({ id: 'tpl-X', tenantId: 'tenant-OTHER' });
        mockTemplateRepo.findById.mockResolvedValue(foreign);

        await expect(service.softDeletePromptTemplate('tpl-X')).rejects.toThrow(NotFoundException);
        expect(mockTemplateRepo.softDelete).not.toHaveBeenCalled();
      });

      it('throws ForbiddenException when caller does not own a USER_PERSONAL template', async () => {
        const personal = createMockTemplateEntity({
          id: 'tpl-P',
          tenantId: 'tenant-1',
          scope: 'USER_PERSONAL',
          ownerUserId: 'someone-else',
        });
        mockTemplateRepo.findById.mockResolvedValue(personal);

        await expect(service.softDeletePromptTemplate('tpl-P')).rejects.toThrow(ForbiddenException);
      });

      it('throws ForbiddenException when caller lacks manage on a TENANT_DEFAULT', async () => {
        abilityCan.mockReturnValue(false);
        const tpl = createMockTemplateEntity({ id: 'tpl-D', tenantId: 'tenant-1', scope: 'TENANT_DEFAULT' });
        mockTemplateRepo.findById.mockResolvedValue(tpl);

        await expect(service.softDeletePromptTemplate('tpl-D')).rejects.toThrow(ForbiddenException);
      });
    });
  });

  describe('createPromptTemplate scope defaults', () => {
    it('defaults newly created template to scope=TENANT_DEFAULT', async () => {
      mockTemplateRepo.findByName.mockResolvedValue(null);
      const saved = createMockTemplateEntity({ scope: 'TENANT_DEFAULT' });
      mockTemplateRepo.create.mockResolvedValue(saved);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      await service.createPromptTemplate({ name: 'New', content: 'X', category: 'SYSTEM' });

      // factory call assertion happens via mocked factory; here we assert
      // create succeeded and event was broadcast with the default scope.
      expect(mockTemplateRepo.create).toHaveBeenCalled();
    });

    it('throws ForbiddenException when caller lacks manage ability for default creation', async () => {
      abilityCan.mockReturnValue(false);

      await expect(service.createPromptTemplate({ name: 'New', content: 'X', category: 'SYSTEM' })).rejects.toThrow(ForbiddenException);
    });
  });

  describe('createPersonal', () => {
    it('stamps scope=USER_PERSONAL and ownerUserId=requestUserId', async () => {
      const saved = createMockTemplateEntity({ scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' });
      mockTemplateRepo.create.mockResolvedValue(saved);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      await service.createPersonal({ name: 'Mine', content: 'X', category: 'CUSTOM' });

      expect(mockTemplateRepo.create).toHaveBeenCalled();
    });

    it('throws BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((k: string) => (k === 'user' ? defaultClsContext.user : null));

      await expect(service.createPersonal({ name: 'X', content: 'X', category: 'CUSTOM' })).rejects.toThrow(BadRequestException);
    });

    it('does NOT require manage ability', async () => {
      abilityCan.mockReturnValue(false); // caller cannot manage tenant defaults, but personal is fine
      const saved = createMockTemplateEntity({ scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' });
      mockTemplateRepo.create.mockResolvedValue(saved);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      await expect(service.createPersonal({ name: 'Mine', content: 'X', category: 'CUSTOM' })).resolves.toBeDefined();
    });
  });

  describe('listDefaultsForDepartment', () => {
    it('returns templates with scope=TENANT_DEFAULT or DEPARTMENT_DEFAULT scoped to the department', async () => {
      const qb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(qb);
      qb.ToList.mockResolvedValue([]);

      await service.listDefaultsForDepartment('dept-1');

      expect(qb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
      expect(qb.WhereOr).toHaveBeenCalledWith({ scope: 'TENANT_DEFAULT' });
      expect(qb.WhereOr).toHaveBeenCalledWith({ scope: 'DEPARTMENT_DEFAULT', departmentId: 'dept-1' });
    });

    it('throws BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((k: string) => (k === 'user' ? defaultClsContext.user : null));

      await expect(service.listDefaultsForDepartment('dept-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('listMyPersonalForDepartment', () => {
    it('delegates to findMyPersonalForDepartment with caller tenant + user', async () => {
      mockTemplateRepo.findMyPersonalForDepartment.mockResolvedValue([]);

      await service.listMyPersonalForDepartment('dept-1');

      expect(mockTemplateRepo.findMyPersonalForDepartment).toHaveBeenCalledWith('tenant-1', 'user-id-1', 'dept-1');
    });

    it('throws BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((k: string) => (k === 'user' ? defaultClsContext.user : null));

      await expect(service.listMyPersonalForDepartment('dept-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when caller user id is missing', async () => {
      mockClsService.get.mockImplementation((k: string) => (k === 'tenantId' ? 'tenant-1' : null));

      await expect(service.listMyPersonalForDepartment('dept-1')).rejects.toThrow(BadRequestException);
    });
  });

  // ─── end-user readable templates (no admin ability) ─────
  describe('listAvailableForCaller', () => {
    it('scopes to tenant + ENABLED and ORs (TENANT_DEFAULT, DEPARTMENT_DEFAULT, own USER_PERSONAL)', async () => {
      const qb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(qb);
      qb.ToList.mockResolvedValue([createMockTemplateEntity({ id: 't1' })]);

      const result = await service.listAvailableForCaller();

      expect(qb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
      expect(qb.Where).toHaveBeenCalledWith({ resourceStatus: ResourceStatusType.ENABLED });
      // Tenant + department defaults are publication-gated
      // to non-DRAFT so clinicians never see admin drafts-in-progress.
      expect(qb.WhereOr).toHaveBeenCalledWith({ scope: 'TENANT_DEFAULT', status: { not: 'DRAFT' } });
      expect(qb.WhereOr).toHaveBeenCalledWith({ scope: 'DEPARTMENT_DEFAULT', status: { not: 'DRAFT' } });
      expect(qb.WhereOr).toHaveBeenCalledWith({ scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' });
      expect(result).toHaveLength(1);
    });

    // Publication status (DRAFT/PUBLISHED) is enforced on
    // the clinician resolution: tenant + department DEFAULT templates must be
    // non-DRAFT (PUBLISHED, or legacy/unset as a safe fallback), while the
    // caller's OWN personal overlays are returned regardless of status.
    it('gates tenant + department defaults to non-DRAFT but never the caller own personal templates', async () => {
      const qb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(qb);
      qb.ToList.mockResolvedValue([]);

      await service.listAvailableForCaller();

      expect(qb.WhereOr).toHaveBeenCalledWith({ scope: 'TENANT_DEFAULT', status: { not: 'DRAFT' } });
      expect(qb.WhereOr).toHaveBeenCalledWith({ scope: 'DEPARTMENT_DEFAULT', status: { not: 'DRAFT' } });

      const personalCalls = qb.WhereOr.mock.calls.filter(([p]: [Record<string, unknown>]) => p?.scope === 'USER_PERSONAL');
      expect(personalCalls).toHaveLength(1);
      expect(personalCalls[0][0]).toEqual({ scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' });
      expect(personalCalls[0][0]).not.toHaveProperty('status');
    });

    it('applies the category filter when provided', async () => {
      const qb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(qb);
      qb.ToList.mockResolvedValue([]);

      await service.listAvailableForCaller({ category: 'SUMMARY' });

      expect(qb.Where).toHaveBeenCalledWith({ category: 'SUMMARY' });
    });

    it('does NOT include other users personal templates (owner predicate bound to caller)', async () => {
      const qb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(qb);
      qb.ToList.mockResolvedValue([]);

      await service.listAvailableForCaller();

      const personalCalls = qb.WhereOr.mock.calls.filter(([p]: [Record<string, unknown>]) => p?.scope === 'USER_PERSONAL');
      expect(personalCalls).toHaveLength(1);
      expect(personalCalls[0][0]).toEqual({ scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' });
    });

    it('throws BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((k: string) => (k === 'user' ? defaultClsContext.user : null));

      await expect(service.listAvailableForCaller()).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when caller user id is missing', async () => {
      mockClsService.get.mockImplementation((k: string) => (k === 'tenantId' ? 'tenant-1' : null));

      await expect(service.listAvailableForCaller()).rejects.toThrow(BadRequestException);
    });
  });

  // ─── assign templates to department ───────────

  describe('assignToDepartment', () => {
    it('delegates to DepartmentService.updatePromptConfig with the right fields', async () => {
      mockDepartmentService.updatePromptConfig.mockResolvedValue({ id: 'dept-1' });

      await service.assignToDepartment({
        departmentId: 'dept-1',
        newPatientPromptId: 'np-1',
        revisitPromptId: 'rv-1',
        // The AssignDepartmentPromptRequest
        // DTO now carries the target Department row's expectedVersion
        // so the downstream `updatePromptConfig` can CAS against it.
        expectedVersion: 7,
      } as never);

      expect(mockDepartmentService.updatePromptConfig).toHaveBeenCalledWith('dept-1', {
        newPatientPromptId: 'np-1',
        revisitPromptId: 'rv-1',
        expectedVersion: 7,
      });
    });

    it('propagates ForbiddenException / NotFoundException from DepartmentService (tenant guard)', async () => {
      mockDepartmentService.updatePromptConfig.mockRejectedValue(new NotFoundException('Department not found'));

      await expect(service.assignToDepartment({ departmentId: 'wrong', newPatientPromptId: 'np-1', expectedVersion: 1 } as never)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── prompt quality/score test run ──────────────────────

  describe('prompt test run (BUG-018 two-call: start + finalize)', () => {
    // TEXT now acks a STREAMING job on POST /generate and serves the finished
    // text on GET /tasks/:id. Both live on the same axios mock.
    const createTextHttpMock = (taskOutput: string, taskOverrides: Record<string, unknown> = {}) => ({
      axiosRef: {
        post: vi.fn().mockResolvedValue({ data: { task_id: 'task-1', status: 'pending', stream_url: '/api/v1/tasks/task-1/stream' } }),
        get: vi.fn().mockResolvedValue({ data: { task_id: 'task-1', status: 'completed', content: taskOutput, ...taskOverrides } }),
      },
    });

    const defaultTaskDefaults = () => ({
      getEffective: vi.fn().mockResolvedValue({ taskKey: 'text.test', model: { provider: 'lm-studio', sourceUri: 'resolved-medgemma' } }),
    });

    const buildTextService = (
      taskOutput: string,
      opts: {
        aiTaskDefaultService?: { getEffective: ReturnType<typeof vi.fn> };
        secretsService?: Record<string, unknown>;
        aiModelRepository?: { findByTaskTypeSharedRead: ReturnType<typeof vi.fn> };
        goldenCaseRepository?: { findById: ReturnType<typeof vi.fn>; decryptFieldsFromEntity: ReturnType<typeof vi.fn> };
        textRequestEnrichment?: Record<string, unknown>;
        taskOverrides?: Record<string, unknown>;
      } = {},
    ) => {
      const httpMock = createTextHttpMock(taskOutput, opts.taskOverrides);
      const configMock = createMockConfigService();
      const aiTaskDefaultService = opts.aiTaskDefaultService ?? defaultTaskDefaults();
      const svc = new PromptManagementService(
        mockTemplateRepo as never,
        mockVersionRepo as never,
        mockUsageRepo as never,
        mockDepartmentService as never,
        mockEventEmitter as never,
        mockClsService as never,
        mockDatabaseService as never,
        httpMock as never,
        configMock as never,
        opts.secretsService as never, // secretsService
        aiTaskDefaultService as never, // IAiTaskDefaultService
        undefined, // userProfileService
        undefined, // entitlements
        undefined, // promotionGate
        opts.aiModelRepository as never, // aiModelRepository
        opts.goldenCaseRepository as never, // goldenCaseRepository
        opts.textRequestEnrichment as never, // TextRequestEnrichmentService
      );
      return { svc, httpMock, aiTaskDefaultService };
    };

    /** Run the full two-call flow the way the console does. */
    const runFullTest = async (svc: PromptManagementService, dto: Record<string, unknown> = {}) => {
      const ack = await svc.startPromptTemplateTest('tpl-1', dto as never);
      const result = await svc.finalizePromptTemplateTest('tpl-1', {
        taskId: ack.taskId!,
        expectedVersion: (dto.expectedVersion as number) ?? 1,
      } as never);
      return { ack, result };
    };

    // ── BUG-018 — the pinned snapshot must survive the submit→finalize split ──
    // Splitting the call introduced a way to lose the tested identity: if
    // finalize only carries `taskId`, a run against a pinned PromptVersion is
    // scored against the MUTABLE draft instead. `variableCoverage` is computed
    // from the tested `variables`, so a version declaring two variables must
    // not be scored against a draft declaring none.
    it('scores a pinned-version run against that version, not the live draft', async () => {
      const existing = createMockTemplateEntity({
        id: 'tpl-1',
        version: 1,
        content: 'Draft with no variables',
        variables: null,
      });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(existing);
      mockVersionRepo.findByVersionNumber.mockResolvedValue({
        content: 'Pinned {{topic}} and {{depth}}',
        variables: [{ name: 'topic' }, { name: 'depth' }],
      });
      const { svc } = buildTextService(wordsOfLength(60));

      const ack = await svc.startPromptTemplateTest('tpl-1', {
        versionNumber: 2,
        variables: { topic: 'asthma', depth: 'brief' },
      } as never);
      const result = await svc.finalizePromptTemplateTest('tpl-1', {
        taskId: ack.taskId!,
        versionNumber: 2,
        expectedVersion: 1,
      } as never);

      // Scored against the VERSION's two declared variables.
      expect(result.metrics?.variablesDeclared).toBe(2);
    });

    // ── model selection ──────────────────────────────────
    it('resolves provider+model via the text.test AiTaskDefault and posts both to TEXT', async () => {
      const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1, content: 'Summarize {{topic}}' });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      const { svc, httpMock, aiTaskDefaultService } = buildTextService(wordsOfLength(60));

      const ack = await svc.startPromptTemplateTest('tpl-1', { variables: { topic: 'asthma' } } as never);

      expect(aiTaskDefaultService.getEffective).toHaveBeenCalledWith('text.test', 'tenant-1');
      const [, payload] = httpMock.axiosRef.post.mock.calls[0];
      expect((payload as { provider?: string }).provider).toBe('lm-studio');
      expect((payload as { model?: string }).model).toBe('resolved-medgemma');
      expect(ack.provider).toBe('lm-studio');
    });

    // ── BUG-018 test 2: the submit acks, it never awaits a completion ──
    it('acks with { taskId, streamUrl } and never fetches the finished generation', async () => {
      const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      const { svc, httpMock } = buildTextService(wordsOfLength(60));

      const ack = await svc.startPromptTemplateTest('tpl-1', {} as never);

      expect(ack.mode).toBe('stream');
      expect(ack.taskId).toBe('task-1');
      expect(ack.streamUrl).toBe('text/tasks/task-1/stream');
      const [, payload] = httpMock.axiosRef.post.mock.calls[0];
      expect((payload as { stream?: boolean }).stream).toBe(true);
      // no blocking read of the completion, and no write
      expect(httpMock.axiosRef.get).not.toHaveBeenCalled();
      expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    // ── BUG-018 test 3: the outgoing request is tenant-attributed + enriched ──
    it('sends X-Tenant-Id and runs the body through the shared TEXT enrichment service', async () => {
      const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      const textRequestEnrichment = {
        applyTextRuntimeProfile: vi.fn(async (b: Record<string, unknown>) => {
          b.temperature = 0.3;
          return b;
        }),
        applyTenantProviderOverrides: vi.fn(async (b: Record<string, unknown>) => {
          b.provider_overrides = { 'lm-studio': { api_key: 'k', funding: 'tenant' } };
          return b;
        }),
      };
      const { svc, httpMock } = buildTextService(wordsOfLength(60), { textRequestEnrichment });

      await svc.startPromptTemplateTest('tpl-1', {} as never);

      expect(textRequestEnrichment.applyTextRuntimeProfile).toHaveBeenCalledTimes(1);
      expect(textRequestEnrichment.applyTenantProviderOverrides).toHaveBeenCalledTimes(1);
      const [, payload, config] = httpMock.axiosRef.post.mock.calls[0];
      expect((payload as { temperature?: number }).temperature).toBe(0.3);
      expect((payload as { provider_overrides?: unknown }).provider_overrides).toBeDefined();
      expect((config as { headers: Record<string, string> }).headers['X-Tenant-Id']).toBe('tenant-1');
    });

    it('finalize scores the TEXT task content and persists lastTestScore/lastTestOutput/lastTestAt via OCC write', async () => {
      const output = wordsOfLength(60); // ≥ 50 words → full score
      const existing = createMockTemplateEntity({ id: 'tpl-1', version: 5, content: 'Summarize {{topic}}' });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1', version: 6 }));
      const { svc, httpMock } = buildTextService(output);

      const { ack, result } = await runFullTest(svc, { variables: { topic: 'asthma' }, expectedVersion: 5 });

      // The interpolated prompt went out on the SUBMIT call
      expect(httpMock.axiosRef.post).toHaveBeenCalledTimes(1);
      const [, payload] = httpMock.axiosRef.post.mock.calls[0];
      expect((payload as { prompt: string }).prompt).toContain('asthma');
      expect(ack.assembledPrompt).toContain('asthma');

      // The finished text was read SERVER-SIDE from TEXT, never from the client
      expect(httpMock.axiosRef.get).toHaveBeenCalledTimes(1);
      expect(httpMock.axiosRef.get.mock.calls[0][0]).toContain('/api/v1/tasks/task-1');

      expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalledWith('tpl-1', existing, 5);
      expect(existing.lastTestScore).toBe(1);
      expect(existing.lastTestOutput).toBe(output);
      expect(existing.lastTestAt).toBeInstanceOf(Date);

      expect(result.id).toBe('tpl-1');
      expect(result.score).toBe(1);
      expect(result.output).toBe(output);
      expect(result.version).toBe(6);
      expect(typeof result.testedAt).toBe('string');
    });

    // ── BUG-018 test 4: non-terminal / unknown tasks ──
    it('finalize on a task that is still running throws BadRequestException naming the state (no write)', async () => {
      const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      const { svc } = buildTextService('', { taskOverrides: { status: 'running', content: null } });

      await expect(svc.finalizePromptTemplateTest('tpl-1', { taskId: 'task-1', expectedVersion: 1 } as never)).rejects.toThrow(/running/);
      expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
    });

    it('finalize on an unknown task id (TEXT 404) throws NotFoundException', async () => {
      const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      const { svc, httpMock } = buildTextService('');
      httpMock.axiosRef.get.mockRejectedValueOnce(Object.assign(new Error('not found'), { response: { status: 404 } }));

      await expect(svc.finalizePromptTemplateTest('tpl-1', { taskId: 'ghost', expectedVersion: 1 } as never)).rejects.toThrow(NotFoundException);
    });

    // ── encrypt `lastTestOutput` on the finalize write ──
    const buildTextServiceWithSecrets = (taskOutput: string) => {
      const secretsService = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') };
      const { svc, httpMock } = buildTextService(taskOutput, { secretsService });
      return { svc, httpMock, secretsService };
    };

    it('encrypts lastTestOutput BEFORE the CAS write, and the result DTO carries no ciphertext', async () => {
      const output = wordsOfLength(60);
      const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1, content: 'Summarize {{topic}}' });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1', version: 2 }));
      const { svc, secretsService } = buildTextServiceWithSecrets(output);

      const { result } = await runFullTest(svc, { variables: { topic: 'asthma' }, expectedVersion: 1 });

      expect(mockTemplateRepo.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
      expect(mockTemplateRepo.encryptFieldsIntoEntity).toHaveBeenCalledWith(existing, secretsService);
      expect(mockTemplateRepo.encryptFieldsIntoEntity.mock.invocationCallOrder[0]).toBeLessThan(
        mockTemplateRepo.updateWithVersion.mock.invocationCallOrder[0],
      );

      expect(result).not.toHaveProperty('encryptedLastTestOutput');
      expect(result).not.toHaveProperty('keyVersion');
    });

    it('still persists the test result when encryption fails (dual-write soak)', async () => {
      const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1', version: 2 }));
      const { svc } = buildTextServiceWithSecrets(wordsOfLength(60));
      mockTemplateRepo.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));

      const { result } = await runFullTest(svc);

      expect(result.id).toBe('tpl-1');
      expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalledTimes(1);
    });

    it('does NOT encrypt when no SecretsService is wired', async () => {
      const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1', version: 2 }));
      const { svc } = buildTextService(wordsOfLength(60)); // no secretsService

      await runFullTest(svc);

      expect(mockTemplateRepo.encryptFieldsIntoEntity).not.toHaveBeenCalled();
      expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalledTimes(1);
    });

    it('scores a short TEXT output below 1.0 (deterministic word-count heuristic)', async () => {
      const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1', version: 2 }));
      const { svc } = buildTextService(wordsOfLength(5)); // 5/50 → 0.1

      const { result } = await runFullTest(svc);

      expect(result.score).toBeCloseTo(0.1, 5);
    });

    it('broadcasts ResourceUpdated after a successful finalize', async () => {
      const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1', version: 2 }));
      const { svc } = buildTextService(wordsOfLength(80));

      await runFullTest(svc);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: 'tpl-1' }));
    });

    it('throws NotFoundException on a cross-tenant template — on BOTH calls (no TEXT call, no write)', async () => {
      const foreign = createMockTemplateEntity({ id: 'tpl-X', tenantId: 'tenant-OTHER', version: 1 });
      mockTemplateRepo.findById.mockResolvedValue(foreign);
      const { svc, httpMock } = buildTextService(wordsOfLength(80));

      await expect(svc.startPromptTemplateTest('tpl-X', {} as never)).rejects.toThrow(NotFoundException);
      await expect(svc.finalizePromptTemplateTest('tpl-X', { taskId: 'task-1' } as never)).rejects.toThrow(NotFoundException);
      expect(httpMock.axiosRef.post).not.toHaveBeenCalled();
      expect(httpMock.axiosRef.get).not.toHaveBeenCalled();
      expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown template id', async () => {
      mockTemplateRepo.findById.mockResolvedValue(undefined);
      const { svc } = buildTextService(wordsOfLength(80));

      await expect(svc.startPromptTemplateTest('tpl-missing', {} as never)).rejects.toThrow(NotFoundException);
      await expect(svc.finalizePromptTemplateTest('tpl-missing', { taskId: 'task-1' } as never)).rejects.toThrow(NotFoundException);
    });

    it('propagates OptimisticConcurrencyException from the finalize CAS write', async () => {
      const existing = createMockTemplateEntity({ id: 'tpl-1', version: 5 });
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.updateWithVersion.mockRejectedValue(
        new OptimisticConcurrencyException('PromptTemplate', 'tpl-1', { expectedVersion: 5, currentVersion: 6 }),
      );
      const { svc } = buildTextService(wordsOfLength(80));

      await expect(svc.finalizePromptTemplateTest('tpl-1', { taskId: 'task-1', expectedVersion: 5 } as never)).rejects.toThrow(
        OptimisticConcurrencyException,
      );
    });

    // ── deterministic composite rubric ──────────
    describe('deterministic output rubric', () => {
      const runWith = async (entityOverrides: Record<string, unknown>, output: string) => {
        const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1, ...entityOverrides });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1', version: 2, ...entityOverrides }));
        const { svc } = buildTextService(output);
        const { result } = await runFullTest(svc);
        return result;
      };

      it('scores an empty output as 0 (non-empty gate)', async () => {
        const result = await runWith({ category: 'SYSTEM', content: 'Plain prompt', variables: null }, '   ');
        expect(result.score).toBe(0);
        expect(result.metrics?.nonEmpty).toBe(false);
      });

      it('scores a long plain output as full length (length-only dimension)', async () => {
        const result = await runWith({ category: 'SYSTEM', content: 'Plain prompt', variables: null }, wordsOfLength(60));
        expect(result.score).toBe(1);
        expect(result.metrics?.jsonExpected).toBe(false);
        expect(result.metrics?.variableCoverage).toBeNull();
      });

      it('rewards valid JSON for a JSON/DNA template', async () => {
        const jsonOutput = JSON.stringify({ summary: wordsOfLength(60) });
        const result = await runWith({ category: 'DNA_ANALYSIS', content: 'Return JSON', variables: null }, jsonOutput);
        expect(result.metrics?.jsonExpected).toBe(true);
        expect(result.metrics?.jsonValid).toBe(true);
        expect(result.score).toBe(1);
      });

      it('penalizes invalid JSON for a JSON/DNA template', async () => {
        const result = await runWith({ category: 'DNA_ANALYSIS', content: 'Return JSON', variables: null }, wordsOfLength(60));
        expect(result.metrics?.jsonExpected).toBe(true);
        expect(result.metrics?.jsonValid).toBe(false);
        expect(result.score).toBe(0.5);
      });

      it('detects a JSON-enforcement cue in the content (no DNA category)', async () => {
        const result = await runWith({ category: 'SYSTEM', content: 'Respond strictly in json', variables: null }, wordsOfLength(60));
        expect(result.metrics?.jsonExpected).toBe(true);
        expect(result.metrics?.jsonValid).toBe(false);
        expect(result.score).toBe(0.5);
      });

      it('measures declared-variable coverage in the output', async () => {
        const result = await runWith(
          { category: 'SYSTEM', content: 'Note about {{topic}} for {{patient}}', variables: [{ name: 'topic' }, { name: 'patient' }] },
          `topic ${wordsOfLength(60)}`,
        );
        expect(result.metrics?.variablesDeclared).toBe(2);
        expect(result.metrics?.variableCoverage).toBe(0.5);
        expect(result.score).toBe(0.75);
      });

      it('surfaces the metrics breakdown on the result DTO', async () => {
        const result = await runWith({ category: 'SYSTEM', content: 'Plain', variables: null }, wordsOfLength(60));
        expect(result.metrics).toBeDefined();
        expect(result.metrics?.wordCount).toBe(60);
        expect(result.metrics?.lengthScore).toBe(1);
      });
    });

    // ─── provider selection, dry-run/version, golden-case ───
    describe('provider/model selection (text.test routing tier)', () => {
      it('forwards an explicit caller-supplied provider/model pair to TEXT verbatim', async () => {
        const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        const aiTaskDefaultService = { getEffective: vi.fn() };
        const aiModelRepository = {
          findByTaskTypeSharedRead: vi.fn().mockResolvedValue([{ provider: 'azure-openai', sourceUri: 'gpt-4o' }]),
        };
        const { svc, httpMock } = buildTextService(wordsOfLength(60), { aiTaskDefaultService, aiModelRepository });

        await svc.startPromptTemplateTest('tpl-1', { provider: 'azure-openai', model: 'gpt-4o' } as never);

        // The task-default cascade is never consulted when the caller pins a pair.
        expect(aiTaskDefaultService.getEffective).not.toHaveBeenCalled();
        const [, payload] = httpMock.axiosRef.post.mock.calls[0];
        expect((payload as { provider?: string }).provider).toBe('azure-openai');
        expect((payload as { model?: string }).model).toBe('gpt-4o');
      });

      it('rejects an unknown/disabled caller-supplied provider/model pair with ArgumentInvalidException', async () => {
        const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        const aiModelRepository = { findByTaskTypeSharedRead: vi.fn().mockResolvedValue([]) };
        const { svc, httpMock } = buildTextService(wordsOfLength(60), { aiModelRepository });

        await expect(svc.startPromptTemplateTest('tpl-1', { provider: 'ghost-provider', model: 'ghost-model' } as never)).rejects.toThrow(
          ArgumentInvalidException,
        );
        expect(httpMock.axiosRef.post).not.toHaveBeenCalled();
        expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
      });

      it('rejects a partial pair (provider without model)', async () => {
        const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        const { svc } = buildTextService(wordsOfLength(60));

        await expect(svc.startPromptTemplateTest('tpl-1', { provider: 'azure-openai' } as never)).rejects.toThrow(ArgumentInvalidException);
      });

      // ── BUG-018 test 5/6: fail-closed miss, and miss ≠ error ──
      it('fails closed with a BadRequestException naming text.test when nothing resolves', async () => {
        const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        const aiTaskDefaultService = { getEffective: vi.fn().mockResolvedValue({ modelSlug: null, source: null, model: null }) };
        const { svc, httpMock } = buildTextService(wordsOfLength(60), { aiTaskDefaultService });

        await expect(svc.startPromptTemplateTest('tpl-1', {} as never)).rejects.toThrow(BadRequestException);
        await expect(svc.startPromptTemplateTest('tpl-1', {} as never)).rejects.toThrow(/text\.test/);
        expect(httpMock.axiosRef.post).not.toHaveBeenCalled();
      });

      it('propagates a task-default LOOKUP ERROR instead of silently substituting a platform model', async () => {
        const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        const boom = new Error('registry unavailable');
        const aiTaskDefaultService = { getEffective: vi.fn().mockRejectedValue(boom) };
        const { svc, httpMock } = buildTextService(wordsOfLength(60), { aiTaskDefaultService });

        await expect(svc.startPromptTemplateTest('tpl-1', {} as never)).rejects.toThrow(boom);
        expect(httpMock.axiosRef.post).not.toHaveBeenCalled();
      });
    });

    describe('dryRun + versionNumber', () => {
      // ── BUG-018 test 1: dry run generates NOTHING ──
      it('dry-run returns the assembled prompt and never calls TEXT at all', async () => {
        const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1, content: 'Summarize {{topic}}' });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        const { svc, httpMock } = buildTextService(wordsOfLength(60));

        const ack = await svc.startPromptTemplateTest('tpl-1', { variables: { topic: 'asthma' }, dryRun: true } as never);

        expect(ack.mode).toBe('dry-run');
        expect(ack.assembledPrompt).toContain('asthma');
        expect(ack.taskId).toBeUndefined();
        expect(ack.streamUrl).toBeUndefined();
        expect(httpMock.axiosRef.post).not.toHaveBeenCalled();
        expect(httpMock.axiosRef.get).not.toHaveBeenCalled();
        expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
        expect(mockTemplateRepo.encryptFieldsIntoEntity).not.toHaveBeenCalled();
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });

      it('versionNumber targets the pinned PromptVersion snapshot content, not the mutable draft', async () => {
        const existing = createMockTemplateEntity({ id: 'tpl-1', version: 3, content: 'DRAFT content — must not be sent' });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        const version = createMockVersionEntity({
          promptTemplateId: 'tpl-1',
          versionNumber: 2,
          content: 'PINNED snapshot for {{topic}}',
          variables: [{ name: 'topic' }],
        });
        mockVersionRepo.findByVersionNumber.mockResolvedValue(version);
        const { svc, httpMock } = buildTextService(wordsOfLength(60));

        await svc.startPromptTemplateTest('tpl-1', { versionNumber: 2, variables: { topic: 'asthma' } } as never);

        expect(mockVersionRepo.findByVersionNumber).toHaveBeenCalledWith('tpl-1', 2);
        const [, payload] = httpMock.axiosRef.post.mock.calls[0];
        const prompt = (payload as { prompt: string }).prompt;
        expect(prompt).toContain('PINNED snapshot for asthma');
        expect(prompt).not.toContain('DRAFT content');
      });

      it('throws NotFoundException for a missing versionNumber (no TEXT call, no write)', async () => {
        const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        mockVersionRepo.findByVersionNumber.mockResolvedValue(undefined);
        const { svc, httpMock } = buildTextService(wordsOfLength(60));

        await expect(svc.startPromptTemplateTest('tpl-1', { versionNumber: 99 } as never)).rejects.toThrow(NotFoundException);
        expect(httpMock.axiosRef.post).not.toHaveBeenCalled();
        expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
      });

      it('interpolates a single-brace v1-style body via the shared substituter — no literal braces leak', async () => {
        const existing = createMockTemplateEntity({
          id: 'tpl-1',
          version: 1,
          content: 'Dept: {current_department} | Visit: {visit_type}',
          variables: [{ name: 'current_department' }, { name: 'visit_type' }],
        });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        const { svc, httpMock } = buildTextService(wordsOfLength(60));

        await svc.startPromptTemplateTest('tpl-1', { variables: { current_department: 'Cardiology' } } as never);

        const [, payload] = httpMock.axiosRef.post.mock.calls[0];
        const prompt = (payload as { prompt: string }).prompt;
        expect(prompt).toContain('Dept: Cardiology');
        expect(prompt).toContain('Visit: Medical examination');
        expect(prompt).not.toMatch(/\{current_department\}/);
        expect(prompt).not.toMatch(/\{visit_type\}/);
      });
    });

    describe('goldenCaseId (predefined example data)', () => {
      it('feeds the decrypted golden-case transcript into interpolation as sample input', async () => {
        const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1, content: 'Summarize:' });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        const goldenCaseEntity = { id: 'case-1', tenantId: 'tenant-1' };
        const goldenCaseRepository = {
          findById: vi.fn().mockResolvedValue(goldenCaseEntity),
          decryptFieldsFromEntity: vi.fn().mockResolvedValue({ transcript: 'Patient reports chest pain.', referenceNote: 'SOAP note...' }),
        };
        const secretsService = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') };
        const { svc, httpMock } = buildTextService(wordsOfLength(60), { goldenCaseRepository, secretsService });

        await svc.startPromptTemplateTest('tpl-1', { goldenCaseId: 'case-1' } as never);

        expect(goldenCaseRepository.findById).toHaveBeenCalledWith('case-1');
        expect(goldenCaseRepository.decryptFieldsFromEntity).toHaveBeenCalledWith(goldenCaseEntity, secretsService);
        const [, payload] = httpMock.axiosRef.post.mock.calls[0];
        expect((payload as { prompt: string }).prompt).toContain('Patient reports chest pain.');
      });

      it('throws NotFoundException on a cross-tenant golden case (404-over-403)', async () => {
        const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        const goldenCaseRepository = {
          findById: vi.fn().mockResolvedValue({ id: 'case-X', tenantId: 'tenant-OTHER' }),
          decryptFieldsFromEntity: vi.fn(),
        };
        const { svc, httpMock } = buildTextService(wordsOfLength(60), { goldenCaseRepository });

        await expect(svc.startPromptTemplateTest('tpl-1', { goldenCaseId: 'case-X' } as never)).rejects.toThrow(NotFoundException);
        expect(goldenCaseRepository.decryptFieldsFromEntity).not.toHaveBeenCalled();
        expect(httpMock.axiosRef.post).not.toHaveBeenCalled();
      });

      it('throws NotFoundException on an unknown golden case', async () => {
        const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        const goldenCaseRepository = { findById: vi.fn().mockResolvedValue(undefined), decryptFieldsFromEntity: vi.fn() };
        const { svc } = buildTextService(wordsOfLength(60), { goldenCaseRepository });

        await expect(svc.startPromptTemplateTest('tpl-1', { goldenCaseId: 'case-missing' } as never)).rejects.toThrow(NotFoundException);
      });

      it('rejects sampleInput + goldenCaseId supplied together', async () => {
        const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
        mockTemplateRepo.findById.mockResolvedValue(existing);
        const { svc, httpMock } = buildTextService(wordsOfLength(60));

        await expect(svc.startPromptTemplateTest('tpl-1', { sampleInput: 'free text', goldenCaseId: 'case-1' } as never)).rejects.toThrow(
          ArgumentInvalidException,
        );
        expect(httpMock.axiosRef.post).not.toHaveBeenCalled();
        expect(mockTemplateRepo.findById).not.toHaveBeenCalled();
      });
    });
  });
  // ─── repository-level pagination ────────────────────────

  describe('listPromptTemplatesPaginated', () => {
    it('delegates to repository.findPaginated and returns {data,count,page,limit}', async () => {
      mockTemplateRepo.findPaginated.mockResolvedValue({
        data: [createMockTemplateEntity({ id: 't1' }), createMockTemplateEntity({ id: 't2' })],
        count: 7,
      });

      const result = await service.listPromptTemplatesPaginated({ page: 2, limit: 2 });

      expect(mockTemplateRepo.findPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', resourceStatus: ResourceStatusType.ENABLED }),
        2,
        2,
      );
      expect(result.count).toBe(7);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(2);
      expect(result.data).toHaveLength(2);
    });

    it('defaults to page 1 / limit 50 and applies filters into the where clause', async () => {
      mockTemplateRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

      await service.listPromptTemplatesPaginated({ category: 'SUMMARY', search: 'soap', includeDisabled: true });

      const [where, page, limit] = mockTemplateRepo.findPaginated.mock.calls[0];
      expect(page).toBe(1);
      expect(limit).toBe(50);
      expect(where).toMatchObject({ tenantId: 'tenant-1', category: 'SUMMARY', name: { contains: 'soap', mode: 'insensitive' } });
      // includeDisabled drops the ENABLED-only constraint
      expect(where).not.toHaveProperty('resourceStatus');
    });

    // Server-side status filter folds into the where clause.
    it('applies the status filter into the where clause', async () => {
      mockTemplateRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

      await service.listPromptTemplatesPaginated({ status: 'PUBLISHED' });

      const [where] = mockTemplateRepo.findPaginated.mock.calls[0];
      expect(where).toMatchObject({ tenantId: 'tenant-1', status: 'PUBLISHED' });
    });

    it('does not add a status constraint when status is omitted', async () => {
      mockTemplateRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

      await service.listPromptTemplatesPaginated({ category: 'SUMMARY' });

      const [where] = mockTemplateRepo.findPaginated.mock.calls[0];
      expect(where).not.toHaveProperty('status');
    });

    it('throws BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'user' ? defaultClsContext.user : null));

      await expect(service.listPromptTemplatesPaginated()).rejects.toThrow(BadRequestException);
    });
  });

  // ─── usage analytics (groupBy dept / doctor / time) ─────

  describe('getUsageAnalytics', () => {
    it('returns aggregates grouped by department, doctor, and day', async () => {
      mockUsageRepo.groupByDepartment.mockResolvedValue([
        { departmentId: 'dept-1', count: 4 },
        { departmentId: null, count: 1 },
      ]);
      mockUsageRepo.groupByDoctor.mockResolvedValue([{ doctorId: 'doc-1', count: 5 }]);
      mockUsageRepo.groupByDay.mockResolvedValue([
        { day: '2026-06-01', count: 2 },
        { day: '2026-06-02', count: 3 },
      ]);

      const result = await service.getUsageAnalytics();

      expect(mockUsageRepo.groupByDepartment).toHaveBeenCalledWith('tenant-1', undefined);
      expect(mockUsageRepo.groupByDoctor).toHaveBeenCalledWith('tenant-1', undefined);
      expect(mockUsageRepo.groupByDay).toHaveBeenCalledWith('tenant-1', undefined);
      expect(result.totalUsages).toBe(5);
      expect(result.byDepartment).toEqual([
        { departmentId: 'dept-1', count: 4 },
        { departmentId: null, count: 1 },
      ]);
      expect(result.byDoctor).toEqual([{ doctorId: 'doc-1', count: 5 }]);
      expect(result.byDay).toEqual([
        { day: '2026-06-01', count: 2 },
        { day: '2026-06-02', count: 3 },
      ]);
    });

    it('passes through an optional promptTemplateId filter to the repository', async () => {
      mockUsageRepo.groupByDepartment.mockResolvedValue([]);
      mockUsageRepo.groupByDoctor.mockResolvedValue([]);
      mockUsageRepo.groupByDay.mockResolvedValue([]);

      await service.getUsageAnalytics({ promptTemplateId: 'tpl-9' });

      expect(mockUsageRepo.groupByDepartment).toHaveBeenCalledWith('tenant-1', 'tpl-9');
      expect(mockUsageRepo.groupByDoctor).toHaveBeenCalledWith('tenant-1', 'tpl-9');
      expect(mockUsageRepo.groupByDay).toHaveBeenCalledWith('tenant-1', 'tpl-9');
    });

    it('throws BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'user' ? defaultClsContext.user : null));

      await expect(service.getUsageAnalytics()).rejects.toThrow(BadRequestException);
    });
  });

  // ─── tenant-scoped raw usage-record listing (Agent Jobs) ─────

  describe('listUsageRecords', () => {
    const mkRecord = (overrides: Record<string, unknown> = {}) => ({
      id: 'run-1',
      tenantId: 'tenant-1',
      promptTemplateId: 'tpl-1',
      promptVersionNumber: 3,
      consultationId: 'cons-1',
      doctorId: 'doc-1',
      departmentId: 'dept-1',
      createdAt: new Date('2026-07-01T09:00:00Z'),
      ...overrides,
    });

    it('returns a paginated envelope of run rows, tenant-scoped, newest first', async () => {
      mockUsageRepo.findAll.mockResolvedValue([mkRecord(), mkRecord({ id: 'run-2', promptVersionNumber: null })]);
      mockUsageRepo.count.mockResolvedValue(12);

      const result = await service.listUsageRecords({ page: 0, limit: 2 });

      expect(mockUsageRepo.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 0,
          limit: 2,
          filters: { tenantId: 'tenant-1' },
          sort: [{ createdAt: 'desc' }],
        }),
      );
      expect(mockUsageRepo.count).toHaveBeenCalledWith(expect.objectContaining({ filters: { tenantId: 'tenant-1' } }));
      expect(result.count).toBe(12);
      expect(result.page).toBe(0);
      expect(result.limit).toBe(2);
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({
        id: 'run-1',
        promptTemplateId: 'tpl-1',
        promptVersionNumber: 3,
        consultationId: 'cons-1',
        doctorId: 'doc-1',
        departmentId: 'dept-1',
        createdAt: '2026-07-01T09:00:00.000Z',
      });
      expect(result.data[1].promptVersionNumber).toBeNull();
    });

    it('narrows to a single template when promptTemplateId is given', async () => {
      mockUsageRepo.findAll.mockResolvedValue([]);
      mockUsageRepo.count.mockResolvedValue(0);

      await service.listUsageRecords({ promptTemplateId: 'tpl-9' });

      expect(mockUsageRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ filters: { tenantId: 'tenant-1', promptTemplateId: 'tpl-9' } }));
    });

    it('defaults to page 0 / limit 20', async () => {
      mockUsageRepo.findAll.mockResolvedValue([]);
      mockUsageRepo.count.mockResolvedValue(0);

      const result = await service.listUsageRecords();

      expect(mockUsageRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ page: 0, limit: 20 }));
      expect(result.page).toBe(0);
      expect(result.limit).toBe(20);
    });

    it('throws BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'user' ? defaultClsContext.user : null));

      await expect(service.listUsageRecords()).rejects.toThrow(BadRequestException);
    });
  });

  // ─── doctor self-service (caller-ownership) ───
  describe('doctor self-service: personal CRUD + preferred template', () => {
    const createMockUserProfileService = () => ({
      upsertByUserId: vi.fn(),
      getByUserId: vi.fn(),
    });

    let profileSvc: ReturnType<typeof createMockUserProfileService>;
    let svc: PromptManagementService;

    beforeEach(() => {
      profileSvc = createMockUserProfileService();
      svc = new PromptManagementService(
        mockTemplateRepo as never,
        mockVersionRepo as never,
        mockUsageRepo as never,
        mockDepartmentService as never,
        mockEventEmitter as never,
        mockClsService as never,
        mockDatabaseService as never,
        undefined, // httpService
        undefined, // configService
        undefined, // secretsService
        undefined, // harnessPolicyService
        profileSvc as never, // userProfileService
      );
    });

    describe('updatePersonal', () => {
      it('REJECTS a non-personal template even when the caller has manage (NOT a doctor self-service target)', async () => {
        abilityCan.mockReturnValue(true); // caller has manage
        const tenantDefault = createMockTemplateEntity({ id: 'tpl-D', tenantId: 'tenant-1', scope: 'TENANT_DEFAULT' });
        mockTemplateRepo.findById.mockResolvedValue(tenantDefault);

        await expect(svc.updatePersonal('tpl-D', { content: 'edit', expectedVersion: 1 } as never)).rejects.toThrow(ForbiddenException);
        expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
      });

      it("REJECTS another user's personal template (ownership)", async () => {
        const personal = createMockTemplateEntity({ id: 'tpl-P', tenantId: 'tenant-1', scope: 'USER_PERSONAL', ownerUserId: 'someone-else' });
        mockTemplateRepo.findById.mockResolvedValue(personal);

        await expect(svc.updatePersonal('tpl-P', { content: 'edit', expectedVersion: 1 } as never)).rejects.toThrow(ForbiddenException);
        expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
      });

      it('allows the owner to update their own personal template (delegates to the CAS write path)', async () => {
        abilityCan.mockReturnValue(false); // no manage — ownership is the only grant
        const personal = createMockTemplateEntity({ id: 'tpl-mine', tenantId: 'tenant-1', scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' });
        mockTemplateRepo.findById.mockResolvedValue(personal);
        mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());
        mockTemplateRepo.updateWithVersion.mockResolvedValue(personal);

        await svc.updatePersonal('tpl-mine', { content: 'new content', expectedVersion: 1 } as never);

        expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalled();
      });

      it('throws NotFoundException (no existence leak) for a cross-tenant template', async () => {
        const foreign = createMockTemplateEntity({ id: 'tpl-X', tenantId: 'tenant-OTHER', scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' });
        mockTemplateRepo.findById.mockResolvedValue(foreign);

        await expect(svc.updatePersonal('tpl-X', { content: 'edit', expectedVersion: 1 } as never)).rejects.toThrow(NotFoundException);
      });
    });

    describe('deletePersonal', () => {
      it('REJECTS a non-personal template even with manage', async () => {
        abilityCan.mockReturnValue(true);
        const tenantDefault = createMockTemplateEntity({ id: 'tpl-D', tenantId: 'tenant-1', scope: 'TENANT_DEFAULT' });
        mockTemplateRepo.findById.mockResolvedValue(tenantDefault);

        await expect(svc.deletePersonal('tpl-D')).rejects.toThrow(ForbiddenException);
        expect(mockTemplateRepo.softDelete).not.toHaveBeenCalled();
      });

      it('allows the owner to delete their own personal template (delegates to soft delete)', async () => {
        const personal = createMockTemplateEntity({ id: 'tpl-mine', tenantId: 'tenant-1', scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' });
        mockTemplateRepo.findById.mockResolvedValue(personal);
        mockTemplateRepo.softDelete.mockResolvedValue(personal);

        await svc.deletePersonal('tpl-mine');

        expect(mockTemplateRepo.softDelete).toHaveBeenCalledWith('tpl-mine');
      });
    });

    describe('setPreferredPromptTemplate', () => {
      it('writes the caller UserProfile.preferredPromptTemplateId when the template is available to the caller', async () => {
        vi.spyOn(svc, 'listAvailableForCaller').mockResolvedValue([{ id: 'tpl-1' } as never, { id: 'tpl-2' } as never]);
        profileSvc.upsertByUserId.mockResolvedValue({ preferredPromptTemplateId: 'tpl-1' });

        const res = await svc.setPreferredPromptTemplate('tpl-1');

        expect(profileSvc.upsertByUserId).toHaveBeenCalledWith('user-id-1', { preferredPromptTemplateId: 'tpl-1' });
        expect(res.preferredPromptTemplateId).toBe('tpl-1');
      });

      it('REJECTS a template that is not available to the caller (ownership / publication gate)', async () => {
        vi.spyOn(svc, 'listAvailableForCaller').mockResolvedValue([{ id: 'tpl-1' } as never]);

        await expect(svc.setPreferredPromptTemplate('tpl-not-mine')).rejects.toThrow(ForbiddenException);
        expect(profileSvc.upsertByUserId).not.toHaveBeenCalled();
      });

      it('clears the preference (templateId=null) without an availability check', async () => {
        const listSpy = vi.spyOn(svc, 'listAvailableForCaller');
        profileSvc.upsertByUserId.mockResolvedValue({ preferredPromptTemplateId: null });

        const res = await svc.setPreferredPromptTemplate(null);

        expect(listSpy).not.toHaveBeenCalled();
        expect(profileSvc.upsertByUserId).toHaveBeenCalledWith('user-id-1', { preferredPromptTemplateId: null });
        expect(res.preferredPromptTemplateId).toBeNull();
      });
    });
  });

  // ─── admin per-user prompt scope (USER_PERSONAL/ownerUserId) ──
  describe('admin USER_PERSONAL create + owner filters', () => {
    it('createPromptTemplate stamps scope=USER_PERSONAL + the provided ownerUserId (admin-for-user)', async () => {
      mockTemplateRepo.findByName.mockResolvedValue(null);
      mockTemplateRepo.create.mockResolvedValue(createMockTemplateEntity({ scope: 'USER_PERSONAL', ownerUserId: 'target-user' }));
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      await service.createPromptTemplate({
        name: 'For a user',
        content: 'X',
        category: 'CUSTOM',
        scope: 'USER_PERSONAL',
        ownerUserId: 'target-user',
      } as never);

      expect(PromptTemplateFactory.CreatePromptTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'USER_PERSONAL', ownerUserId: 'target-user' }),
      );
    });

    it('createPromptTemplate falls back ownerUserId to the caller when scope=USER_PERSONAL and no owner given', async () => {
      mockTemplateRepo.findByName.mockResolvedValue(null);
      mockTemplateRepo.create.mockResolvedValue(createMockTemplateEntity({ scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' }));
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

      await service.createPromptTemplate({
        name: 'Mine via admin route',
        content: 'X',
        category: 'CUSTOM',
        scope: 'USER_PERSONAL',
      } as never);

      expect(PromptTemplateFactory.CreatePromptTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' }),
      );
    });

    it('createPromptTemplate rejects ownerUserId when scope is not USER_PERSONAL', async () => {
      mockTemplateRepo.findByName.mockResolvedValue(null);

      await expect(
        service.createPromptTemplate({
          name: 'Bad',
          content: 'X',
          category: 'CUSTOM',
          ownerUserId: 'target-user',
        } as never),
      ).rejects.toThrow(BadRequestException);
      expect(mockTemplateRepo.create).not.toHaveBeenCalled();
    });

    it('createPromptTemplate still requires manage ability (CASL) for USER_PERSONAL admin-for-user', async () => {
      abilityCan.mockReturnValue(false);

      await expect(
        service.createPromptTemplate({
          name: 'No manage',
          content: 'X',
          category: 'CUSTOM',
          scope: 'USER_PERSONAL',
          ownerUserId: 'target-user',
        } as never),
      ).rejects.toThrow(ForbiddenException);
    });

    it('listPromptTemplates applies scope + ownerUserId filters', async () => {
      const mockQb = createMockQueryBuilder();
      mockTemplateRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      await service.listPromptTemplates({ scope: 'USER_PERSONAL', ownerUserId: 'target-user' });

      expect(mockQb.Where).toHaveBeenCalledWith({ scope: 'USER_PERSONAL' });
      expect(mockQb.Where).toHaveBeenCalledWith({ ownerUserId: 'target-user' });
    });

    it('listPromptTemplatesPaginated folds scope + ownerUserId into the where clause', async () => {
      mockTemplateRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

      await service.listPromptTemplatesPaginated({ scope: 'USER_PERSONAL', ownerUserId: 'target-user' });

      const [where] = mockTemplateRepo.findPaginated.mock.calls[0];
      expect(where).toMatchObject({ tenantId: 'tenant-1', scope: 'USER_PERSONAL', ownerUserId: 'target-user' });
    });
  });

  // ─── approveTemplate scope (OD-3): SYSTEM = super-admin only,
  //     tenant-owned = manage:PromptTemplate for that tenant ───
  describe('approveTemplate authorization scope (OD-3)', () => {
    const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

    // Override the CLS user roles (isSuperAdmin reads user.roles) and the
    // working tenant + ability for a single test.
    const useContext = (opts: { roles?: string[]; tenantId?: string; canManage?: boolean }) => {
      abilityCan.mockReturnValue(opts.canManage ?? true);
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return { ...defaultClsContext.user, roles: opts.roles ?? [] };
          case 'tenantId':
            return opts.tenantId ?? 'tenant-1';
          case 'userAbility':
            return { can: abilityCan };
          default:
            return null;
        }
      });
    };

    const wireApproveSuccess = (template: ReturnType<typeof createMockTemplateEntity>) => {
      mockTemplateRepo.findById.mockResolvedValue(template);
      mockVersionRepo.findMaxVersionNumber.mockResolvedValue(0);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());
      mockTemplateRepo.updateWithVersion.mockResolvedValue(template);
    };

    it('tenant admin approves own-tenant template → 200 (snapshots + CAS)', async () => {
      useContext({ roles: [], tenantId: 'tenant-1', canManage: true });
      const tpl = createMockTemplateEntity({ id: 'tpl-t', tenantId: 'tenant-1', scope: 'TENANT_DEFAULT', status: 'DRAFT', version: 3 });
      wireApproveSuccess(tpl);

      const result = await service.approveTemplate('tpl-t', { expectedVersion: 3 } as never);

      expect(result).toBeDefined();
      expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalledWith('tpl-t', tpl, 3, mockTxClient);
    });

    it('pins approvedVersionNumber to the EXISTING latest snapshot when it already matches the live content', async () => {
      useContext({ roles: [], tenantId: 'tenant-1', canManage: true });
      const tpl = createMockTemplateEntity({ id: 'tpl-t', tenantId: 'tenant-1', scope: 'TENANT_DEFAULT', status: 'DRAFT', version: 3 });
      mockTemplateRepo.findById.mockResolvedValue(tpl);
      // The publish edit already wrote v2 with exactly this content.
      mockVersionRepo.findLatestVersion.mockResolvedValue(createMockVersionEntity({ versionNumber: 2, content: tpl.content, variables: tpl.variables ?? null }));
      mockTemplateRepo.updateWithVersion.mockResolvedValue(tpl);

      await service.approveTemplate('tpl-t', { expectedVersion: 3 } as never);

      // No v3 is authored — approval pins v2.
      expect(mockVersionRepo.create).not.toHaveBeenCalled();
      expect(tpl.approvedVersionNumber).toBe(2);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          data: expect.objectContaining({ action: 'approve', approvedVersionNumber: 2 }),
        }),
      );
    });

    it('authors a new snapshot when the live content has drifted from the latest version (eval-gate integrity, F-02)', async () => {
      useContext({ roles: [], tenantId: 'tenant-1', canManage: true });
      const tpl = createMockTemplateEntity({ id: 'tpl-t', tenantId: 'tenant-1', scope: 'TENANT_DEFAULT', status: 'DRAFT', version: 3 });
      mockTemplateRepo.findById.mockResolvedValue(tpl);
      // History max = 5 → approval creates + PINS version 6.
      mockVersionRepo.findMaxVersionNumber.mockResolvedValue(5);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 6 }));
      mockTemplateRepo.updateWithVersion.mockResolvedValue(tpl);

      await service.approveTemplate('tpl-t', { expectedVersion: 3 } as never);

      // The pinned snapshot IS version 6 …
      expect(mockVersionRepo.create).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: 6 }), mockTxClient);
      // … approvedVersionNumber is set to 6 on the entity persisted via CAS,
      // so resolution serves v6 (not a later unapproved edit).
      expect(tpl.approvedVersionNumber).toBe(6);
      expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalledWith('tpl-t', tpl, 3, mockTxClient);
      // Audit sys-event records the pinned version.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          data: expect.objectContaining({ action: 'approve', status: 'APPROVED', approvedVersionNumber: 6 }),
        }),
      );
    });

    it('tenant admin on a SYSTEM/library template → 403 (no write)', async () => {
      useContext({ roles: [], tenantId: 'tenant-1', canManage: true });
      const tpl = createMockTemplateEntity({ id: 'tpl-sys', tenantId: SYSTEM_TENANT_ID, scope: 'TENANT_DEFAULT', status: 'DRAFT', version: 1 });
      mockTemplateRepo.findById.mockResolvedValue(tpl);

      await expect(service.approveTemplate('tpl-sys', { expectedVersion: 1 } as never)).rejects.toThrow(ForbiddenException);
      expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
    });

    it('super admin approves a SYSTEM/library template → 200', async () => {
      useContext({ roles: ['SUPER_ADMIN'], tenantId: 'tenant-1', canManage: false });
      const tpl = createMockTemplateEntity({ id: 'tpl-sys', tenantId: SYSTEM_TENANT_ID, scope: 'TENANT_DEFAULT', status: 'DRAFT', version: 2 });
      wireApproveSuccess(tpl);

      const result = await service.approveTemplate('tpl-sys', { expectedVersion: 2 } as never);

      expect(result).toBeDefined();
      expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalled();
    });

    it('super admin approves a tenant-owned template → 200', async () => {
      useContext({ roles: ['SUPER_ADMIN'], tenantId: 'tenant-1', canManage: false });
      const tpl = createMockTemplateEntity({ id: 'tpl-t', tenantId: 'tenant-1', scope: 'DEPARTMENT_DEFAULT', status: 'DRAFT', version: 4 });
      wireApproveSuccess(tpl);

      const result = await service.approveTemplate('tpl-t', { expectedVersion: 4 } as never);

      expect(result).toBeDefined();
      expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalled();
    });

    it('cross-tenant template id → 404 (existence hidden, no write)', async () => {
      useContext({ roles: [], tenantId: 'tenant-1', canManage: true });
      const tpl = createMockTemplateEntity({ id: 'tpl-x', tenantId: 'tenant-OTHER', scope: 'TENANT_DEFAULT', status: 'DRAFT', version: 1 });
      mockTemplateRepo.findById.mockResolvedValue(tpl);

      await expect(service.approveTemplate('tpl-x', { expectedVersion: 1 } as never)).rejects.toThrow(NotFoundException);
      expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
    });

    it('tenant caller lacking manage:PromptTemplate on own-tenant template → 403', async () => {
      useContext({ roles: [], tenantId: 'tenant-1', canManage: false });
      const tpl = createMockTemplateEntity({ id: 'tpl-t', tenantId: 'tenant-1', scope: 'TENANT_DEFAULT', status: 'DRAFT', version: 1 });
      mockTemplateRepo.findById.mockResolvedValue(tpl);

      await expect(service.approveTemplate('tpl-t', { expectedVersion: 1 } as never)).rejects.toThrow(ForbiddenException);
      expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
    });

    it('missing template id → 404', async () => {
      useContext({ roles: ['SUPER_ADMIN'], tenantId: 'tenant-1' });
      mockTemplateRepo.findById.mockResolvedValue(null);

      await expect(service.approveTemplate('nope', { expectedVersion: 1 } as never)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── approveTemplate eval promotion gate  ───
  describe('approveTemplate eval promotion gate', () => {
    const mockGate = { evaluatePromotion: vi.fn() };

    const buildGatedService = () =>
      new PromptManagementService(
        mockTemplateRepo as never,
        mockVersionRepo as never,
        mockUsageRepo as never,
        mockDepartmentService as never,
        mockEventEmitter as never,
        mockClsService as never,
        mockDatabaseService as never,
        undefined as never, // httpService
        undefined as never, // configService
        undefined as never, // secretsService
        undefined as never, // harnessPolicyService
        undefined as never, // userProfileService
        undefined as never, // entitlements
        mockGate as never, // promotionGate (appended)
      );

    beforeEach(() => {
      mockGate.evaluatePromotion.mockReset();
      // Super admin approving a tenant-owned DRAFT template.
      mockClsService.get.mockImplementation((key: string) =>
        key === 'user' ? { ...defaultClsContext.user, roles: ['SUPER_ADMIN'] } : key === 'tenantId' ? 'tenant-1' : null,
      );
    });

    it('blocks approval with 409 and does NOT flip status when the gate fails in block-mode', async () => {
      const tpl = createMockTemplateEntity({ id: 'tpl-g', tenantId: 'tenant-1', scope: 'DEPARTMENT_DEFAULT', status: 'DRAFT', version: 2 });
      mockTemplateRepo.findById.mockResolvedValue(tpl);
      mockGate.evaluatePromotion.mockResolvedValue({
        mode: 'block',
        evaluated: true,
        passed: false,
        blocked: true,
        failures: ['pdsqi_accurate=2.0000 < 4.0'],
        runIds: ['run-1'],
        aggregates: { pdsqi_accurate: 2.0 },
      });

      const svc = buildGatedService();
      await expect(svc.approveTemplate('tpl-g', { expectedVersion: 2 } as never)).rejects.toThrow(ConflictException);
      expect(mockGate.evaluatePromotion).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', promptTemplateId: 'tpl-g', trigger: 'approve' }),
      );
      // Status not promoted; no version-pin CAS.
      expect(tpl.status).not.toBe('APPROVED');
      expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
    });

    it('proceeds to APPROVED when the gate passes (or warns)', async () => {
      const tpl = createMockTemplateEntity({ id: 'tpl-g', tenantId: 'tenant-1', scope: 'DEPARTMENT_DEFAULT', status: 'DRAFT', version: 3 });
      mockTemplateRepo.findById.mockResolvedValue(tpl);
      mockVersionRepo.findMaxVersionNumber.mockResolvedValue(0);
      mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());
      mockTemplateRepo.updateWithVersion.mockResolvedValue(tpl);
      mockGate.evaluatePromotion.mockResolvedValue({
        mode: 'warn',
        evaluated: true,
        passed: false,
        blocked: false, // warn-mode never blocks
        failures: ['x'],
        runIds: ['run-1'],
        aggregates: {},
      });

      const svc = buildGatedService();
      const result = await svc.approveTemplate('tpl-g', { expectedVersion: 3 } as never);
      expect(result).toBeDefined();
      expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalled();
    });
  });
});
