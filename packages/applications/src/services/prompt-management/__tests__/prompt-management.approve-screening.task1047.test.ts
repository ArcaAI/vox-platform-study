/**
 * TASK-1047 D2 / OD-4 — PromptTemplate APPROVE screens the template body once, at authoring time.
 *
 *  - The pointer-rendered body is screened under the TEMPLATE's tenant before anything is written.
 *  - Any finding refuses the approval (no override): 409 for a verdict on the content, 503 when
 *    guardrail could not answer (fail closed). Nothing is pinned, no version is minted.
 *  - A clean body approves exactly as before.
 */
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptManagementService } from '../prompt-management.service';

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
const templateRepo = { findById: vi.fn(), updateWithVersion: vi.fn() };
const versionRepo = {
  findLatestVersion: vi.fn(async () => null),
  findMaxVersionNumber: vi.fn(async () => 1),
  create: vi.fn(async (v: unknown) => v),
};
const registry = { screenAndRegister: vi.fn(), areGoverned: vi.fn(), currentPolicyVersion: vi.fn(), registerPlatformPieces: vi.fn() };

function template() {
  return {
    id: 'tpl-1',
    tenantId: TENANT,
    name: 'SOAP',
    description: null,
    content: 'Summarise {{transcript}} as SOAP.',
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
  };
}

function makeService() {
  const positional: unknown[] = [
    templateRepo,
    versionRepo,
    {},
    {},
    events,
    cls,
    databaseService,
    ...Array.from({ length: 12 }, () => undefined),
    registry,
  ];
  return new (PromptManagementService as unknown as new (...args: unknown[]) => PromptManagementService)(...positional);
}

const refused = (code: string) => ({
  passed: false,
  policyVersion: 'pv-1',
  digests: ['d'],
  findings: [{ code, pieceKind: 'TEMPLATE_BODY', pieceKey: 'body', digest: 'd'.repeat(64), reason: 'r' }],
});

beforeEach(() => {
  vi.clearAllMocks();
  templateRepo.findById.mockResolvedValue(template());
  templateRepo.updateWithVersion.mockImplementation(async (_id: string, entity: unknown) => ({ ...(entity as object), version: 3 }));
});

describe('approveTemplate — authoring-time screening (OD-4)', () => {
  it('screens the pointer-rendered body under the template tenant, then approves a clean body', async () => {
    registry.screenAndRegister.mockResolvedValue({ passed: true, policyVersion: 'pv-1', digests: ['d'], findings: [] });
    const result = await makeService().approveTemplate('tpl-1', { expectedVersion: 2 } as never);
    expect(registry.screenAndRegister).toHaveBeenCalledWith(TENANT, [
      {
        kind: 'TEMPLATE_BODY',
        sourceType: 'PROMPT_VERSION',
        sourceId: 'tpl-1',
        sourceKey: 'body',
        text: 'Summarise [see the transcript data section below] as SOAP.',
      },
    ]);
    expect(result.status).toBe('APPROVED');
    expect(templateRepo.updateWithVersion).toHaveBeenCalled();
  });

  it.each(['PROMPT_SCREENING_INJECTION', 'PROMPT_SCREENING_UNSAFE', 'PROMPT_CONTAINS_PII'])(
    '%s refuses approval with 409 and writes nothing',
    async (code) => {
      registry.screenAndRegister.mockResolvedValue(refused(code));
      const error = await makeService()
        .approveTemplate('tpl-1', { expectedVersion: 2 } as never)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        reason: 'PROMPT_SCREENING_REFUSED',
        code,
        findings: [expect.objectContaining({ code })],
      });
      expect(databaseService.baseClient.$transaction).not.toHaveBeenCalled();
      expect(templateRepo.updateWithVersion).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    },
  );

  it('guardrail down refuses approval with 503 PROMPT_SCREENING_UNAVAILABLE (fail closed)', async () => {
    registry.screenAndRegister.mockResolvedValue(refused('PROMPT_SCREENING_UNAVAILABLE'));
    const error = await makeService()
      .approveTemplate('tpl-1', { expectedVersion: 2 } as never)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'PROMPT_SCREENING_UNAVAILABLE' });
    expect(templateRepo.updateWithVersion).not.toHaveBeenCalled();
  });
});
