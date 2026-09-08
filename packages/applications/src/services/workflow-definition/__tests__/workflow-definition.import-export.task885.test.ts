/**
 * TASK-885 (owner #4) — `WorkflowDefinitionService.exportDefinition` / `.importDefinition`.
 *
 * The pure rewrite is covered by `portable-graph.task885.test.ts`; this file covers the parts
 * that need a tenant, a catalogue and a lifecycle:
 *
 *   - a cross-tenant id is a 404, never a 403 (rule 04);
 *   - an export carries no row id, no credential and no derived artifact;
 *   - an import RESOLVES every reference against the CALLER's catalogue and, when it cannot,
 *     refuses the whole bundle with a 409 that NAMES the offenders — never a partial import and
 *     never a silently dropped binding;
 *   - an import lands DRAFT in a NEW lineage, with the report recomputed here.
 *
 * Written RED-first: every test in this file failed against `460e950c5`, where
 * `exportDefinition` / `importDefinition` did not exist.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { isPortableBundle, portableBundleProblems, PORTABLE_BUNDLE_SCHEMA_VERSION } from '@arcaai/workflow-contract';
import { WorkflowDefinitionService } from '../workflow-definition.service';
import type { WorkflowDefinitionBundle } from '../dto';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  findPublishedBySlug: vi.fn(),
  findAllVersionsBySlug: vi.fn(),
};

const mockDatabaseService = {
  baseClient: { $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({})) },
};

const mockEntitlements = {
  isEnforcementEnabled: vi.fn(() => false),
  assertQuantityQuota: vi.fn(),
  isFeatureEnabled: vi.fn(() => Promise.resolve(true)),
};

const mockPromptTemplateRepository = { findById: vi.fn(), findByName: vi.fn() };
const mockDocumentTemplateRepository = { findById: vi.fn(), findByTenantAndSlug: vi.fn() };
const mockMcpServerRepository = { findById: vi.fn(), findByTenantAndName: vi.fn() };
const mockAgentRepository = { findPublishedActiveBySlug: vi.fn() };
const mockAiModelRepository = { findBySlug: vi.fn() };
const mockRoutingPolicyService = { getById: vi.fn(), resolveDefault: vi.fn() };

/** A generation node bound to a prompt template BY ROW ID, with a pin and a PHI-pointing gate. */
const BOUND_GRAPH = {
  version: 1,
  nodes: [
    // TASK-893 — `prompt.template_ref` is an ACTION now; the walker rewrites nested config too.
    {
      id: 'n_gen',
      type: 'core.action',
      config: {
        actionKey: 'prompt.template_ref',
        action: { promptTemplateId: 'tpl-1', promptVersionNumber: 4, evalGate: { goldenSetId: 'gs-secret', enabled: true }, temperature: 0.3 },
      },
    },
  ],
  edges: [],
};

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'discharge_summary',
  name: 'Discharge Summary',
  description: 'The one we use',
  paletteKey: 'core',
  versionNumber: 3,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.PUBLISHED,
  graph: BOUND_GRAPH,
  graphChecksum: 'checksum-1',
  compiledConfig: { formatVersion: 1, secretish: 'derived' },
  compiledConfigChecksum: 'compiled-1',
  registryChecksum: 'registry-1',
  validationReport: { ok: true, findings: [] },
  needsReview: false,
  validatedAt: new Date('2026-09-01T00:00:00Z'),
  publishedAt: new Date('2026-09-01T00:00:00Z'),
  deprecatedAt: null,
  isActive: true,
  resourceStatus: 'ENABLED',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  version: 1,
  tags: ['clinical'],
  hasChanges: false,
  changes: {},
  ...overrides,
});

const bundle = (overrides: Partial<WorkflowDefinitionBundle> = {}): WorkflowDefinitionBundle =>
  ({
    kind: 'workflow',
    schemaVersion: 1,
    exportedAt: '2026-09-06T00:00:00.000Z',
    source: { tenantKind: 'tenant', slug: 'discharge_summary', version: 3 },
    payload: {
      name: 'Discharge Summary',
      description: 'The one we use',
      paletteKey: 'core',
      graph: {
        version: 1,
        nodes: [{ id: 'n_gen', type: 'core.action', config: { actionKey: 'prompt.template_ref', action: { promptTemplateRef: { name: 'Discharge Summary Prompt' } } } }],
        edges: [],
      },
      references: [{ nodeId: 'n_gen', kind: 'promptTemplate', key: 'Discharge Summary Prompt' }],
    },
    ...overrides,
  }) as WorkflowDefinitionBundle;

describe('WorkflowDefinitionService — workflow import/export (TASK-885)', () => {
  let service: WorkflowDefinitionService;

  const construct = () =>
    new WorkflowDefinitionService(
      mockRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDatabaseService as never,
      mockEntitlements as never,
      undefined,
      undefined,
      mockPromptTemplateRepository as never,
      undefined,
      undefined,
      mockRoutingPolicyService as never,
      mockAgentRepository as never,
      mockAiModelRepository as never,
      mockDocumentTemplateRepository as never,
      mockMcpServerRepository as never,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockDatabaseService.baseClient.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({}));
    mockRepository.findMaxVersionNumber.mockResolvedValue(0);
    mockRepository.create.mockImplementation((created: unknown) => Promise.resolve(created));
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    service = construct();
  });

  describe('exportDefinition', () => {
    it('exports VALUES only: portable refs, no row id, no PHI pointer, no derived artifact', async () => {
      mockRepository.findById.mockResolvedValue(entity());
      mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-1', name: 'Discharge Summary Prompt' });

      const result = await service.exportDefinition('def-1');

      expect(result.kind).toBe('workflow');
      expect(result.schemaVersion).toBe(1);
      expect(result.source).toEqual({ tenantKind: 'tenant', slug: 'discharge_summary', version: 3 });
      expect(result.payload.name).toBe('Discharge Summary');
      expect(result.payload.paletteKey).toBe('core');

      const nodeConfig = (result.payload.graph as { nodes: { config: Record<string, unknown> }[] }).nodes[0].config;
      // The rewrite reaches the DELEGATE config a `core.action` carries — the walker recurses,
      // and the `actionKey` selecting that delegate travels verbatim.
      expect(nodeConfig).toEqual({
        actionKey: 'prompt.template_ref',
        action: { promptTemplateRef: { name: 'Discharge Summary Prompt' }, temperature: 0.3 },
      });
      expect(result.payload.references).toEqual([{ nodeId: 'n_gen', kind: 'promptTemplate', key: 'Discharge Summary Prompt' }]);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('tpl-1');
      expect(serialized).not.toContain('gs-secret');
      expect(serialized).not.toContain('compiledConfig');
      expect(serialized).not.toContain('validationReport');
      expect(serialized).not.toContain('tenant-1');
    });

    it('stamps the SYSTEM tier as provenance when the exported row is a platform template', async () => {
      mockRepository.findById.mockResolvedValue(entity({ tenantId: SYSTEM_TENANT_ID, graph: { version: 1, nodes: [], edges: [] } }));
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? SYSTEM_TENANT_ID : { id: 'root-1', roles: ['SUPER_ADMIN'] }));
      service = construct();

      const result = await service.exportDefinition('def-1');

      expect(result.source.tenantKind).toBe('system');
    });

    // TASK-889 — the workflow bundle is now the SHARED envelope, so what proves it is the shared
    // validator, not a second hand-rolled shape check. An export that this refuses is an export
    // an importer of EITHER kind would refuse.
    it('produces an envelope the shared portable-bundle validator accepts as a `workflow` bundle', async () => {
      mockRepository.findById.mockResolvedValue(entity());
      mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-1', name: 'Discharge Summary Prompt' });

      const result = await service.exportDefinition('def-1');

      expect(portableBundleProblems(result, { kind: 'workflow' })).toEqual([]);
      expect(isPortableBundle(result, { kind: 'workflow' })).toBe(true);
      expect(result.schemaVersion).toBe(PORTABLE_BUNDLE_SCHEMA_VERSION);
      // …and an AGENT importer refuses it by shape, which is the whole point of a shared `kind`.
      expect(portableBundleProblems(result, { kind: 'agent' })).toEqual([
        { path: 'kind', message: 'This importer accepts `agent` bundles; this one is `workflow`.' },
      ]);
    });

    it('is a 404 for another tenant’s id — never a 403', async () => {
      mockRepository.findById.mockResolvedValue(entity({ tenantId: 'tenant-2' }));

      await expect(service.exportDefinition('def-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to export a graph whose bound row no longer resolves, rather than dropping the binding', async () => {
      mockRepository.findById.mockResolvedValue(entity());
      mockPromptTemplateRepository.findById.mockRejectedValue(new Error('gone'));

      await expect(service.exportDefinition('def-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('importDefinition', () => {
    it('resolves references against the CALLER’s catalogue and lands a DRAFT in a NEW lineage', async () => {
      mockPromptTemplateRepository.findByName.mockResolvedValue({ id: 'tpl-target-9', name: 'Discharge Summary Prompt' });

      const result = await service.importDefinition({ targetSlug: 'discharge_summary_imported', bundle: bundle() });

      expect(mockPromptTemplateRepository.findByName).toHaveBeenCalledWith('tenant-1', 'Discharge Summary Prompt');
      expect(mockRepository.create).toHaveBeenCalledTimes(1);
      const created = mockRepository.create.mock.calls[0][0];
      expect(created.tenantId).toBe('tenant-1');
      expect(created.slug).toBe('discharge_summary_imported');
      expect(created.versionNumber).toBe(1);
      expect(created.status).toBe(WorkflowDefinitionStatus.DRAFT);
      expect(created.isActive).toBe(false);
      expect(created.parentVersionId).toBeNull();
      // The reference was rewritten into THIS tenant's row id.
      expect(created.graph.nodes[0].config).toEqual({ actionKey: 'prompt.template_ref', action: { promptTemplateId: 'tpl-target-9' } });
      // Recomputed here, never carried.
      expect(created.validationReport).toBeDefined();
      expect(created.compiledConfig).toBeNull();

      expect(result.slug).toBe('discharge_summary_imported');
    });

    it('refuses the WHOLE bundle with a 409 that NAMES every unresolvable reference', async () => {
      mockPromptTemplateRepository.findByName.mockResolvedValue(null);
      mockAgentRepository.findPublishedActiveBySlug.mockResolvedValue(null);

      const withAgent = bundle();
      withAgent.payload.graph = {
        version: 1,
        nodes: [
          { id: 'n_gen', type: 'core.action', config: { actionKey: 'prompt.template_ref', action: { promptTemplateRef: { name: 'Discharge Summary Prompt' } } } },
          { id: 'n_agent', type: 'core.agent', config: { agentRef: { slug: 'soap-writer' } } },
        ],
        edges: [],
      };

      const error = await service.importDefinition({ targetSlug: 'imported', bundle: withAgent }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as { code: string; unresolvedReferences: unknown[] };
      expect(body.code).toBe('WORKFLOW_IMPORT_UNRESOLVED_REFERENCES');
      expect(body.unresolvedReferences).toEqual([
        { nodeId: 'n_gen', kind: 'promptTemplate', key: 'Discharge Summary Prompt' },
        { nodeId: 'n_agent', kind: 'agent', key: 'soap-writer' },
      ]);
      expect(mockRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a bundle of the wrong kind or an unimplemented schema version', async () => {
      await expect(service.importDefinition({ targetSlug: 'imported', bundle: bundle({ kind: 'agent' as never }) })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.importDefinition({ targetSlug: 'imported', bundle: bundle({ schemaVersion: 99 }) })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a targetSlug the tenant already uses rather than silently minting version N+1', async () => {
      mockPromptTemplateRepository.findByName.mockResolvedValue({ id: 'tpl-target-9' });
      mockRepository.findMaxVersionNumber.mockResolvedValue(2);

      await expect(service.importDefinition({ targetSlug: 'discharge_summary', bundle: bundle() })).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a palette the node registry does not declare', async () => {
      const strange = bundle();
      strange.payload.paletteKey = 'summarisation';

      await expect(service.importDefinition({ targetSlug: 'imported', bundle: strange })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
