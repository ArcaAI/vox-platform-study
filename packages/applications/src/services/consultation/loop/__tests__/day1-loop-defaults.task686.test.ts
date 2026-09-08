/**
 * The day-1 default context schema.
 *
 * The signalling gate is on, so a real `context.added` now starts
 * `ConsultationLoopWorkflow`. The workflow then completes `phase: "DISABLED"`,
 * because its pinned config's `enabled` is DERIVED
 * (`loop-config.service.ts:156`) and neither of its two sources exists on a
 * fresh install:
 *
 *     const enabled = workflowDefinition !== null || contextSchemaVersionId !== null;
 *
 * retired the FIRST source's old form — a seeded default
 * `DepartmentAgent` carrying loop configuration — and replaced it with the
 * tenant's governing `WorkflowDefinition`. The seeded context schema is
 * unchanged, and it is what this suite pins:
 *
 *  - the seeded `definition` is publishable by the REAL publish validator
 *    (`contextSchemaDefinitionProblems`), not by a hand-rolled restatement of it;
 *  - the seeded rows, fed through the REAL `LoopConfigService`, resolve
 *    `enabled: true` on the schema ALONE — no definition assigned;
 *  - removing the schema again returns the loop to `enabled: false` cleanly —
 *    ("a consultation with no loop configured behaves EXACTLY as it
 *    does today") must still hold.
 *
 * `packages/database` must not depend on `@arcaai/applications` (that would
 * close a cycle: applications → domains → database), so the seed carries its own
 * copies of the canonicalisers. The checksum-parity case below is what stops the
 * two implementations drifting.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

import { contextSchemaDefinitionProblems, computeDefinitionChecksum } from '../../../consultation-context-schema/context-schema-definition';
import { LoopConfigService } from '../loop-config.service';

import {
  DAY1_CONTEXT_SCHEMAS,
  DAY1_CONTEXT_SCHEMA_DEFINITION,
  DAY1_CONTEXT_SCHEMA_VERSIONS,
} from '../../../../../../database/src/prisma/db_main/seed/07e-consultation-note-context-schema';

// =============================================================================
// 1. The seeded definition is publishable by the real validator
// =============================================================================

describe('The seeded context-schema definition', () => {
  it('is accepted by the real publish validator with zero problems', () => {
    expect(contextSchemaDefinitionProblems(DAY1_CONTEXT_SCHEMA_DEFINITION)).toEqual([]);
  });

  it('declares exactly the owner-specified E1 vocabulary, on the five platform primitives', () => {
    const kinds = (DAY1_CONTEXT_SCHEMA_DEFINITION as { kinds: { key: string; primitive: string }[] }).kinds;
    expect(kinds.map((k) => [k.key, k.primitive])).toEqual([
      ['audio_stream', 'STREAM_AUDIO'],
      ['work_note', 'TEXT'],
      ['case_note', 'TEXT'],
      ['attachment', 'DOCUMENT'],
    ]);
  });

  it('declares one output — the note `harness.finalize` actually produces', () => {
    const outputs = (DAY1_CONTEXT_SCHEMA_DEFINITION as { outputs: { key: string }[] }).outputs;
    expect(outputs.map((o) => o.key)).toEqual(['soap_note']);
  });

  it('seeds a checksum computed by the same algorithm the publish path uses', () => {
    for (const version of DAY1_CONTEXT_SCHEMA_VERSIONS) {
      expect(version.checksum).toBe(computeDefinitionChecksum(DAY1_CONTEXT_SCHEMA_DEFINITION));
    }
  });
});

// =============================================================================
// 2. The seeded rows satisfy the SERVABLE predicate
//    (`LoopConfigService.resolveServableContextSchemaVersion`)
// =============================================================================

describe('The seeded schema rows are servable', () => {
  it('are TENANT-scoped defaults, ENABLED, PUBLISHED, with a non-null pin that resolves to a seeded version', () => {
    expect(DAY1_CONTEXT_SCHEMAS.length).toBeGreaterThan(0);

    for (const schema of DAY1_CONTEXT_SCHEMAS) {
      // findDefaultForScope(tenantId, TENANT, null) filters on exactly these.
      expect(schema.scope).toBe('TENANT');
      expect(schema.departmentId).toBeNull();
      expect(schema.isDefault).toBe(true);
      expect(schema.resourceStatus).toBe('ENABLED');

      // The servable check in loop-config.service.ts.
      expect(schema.pinnedVersionNumber).not.toBeNull();
      expect(['PUBLISHED', 'APPROVED']).toContain(schema.status);

      // findBySchemaAndVersionNumber(schema.id, pinnedVersionNumber) must hit.
      const version = DAY1_CONTEXT_SCHEMA_VERSIONS.find(
        (v) => v.schemaId === schema.id && v.versionNumber === schema.pinnedVersionNumber,
      );
      expect(version).toBeDefined();
      expect(version?.tenantId).toBe(schema.tenantId);
    }
  });
});

// =============================================================================
// 3. The real LoopConfigService resolves `enabled: true` — and K7 still holds
// =============================================================================

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockConsultationRepository = { findById: vi.fn() };
const mockContextSchemaRepository = { findDefaultForScope: vi.fn() };
const mockContextSchemaVersionRepository = { findBySchemaAndVersionNumber: vi.fn() };
const mockWorkflowAssignments = { resolve: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn() };

const TENANT_ID = DAY1_CONTEXT_SCHEMAS[0]!.tenantId;
const DEPARTMENT_ID = 'department-1';
const CONSULTATION_ID = 'consultation-1';

function buildService(): LoopConfigService {
  return new LoopConfigService(
    mockConsultationRepository as never,
    mockContextSchemaRepository as never,
    mockContextSchemaVersionRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    undefined,
    mockWorkflowAssignments as never,
    mockWorkflowDefinitionRepository as never,
  );
}

describe('LoopConfigService against the seeded rows', () => {
  let service: LoopConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConsultationRepository.findById.mockResolvedValue({ id: CONSULTATION_ID, tenantId: TENANT_ID, departmentId: DEPARTMENT_ID });
    // A fresh install seeds the SCHEMA and nothing else — no tenant has authored
    // a consultation workflow yet, so no definition is assigned. That is the
    // case this suite exists to pin: the seeded schema ALONE must enable the loop.
    mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' });
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
    // DEPARTMENT tier misses; the seeded TENANT-scoped default answers.
    mockContextSchemaRepository.findDefaultForScope.mockImplementation(async (_tenantId: string, scope: string) =>
      scope === 'TENANT' ? DAY1_CONTEXT_SCHEMAS[0] : null,
    );
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({
      id: 'schema-version-1',
      definition: DAY1_CONTEXT_SCHEMA_DEFINITION,
    });
    service = buildService();
  });

  it('resolves enabled: true from the seeded schema alone', async () => {
    const result = await service.resolveForConsultation(TENANT_ID, CONSULTATION_ID);

    expect(result.enabled).toBe(true);
    expect(result.contextSchemaVersionId).toBe('schema-version-1');
    // No tenant-authored workflow on a fresh install.
    expect(result.agentId).toBeNull();
    expect(result.agentConfigVersionId).toBeNull();
  });

  it('derives a non-empty action subscription for every seeded kind', async () => {
    const result = await service.resolveForConsultation(TENANT_ID, CONSULTATION_ID);

    expect(result.subscriptions).toEqual([
      { kindKey: 'work_note', actions: ['client.emit'] },
      { kindKey: 'case_note', actions: ['client.emit'] },
      { kindKey: 'attachment', actions: ['document.extract_text', 'client.emit'] },
    ]);
    // Every subscription resolved to at least one action — a subscription with
    // an empty action list is the "running but inert" failure mode. `audio_stream`
    // is declared by the schema and deliberately not subscribed at all, which is
    // what keeps this true (see `LoopConfigService.buildSubscriptions`).
    expect(result.subscriptions.every((s) => s.actions.length > 0)).toBe(true);
    expect(result.subscriptions.map((s) => s.kindKey)).not.toContain('audio_stream');
  });

  it('leaves the LiveDoc lifecycle alone and runs the platform endpoint stage at consultation end', async () => {
    const result = await service.resolveForConsultation(TENANT_ID, CONSULTATION_ID);

    expect(result.startActions).toEqual([]);
    // TASK-882: the day-1 tenant's governing graph declares no endpoint node, so the stage
    // resolves to the platform default — minus `livedoc.stop`, because the loop never drives the
    // LiveDoc lifecycle. `harness.finalize` is still there and still in the same relative
    // position; what is new is the stage AROUND it.
    expect(result.endingActions).toEqual(['session.timeout', 'harness.finalize', 'summary.finalize', 'feedback.capture']);
  });

  it('keeps the deliberative lane OFF — the roster retired with DepartmentAgentRole', async () => {
    const result = await service.resolveForConsultation(TENANT_ID, CONSULTATION_ID);

    expect(result.reasoningEnabled).toBe(false);
    expect(result.agents).toEqual([]);
  });

  /**
   * A tenant that soft-deletes, unpublishes, un-defaults or un-pins the seeded
   * schema must fall back to exactly today's behaviour.
   * `findDefaultForScope` filters on `resourceStatus: ENABLED`, so a soft delete
   * shows up here as the repository answering null.
   */
  it.each([
    ['soft-deleted / un-defaulted (repository answers null)', null],
    ['reverted to DRAFT', { ...DAY1_CONTEXT_SCHEMAS[0], status: 'DRAFT' }],
    ['un-pinned', { ...DAY1_CONTEXT_SCHEMAS[0], pinnedVersionNumber: null }],
  ])('K7 — %s returns the loop to enabled: false', async (_label, schemaRow) => {
    mockContextSchemaRepository.findDefaultForScope.mockImplementation(async (_tenantId: string, scope: string) =>
      scope === 'TENANT' ? schemaRow : null,
    );

    const result = await service.resolveForConsultation(TENANT_ID, CONSULTATION_ID);

    expect(result.enabled).toBe(false);
    expect(result.contextSchemaVersionId).toBeNull();
    expect(result.startActions).toEqual([]);
    expect(result.subscriptions).toEqual([]);
  });
});
