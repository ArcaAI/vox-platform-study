/**
 * `usages()`, and the acknowledgement gate publish now runs against it.
 *
 * The pure rule itself is tested in `context-schema-usages.task982.test.ts`. What is locked HERE
 * is the service's behaviour around it:
 *
 *  - ownership is resolved BEFORE any consumer is read (404-over-403, no cross-tenant probe);
 *  - `againstVersion` defaults to the schema's own pin, and an unknown one is a 404;
 *  - a publish that would make an ACTIVE pinned consumer refuse is itself refused, with the whole
 *    impact in the body — and writes nothing;
 *  - the acknowledgement makes it publish, and the impact rides on the response either way;
 *  - an inactive consumer is reported but never gates;
 *  - `pin` reports impact and never gates on it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConsultationContextSchemaService } from '../consultation-context-schema.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockSchemaRepository = {
  findById: vi.fn(),
  update: vi.fn(),
};

const mockVersionRepository = {
  create: vi.fn(),
  findLatestForSchema: vi.fn(),
  findBySchemaAndVersionNumber: vi.fn(),
};

const mockWorkflowDefinitionRepository = { findByContextSchemaId: vi.fn() };
const mockAgentRepository = { findByContextSchemaId: vi.fn() };

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ConsultationContextSchemaVersionFactory: {
      CreateConsultationContextSchemaVersion: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        id: `version-${data.versionNumber}`,
        createdAt: new Date('2026-09-17T00:00:00Z'),
        version: 1,
      })),
    },
  };
});

/** A definition declaring exactly the named kinds, each a bare STRUCTURED kind. */
function definitionWithKinds(...keys: string[]): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    kinds: keys.map((key) => ({
      key,
      label: key,
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      fields: { type: 'object', properties: {}, additionalProperties: false },
    })),
  };
}

const schemaEntity = (overrides: Record<string, unknown> = {}) => {
  const base = {
    id: 'schema-1',
    tenantId: 'tenant-1',
    slug: 'default_context',
    name: 'Default Context',
    description: null,
    scope: 'TENANT',
    departmentId: null,
    status: 'PUBLISHED',
    pinnedVersionNumber: 1,
    isDefault: true,
    sourceTemplateSlug: null,
    templateLocked: false,
    resourceStatus: 'ENABLED',
    createdAt: new Date('2026-09-17T00:00:00Z'),
    updatedAt: new Date('2026-09-17T00:00:00Z'),
    version: 1,
    ...overrides,
  };
  return base;
};

const versionEntity = (versionNumber: number, definition: Record<string, unknown>) => ({
  id: `version-${versionNumber}`,
  tenantId: 'tenant-1',
  schemaId: 'schema-1',
  versionNumber,
  definition,
  checksum: `sum-${versionNumber}`,
  changeReason: null,
  createdAt: new Date('2026-09-17T00:00:00Z'),
  version: 1,
});

/** A published workflow row whose FROZEN trigger declares exactly `frozenKeys`. */
function workflowRow(overrides: Record<string, unknown> = {}, frozenKeys: string[] = ['intake']) {
  return {
    id: 'wf-1',
    tenantId: 'tenant-1',
    slug: 'consultation',
    name: 'Consultation',
    versionNumber: 3,
    status: 'PUBLISHED',
    isActive: true,
    contextSchemaId: 'schema-1',
    contextSchemaVersionNumber: 1,
    contextSchemaFollowsLatest: false,
    compiledConfig: {
      stages: [
        {
          nodes: [
            {
              id: 'trigger',
              type: 'core.trigger',
              config: {
                contextSchema: {
                  resolved: {
                    type: 'object',
                    additionalProperties: false,
                    properties: Object.fromEntries(frozenKeys.map((key) => [key, { type: 'object' }])),
                  },
                },
              },
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe('ConsultationContextSchemaService — usages and publish impact', () => {
  let service: ConsultationContextSchemaService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) =>
      key === 'tenantId' ? 'tenant-1' : key === 'user' ? { id: 'user-1', roles: ['TENANT_ADMIN'] } : undefined,
    );
    mockWorkflowDefinitionRepository.findByContextSchemaId.mockResolvedValue([]);
    mockAgentRepository.findByContextSchemaId.mockResolvedValue([]);

    service = new ConsultationContextSchemaService(
      mockSchemaRepository as never,
      mockVersionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockWorkflowDefinitionRepository as never,
      mockAgentRepository as never,
    );
  });

  describe('usages', () => {
    it('answers 404 for a cross-tenant schema id before reading any consumer', async () => {
      mockSchemaRepository.findById.mockResolvedValue(schemaEntity({ tenantId: 'tenant-2' }));

      await expect(service.usages('schema-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockWorkflowDefinitionRepository.findByContextSchemaId).not.toHaveBeenCalled();
    });

    it("defaults to the schema's own pin and reports a follow-latest workflow as accepting", async () => {
      mockSchemaRepository.findById.mockResolvedValue(schemaEntity({ pinnedVersionNumber: 2 }));
      mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(versionEntity(2, definitionWithKinds('intake', 'referral')));
      mockWorkflowDefinitionRepository.findByContextSchemaId.mockResolvedValue([workflowRow({ contextSchemaFollowsLatest: true })]);

      const result = await service.usages('schema-1');

      expect(result.schemaId).toBe('schema-1');
      expect(result.againstVersion).toBe(2);
      expect(result.workflows).toHaveLength(1);
      expect(result.workflows[0]).toMatchObject({
        definitionId: 'wf-1',
        slug: 'consultation',
        versionNumber: 3,
        isActive: true,
        binding: 'latest',
        verdict: 'accepts',
        problems: [],
      });
    });

    it('reports a PINNED workflow as refusing the kind its frozen trigger lacks', async () => {
      mockSchemaRepository.findById.mockResolvedValue(schemaEntity({ pinnedVersionNumber: 1 }));
      mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(versionEntity(2, definitionWithKinds('intake', 'referral')));
      mockWorkflowDefinitionRepository.findByContextSchemaId.mockResolvedValue([workflowRow()]);

      const result = await service.usages('schema-1', 2);

      expect(result.againstVersion).toBe(2);
      expect(result.workflows[0]).toMatchObject({ binding: 'pinned', boundVersion: 1, verdict: 'refuses' });
      expect(result.workflows[0].problems).toEqual(['/referral: not declared in the bound version v1']);
    });

    it('lists an agent bound to the schema with its own binding and verdict', async () => {
      mockSchemaRepository.findById.mockResolvedValue(schemaEntity({ pinnedVersionNumber: 2 }));
      mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(versionEntity(2, definitionWithKinds('intake', 'referral')));
      mockAgentRepository.findByContextSchemaId.mockResolvedValue([
        {
          id: 'agent-1',
          slug: 'scribe',
          name: 'Scribe',
          versionNumber: 4,
          status: 'PUBLISHED',
          isActive: true,
          contextSchemaVersionNumber: 1,
          compiledConfig: {
            contextSchema: {
              versionNumber: 1,
              payloadSchema: { type: 'object', additionalProperties: false, properties: { intake: { type: 'object' } } },
            },
          },
        },
      ]);

      const result = await service.usages('schema-1');

      expect(result.agents[0]).toMatchObject({
        agentId: 'agent-1',
        slug: 'scribe',
        binding: 'pinned',
        boundVersion: 1,
        verdict: 'refuses',
      });
    });

    it('404s an `againstVersion` the schema does not have', async () => {
      mockSchemaRepository.findById.mockResolvedValue(schemaEntity({ pinnedVersionNumber: 1 }));
      mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(null);

      await expect(service.usages('schema-1', 99)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('publish — the impact acknowledgement gate', () => {
    function arrangePublish(consumers: Record<string, unknown>[]) {
      mockSchemaRepository.findById.mockResolvedValue(schemaEntity({ pinnedVersionNumber: 1 }));
      mockVersionRepository.findLatestForSchema.mockResolvedValue(versionEntity(1, definitionWithKinds('intake')));
      mockVersionRepository.create.mockImplementation(async (v: unknown) => v);
      mockSchemaRepository.update.mockImplementation(async (_id: string, e: unknown) => e);
      mockWorkflowDefinitionRepository.findByContextSchemaId.mockResolvedValue(consumers);
    }

    it('REFUSES with SCHEMA_IMPACT_UNACKNOWLEDGED when an active pinned consumer would refuse, writing nothing', async () => {
      arrangePublish([workflowRow()]);

      await expect(service.publish('schema-1', { definition: definitionWithKinds('intake', 'referral') })).rejects.toMatchObject({
        response: { code: 'SCHEMA_IMPACT_UNACKNOWLEDGED' },
      });
      expect(mockVersionRepository.create).not.toHaveBeenCalled();
      expect(mockSchemaRepository.update).not.toHaveBeenCalled();
    });

    it('carries the full impact in the refusal body so the admin sees WHICH consumer refuses', async () => {
      arrangePublish([workflowRow()]);

      const error = await service.publish('schema-1', { definition: definitionWithKinds('intake', 'referral') }).catch((e) => e);

      expect(error.response.impact.againstVersion).toBe(2);
      expect(error.response.impact.workflows[0]).toMatchObject({ slug: 'consultation', verdict: 'refuses' });
    });

    it('publishes with `acknowledgeImpact` and embeds the impact in the response', async () => {
      arrangePublish([workflowRow()]);

      const result = await service.publish('schema-1', {
        definition: definitionWithKinds('intake', 'referral'),
        acknowledgeImpact: true,
      });

      expect(mockVersionRepository.create).toHaveBeenCalled();
      expect(result.pinnedVersionNumber).toBe(2);
      expect(result.impact?.workflows[0]).toMatchObject({ verdict: 'refuses' });
    });

    it('needs no acknowledgement when every consumer follows latest', async () => {
      arrangePublish([workflowRow({ contextSchemaFollowsLatest: true })]);

      const result = await service.publish('schema-1', { definition: definitionWithKinds('intake', 'referral') });

      expect(result.impact?.workflows[0]).toMatchObject({ binding: 'latest', verdict: 'accepts' });
      expect(mockVersionRepository.create).toHaveBeenCalled();
    });

    it('a refusing consumer that is NOT active is listed but does not gate the publish', async () => {
      arrangePublish([workflowRow({ isActive: false, status: 'DEPRECATED' })]);

      const result = await service.publish('schema-1', { definition: definitionWithKinds('intake', 'referral') });

      expect(result.impact?.workflows[0]).toMatchObject({ isActive: false, status: 'DEPRECATED', verdict: 'refuses' });
      expect(mockVersionRepository.create).toHaveBeenCalled();
    });
  });

  describe('pin — impact is reported, never gated', () => {
    it('embeds the impact of the version being pinned', async () => {
      mockSchemaRepository.findById.mockResolvedValue(schemaEntity({ pinnedVersionNumber: 2 }));
      mockVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(versionEntity(1, definitionWithKinds('intake', 'referral')));
      mockSchemaRepository.update.mockImplementation(async (_id: string, e: unknown) => e);
      mockWorkflowDefinitionRepository.findByContextSchemaId.mockResolvedValue([workflowRow()]);

      const result = await service.pin('schema-1', { versionNumber: 1 });

      expect(result.pinnedVersionNumber).toBe(1);
      expect(result.impact?.againstVersion).toBe(1);
      expect(result.impact?.workflows[0]).toMatchObject({ verdict: 'refuses' });
    });
  });
});
