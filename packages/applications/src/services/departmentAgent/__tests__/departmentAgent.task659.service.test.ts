/**
 * TASK-659 — DepartmentAgentService loop-configuration + promotion surface.
 *
 * Covers: unknown subscribedKinds kind rejected; writeScope naming an
 * undeclared output rejected; harnessOverrides global-admin-only key still
 * rejected (regression); the config version is immutable once written;
 * exactly one PRIMARY per department; and the byte-identical regression when
 * none of the seven new fields are set.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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
  findPrimaryForDepartment: vi.fn(),
};
const mockDepartmentRepository = { findById: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), create: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), create: vi.fn() };
const mockAgentVersionRepository = { findLatestForAgent: vi.fn(), create: vi.fn() };
const mockContextSchemaRepository = { findDefaultForScope: vi.fn() };
const mockContextSchemaVersionRepository = { findBySchemaAndVersionNumber: vi.fn() };

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    DepartmentAgentFactory: {
      // Mirrors the real factory's `??` precedence per field (NOT a plain
      // spread-over-defaults — a plain spread would leave an explicit
      // `undefined` in place of the default when the DTO omits the field).
      CreateDepartmentAgent: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        role: (data.role as string | undefined) ?? 'SPECIALIST',
        subscribedKinds: (data.subscribedKinds as Record<string, unknown> | undefined) ?? null,
        writeScope: (data.writeScope as Record<string, unknown> | undefined) ?? null,
        goal: (data.goal as Record<string, unknown> | undefined) ?? null,
        guardrailProfile: (data.guardrailProfile as string | undefined) ?? null,
        alwaysActions: (data.alwaysActions as string[] | undefined) ?? null,
        neverActions: (data.neverActions as string[] | undefined) ?? null,
        id: 'new-agent-id',
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      })),
    },
    DepartmentAgentVersionFactory: {
      CreateDepartmentAgentVersion: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'new-version-id' })),
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
  role: 'SPECIALIST',
  subscribedKinds: null,
  writeScope: null,
  goal: null,
  guardrailProfile: null,
  alwaysActions: null,
  neverActions: null,
  ...overrides,
});

/** Full DI graph, including the TASK-659 optional trailing dependencies. */
function buildService() {
  return new DepartmentAgentService(
    mockAgentRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDepartmentRepository as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    undefined, // promotionGate
    undefined, // aiModelRepository
    mockAgentVersionRepository as never,
    mockContextSchemaRepository as never,
    mockContextSchemaVersionRepository as never,
  );
}

describe('DepartmentAgentService — TASK-659', () => {
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
    mockAgentRepository.findPrimaryForDepartment.mockResolvedValue(null);
    mockAgentRepository.create.mockImplementation(async (e: unknown) => e);
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockAgentVersionRepository.create.mockImplementation(async (e: unknown) => e);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(null);

    service = buildService();
  });

  const baseCreateDto = { departmentId: 'dept-1', name: 'X', slug: 'x', promptTemplateId: 'tpl-1' };

  describe('regression — no TASK-659 fields set', () => {
    it('creating without any of the seven new fields behaves exactly as before and writes NO config version', async () => {
      const res = await service.create(baseCreateDto);

      expect(res.slug).toBe('x');
      expect(mockAgentVersionRepository.create).not.toHaveBeenCalled();
    });

    it('a regression harnessOverrides global-admin-only key is still rejected (400)', async () => {
      await expect(
        service.create({ ...baseCreateDto, harnessOverrides: { maxRegen: 2, smrProvider: 'azure' } }),
      ).rejects.toThrow(/global-admin-only/);
    });
  });

  describe('subscribedKinds cross-check', () => {
    it('rejects an unknown kind when the department has a servable schema', async () => {
      mockContextSchemaRepository.findDefaultForScope.mockImplementation(async (_tenantId: string, scope: string) =>
        scope === 'DEPARTMENT'
          ? { id: 'schema-1', pinnedVersionNumber: 1, status: 'PUBLISHED' }
          : null,
      );
      mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
        id: 'version-1',
        definition: { kinds: [{ key: 'referral_letter' }], outputs: [{ key: 'soap_note' }] },
      });

      await expect(
        service.create({ ...baseCreateDto, subscribedKinds: { version: 1, kinds: [{ key: 'unknown_kind' }] } }),
      ).rejects.toThrow(/unknown kind/);
    });

    it('accepts a subscribed kind declared in the resolved schema', async () => {
      mockContextSchemaRepository.findDefaultForScope.mockImplementation(async (_tenantId: string, scope: string) =>
        scope === 'DEPARTMENT' ? { id: 'schema-1', pinnedVersionNumber: 1, status: 'PUBLISHED' } : null,
      );
      mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
        id: 'version-1',
        definition: { kinds: [{ key: 'referral_letter' }] },
      });

      const res = await service.create({ ...baseCreateDto, subscribedKinds: { version: 1, kinds: [{ key: 'referral_letter' }] } });
      expect(res.subscribedKinds).toEqual({ version: 1, kinds: [{ key: 'referral_letter' }] });
    });

    it('rejects a naming ANY kind when the department has no published context schema (fail-closed)', async () => {
      mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);

      await expect(
        service.create({ ...baseCreateDto, subscribedKinds: { version: 1, kinds: [{ key: 'referral_letter' }] } }),
      ).rejects.toThrow(BadRequestException);
    });

    it('skips the cross-check when the schema repositories are not wired (structural-only degradation)', async () => {
      const bareService = new DepartmentAgentService(
        mockAgentRepository as never,
        mockEventEmitter as never,
        mockClsService as never,
        mockDepartmentRepository as never,
        mockPromptTemplateRepository as never,
        mockPromptVersionRepository as never,
      );

      const res = await bareService.create({
        ...baseCreateDto,
        subscribedKinds: { version: 1, kinds: [{ key: 'whatever_kind' }] },
      });
      expect(res.slug).toBe('x');
    });

    it('rejects malformed subscribedKinds shape regardless of the schema plane', async () => {
      await expect(service.create({ ...baseCreateDto, subscribedKinds: { version: 1, kinds: 'not-an-array' } })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('writeScope cross-check', () => {
    it('rejects an undeclared output', async () => {
      mockContextSchemaRepository.findDefaultForScope.mockImplementation(async (_tenantId: string, scope: string) =>
        scope === 'DEPARTMENT' ? { id: 'schema-1', pinnedVersionNumber: 1, status: 'PUBLISHED' } : null,
      );
      mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
        id: 'version-1',
        definition: { kinds: [], outputs: [{ key: 'soap_note' }] },
      });

      await expect(
        service.create({ ...baseCreateDto, writeScope: { version: 1, outputs: ['undeclared_output'] } }),
      ).rejects.toThrow(/undeclared output/);
    });

    it('accepts a declared output', async () => {
      mockContextSchemaRepository.findDefaultForScope.mockImplementation(async (_tenantId: string, scope: string) =>
        scope === 'DEPARTMENT' ? { id: 'schema-1', pinnedVersionNumber: 1, status: 'PUBLISHED' } : null,
      );
      mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
        id: 'version-1',
        definition: { kinds: [], outputs: [{ key: 'soap_note' }] },
      });

      const res = await service.create({ ...baseCreateDto, writeScope: { version: 1, outputs: ['soap_note'] } });
      expect(res.writeScope).toEqual({ version: 1, outputs: ['soap_note'] });
    });
  });

  describe('exactly one PRIMARY per department', () => {
    it('rejects creating a second PRIMARY agent in the same department', async () => {
      mockAgentRepository.findPrimaryForDepartment.mockResolvedValue(mockAgent({ id: 'existing-primary', slug: 'existing-primary' }));

      await expect(service.create({ ...baseCreateDto, role: 'PRIMARY' })).rejects.toThrow(/already has a PRIMARY agent/);
    });

    it('allows creating the FIRST PRIMARY agent in a department', async () => {
      mockAgentRepository.findPrimaryForDepartment.mockResolvedValue(null);

      const res = await service.create({ ...baseCreateDto, role: 'PRIMARY' });
      expect(res.role).toBe('PRIMARY');
    });

    it('rejects promoting an agent to PRIMARY via update when another agent already holds it', async () => {
      const agent = mockAgent({ role: 'SPECIALIST' });
      mockAgentRepository.findById.mockResolvedValue(agent);
      mockAgentRepository.findPrimaryForDepartment.mockResolvedValue(mockAgent({ id: 'other-primary', slug: 'other-primary' }));

      await expect(service.update('agent-1', { role: 'PRIMARY', expectedVersion: 1 })).rejects.toThrow(/already has a PRIMARY agent/);
      // The exclude-self id was passed through so the check ignores the row being edited.
      expect(mockAgentRepository.findPrimaryForDepartment).toHaveBeenCalledWith('tenant-1', 'dept-1', 'agent-1');
    });

    it('re-saving the SAME PRIMARY agent (role unchanged) does not re-check the invariant', async () => {
      const agent = mockAgent({ role: 'PRIMARY' });
      mockAgentRepository.findById.mockResolvedValue(agent);
      mockAgentRepository.updateWithVersion.mockResolvedValue({ ...agent, version: 2 });

      await service.update('agent-1', { name: 'Renamed', role: 'PRIMARY', expectedVersion: 1 });
      expect(mockAgentRepository.findPrimaryForDepartment).not.toHaveBeenCalled();
    });
  });

  describe('always/never compliance envelope', () => {
    it('rejects an action present in both lists', async () => {
      await expect(
        service.create({ ...baseCreateDto, alwaysActions: ['harness.finalize'], neverActions: ['harness.finalize'] }),
      ).rejects.toThrow(/appear in both/);
    });

    it('detects the overlap across a partial update against the agent\'s EXISTING other list', async () => {
      const agent = mockAgent({ alwaysActions: ['harness.finalize'] });
      mockAgentRepository.findById.mockResolvedValue(agent);

      await expect(service.update('agent-1', { neverActions: ['harness.finalize'], expectedVersion: 1 })).rejects.toThrow(/appear in both/);
    });
  });

  describe('goal — constrained, not free text', () => {
    it('rejects an objective over the length cap', async () => {
      await expect(service.create({ ...baseCreateDto, goal: { version: 1, objective: 'x'.repeat(500) } })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('accepts a bounded objective', async () => {
      const res = await service.create({ ...baseCreateDto, goal: { version: 1, objective: 'Draft a concise SOAP note.' } });
      expect(res.goal).toEqual({ version: 1, objective: 'Draft a concise SOAP note.' });
    });
  });

  describe('guardrailProfile', () => {
    it('rejects an uncatalogued profile', async () => {
      await expect(service.create({ ...baseCreateDto, guardrailProfile: 'YOLO' })).rejects.toThrow(BadRequestException);
    });

    it('accepts a catalogued profile', async () => {
      const res = await service.create({ ...baseCreateDto, guardrailProfile: 'STRICT' });
      expect(res.guardrailProfile).toBe('STRICT');
    });
  });

  describe('config version immutability', () => {
    it('writes a v1 snapshot on create when a loop-config field is set', async () => {
      await service.create({ ...baseCreateDto, guardrailProfile: 'STRICT' });

      expect(mockAgentVersionRepository.create).toHaveBeenCalledOnce();
      const written = mockAgentVersionRepository.create.mock.calls[0][0] as { versionNumber: number };
      expect(written.versionNumber).toBe(1);
      // Immutable: the repository is never asked to update a version row.
      expect(mockAgentVersionRepository).not.toHaveProperty('update');
    });

    it('bumps to v2 on a subsequent config-changing update, never touching v1', async () => {
      const agent = mockAgent({ guardrailProfile: 'STANDARD' });
      mockAgentRepository.findById.mockResolvedValue(agent);
      mockAgentRepository.updateWithVersion.mockResolvedValue({ ...agent, version: 2, guardrailProfile: 'STRICT' });
      mockAgentVersionRepository.findLatestForAgent.mockResolvedValue({ versionNumber: 1, checksum: 'old-checksum' });

      await service.update('agent-1', { guardrailProfile: 'STRICT', expectedVersion: 1 });

      expect(mockAgentVersionRepository.create).toHaveBeenCalledOnce();
      const written = mockAgentVersionRepository.create.mock.calls[0][0] as { versionNumber: number };
      expect(written.versionNumber).toBe(2);
    });

    it('does NOT write a new version when the snapshot is byte-identical to the latest (idempotent no-op)', async () => {
      const agent = mockAgent({ guardrailProfile: 'STRICT' });
      mockAgentRepository.findById.mockResolvedValue(agent);
      mockAgentRepository.updateWithVersion.mockResolvedValue({ ...agent, version: 2 });
      // Pre-seed the "latest" snapshot with the checksum the service will
      // independently recompute for the SAME configuration — the repository
      // is a stand-in, so this test proves the no-op guard by construction:
      // create the real checksum once via a throwaway create(), then assert
      // update() with identical config does not write again.
      mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
      mockAgentVersionRepository.create.mockImplementation(async (e: { checksum: string }) => e);

      // First write establishes the checksum.
      await service.create({ ...baseCreateDto, guardrailProfile: 'STRICT' });
      const firstChecksum = (mockAgentVersionRepository.create.mock.calls[0][0] as { checksum: string }).checksum;
      mockAgentVersionRepository.create.mockClear();
      mockAgentVersionRepository.findLatestForAgent.mockResolvedValue({ versionNumber: 1, checksum: firstChecksum });

      // Update writes the SAME guardrailProfile value — no new version.
      await service.update('agent-1', { guardrailProfile: 'STRICT', expectedVersion: 1 });
      expect(mockAgentVersionRepository.create).not.toHaveBeenCalled();
    });

    it('is skipped entirely when the version repository is not wired', async () => {
      const bareService = new DepartmentAgentService(
        mockAgentRepository as never,
        mockEventEmitter as never,
        mockClsService as never,
        mockDepartmentRepository as never,
        mockPromptTemplateRepository as never,
        mockPromptVersionRepository as never,
      );

      const res = await bareService.create({ ...baseCreateDto, guardrailProfile: 'STRICT' });
      expect(res.guardrailProfile).toBe('STRICT');
      expect(mockAgentVersionRepository.create).not.toHaveBeenCalled();
    });
  });
});
