/**
 * TASK-1057 — `contextSchema.publish` (reason) and `contextSchema.publishImpact` (the
 * acknowledgement policy) on `publish`, and the stamps they record on the sys-event.
 */
import { describe, expect, it, vi } from 'vitest';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';
import { ConsultationContextSchemaService } from '../consultation-context-schema.service';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ConsultationContextSchemaVersionFactory: {
      CreateConsultationContextSchemaVersion: vi.fn((d: Record<string, unknown>) => ({ ...d, id: `version-${d.versionNumber}`, version: 1 })),
    },
  };
});

function definitionWithKinds(...keys: string[]) {
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

const workflowRow = () => ({
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
      { nodes: [{ id: 't', type: 'core.trigger', config: { contextSchema: { resolved: { type: 'object', additionalProperties: false, properties: { intake: { type: 'object' } } } } } }] },
    ],
  },
});

type Modes = { reason: 'required' | 'not-required'; impact: 'required' | 'not-required' };

function build(modes: Modes, withConsumer: boolean) {
  const schema = { id: 'schema-1', tenantId: 'tenant-1', status: 'PUBLISHED', pinnedVersionNumber: 1, version: 1, resourceStatus: 'ENABLED' };
  const schemas = { findById: vi.fn(async () => schema), update: vi.fn(async (_i: string, e: unknown) => e) };
  const versions = {
    findLatestForSchema: vi.fn(async () => ({ id: 'v1', versionNumber: 1, definition: definitionWithKinds('intake'), checksum: 'old' })),
    create: vi.fn(async (v: unknown) => v),
  };
  const workflows = { findByContextSchemaId: vi.fn(async () => (withConsumer ? [workflowRow()] : [])) };
  const agents = { findByContextSchemaId: vi.fn(async () => []) };
  const emit = vi.fn();
  const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? 'tenant-1' : k === 'user' ? { id: 'u1', roles: ['TENANT_ADMIN'] } : undefined)) };
  const tenantSettings = {
    resolve: vi.fn((key: string) => ({ value: key.includes('publishImpact') ? modes.impact : modes.reason })),
  };
  const confirmations = new ActionConfirmationService(tenantSettings as never);
  const service = new ConsultationContextSchemaService(
    schemas as never,
    versions as never,
    { emit } as never,
    cls as never,
    workflows as never,
    agents as never,
    confirmations,
  );
  return { service, versions, schemas, emit };
}

const DEF = definitionWithKinds('intake', 'referral');

describe('ConsultationContextSchemaService.publish — action confirmation (TASK-1057)', () => {
  it('publishes with no reason by default and stamps the sys-event', async () => {
    const { service, versions, emit } = build({ reason: 'not-required', impact: 'required' }, false);
    await service.publish('schema-1', { definition: DEF });
    expect(versions.create).toHaveBeenCalled();
    const payload = JSON.stringify(emit.mock.calls);
    expect(payload).toContain('contextSchema.publish');
    expect(payload).toContain('reason not required');
  });

  it('refuses CONFIRMATION_REQUIRED for a missing reason when required, writing nothing', async () => {
    const { service, versions, schemas } = build({ reason: 'required', impact: 'required' }, false);
    await expect(service.publish('schema-1', { definition: DEF })).rejects.toMatchObject({
      response: { code: 'CONFIRMATION_REQUIRED', actionId: 'contextSchema.publish' },
    });
    expect(versions.create).not.toHaveBeenCalled();
    expect(schemas.update).not.toHaveBeenCalled();
  });

  it('keeps SCHEMA_IMPACT_UNACKNOWLEDGED when the acknowledgement is required and missing', async () => {
    const { service, versions } = build({ reason: 'not-required', impact: 'required' }, true);
    await expect(service.publish('schema-1', { definition: DEF })).rejects.toMatchObject({ response: { code: 'SCHEMA_IMPACT_UNACKNOWLEDGED' } });
    expect(versions.create).not.toHaveBeenCalled();
  });

  it('lets an impactful publish through without the acknowledgement when its policy is not-required, stamping both', async () => {
    const { service, versions, emit } = build({ reason: 'not-required', impact: 'not-required' }, true);
    await service.publish('schema-1', { definition: DEF });
    expect(versions.create).toHaveBeenCalled();
    const payload = JSON.stringify(emit.mock.calls);
    expect(payload).toContain('contextSchema.publishImpact');
    expect(payload).toContain('acknowledgement not required');
    expect(payload).toContain('confirmations');
  });
});
