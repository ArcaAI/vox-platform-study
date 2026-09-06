/**
 * TASK-890 L13 step iii — the prompt REFERENCE-LIBRARY reads and the clone lookup.
 *
 * `PromptTemplate` / `PromptVersion` leave `SYSTEM_SHARED_READ_MODELS` at step v, so the only
 * reads still allowed to see SYSTEM say so explicitly on the unscoped base client
 * (`WorkflowDefinitionRepository.findCloneSource` pattern), and every runtime read of a
 * `SYSTEM_DEFAULTS.*` pointer resolves the TENANT's clone through `sourceTemplateId` instead.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/database';
import { PromptTemplateRepository } from '../PromptTemplateRepository';
import { ResourceStatusType } from '../../../../enums';

function makeRepo() {
  const scoped = { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() };
  const unitOfWork = { getDatabaseService: () => ({ promptTemplate: scoped }) };
  const base = { promptTemplate: { findFirst: vi.fn(), findMany: vi.fn() } };
  return { scoped, base, repo: new PromptTemplateRepository(unitOfWork as never) };
}

const systemRow = { id: 'sys-1', tenantId: SYSTEM_TENANT_ID, name: 'CATCHALL_SOAP', category: 'SYSTEM', resourceStatus: ResourceStatusType.ENABLED };

describe('PromptTemplateRepository reference reads (TASK-890)', () => {
  let scoped: ReturnType<typeof makeRepo>['scoped'];
  let base: ReturnType<typeof makeRepo>['base'];
  let repo: PromptTemplateRepository;
  beforeEach(() => ({ scoped, base, repo } = makeRepo()));

  it('findSystemReferenceById pins SYSTEM on the supplied unscoped client and never touches the scoped delegate', async () => {
    base.promptTemplate.findFirst.mockResolvedValue(systemRow);
    const found = await repo.findSystemReferenceById('sys-1', base);
    expect(found?.id).toBe('sys-1');
    expect(scoped.findFirst).not.toHaveBeenCalled();
    expect(base.promptTemplate.findFirst.mock.calls[0][0].where).toEqual({
      id: 'sys-1',
      tenantId: SYSTEM_TENANT_ID,
      resourceStatus: ResourceStatusType.ENABLED,
    });
  });

  it('findSystemReferenceById answers null for an id that is not a SYSTEM row', async () => {
    base.promptTemplate.findFirst.mockResolvedValue(null);
    expect(await repo.findSystemReferenceById('tenant-owned', base)).toBeNull();
  });

  it('findSystemReferences lists the SYSTEM library on the unscoped client', async () => {
    base.promptTemplate.findMany.mockResolvedValue([systemRow]);
    expect((await repo.findSystemReferences(base)).map((r) => r.id)).toEqual(['sys-1']);
    expect(base.promptTemplate.findMany.mock.calls[0][0].where).toEqual({
      tenantId: SYSTEM_TENANT_ID,
      resourceStatus: ResourceStatusType.ENABLED,
    });
  });

  it('findByTenantAndSourceTemplateId resolves a tenant CLONE by provenance on the SCOPED client', async () => {
    scoped.findFirst.mockResolvedValue({ id: 'clone-1', tenantId: 'tenant-1', name: 'CATCHALL_SOAP', category: 'SYSTEM' });
    const clone = await repo.findByTenantAndSourceTemplateId('tenant-1', 'sys-1');
    expect(clone?.id).toBe('clone-1');
    expect(scoped.findFirst.mock.calls[0][0].where).toEqual({
      tenantId: 'tenant-1',
      sourceTemplateId: 'sys-1',
      resourceStatus: ResourceStatusType.ENABLED,
    });
  });

  it('findByTenantAndSourceTemplateId answers null — never throws — when the tenant has no clone', async () => {
    scoped.findFirst.mockResolvedValue(null);
    expect(await repo.findByTenantAndSourceTemplateId('tenant-1', 'sys-1')).toBeNull();
    scoped.findFirst.mockRejectedValue(new Error('boom'));
    expect(await repo.findByTenantAndSourceTemplateId('tenant-1', 'sys-1')).toBeNull();
  });
});
