/**
 * TASK-674 — `DepartmentAgentService.listVersions`.
 *
 * Covers: ownership-checked read (cross-tenant 404), newest-first mapping to
 * `DepartmentAgentVersionResponse` (incl. `changeReason`), and the
 * `@Optional()` degrade to an empty list when `agentVersionRepository` is not
 * wired — mirrors every other TASK-659 read path's fixture-arity convention.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { DepartmentAgentService } from '../departmentAgent.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockAgentRepository = { findById: vi.fn() };
const mockDepartmentRepository = { findById: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), create: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), create: vi.fn() };
const mockAgentVersionRepository = { findAllForAgent: vi.fn() };

const mockAgent = { id: 'agent-1', tenantId: 'tenant-1' };

function buildService(includeVersionRepository = true) {
  return new DepartmentAgentService(
    mockAgentRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDepartmentRepository as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    undefined, // promotionGate
    undefined, // aiModelRepository
    includeVersionRepository ? (mockAgentVersionRepository as never) : undefined,
    undefined, // contextSchemaRepository
    undefined, // contextSchemaVersionRepository
  );
}

describe('DepartmentAgentService.listVersions — TASK-674', () => {
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
    mockAgentRepository.findById.mockResolvedValue(mockAgent);
  });

  it('returns the recorded versions, newest first, with changeReason mapped through', async () => {
    const v2 = {
      id: 'v-2',
      agentId: 'agent-1',
      versionNumber: 2,
      configSnapshot: { role: 'PRIMARY' },
      checksum: 'sha-2',
      changeReason: null,
      createdBy: 'user-1',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
    };
    const v1 = {
      id: 'v-1',
      agentId: 'agent-1',
      versionNumber: 1,
      configSnapshot: { role: 'SPECIALIST' },
      checksum: 'sha-1',
      changeReason: "Cloned from template 'Cardiology Base' via agent clone",
      createdBy: 'user-1',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    mockAgentVersionRepository.findAllForAgent.mockResolvedValue([v2, v1]);

    const service = buildService();
    const result = await service.listVersions('agent-1');

    expect(mockAgentVersionRepository.findAllForAgent).toHaveBeenCalledWith('agent-1');
    expect(result).toEqual([
      {
        id: 'v-2',
        agentId: 'agent-1',
        versionNumber: 2,
        configSnapshot: { role: 'PRIMARY' },
        checksum: 'sha-2',
        changeReason: null,
        createdBy: 'user-1',
        createdAt: '2026-08-02T00:00:00.000Z',
      },
      {
        id: 'v-1',
        agentId: 'agent-1',
        versionNumber: 1,
        configSnapshot: { role: 'SPECIALIST' },
        checksum: 'sha-1',
        changeReason: "Cloned from template 'Cardiology Base' via agent clone",
        createdBy: 'user-1',
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
  });

  it('404s on a cross-tenant id — no version is read for an agent outside the caller tenant', async () => {
    mockAgentRepository.findById.mockResolvedValue({ id: 'agent-1', tenantId: 'other-tenant' });
    const service = buildService();

    await expect(service.listVersions('agent-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(mockAgentVersionRepository.findAllForAgent).not.toHaveBeenCalled();
  });

  it('degrades to an empty list when agentVersionRepository is not wired', async () => {
    const service = buildService(false);
    await expect(service.listVersions('agent-1')).resolves.toEqual([]);
  });
});
