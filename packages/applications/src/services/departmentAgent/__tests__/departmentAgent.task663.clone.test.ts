/**
 * TASK-663 — the TASK-659 §4.5 clone() gap, closed.
 *
 * TASK-659 added seven loop-config fields to `DepartmentAgent` and deliberately
 * did NOT propagate them in `clone()`, flagging the call for this ticket. The
 * consequence was silent: cloning an agent dropped its ENTIRE loop
 * configuration with no error. Promotion is the feature that copies agents, so
 * the two copy paths must agree on what an agent IS.
 *
 * Also pins the 404-over-403 cross-tenant posture (C5) on the same service, as
 * a regression guard for the new cross-tenant surface landing beside it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { DepartmentAgentService } from '../departmentAgent.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockAgentRepository = {
  findById: vi.fn(),
  isSlugUnique: vi.fn(),
  create: vi.fn(),
  findPrimaryForDepartment: vi.fn(),
};
const mockDepartmentRepository = { findById: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), create: vi.fn() };
const mockPromptVersionRepository = { create: vi.fn() };
const mockAgentVersionRepository = { findLatestForAgent: vi.fn(), create: vi.fn() };

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    DepartmentAgentFactory: {
      CreateDepartmentAgent: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'clone-id', createdAt: new Date(), version: 1 })),
    },
    DepartmentAgentVersionFactory: {
      CreateDepartmentAgentVersion: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'clone-version-id' })),
    },
    PromptTemplateFactory: { CreatePromptTemplate: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'cloned-tpl' })) },
    PromptVersionFactory: { CreatePromptVersion: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'cloned-v1' })) },
  };
});

/** A source agent with a FULLY configured loop surface. */
const configuredSource = (overrides: Record<string, unknown> = {}) => ({
  id: 'agent-1',
  tenantId: 'tenant-1',
  departmentId: 'dept-1',
  name: 'Cardiology SOAP',
  slug: 'cardiology-soap',
  description: 'the original',
  promptTemplateId: 'tpl-1',
  pinnedVersionNumber: 2,
  dnaStylePolicy: 'INHERIT',
  harnessOverrides: { maxRegen: 2 },
  goldenSetId: 'golden-1',
  newPatientTemplateId: 'tpl-np',
  revisitTemplateId: null,
  preSummaryTemplateId: null,
  livePromptTemplateId: null,
  toolConfig: { version: 1, tools: { ner: { enabled: true } } },
  llmOverrides: null,
  templateLocked: false,
  sourceAgentTemplateSlug: 'golden-slug',
  tags: ['cardio'],
  role: 'PRIMARY',
  subscribedKinds: { version: 1, kinds: [{ key: 'referral_letter' }] },
  writeScope: { version: 1, outputs: ['soap_note'] },
  goal: { version: 1, objective: 'Draft an accurate SOAP note' },
  guardrailProfile: 'STRICT',
  alwaysActions: ['harness.finalize'],
  neverActions: ['client.emit'],
  ...overrides,
});

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
    undefined, // contextSchemaRepository
    undefined, // contextSchemaVersionRepository
  );
}

describe('DepartmentAgentService.clone — TASK-663 (closing the TASK-659 §4.5 gap)', () => {
  let service: DepartmentAgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : { id: 'user-1' }));
    mockAgentRepository.findById.mockResolvedValue(configuredSource());
    mockAgentRepository.isSlugUnique.mockResolvedValue(true);
    mockAgentRepository.create.mockImplementation(async (e: unknown) => e);
    mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-1', tenantId: 'tenant-1', name: 'T', content: 'body', tags: [] });
    mockPromptTemplateRepository.create.mockImplementation(async (e: unknown) => e);
    mockPromptVersionRepository.create.mockImplementation(async (e: unknown) => e);
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockAgentVersionRepository.create.mockImplementation(async (e: unknown) => e);

    service = buildService();
  });

  const cloneDto = { name: 'Cardiology SOAP (mine)', slug: 'cardiology-soap-mine' };

  it('carries the six non-role loop-config fields onto the clone', async () => {
    await service.clone('agent-1', cloneDto);

    const created = mockAgentRepository.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created.subscribedKinds).toEqual({ version: 1, kinds: [{ key: 'referral_letter' }] });
    expect(created.writeScope).toEqual({ version: 1, outputs: ['soap_note'] });
    expect(created.goal).toEqual({ version: 1, objective: 'Draft an accurate SOAP note' });
    expect(created.guardrailProfile).toBe('STRICT');
    expect(created.alwaysActions).toEqual(['harness.finalize']);
    expect(created.neverActions).toEqual(['client.emit']);
  });

  it('forces role to SPECIALIST — a clone lands in the SAME department as its source', async () => {
    // If the source is that department's PRIMARY, a PRIMARY clone would violate
    // the one-PRIMARY-per-department invariant by construction. No query is
    // needed to know this, which is why clone (unlike promotion) does not run
    // the PRIMARY check at all.
    await service.clone('agent-1', cloneDto);

    const created = mockAgentRepository.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created.role).toBe('SPECIALIST');
    expect(mockAgentRepository.findPrimaryForDepartment).not.toHaveBeenCalled();
  });

  it('writes an immutable configuration version for the clone', async () => {
    // Without this a cloned agent would carry a configuration but no immutable
    // version, and would therefore be unpromotable — promotion copies a
    // VERSION, never a live row.
    await service.clone('agent-1', cloneDto);

    expect(mockAgentVersionRepository.create).toHaveBeenCalledTimes(1);
    const version = mockAgentVersionRepository.create.mock.calls[0][0] as Record<string, unknown>;
    expect(version.agentId).toBe('clone-id');
    expect(version.versionNumber).toBe(1);
    expect((version.configSnapshot as Record<string, unknown>).guardrailProfile).toBe('STRICT');
    expect((version.configSnapshot as Record<string, unknown>).role).toBe('SPECIALIST');
  });

  it('writes NO configuration version when the source has nothing configured (regression)', async () => {
    mockAgentRepository.findById.mockResolvedValue(
      configuredSource({
        role: 'SPECIALIST',
        subscribedKinds: null,
        writeScope: null,
        goal: null,
        guardrailProfile: null,
        alwaysActions: null,
        neverActions: null,
      }),
    );

    await service.clone('agent-1', cloneDto);

    expect(mockAgentVersionRepository.create).not.toHaveBeenCalled();
  });

  it('still does NOT carry the fields a clone must not inherit (regression)', async () => {
    await service.clone('agent-1', cloneDto);

    const created = mockAgentRepository.create.mock.calls[0][0] as Record<string, unknown>;
    // The clone tracks the latest of ITS OWN new template.
    expect(created.pinnedVersionNumber).toBeNull();
    // The copy is the customizable one, whatever the source is.
    expect(created.templateLocked).toBe(false);
    // Its own fresh DRAFT template, not the source's.
    expect(created.promptTemplateId).toBe('cloned-tpl');
  });
});

describe('DepartmentAgentService — 404-over-403 cross-tenant posture (C5 regression)', () => {
  let service: DepartmentAgentService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : { id: 'user-1' }));
    service = buildService();
  });

  it('a cross-tenant agent read returns 404, never 403 — outside a promotion nothing changed', async () => {
    mockAgentRepository.findById.mockResolvedValue(configuredSource({ tenantId: 'someone-else' }));

    await expect(service.getById('agent-1')).rejects.toThrow(NotFoundException);
  });

  it('a cross-tenant agent clone returns 404, never 403', async () => {
    mockAgentRepository.findById.mockResolvedValue(configuredSource({ tenantId: 'someone-else' }));

    await expect(service.clone('agent-1', { name: 'x', slug: 'x' })).rejects.toThrow(NotFoundException);
    expect(mockAgentRepository.create).not.toHaveBeenCalled();
  });

  it('a missing agent is indistinguishable from a cross-tenant one', async () => {
    mockAgentRepository.findById.mockResolvedValue(null);
    const missing = await service.getById('nope').catch((e: Error) => e);

    mockAgentRepository.findById.mockResolvedValue(configuredSource({ tenantId: 'someone-else' }));
    const foreign = await service.getById('agent-1').catch((e: Error) => e);

    expect((missing as Error).constructor).toBe((foreign as Error).constructor);
  });
});
