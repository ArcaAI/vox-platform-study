/**
 * TASK-1057 — prompt-template create / update / approve consult the platform action-confirmation
 * policy BEFORE mutating, and record the audit stamp even when nothing was required.
 */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptManagementService } from '../prompt-management.service';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';

const TENANT = 'tenant-1';

const cls = {
  get: vi.fn((key: string) => {
    if (key === 'user') return { id: 'admin-1', roles: [] };
    if (key === 'tenantId') return TENANT;
    if (key === 'userAbility') return { can: () => true };
    return null;
  }),
  set: vi.fn(),
};
const events = { emit: vi.fn() };
const tx = { __tx: true };
const databaseService = { baseClient: { $transaction: vi.fn(async (work: (t: unknown) => unknown) => work(tx)) } };
const templateRepo = { findById: vi.fn(), findByName: vi.fn(), create: vi.fn(), updateWithVersion: vi.fn() };
const versionRepo = {
  findLatestVersion: vi.fn(async () => null),
  findMaxVersionNumber: vi.fn(async () => 1),
  create: vi.fn(async (v: unknown) => v),
};
const registry = {
  screenAndRegister: vi.fn(async () => ({ passed: true, policyVersion: 'pv', digests: [], findings: [] })),
};

/** The REAL policy service over a fake settings resolver — `mode` undefined = no SYSTEM row = code default. */
function confirmations(mode?: string) {
  return new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never, {} as never, {} as never, {} as never);
}

function template() {
  return {
    id: 'tpl-1',
    tenantId: TENANT,
    name: 'SOAP',
    description: null,
    content: 'Summarise.',
    category: 'SYSTEM',
    status: 'DRAFT',
    variables: null,
    currentVersionNumber: 1,
    approvedVersionNumber: null,
    departmentId: null,
    scope: 'TENANT_DEFAULT',
    ownerUserId: null,
    tags: [],
    resourceStatus: 'ENABLED',
    version: 2,
    createdAt: new Date(),
    updatedAt: new Date(),
    incrementVersion: vi.fn(),
    hasChanges: true,
  };
}

function makeService(policy: ActionConfirmationService) {
  const positional: unknown[] = [templateRepo, versionRepo, {}, {}, events, cls, databaseService, ...Array.from({ length: 12 }, () => undefined), registry, policy];
  const service = new (PromptManagementService as unknown as new (...args: unknown[]) => PromptManagementService)(...positional);
  const broadcast = vi.spyOn(service as never, 'broadcastSysEvent');
  return { service, broadcast: broadcast as unknown as ReturnType<typeof vi.fn> };
}

const createDto = { name: 'New', content: 'Body', category: 'CUSTOM' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  templateRepo.findById.mockResolvedValue(template());
  templateRepo.findByName.mockResolvedValue(null);
  templateRepo.create.mockImplementation(async () => ({ ...template(), id: 'tpl-new', name: 'New' }));
  templateRepo.updateWithVersion.mockImplementation(async (_id: string, entity: unknown) => ({ ...(entity as object), version: 3 }));
});

describe('promptTemplate.create', () => {
  it('passes without a reason under the default policy and stamps "not required"', async () => {
    const { service, broadcast } = makeService(confirmations());
    await service.createPromptTemplate(createDto);
    expect(templateRepo.create).toHaveBeenCalled();
    expect(broadcast.mock.calls[0][1].data.confirmation).toMatchObject({ actionId: 'promptTemplate.create', required: false, note: 'reason not required' });
  });

  it('refuses 400 CONFIRMATION_REQUIRED before any write when required and missing', async () => {
    const { service } = makeService(confirmations('required'));
    const error = await service.createPromptTemplate(createDto).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'promptTemplate.create' });
    expect(templateRepo.create).not.toHaveBeenCalled();
    expect(versionRepo.create).not.toHaveBeenCalled();
  });

  it('persists a supplied changeReason on version 1', async () => {
    const { service } = makeService(confirmations('required'));
    await service.createPromptTemplate({ ...(createDto as object), changeReason: 'Seed for oncology' } as never);
    expect(versionRepo.create.mock.calls[0][0]).toMatchObject({ changeReason: 'Seed for oncology' });
  });
});

describe('promptTemplate.update', () => {
  const updateDto = { content: 'Changed', expectedVersion: 2 } as never;

  it('passes without a reason under the default policy and stamps "not required"', async () => {
    const { service, broadcast } = makeService(confirmations());
    await service.updatePromptTemplate('tpl-1', updateDto);
    expect(broadcast.mock.calls[0][1].data.confirmation).toMatchObject({ actionId: 'promptTemplate.update', required: false });
  });

  it('refuses 400 CONFIRMATION_REQUIRED before any write when required and missing', async () => {
    const { service } = makeService(confirmations('required'));
    const error = await service.updatePromptTemplate('tpl-1', updateDto).catch((caught: unknown) => caught);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'promptTemplate.update' });
    expect(databaseService.baseClient.$transaction).not.toHaveBeenCalled();
    expect(templateRepo.updateWithVersion).not.toHaveBeenCalled();
  });
});

describe('promptTemplate.approve', () => {
  const approveDto = { expectedVersion: 2 } as never;

  it('passes without a reason under the default policy and stamps "not required"', async () => {
    const { service, broadcast } = makeService(confirmations());
    await service.approveTemplate('tpl-1', approveDto);
    expect(broadcast.mock.calls[0][1].data.confirmation).toMatchObject({ actionId: 'promptTemplate.approve', required: false });
  });

  it('refuses 400 CONFIRMATION_REQUIRED before any write when required and missing', async () => {
    const { service } = makeService(confirmations('required'));
    const error = await service.approveTemplate('tpl-1', approveDto).catch((caught: unknown) => caught);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'promptTemplate.approve' });
    expect(databaseService.baseClient.$transaction).not.toHaveBeenCalled();
    expect(registry.screenAndRegister).not.toHaveBeenCalled();
  });
});
