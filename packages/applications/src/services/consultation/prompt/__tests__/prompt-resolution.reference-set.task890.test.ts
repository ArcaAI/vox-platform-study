/**
 * TASK-890 §3.4 (OD-M) — a `SYSTEM_DEFAULTS.*` pointer resolves the TENANT's CLONE.
 *
 * Before this ticket the four `SYSTEM_DEFAULTS.*` ids were read directly, and they resolved only
 * because `PromptTemplate` / `PromptVersion` were `SYSTEM_SHARED_READ_MODELS` members — a by-id
 * widening that served the PLATFORM's row to every tenant. A prompt is CONTENT (§1.5): the
 * platform library is a REFERENCE SET, each tenant is provisioned with its own copy stamped
 * `sourceTemplateId`, and that copy is what "the system default" means at runtime. A tenant
 * without one is told so by name — it is never quietly served somebody else's row.
 *
 * The three chains differ in what "no clone" MEANS, and that difference is deliberate:
 *  - the summary chain has nothing below its default tier → fail CLOSED, named;
 *  - the pre-summary chain already fails closed one tier lower → the tier is simply absent;
 *  - the live chain fails OPEN to byte-identical in-code constants → unchanged, by design.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptResolutionService, SYSTEM_DEFAULTS } from '../prompt-resolution.service';

const TENANT = '50000000-0000-0000-0000-000000000000';
const CLONE_ID = '9c2f6c2a-0000-4000-8000-000000000001';

const departmentRepository = { findById: vi.fn() };
const promptTemplateRepository = { findById: vi.fn(), findAll: vi.fn(), findByTenantAndSourceTemplateId: vi.fn() };
const promptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };
const workflowAssignments = { resolve: vi.fn() };
const workflowDefinitionRepository = { findPublishedBySlug: vi.fn() };

/** The two sibling chains are private; drive them the way `resolve()` does, with a fresh trace. */
const trace = () => ({ usedDefaults: [] }) as any;

function make(): PromptResolutionService {
  return new PromptResolutionService(
    departmentRepository as never,
    promptTemplateRepository as never,
    promptVersionRepository as never,
    workflowAssignments as never,
    workflowDefinitionRepository as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  departmentRepository.findById.mockResolvedValue(null);
  promptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED', content: 'body' }));
  promptTemplateRepository.findAll.mockResolvedValue([]);
  promptVersionRepository.findByVersionNumber.mockResolvedValue(null);
  workflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' });
  workflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
});

describe('the summary chain`s default tier', () => {
  it('serves the TENANT`s clone, resolved by provenance — never the SYSTEM row', async () => {
    promptTemplateRepository.findByTenantAndSourceTemplateId.mockResolvedValue({ id: CLONE_ID });

    const result = await make().resolve({ tenantId: TENANT });

    expect(result.resolvedFrom).toBe('default');
    expect(result.promptId).toBe(CLONE_ID);
    expect(result.promptId).not.toBe(SYSTEM_DEFAULTS.promptId);
    expect(promptTemplateRepository.findByTenantAndSourceTemplateId).toHaveBeenCalledWith(TENANT, SYSTEM_DEFAULTS.promptId);
  });

  it('fails CLOSED with PROMPT_DEFAULT_NOT_PROVISIONED when the tenant has no clone, naming the pointer and the remedy', async () => {
    promptTemplateRepository.findByTenantAndSourceTemplateId.mockResolvedValue(null);

    const error = await make()
      .resolve({ tenantId: TENANT })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const body = (error as ServiceUnavailableException).getResponse() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'PROMPT_DEFAULT_NOT_PROVISIONED', sourceTemplateId: SYSTEM_DEFAULTS.promptId, tenantId: TENANT });
    expect(String(body['message'])).toContain('reference-set/sync');
  });

  it('fails closed for a resolution that names NO tenant at all — an unattributable request cannot have a clone', async () => {
    promptTemplateRepository.findByTenantAndSourceTemplateId.mockResolvedValue(null);
    await expect(make().resolve({})).rejects.toBeInstanceOf(ServiceUnavailableException);
    // The lookup is not even attempted: there is no tenant to look one up for.
    expect(promptTemplateRepository.findByTenantAndSourceTemplateId).not.toHaveBeenCalled();
  });
});

describe('the pre-summary chain`s default tier', () => {
  it('serves the tenant`s clone of the pre-summary default', async () => {
    promptTemplateRepository.findByTenantAndSourceTemplateId.mockImplementation(async (_t: string, source: string) =>
      source === SYSTEM_DEFAULTS.preSummaryPromptId ? { id: CLONE_ID } : null,
    );
    const result = await (make() as any).resolvePreSummaryPromptId({ tenantId: TENANT }, null, trace());
    expect(result.promptId).toBe(CLONE_ID);
  });

  it('keeps its OWN fail-closed behaviour when the tenant has no clone — this tier is simply absent', async () => {
    promptTemplateRepository.findByTenantAndSourceTemplateId.mockResolvedValue(null);
    await expect((make() as any).resolvePreSummaryPromptId({ tenantId: TENANT }, null, trace())).rejects.toBeTruthy();
  });
});

describe('the live chain`s default tier', () => {
  it('serves the tenant`s clone when it has one', async () => {
    promptTemplateRepository.findByTenantAndSourceTemplateId.mockImplementation(async (_t: string, source: string) =>
      source === SYSTEM_DEFAULTS.livePromptId ? { id: CLONE_ID } : null,
    );
    promptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED', content: 'live body' }));
    const result = await (make() as any).resolveLivePromptId({ tenantId: TENANT }, null, trace());
    expect(result).toMatchObject({ promptId: CLONE_ID, tier: 'default' });
  });

  it('still fails OPEN to the in-code constants when the tenant has no clone — the documented live exception, unchanged', async () => {
    promptTemplateRepository.findByTenantAndSourceTemplateId.mockResolvedValue(null);
    const result = await (make() as any).resolveLivePromptId({ tenantId: TENANT }, null, trace());
    expect(result.tier).toBe('code-default');
  });
});
