/**
 * TASK-889 — the sync DATA path, proven against the REAL tenant-scope extension and no database.
 *
 * ## What is actually under test
 *
 * Both syncs were already authorised correctly (`manage` in the source AND in every target, from
 * `UserRoleAssignment` through `PolicyEngine`) and both were already tested at the service with
 * mocked repositories. What no test could see is the layer BELOW the repositories: the
 * tenant-scope `$extends`, which merges the CLS tenant into every scoped `where` and throws
 * `TenantScope: tenantId mismatch` when a scoped write names a different one. A sync is a
 * sequence of steps that each mean a DIFFERENT tenant, so mocked repositories will happily
 * "work" while the real client would refuse — or, worse, silently answer for the wrong tenant.
 *
 * So this file wires the real `applyTenantScopeExtension` (`@arcaai/database`) over a stub Prisma
 * client, drives its `getTenantId` from the SAME fake CLS the services drive, and points the
 * repository stubs at it. Every assertion below is therefore about args the extension actually
 * produced, not about a mock's call log.
 *
 * | Claim | How it is proven |
 * |---|---|
 * | (a) the source read carries the SOURCE tenant | a stub finder issues a `where` with NO tenant; the extension's injected value is read back |
 * | (b) each target write carries THAT target's tenant | the same, per target, in order — and a step that named the wrong tenant would throw, not mis-record |
 * | (c) a target outside the caller's memberships is never touched | the 404 lands with an EMPTY query log |
 * | (d) a super admin still works | the same run with `SUPER_ADMIN` and no pinned working tenant |
 *
 * Written RED-first: (a)/(b)/(d) failed for `WorkflowDefinitionService` against `dbdf15cb7`,
 * where `syncToTenants` still demanded an elevated tenant-less context and every target step
 * inherited the caller's own tenant.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { applyTenantScopeExtension } from '@arcaai/database';
import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentService } from '../../agent/agent.service';
import { WorkflowDefinitionService } from '../../workflow-definition/workflow-definition.service';

const SOURCE = '50000000-0000-0000-0000-0000000000a1';
const TARGET_ONE = '50000000-0000-0000-0000-0000000000b1';
const TARGET_TWO = '50000000-0000-0000-0000-0000000000c1';
const UNMANAGED = '50000000-0000-0000-0000-0000000000d1';

// ---------------------------------------------------------------------------------------------
// A CLS that behaves like the real one for the ONE thing this file depends on: `run` opens a
// nested store that INHERITS the parent's and can be given its own `tenantId`, and unwinds on the
// way out. Anything less would make `runInTenantContext` untestable by construction.
// ---------------------------------------------------------------------------------------------
function makeCls(initial: Record<string, unknown>) {
  const stack: Record<string, unknown>[] = [{ ...initial }];
  const top = () => stack[stack.length - 1]!;
  return {
    get: vi.fn((key?: string) => (key === undefined ? top() : top()[key])),
    set: vi.fn((key: string, value: unknown) => {
      top()[key] = value;
    }),
    run: vi.fn(async (optionsOrCallback: unknown, maybeCallback?: unknown) => {
      const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as () => Promise<unknown>;
      stack.push({ ...top() });
      try {
        return await callback();
      } finally {
        stack.pop();
      }
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// The stub Prisma client, wrapped in the REAL extension. Each delegate call records the args the
// extension handed downstream — i.e. the tenant it decided this call belongs to.
// ---------------------------------------------------------------------------------------------
type ScopedQuery = { model: string; op: string; tenantId: unknown };

function makeScopedClient(cls: { get: (key?: string) => unknown }) {
  const log: ScopedQuery[] = [];
  let config!: { query: { $allModels: Record<string, (params: unknown) => Promise<unknown>> } };
  const prisma = {
    $extends: (given: unknown) => {
      config = given as typeof config;
      return prisma;
    },
  };
  applyTenantScopeExtension(prisma as never, {
    getTenantId: () => cls.get('tenantId') as string | null | undefined,
    isSuperAdmin: () => Boolean((cls.get('user') as { roles?: string[] } | undefined)?.roles?.includes('SUPER_ADMIN')),
  });

  /** Issue one extension-mediated call. `result` is what the "database" would have returned. */
  async function call(model: string, op: string, args: Record<string, unknown>, result: unknown): Promise<unknown> {
    const handler = config.query.$allModels[op];
    if (!handler) throw new Error(`the extension declares no handler for ${op}`);
    return handler({
      model,
      args,
      query: async (finalArgs: unknown) => {
        const scoped = finalArgs as { where?: Record<string, unknown>; data?: Record<string, unknown> };
        log.push({ model, op, tenantId: scoped.where?.tenantId ?? scoped.data?.tenantId });
        return result;
      },
    });
  }

  return { call, log };
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
const PLAIN_GRAPH = { version: 1, nodes: [{ id: 'n1', type: 'noop', config: {} }], edges: [] };

const workflowRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: SOURCE,
  slug: 'soap',
  name: 'SOAP',
  description: null,
  paletteKey: 'summarization',
  versionNumber: 2,
  parentVersionId: null,
  graph: PLAIN_GRAPH,
  graphChecksum: 'sha256:g',
  compiledConfig: null,
  compiledConfigChecksum: null,
  registryChecksum: null,
  validationReport: null,
  validatedAt: null,
  status: WorkflowDefinitionStatus.PUBLISHED,
  isActive: true,
  publishedAt: new Date(),
  deprecatedAt: null,
  resourceStatus: ResourceStatusType.ENABLED,
  tags: [],
  version: 1,
  hasChanges: false,
  changes: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const agentRow = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'agent-1',
    tenantId: SOURCE,
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: null,
    task: AgentTask.TEXT_GENERATION,
    versionNumber: 3,
    parentVersionId: null,
    status: WorkflowDefinitionStatus.PUBLISHED,
    isActive: true,
    modelId: 'model-llm',
    instruction: { systemPrompt: 'scribe' },
    parameters: null,
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: null,
    compiledConfigChecksum: null,
    validationReport: null,
    validatedAt: null,
    publishedAt: new Date(),
    deprecatedAt: null,
    resourceStatus: ResourceStatusType.ENABLED,
    tags: [],
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    updatedBy: null,
    ...overrides,
  }) as never;

const MODEL = {
  id: 'model-llm',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'lms-gemma-4-e2b-it-qat',
  taskType: 'TEXT_GENERATION',
  provider: 'lm-studio',
  localPath: null,
  resourceStatus: ResourceStatusType.ENABLED,
  metaData: null,
};

// ---------------------------------------------------------------------------------------------
describe('the sync data path is membership-bounded, not elevated (TASK-889)', () => {
  describe('WorkflowDefinitionService.syncToTenants', () => {
    let cls: ReturnType<typeof makeCls>;
    let scoped: ReturnType<typeof makeScopedClient>;
    let service: WorkflowDefinitionService;
    let created: { tenantId: string }[];

    function construct(managed: string[]) {
      created = [];
      scoped = makeScopedClient(cls);

      // The repository stubs issue REAL extension-mediated calls with NO tenant in the `where`,
      // so what comes back in the log is the tenant the extension decided the step belongs to.
      const repository = {
        findPublishedBySlug: vi.fn(async (tenantId: string, slug: string) => {
          await scoped.call('WorkflowDefinition', 'findFirst', { where: { slug } }, null);
          return workflowRow({ tenantId, slug });
        }),
        findAllVersionsBySlug: vi.fn(async () => []),
        findMaxVersionNumber: vi.fn(async () => 0),
        create: vi.fn(async (entity: { tenantId: string }) => {
          await scoped.call('WorkflowDefinition', 'create', { data: { tenantId: entity.tenantId } }, entity);
          created.push(entity);
          return entity;
        }),
        findById: vi.fn(),
        count: vi.fn(async () => 0),
        update: vi.fn(),
      };

      // Positional, mirroring `workflow-definition.sync-promotion.task885.test.ts`: only the
      // repository, CLS, database, prompt-template and policy slots matter here.
      service = new WorkflowDefinitionService(
        repository as never,
        { emit: vi.fn() } as never,
        cls as never,
        { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } } as never,
        { isEnforcementEnabled: () => false, assertQuantityQuota: vi.fn(), isFeatureEnabled: async () => true } as never,
        undefined,
        undefined,
        { findById: vi.fn(async () => null), findByName: vi.fn(async () => null) } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { buildAbility: vi.fn(async ({ tenantId }: { tenantId: string }) => ({ can: () => managed.includes(tenantId) })) } as never,
      );
      return service;
    }

    beforeEach(() => {
      // A TENANT admin, pinned to their own working tenant — the person owner #4 names, and the
      // one the elevated gate used to turn away.
      cls = makeCls({ tenantId: SOURCE, user: { id: 'admin-1', roles: ['TENANT_ADMIN'] } });
    });

    it('(a,b) reads the source under the SOURCE tenant and writes each target under THAT target', async () => {
      construct([SOURCE, TARGET_ONE, TARGET_TWO]);

      const result = await service.syncToTenants('soap', { sourceTenantId: SOURCE, targetTenantIds: [TARGET_ONE, TARGET_TWO] });

      expect(result.targets.map((target) => target.tenantId)).toEqual([TARGET_ONE, TARGET_TWO]);
      expect(scoped.log.filter((entry) => entry.op === 'findFirst').map((entry) => entry.tenantId)).toEqual([SOURCE]);
      expect(scoped.log.filter((entry) => entry.op === 'create').map((entry) => entry.tenantId)).toEqual([TARGET_ONE, TARGET_TWO]);
      expect(created.map((row) => row.tenantId)).toEqual([TARGET_ONE, TARGET_TWO]);
      // The caller's own pinned tenant is restored — a sync must not leave the request standing
      // in the last tenant it wrote.
      expect(cls.get('tenantId')).toBe(SOURCE);
    });

    it('(c) never queries a tenant the caller does not manage — the 404 lands with an empty query log', async () => {
      construct([SOURCE, TARGET_ONE]);

      await expect(service.syncToTenants('soap', { sourceTenantId: SOURCE, targetTenantIds: [TARGET_ONE, UNMANAGED] })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(scoped.log).toEqual([]);
    });

    it('(d) a super admin with no pinned working tenant still syncs', async () => {
      cls = makeCls({ tenantId: null, user: { id: 'root-1', roles: ['SUPER_ADMIN'] } });
      construct([SOURCE, TARGET_ONE]);

      const result = await service.syncToTenants('soap', { sourceTenantId: SOURCE, targetTenantIds: [TARGET_ONE] });

      expect(result.targets.map((target) => target.tenantId)).toEqual([TARGET_ONE]);
      // Even elevated, each step is PINNED rather than passed through: the source read is filtered
      // to the source, not served the whole estate.
      expect(scoped.log.filter((entry) => entry.op === 'findFirst').map((entry) => entry.tenantId)).toEqual([SOURCE]);
      expect(scoped.log.filter((entry) => entry.op === 'create').map((entry) => entry.tenantId)).toEqual([TARGET_ONE]);
    });
  });

  describe('AgentService.syncToTenants', () => {
    let cls: ReturnType<typeof makeCls>;
    let scoped: ReturnType<typeof makeScopedClient>;
    let service: AgentService;

    function construct(managed: string[]) {
      scoped = makeScopedClient(cls);

      const agentRepository = {
        findAllVersionsBySlug: vi.fn(async (tenantId: string, slug: string) => {
          await scoped.call('Agent', 'findMany', { where: { slug } }, null);
          return [agentRow({ tenantId, slug })];
        }),
        findMaxVersionNumber: vi.fn(async () => 0),
        create: vi.fn(async (entity: unknown) => entity),
        findPublishedActiveBySlug: vi.fn(async () => null),
        findPublishedVisibleBySlugVersion: vi.fn(async () => null),
      };
      // The ONE scoped read inside the copy: the SOURCE agent's fallback chain. Under a target's
      // context it would answer for the target and the chain would silently vanish — which is why
      // the sync hoists it into the source step.
      const fallbackRepository = {
        findByAgentId: vi.fn(async () => {
          await scoped.call('AgentModelFallback', 'findMany', { where: { agentId: 'agent-1' } }, null);
          return [];
        }),
        create: vi.fn(async (entity: unknown) => entity),
      };

      service = new AgentService(
        agentRepository as never,
        fallbackRepository as never,
        { findByIdOrNull: vi.fn(async () => MODEL), findBySlug: vi.fn(async () => null), findById: vi.fn(async () => MODEL) } as never,
        { emit: vi.fn() } as never,
        cls as never,
        { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } } as never,
        { resolve: vi.fn() } as never,
        { resolveConnection: vi.fn(), resolveTenantCloudOverrides: vi.fn() } as never,
        { findById: vi.fn(async () => null), findByName: vi.fn(async () => null) } as never,
        { findByVersionNumber: vi.fn() } as never,
        { buildAbility: vi.fn(async ({ tenantId }: { tenantId: string }) => ({ can: () => managed.includes(tenantId) })) } as never,
        { findEnabledById: vi.fn(async () => null) } as never,
      );
      return service;
    }

    beforeEach(() => {
      cls = makeCls({ tenantId: SOURCE, user: { id: 'admin-1', roles: ['TENANT_ADMIN'] } });
    });

    it('(a,b) reads the source — including its fallback chain — under the SOURCE tenant, then writes each target under THAT target', async () => {
      construct([SOURCE, TARGET_ONE, TARGET_TWO]);

      const result = await service.syncToTenants('clinic-summarizer', { targetTenantIds: [TARGET_ONE, TARGET_TWO] });

      expect(result.targets.map((target) => target.tenantId)).toEqual([TARGET_ONE, TARGET_TWO]);
      // TWO scoped reads, both in the SOURCE step, and the fallback chain read ONCE rather than
      // once per target — which is what makes it safe for the target steps to name their own
      // tenant. BOTH are pinned to the SOURCE: TASK-890 step v removed `Agent` from
      // `SYSTEM_SHARED_READ_MODELS`, so a sync reads exactly the tenant it names — which is what
      // "membership-bounded" claimed all along and is now literally true of every read here.
      expect(scoped.log.map((entry) => entry.model)).toEqual(['Agent', 'AgentModelFallback']);
      expect(scoped.log[0]!.tenantId).toBe(SOURCE);
      expect(scoped.log[1]!.tenantId).toBe(SOURCE);
      expect(cls.get('tenantId')).toBe(SOURCE);
    });

    it('(c) never queries a tenant the caller does not manage', async () => {
      construct([SOURCE, TARGET_ONE]);

      await expect(service.syncToTenants('clinic-summarizer', { targetTenantIds: [TARGET_ONE, UNMANAGED] })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(scoped.log.some((entry) => entry.tenantId === UNMANAGED)).toBe(false);
    });
  });
});
