/**
 * DepartmentAgentService unit tests (TASK-546).
 *
 * Covers the validation invariants the ticket enumerates: factory usage +
 * sys-event on create, 404-over-403 cross-tenant, pin validation (missing
 * version → 400, non-APPROVED snapshot → 400), harnessOverrides global-only key
 * → 400, templateLocked edit → 403, and default-flip atomicity.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { DepartmentAgentService } from '../departmentAgent.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockAgentRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
  isSlugUnique: vi.fn(),
  setDefaultForDepartment: vi.fn(),
  findDefaultForDepartment: vi.fn(),
};
const mockDepartmentRepository = { findById: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), create: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), create: vi.fn() };

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    DepartmentAgentFactory: {
      CreateDepartmentAgent: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        id: 'new-agent-id',
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      })),
    },
  };
});

/** A hydrated-agent stand-in with working setters + change tracking. */
const mockAgent = (overrides: Record<string, unknown> = {}) => ({
  id: 'agent-1',
  tenantId: 'tenant-1',
  departmentId: 'dept-1',
  name: 'Cardiology SOAP',
  slug: 'cardiology-soap',
  description: null,
  promptTemplateId: 'tpl-1',
  pinnedVersionNumber: null,
  dnaStylePolicy: 'INHERIT',
  harnessOverrides: null,
  goldenSetId: null,
  isDefault: false,
  templateLocked: false,
  tags: [],
  resourceStatus: 'ENABLED',
  version: 1,
  hasChanges: true,
  changes: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  toObject: () => ({}),
  enable: vi.fn(),
  disable: vi.fn(),
  ...overrides,
});

describe('DepartmentAgentService', () => {
  let service: DepartmentAgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'user-1' };
        case 'tenantId':
          return 'tenant-1';
        default:
          return null;
      }
    });
    mockDepartmentRepository.findById.mockResolvedValue({ id: 'dept-1', tenantId: 'tenant-1' });
    mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-1', tenantId: 'tenant-1', status: 'APPROVED', departmentId: null });
    mockAgentRepository.isSlugUnique.mockResolvedValue(true);

    service = new DepartmentAgentService(
      mockAgentRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDepartmentRepository as never,
      mockPromptTemplateRepository as never,
      mockPromptVersionRepository as never,
    );
  });

  describe('create', () => {
    it('creates via the factory and broadcasts a ResourceCreated sys-event', async () => {
      const { DepartmentAgentFactory } = await import('@arcaai/domains');
      mockAgentRepository.create.mockImplementation(async (e: unknown) => e);

      const res = await service.create({
        departmentId: 'dept-1',
        name: 'Cardiology SOAP',
        slug: 'cardiology-soap',
        promptTemplateId: 'tpl-1',
      });

      expect(DepartmentAgentFactory.CreateDepartmentAgent).toHaveBeenCalledOnce();
      expect(mockAgentRepository.create).toHaveBeenCalledOnce();
      expect(mockEventEmitter.emit).toHaveBeenCalled();
      expect(res.slug).toBe('cardiology-soap');
    });

    it('rejects a duplicate slug within the department (400)', async () => {
      mockAgentRepository.isSlugUnique.mockResolvedValue(false);
      await expect(
        service.create({ departmentId: 'dept-1', name: 'X', slug: 'dupe', promptTemplateId: 'tpl-1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a promptTemplateId not visible to the tenant (400)', async () => {
      mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-x', tenantId: 'other-tenant', status: 'APPROVED' });
      await expect(
        service.create({ departmentId: 'dept-1', name: 'X', slug: 'x', promptTemplateId: 'tpl-x' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a harnessOverrides global-admin-only key (400)', async () => {
      await expect(
        service.create({
          departmentId: 'dept-1',
          name: 'X',
          slug: 'x',
          promptTemplateId: 'tpl-1',
          harnessOverrides: { maxRegen: 2, smrProvider: 'azure' },
        }),
      ).rejects.toThrow(/global-admin-only/);
    });

    it('rejects a pin to a non-existent version (400)', async () => {
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue(null);
      await expect(
        service.create({ departmentId: 'dept-1', name: 'X', slug: 'x', promptTemplateId: 'tpl-1', pinnedVersionNumber: 9 }),
      ).rejects.toThrow(ArgumentInvalidException);
    });

    it('rejects a pin against a non-APPROVED template snapshot (400)', async () => {
      mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-1', tenantId: 'tenant-1', status: 'DRAFT', departmentId: null });
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 2, content: 'x' });
      await expect(
        service.create({ departmentId: 'dept-1', name: 'X', slug: 'x', promptTemplateId: 'tpl-1', pinnedVersionNumber: 2 }),
      ).rejects.toThrow(/APPROVED/);
    });
  });

  describe('cross-tenant (404-over-403)', () => {
    it('getById on a foreign agent returns 404', async () => {
      mockAgentRepository.findById.mockResolvedValue(mockAgent({ tenantId: 'other-tenant' }));
      await expect(service.getById('agent-1')).rejects.toThrow(NotFoundException);
    });

    it('update on a foreign agent returns 404', async () => {
      mockAgentRepository.findById.mockResolvedValue(mockAgent({ tenantId: 'other-tenant' }));
      await expect(service.update('agent-1', { expectedVersion: 1 })).rejects.toThrow(NotFoundException);
    });
  });

  describe('templateLocked', () => {
    it('rejects an edit of a locked template copy (403)', async () => {
      mockAgentRepository.findById.mockResolvedValue(mockAgent({ templateLocked: true }));
      await expect(service.update('agent-1', { name: 'new', expectedVersion: 1 })).rejects.toThrow(ForbiddenException);
    });

    it('rejects a delete of a locked template copy (403)', async () => {
      mockAgentRepository.findById.mockResolvedValue(mockAgent({ templateLocked: true }));
      await expect(service.deleteById('agent-1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('update (OCC)', () => {
    it('writes via updateWithVersion and broadcasts ResourceUpdated', async () => {
      const agent = mockAgent();
      mockAgentRepository.findById.mockResolvedValue(agent);
      mockAgentRepository.updateWithVersion.mockResolvedValue({ ...agent, version: 2 });

      await service.update('agent-1', { name: 'Renamed', expectedVersion: 1 });

      expect(mockAgentRepository.updateWithVersion).toHaveBeenCalledWith('agent-1', agent, 1);
      expect(mockEventEmitter.emit).toHaveBeenCalled();
    });
  });

  describe('setDefault (atomic flip)', () => {
    it('delegates the flip to the repository transaction and re-reads', async () => {
      const agent = mockAgent();
      mockAgentRepository.findById.mockResolvedValue(agent);

      await service.setDefault('agent-1');

      expect(mockAgentRepository.setDefaultForDepartment).toHaveBeenCalledWith('tenant-1', 'dept-1', 'agent-1', 'user-1');
      expect(mockEventEmitter.emit).toHaveBeenCalled();
    });
  });

  describe('pin', () => {
    it('rejects a pin to a non-existent version (400)', async () => {
      mockAgentRepository.findById.mockResolvedValue(mockAgent());
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue(null);
      await expect(service.pin('agent-1', 9)).rejects.toThrow(ArgumentInvalidException);
    });

    it('pins to an APPROVED version and bumps the row version', async () => {
      const agent = mockAgent();
      mockAgentRepository.findById.mockResolvedValue(agent);
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 3, content: 'x' });
      mockAgentRepository.updateWithVersion.mockResolvedValue({ ...agent, version: 2, pinnedVersionNumber: 3 });

      const res = await service.pin('agent-1', 3);

      expect(agent.pinnedVersionNumber).toBe(3);
      expect(mockAgentRepository.updateWithVersion).toHaveBeenCalledWith('agent-1', agent, 1);
      expect(res.pinnedVersionNumber).toBe(3);
    });

    it('unpins (null) without touching the version repository', async () => {
      const agent = mockAgent({ pinnedVersionNumber: 3 });
      mockAgentRepository.findById.mockResolvedValue(agent);
      mockAgentRepository.updateWithVersion.mockResolvedValue({ ...agent, version: 2, pinnedVersionNumber: null });

      await service.pin('agent-1', null);

      expect(mockPromptVersionRepository.findByVersionNumber).not.toHaveBeenCalled();
      expect(agent.pinnedVersionNumber).toBeNull();
    });
  });

  describe('clone (clone-to-customize)', () => {
    beforeEach(() => {
      mockAgentRepository.create.mockImplementation(async (e: unknown) => e);
      mockPromptTemplateRepository.create.mockImplementation(async (e: unknown) => e);
      mockPromptVersionRepository.create.mockImplementation(async (e: unknown) => e);
    });

    it('produces an unlocked agent + a DRAFT template copy with lineage, keeping the locked source untouched', async () => {
      const source = mockAgent({ templateLocked: true, sourceAgentTemplateSlug: 'card-soap', promptTemplateId: 'tpl-1' });
      mockAgentRepository.findById.mockResolvedValue(source);
      mockPromptTemplateRepository.findById.mockResolvedValue({
        id: 'tpl-1',
        tenantId: 'tenant-1',
        name: 'Card SOAP',
        content: 'BODY',
        category: 'CLINICAL_SUMMARY',
        status: 'APPROVED',
        departmentId: 'dept-1',
        variables: null,
        scope: 'DEPARTMENT_DEFAULT',
        tags: [],
      });

      const res = await service.clone('agent-1', { name: 'My Card SOAP', slug: 'my-card-soap' });

      // A new editable DRAFT template copy was created and versioned (v1).
      expect(mockPromptTemplateRepository.create).toHaveBeenCalledOnce();
      const createdTemplate = mockPromptTemplateRepository.create.mock.calls[0][0] as {
        id: string;
        status: string;
        content: string | null;
        tenantId: string;
      };
      expect(createdTemplate.status).toBe('DRAFT');
      expect(createdTemplate.content).toBe('BODY');
      expect(createdTemplate.tenantId).toBe('tenant-1');
      expect(mockPromptVersionRepository.create).toHaveBeenCalledOnce();

      // The agent clone is UNLOCKED, bound to the NEW template, keeps lineage.
      expect(res.templateLocked).toBe(false);
      expect(res.sourceAgentTemplateSlug).toBe('card-soap');
      expect(res.slug).toBe('my-card-soap');
      expect(res.promptTemplateId).toBe(createdTemplate.id);
      // A clone is never the department default (DB/factory default false).
      expect(res.isDefault).toBeFalsy();

      // The locked source row is never mutated or deleted.
      expect(mockAgentRepository.updateWithVersion).not.toHaveBeenCalled();
      expect(mockAgentRepository.softDelete).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalled();
    });

    it('a cross-tenant clone attempt returns 404', async () => {
      mockAgentRepository.findById.mockResolvedValue(mockAgent({ tenantId: 'other-tenant' }));
      await expect(service.clone('agent-1', { name: 'X', slug: 'x' })).rejects.toThrow(NotFoundException);
    });

    it('rejects a duplicate slug within the department (400)', async () => {
      mockAgentRepository.findById.mockResolvedValue(mockAgent());
      mockAgentRepository.isSlugUnique.mockResolvedValue(false);
      await expect(service.clone('agent-1', { name: 'X', slug: 'dupe' })).rejects.toThrow(BadRequestException);
    });
  });
});
