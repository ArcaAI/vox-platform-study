/**
 * The day-1 default context schema + agent loop configuration.
 *
 * The signalling gate is on, so a real `context.added` now starts
 * `ConsultationLoopWorkflow`. The workflow then completes `phase: "DISABLED"`,
 * because its pinned config's `enabled` is DERIVED
 * (`loop-config.service.ts:156`) and neither of its two sources exists on a
 * fresh install:
 *
 *     const enabled = agentConfigVersionId !== null || contextSchemaVersionId !== null;
 *
 * This suite pins BOTH sources against the real code that consumes them:
 *
 *  - the seeded `definition` is publishable by the REAL publish validator
 *    (`contextSchemaDefinitionProblems`), not by a hand-rolled restatement of it;
 *  - the seeded agent loop-config passes the REAL validators, and every
 *    `subscribedKinds` key / `writeScope` output resolves against the seeded
 *    definition — an agent subscribed to a kind nobody declares produces a
 *    running-but-inert loop, which is worse than DISABLED;
 *  - the seeded rows, fed through the REAL `LoopConfigService`, resolve
 *    `enabled: true`;
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
import { createHash } from 'node:crypto';

import { contextSchemaDefinitionProblems, computeDefinitionChecksum, findKind } from '../../../consultation-context-schema/context-schema-definition';
import {
  actionOverlapProblems,
  buildLoopConfigSnapshot,
  canonicalAgentConfigJson,
  goalProblems,
  guardrailProfileProblems,
  hasLoopConfig,
  subscribedKindsProblems,
  writeScopeProblems,
} from '../../../departmentAgent/constants';
import { LoopConfigService } from '../loop-config.service';

import {
  DAY1_AGENT_LOOP_CONFIG,
  DAY1_CONTEXT_SCHEMAS,
  DAY1_CONTEXT_SCHEMA_DEFINITION,
  DAY1_CONTEXT_SCHEMA_VERSIONS,
  agentLoopConfigChecksum,
  seedRowHasLoopConfig,
} from '../../../../../../database/src/prisma/db_main/seed/07e-consultation-loop-defaults';
import { ARCAAI_TENANT_AGENTS, GLOBAL_TENANT_AGENTS, GOLDEN_AGENTS } from '../../../../../../database/src/prisma/db_main/seed/07a-agent-golden-library';

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
// 3. The seeded agent loop-config validates, and its keys resolve
// =============================================================================

const ALL_SEEDED_AGENTS = [...GOLDEN_AGENTS, ...GLOBAL_TENANT_AGENTS, ...ARCAAI_TENANT_AGENTS];

describe('The seeded agent loop configuration', () => {
  it('passes every structural validator', () => {
    expect(subscribedKindsProblems(DAY1_AGENT_LOOP_CONFIG.subscribedKinds).problems).toEqual([]);
    expect(writeScopeProblems(DAY1_AGENT_LOOP_CONFIG.writeScope).problems).toEqual([]);
    expect(goalProblems(DAY1_AGENT_LOOP_CONFIG.goal)).toEqual([]);
    expect(guardrailProfileProblems(DAY1_AGENT_LOOP_CONFIG.guardrailProfile)).toEqual([]);
    expect(actionOverlapProblems(DAY1_AGENT_LOOP_CONFIG.alwaysActions, DAY1_AGENT_LOOP_CONFIG.neverActions)).toEqual([]);
  });

  it('actually configures the loop surface (so a version row is warranted)', () => {
    expect(hasLoopConfig(buildLoopConfigSnapshot(DAY1_AGENT_LOOP_CONFIG))).toBe(true);
    expect(seedRowHasLoopConfig(DAY1_AGENT_LOOP_CONFIG)).toBe(true);
  });

  it('subscribes ONLY to kinds the seeded definition declares', () => {
    const { kindKeys } = subscribedKindsProblems(DAY1_AGENT_LOOP_CONFIG.subscribedKinds);
    expect(kindKeys.length).toBeGreaterThan(0);
    for (const key of kindKeys) {
      expect(findKind(DAY1_CONTEXT_SCHEMA_DEFINITION, key), `kind '${key}' is not declared`).toBeDefined();
    }
  });

  it('writes ONLY outputs the seeded definition declares', () => {
    const { outputKeys } = writeScopeProblems(DAY1_AGENT_LOOP_CONFIG.writeScope);
    const declared = (DAY1_CONTEXT_SCHEMA_DEFINITION as { outputs: { key: string }[] }).outputs.map((o) => o.key);
    expect(outputKeys.length).toBeGreaterThan(0);
    for (const key of outputKeys) {
      expect(declared, `output '${key}' is not declared`).toContain(key);
    }
  });

  /**
   * The LiveDoc lifecycle is ALREADY owned by `consultation.controller.ts`
   * (`recording/start` → `liveDocumentationService.start`, `recording/stop` →
   * `.stop`). Subscribing the day-1 agent to a `STREAM_AUDIO` kind would make
   * `deriveStartAndEndingActions` add `livedoc.start`/`livedoc.stop` on top of
   * that — a second start and a second stop per consultation. The kind is
   * DECLARED (it is the tenant's vocabulary) but deliberately NOT subscribed.
   */
  it('does not subscribe to the STREAM_AUDIO kind — the controller owns that lifecycle', () => {
    const { kindKeys } = subscribedKindsProblems(DAY1_AGENT_LOOP_CONFIG.subscribedKinds);
    const audioKinds = kindKeys.filter((key) => findKind(DAY1_CONTEXT_SCHEMA_DEFINITION, key)?.primitive === 'STREAM_AUDIO');
    expect(audioKinds).toEqual([]);
  });

  it('is carried by every seeded default agent', () => {
    expect(ALL_SEEDED_AGENTS.length).toBeGreaterThan(0);
    for (const agent of ALL_SEEDED_AGENTS) {
      expect(agent.role, agent.slug).toBe('PRIMARY');
      expect(agent.subscribedKinds, agent.slug).toEqual(DAY1_AGENT_LOOP_CONFIG.subscribedKinds);
      expect(agent.writeScope, agent.slug).toEqual(DAY1_AGENT_LOOP_CONFIG.writeScope);
    }
  });

  it('computes its version checksum with the same algorithm DepartmentAgentService uses', () => {
    const expected = createHash('sha256').update(canonicalAgentConfigJson(buildLoopConfigSnapshot(DAY1_AGENT_LOOP_CONFIG))).digest('hex');
    expect(agentLoopConfigChecksum(DAY1_AGENT_LOOP_CONFIG)).toBe(expected);
  });
});

// =============================================================================
// 4. Exactly one PRIMARY per department
// =============================================================================

describe('The one-PRIMARY-per-department invariant', () => {
  it('seeds at most one PRIMARY agent per (tenant, department)', () => {
    const primariesByDepartment = new Map<string, string[]>();
    for (const agent of ALL_SEEDED_AGENTS) {
      if (agent.role !== 'PRIMARY') continue;
      const key = `${agent.tenantId}::${agent.departmentId}`;
      primariesByDepartment.set(key, [...(primariesByDepartment.get(key) ?? []), agent.slug]);
    }
    const offenders = [...primariesByDepartment.entries()].filter(([, slugs]) => slugs.length > 1);
    expect(offenders).toEqual([]);
  });
});

// =============================================================================
// 5. The real LoopConfigService resolves `enabled: true` — and K7 still holds
// =============================================================================

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockConsultationRepository = { findById: vi.fn() };
const mockAgentRepository = { findDefaultForDepartment: vi.fn(), findAllByDepartment: vi.fn() };
const mockAgentVersionRepository = { findLatestForAgent: vi.fn() };
const mockContextSchemaRepository = { findDefaultForScope: vi.fn() };
const mockContextSchemaVersionRepository = { findBySchemaAndVersionNumber: vi.fn() };

const TENANT_ID = DAY1_CONTEXT_SCHEMAS[0]!.tenantId;
const DEPARTMENT_ID = 'department-1';
const CONSULTATION_ID = 'consultation-1';

/** The seeded agent as the entity shape `LoopConfigService` reads. */
const SEEDED_AGENT = {
  id: 'agent-1',
  tenantId: TENANT_ID,
  departmentId: DEPARTMENT_ID,
  slug: 'gen-default',
  role: DAY1_AGENT_LOOP_CONFIG.role,
  goal: DAY1_AGENT_LOOP_CONFIG.goal,
  subscribedKinds: DAY1_AGENT_LOOP_CONFIG.subscribedKinds,
  writeScope: DAY1_AGENT_LOOP_CONFIG.writeScope,
  alwaysActions: DAY1_AGENT_LOOP_CONFIG.alwaysActions,
  neverActions: DAY1_AGENT_LOOP_CONFIG.neverActions,
};

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

describe('LoopConfigService against the seeded rows', () => {
  let service: LoopConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConsultationRepository.findById.mockResolvedValue({ id: CONSULTATION_ID, tenantId: TENANT_ID, departmentId: DEPARTMENT_ID });
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue(SEEDED_AGENT);
    mockAgentRepository.findAllByDepartment.mockResolvedValue([SEEDED_AGENT]);
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue({ id: 'agent-version-1', versionNumber: 1 });
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

  it('resolves enabled: true from the seeded schema + agent', async () => {
    const result = await service.resolveForConsultation(TENANT_ID, CONSULTATION_ID);

    expect(result.enabled).toBe(true);
    expect(result.contextSchemaVersionId).toBe('schema-version-1');
    expect(result.agentConfigVersionId).toBe('agent-version-1');
  });

  it('derives a non-empty action subscription for every seeded kind', async () => {
    const result = await service.resolveForConsultation(TENANT_ID, CONSULTATION_ID);

    expect(result.subscriptions).toEqual([
      { kindKey: 'work_note', actions: ['client.emit'] },
      { kindKey: 'case_note', actions: ['client.emit'] },
      { kindKey: 'attachment', actions: ['document.extract_text', 'client.emit'] },
    ]);
    // Every subscription resolved to at least one action — a subscription with
    // an empty action list is the "running but inert" failure mode.
    expect(result.subscriptions.every((s) => s.actions.length > 0)).toBe(true);
  });

  it('leaves the LiveDoc lifecycle alone and finalizes at consultation end', async () => {
    const result = await service.resolveForConsultation(TENANT_ID, CONSULTATION_ID);

    expect(result.startActions).toEqual([]);
    expect(result.endingActions).toEqual(['harness.finalize']);
  });

  it('keeps the deliberative lane OFF — one PRIMARY, no SPECIALIST', async () => {
    const result = await service.resolveForConsultation(TENANT_ID, CONSULTATION_ID);

    expect(result.reasoningEnabled).toBe(false);
  });

  /**
   * A tenant that soft-deletes, unpublishes, un-defaults or
   * un-pins the seeded schema must fall back to exactly today's behaviour.
   * `findDefaultForScope` filters on `resourceStatus: ENABLED`, so a soft delete
   * shows up here as the repository answering null.
   */
  it.each([
    ['soft-deleted / un-defaulted (repository answers null)', null],
    ['reverted to DRAFT', { ...DAY1_CONTEXT_SCHEMAS[0], status: 'DRAFT' }],
    ['un-pinned', { ...DAY1_CONTEXT_SCHEMAS[0], pinnedVersionNumber: null }],
  ])('K7 — %s returns the loop to enabled: false when no agent version exists', async (_label, schemaRow) => {
    mockContextSchemaRepository.findDefaultForScope.mockImplementation(async (_tenantId: string, scope: string) =>
      scope === 'TENANT' ? schemaRow : null,
    );
    mockAgentVersionRepository.findLatestForAgent.mockResolvedValue(null);

    const result = await service.resolveForConsultation(TENANT_ID, CONSULTATION_ID);

    expect(result.enabled).toBe(false);
    expect(result.contextSchemaVersionId).toBeNull();
    expect(result.startActions).toEqual([]);
    // Every subscription degrades to an EMPTY action list, because no servable
    // version means no kind resolves to a primitive. `endingActions` is still
    // populated — `deriveStartAndEndingActions` does not consult `enabled` — but
    // it is inert: `ConsultationLoopWorkflow.run` short-circuits on
    // `config.enabled` before it dispatches anything at all.
    expect(result.subscriptions.every((s) => s.actions.length === 0)).toBe(true);
    expect(result.endingActions).toEqual(['harness.finalize']);
  });

  it('K7 — a department with no default agent stays disabled even with the schema seeded', async () => {
    mockAgentRepository.findDefaultForDepartment.mockResolvedValue(null);

    const result = await service.resolveForConsultation(TENANT_ID, CONSULTATION_ID);

    expect(result.enabled).toBe(false);
    expect(result.agentId).toBeNull();
    expect(result.subscriptions).toEqual([]);
  });
});
