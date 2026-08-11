/**
 * TASK-662 — LoopConfigService.resolveForConsultation.
 *
 * Every resolution failure degrades to the disabled config rather than
 * throwing: missing/cross-tenant consultation, no department, no default
 * agent, no servable context schema. The compliance envelope
 * (`alwaysActions`/`neverActions`) and the `STREAM_AUDIO` start/ending
 * action derivation are covered directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { LoopConfigService, LOOP_CONFIG_MAX_DEPTH, LOOP_CONFIG_MAX_ACTIONS } from '../loop-config.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockConsultationRepository = { findById: vi.fn() };
const mockAgentRepository = { findDefaultForDepartment: vi.fn() };
const mockAgentVersionRepository = { findLatestForAgent: vi.fn() };
const mockContextSchemaRepository = { findDefaultForScope: vi.fn() };
const mockContextSchemaVersionRepository = { findBySchemaAndVersionNumber: vi.fn() };

function buildService(): LoopConfigService {
  return new LoopConfigService(
    mockConsultationRepository as never,
    mockAgentRepository as never,
    mockAgentVersionRepository as never,
    mockContextSchemaRepository as never,
    mockContextSchemaVersionRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
  );
}

const DEFAULT_BUDGET = { maxDepth: LOOP_CONFIG_MAX_DEPTH, maxActions: LOOP_CONFIG_MAX_ACTIONS };

/** A schema definition declaring one kind per fixture case, keyed by primitive. */
function definitionWithKind(kindKey: string, primitive: string) {
  return {
    schemaVersion: '1.0',
    kinds: [
      {
        key: kindKey,
        label: kindKey,
        primitive,
        phiClass: 'PHI',
        cardinality: 'MANY',
        lifecycle: 'DURING',
        producedBy: ['CLIENT'],
      },
    ],
  };
}

const SCHEMA_ROW = { id: 'schema-1', pinnedVersionNumber: 3, status: 'PUBLISHED' };

describe('LoopConfigService.resolveForConsultation — TASK-662', () => {
  let service: LoopConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = buildService();
  });

  it('degrades to a disabled config when the consultation is not found (cross-tenant id) — never throws', async () => {
    mockConsultationRepository.findById.mockRejectedValue(new DataNotFoundException('Consultation', 'consult-1'));

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result).toEqual({
      enabled: false,
      consultationId: null,
      departmentId: null,
      agentId: null,
      agentConfigVersionId: null,
      contextSchemaVersionId: null,
      subscriptions: [],
      budget: DEFAULT_BUDGET,
      startActions: [],
      endingActions: [],
    });
    expect(mockAgentRepository.findDefaultForDepartment).not.toHaveBeenCalled();
  });

  it('degrades to a disabled config when the resolved consultation belongs to a different tenant', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'other-tenant', departmentId: 'dept-1' });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.enabled).toBe(false);
    expect(result.consultationId).toBeNull();
  });

  it('degrades to a disabled config (but still returns consultationId) when the consultation has no department', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: null });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.enabled).toBe(false);
    expect(result.consultationId).toBe('consult-1');
    expect(result.departmentId).toBeNull();
    expect(mockAgentRepository.findDefaultForDepartment).not.toHaveBeenCalled();
  });

  it('degrades to a disabled config when the department has no default agent', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue(null);

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.enabled).toBe(false);
    expect(result.consultationId).toBe('consult-1');
    expect(result.departmentId).toBe('dept-1');
    expect(result.agentId).toBeNull();
  });

  it('populates agentConfigVersionId and contextSchemaVersionId and reports enabled:true when both resolve', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: null,
      alwaysActions: null,
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue({ id: 'agent-version-1' });
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValueOnce(SCHEMA_ROW).mockResolvedValueOnce(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
      id: 'schema-version-1',
      definition: definitionWithKind('transcript', 'STREAM_AUDIO'),
    });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.enabled).toBe(true);
    expect(result.agentId).toBe('agent-1');
    expect(result.agentConfigVersionId).toBe('agent-version-1');
    expect(result.contextSchemaVersionId).toBe('schema-version-1');
    // findDefaultForScope is tried DEPARTMENT-scoped first.
    expect(mockContextSchemaRepository.findDefaultForScope).toHaveBeenNthCalledWith(1, 'tenant-1', 'DEPARTMENT', 'dept-1');
  });

  it('a STREAM_AUDIO subscribed kind produces startActions [livedoc.start] and endingActions [livedoc.stop, harness.finalize]', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: { version: 1, kinds: [{ key: 'transcript' }] },
      alwaysActions: null,
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValueOnce(SCHEMA_ROW).mockResolvedValueOnce(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
      id: 'schema-version-1',
      definition: definitionWithKind('transcript', 'STREAM_AUDIO'),
    });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.startActions).toEqual(['livedoc.start']);
    expect(result.endingActions).toEqual(['livedoc.stop', 'harness.finalize']);
    // STREAM_AUDIO's own default action list is empty.
    expect(result.subscriptions).toEqual([{ kindKey: 'transcript', actions: [] }]);
  });

  it('a non-STREAM_AUDIO-only subscription set produces startActions [] and endingActions [harness.finalize]', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: { version: 1, kinds: [{ key: 'referral_letter' }] },
      alwaysActions: null,
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValueOnce(SCHEMA_ROW).mockResolvedValueOnce(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
      id: 'schema-version-1',
      definition: definitionWithKind('referral_letter', 'DOCUMENT'),
    });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.startActions).toEqual([]);
    expect(result.endingActions).toEqual(['harness.finalize']);
    expect(result.subscriptions).toEqual([{ kindKey: 'referral_letter', actions: ['document.extract_text', 'client.emit'] }]);
  });

  it('neverActions: [harness.finalize] removes harness.finalize from endingActions', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: { version: 1, kinds: [{ key: 'transcript' }] },
      alwaysActions: null,
      neverActions: ['harness.finalize'],
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValueOnce(SCHEMA_ROW).mockResolvedValueOnce(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
      id: 'schema-version-1',
      definition: definitionWithKind('transcript', 'STREAM_AUDIO'),
    });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.endingActions).toEqual(['livedoc.stop']);
  });

  it('alwaysActions: [client.emit] appears on a kind whose primitive maps to [] (STREAM_AUDIO)', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: { version: 1, kinds: [{ key: 'transcript' }] },
      alwaysActions: ['client.emit'],
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValueOnce(SCHEMA_ROW).mockResolvedValueOnce(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
      id: 'schema-version-1',
      definition: definitionWithKind('transcript', 'STREAM_AUDIO'),
    });

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.subscriptions).toEqual([{ kindKey: 'transcript', actions: ['client.emit'] }]);
  });

  it('a malformed subscribedKinds payload yields [] subscriptions rather than throwing', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: { version: 1, kinds: 'not-an-array' },
      alwaysActions: null,
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.subscriptions).toEqual([]);
    expect(result.startActions).toEqual([]);
    expect(result.endingActions).toEqual(['harness.finalize']);
  });

  it('a null subscribedKinds payload yields [] subscriptions', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: null,
      alwaysActions: null,
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.subscriptions).toEqual([]);
  });

  it('every schema tier missing a servable version reports enabled:false when the agent also has no version snapshot', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: 'consult-1', tenantId: 'tenant-1', departmentId: 'dept-1' });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue({
      id: 'agent-1',
      subscribedKinds: null,
      alwaysActions: null,
      neverActions: null,
    });
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);

    const result = await service.resolveForConsultation('tenant-1', 'consult-1');

    expect(result.enabled).toBe(false);
    expect(result.agentId).toBe('agent-1');
    expect(result.contextSchemaVersionId).toBeNull();
  });
});
