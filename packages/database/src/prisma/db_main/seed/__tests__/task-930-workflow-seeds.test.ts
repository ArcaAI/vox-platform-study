/**
 * TASK-930 §8.6 — the two GENERATED workflow modules are engine output, and the seeded
 * workflow/agent set covers what §8.4 and §8.5 promise.
 *
 * COMPILE PARITY is the load-bearing half: for every authored target this re-runs the REAL
 * `validate()` / `compile()` / `publishFindings()` through the regen script's own
 * `engineOutputFor` and compares it to the committed `.generated.ts` blob. A hand-edit to a
 * generated file — or an authored graph that drifted away from its blob — fails here, which is
 * the only reason it is safe to commit compiler output at all.
 *
 * The registry checksum is a property of the node registry, not of a seed: when a ticket adds or
 * removes a node the blobs must be REGENERATED (`pnpm --filter @arcaai/database
 * seed:regen:workflows`), never hand-patched. This test asserts the committed checksum equals the
 * live `registryChecksum()` so that drift is a red test rather than a silent seed failure.
 */
import { describe, expect, it } from 'vitest';

import { SEED_CUSTOMER_TENANT_IDS, SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';
import { ARCAAI_CLINICAL_APPROVED_VERSION, ARCAAI_CLINICAL_TEMPLATES, ARCAAI_CLINICAL_VERSIONS } from '../07b-arcaai-clinical-templates';
import { GLOBAL_AGENT_SPECS, PLATFORM_AGENT_SPECS } from '../25-agents';
import { CONSULTATION_WORKFLOW_SLUG, SUMMARIZATION_WORKFLOW_SLUG, WORKFLOW_LIBRARY_ASSIGNMENTS, WORKFLOW_LIBRARY_TARGETS, workflowLibraryDefinitions } from '../28-workflow-library';
import { WORKFLOW_LIBRARY_GENERATED, REGISTRY_CHECKSUM } from '../28-workflow-library.generated';
import {
  ARCAAI_AGENT_SPECS,
  ARCAAI_DEFAULT_WORKFLOW_SLUG,
  ARCAAI_DEPARTMENT_TABLE,
  ARCAAI_WORKFLOW_TARGETS,
  VISIT_TYPES,
  arcaaiAgentSlug,
  arcaaiWorkflowAssignments,
  arcaaiWorkflowSlug,
  arcaaiWorkflowDefinitions,
} from '../29-arcaai-agents-and-workflows';
import { ARCAAI_GENERATED, REGISTRY_CHECKSUM as ARCAAI_REGISTRY_CHECKSUM } from '../29-arcaai-agents-and-workflows.generated';
import { engineOutputFor } from '../../../../../scripts/regen-workflow-seeds';
import * as contract from '../../../../../../workflow-contract/dist/index.mjs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const liveRegistryChecksum: string = (contract as any).registryChecksum();

describe('TASK-930 §8.6 — the generated blobs are real engine output', () => {
  it('both generated modules carry the LIVE registry checksum (regenerate, never hand-patch)', () => {
    expect(REGISTRY_CHECKSUM).toBe(liveRegistryChecksum);
    expect(ARCAAI_REGISTRY_CHECKSUM).toBe(liveRegistryChecksum);
  });

  it.each(WORKFLOW_LIBRARY_TARGETS.map((target) => [target.key, target] as const))(
    '28-workflow-library.generated — %s compiles to exactly the committed blob',
    (key, target) => {
      const real = engineOutputFor(target, liveRegistryChecksum);
      expect(real.problems).toEqual([]);
      const blob = WORKFLOW_LIBRARY_GENERATED[key];
      expect(blob).toBeDefined();
      expect(blob!.graphChecksum).toBe(real.graphChecksum);
      expect(blob!.compiledConfig).toEqual(real.compiledConfig);
      expect(blob!.validationReport).toEqual(real.validationReport);
    },
  );

  it.each(ARCAAI_WORKFLOW_TARGETS.map((target) => [target.key, target] as const))(
    '29-arcaai-agents-and-workflows.generated — %s compiles to exactly the committed blob',
    (key, target) => {
      const real = engineOutputFor(target, liveRegistryChecksum);
      expect(real.problems).toEqual([]);
      const blob = ARCAAI_GENERATED[key];
      expect(blob).toBeDefined();
      expect(blob!.graphChecksum).toBe(real.graphChecksum);
      expect(blob!.compiledConfig).toEqual(real.compiledConfig);
      expect(blob!.validationReport).toEqual(real.validationReport);
    },
  );

  it('neither generated module carries a blob no target claims (a stale key would seed nothing and hide a rename)', () => {
    expect(Object.keys(WORKFLOW_LIBRARY_GENERATED).sort()).toEqual(WORKFLOW_LIBRARY_TARGETS.map((target) => target.key).sort());
    expect(Object.keys(ARCAAI_GENERATED).sort()).toEqual(ARCAAI_WORKFLOW_TARGETS.map((target) => target.key).sort());
  });
});

describe('TASK-930 §8.4 — Global and SYSTEM carry the identical workflow set', () => {
  it('two slugs per tenant, PUBLISHED + active on the `core` palette, ids unique', () => {
    const rows = workflowLibraryDefinitions();
    for (const tenantId of [SEED_TENANT_ID, SYSTEM_TENANT_ID]) {
      const mine = rows.filter((row) => row.tenantId === tenantId);
      expect(mine.map((row) => row.slug).sort()).toEqual([CONSULTATION_WORKFLOW_SLUG, SUMMARIZATION_WORKFLOW_SLUG].sort());
      for (const row of mine) expect(row).toMatchObject({ status: 'PUBLISHED', isActive: true, paletteKey: 'core', versionNumber: 1 });
    }
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it('and the identical AGENT set — the same five slugs on both tenants (§8.3)', () => {
    expect(GLOBAL_AGENT_SPECS.map((spec) => spec.slug).sort()).toEqual(PLATFORM_AGENT_SPECS.map((spec) => spec.slug).sort());
  });

  it('each tenant carries exactly one TENANT-scope assignment, naming a workflow it owns', () => {
    const rows = workflowLibraryDefinitions();
    for (const tenantId of [SEED_TENANT_ID, SYSTEM_TENANT_ID]) {
      const mine = WORKFLOW_LIBRARY_ASSIGNMENTS.filter((row) => row.tenantId === tenantId);
      expect(mine).toHaveLength(1);
      expect(rows.some((row) => row.tenantId === tenantId && row.slug === mine[0]!.workflowDefinitionSlug)).toBe(true);
    }
  });
});

describe('TASK-930 §8.5 — every ArcaAI department gets one workflow and two agents', () => {
  const ARCAAI = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

  it('11 departments → 11 workflows and 22 agents, one per (department, visit type)', () => {
    expect(ARCAAI_DEPARTMENT_TABLE).toHaveLength(11);
    expect(ARCAAI_WORKFLOW_TARGETS).toHaveLength(ARCAAI_DEPARTMENT_TABLE.length);
    expect(ARCAAI_AGENT_SPECS).toHaveLength(ARCAAI_DEPARTMENT_TABLE.length * VISIT_TYPES.length);
    for (const row of ARCAAI_DEPARTMENT_TABLE) {
      expect(ARCAAI_WORKFLOW_TARGETS.filter((target) => target.slug === arcaaiWorkflowSlug(row))).toHaveLength(1);
      for (const visit of VISIT_TYPES) expect(ARCAAI_AGENT_SPECS.filter((spec) => spec.slug === arcaaiAgentSlug(row, visit))).toHaveLength(1);
    }
    for (const spec of ARCAAI_AGENT_SPECS) expect(spec).toMatchObject({ tenantId: ARCAAI, task: 'TEXT_GENERATION', status: 'PUBLISHED', isActive: true });
    expect(new Set(ARCAAI_AGENT_SPECS.map((spec) => spec.id)).size).toBe(ARCAAI_AGENT_SPECS.length);
    expect(new Set(ARCAAI_WORKFLOW_TARGETS.map((target) => target.id)).size).toBe(ARCAAI_WORKFLOW_TARGETS.length);
  });

  it('every referenced promptTemplateId exists in the ArcaAI library AND has a snapshot at the pinned version', () => {
    const templateById = new Map(ARCAAI_CLINICAL_TEMPLATES.map((template) => [template.id, template]));
    const versionKeys = new Set(ARCAAI_CLINICAL_VERSIONS.map((version) => `${version.promptTemplateId}@${version.versionNumber}`));
    for (const spec of ARCAAI_AGENT_SPECS) {
      const instruction = spec.instruction as { promptTemplateId?: string; promptVersionNumber?: number };
      expect(typeof instruction.promptTemplateId).toBe('string');
      const template = templateById.get(instruction.promptTemplateId!);
      expect(template, `no ArcaAI template ${String(instruction.promptTemplateId)} for ${spec.slug}`).toBeDefined();
      expect(instruction.promptVersionNumber).toBe(ARCAAI_CLINICAL_APPROVED_VERSION);
      expect(template!.approvedVersionNumber).toBe(instruction.promptVersionNumber);
      expect(versionKeys.has(`${instruction.promptTemplateId}@${instruction.promptVersionNumber}`)).toBe(true);
    }
  });

  it('each department workflow routes its OWN two agents off the visit-type condition, `else` → new-visit', () => {
    for (const row of ARCAAI_DEPARTMENT_TABLE) {
      const target = ARCAAI_WORKFLOW_TARGETS.find((candidate) => candidate.slug === arcaaiWorkflowSlug(row))!;
      const slugOf = (nodeId: string) =>
        (target.graph.nodes.find((node) => node.id === nodeId)?.config as { agentRef?: { slug?: string } } | undefined)?.agentRef?.slug;
      expect(slugOf('n_summary_new')).toBe(arcaaiAgentSlug(row, 'new-visit'));
      expect(slugOf('n_summary_revisit')).toBe(arcaaiAgentSlug(row, 'revisit'));
      // Every core.agent slug in the graph is either a platform agent or one of THIS department's.
      const own = new Set(VISIT_TYPES.map((visit) => arcaaiAgentSlug(row, visit)));
      const platform = new Set(['realtime-transcription', 'medical-ner', 'casenote-finalization']);
      for (const node of target.graph.nodes.filter((candidate) => candidate.type === 'core.agent')) {
        const slug = (node.config as { agentRef: { slug: string } }).agentRef.slug;
        expect(own.has(slug) || platform.has(slug)).toBe(true);
      }
      const branchTargets = target.graph.edges.filter((edge) => edge.from === 'n_visit');
      expect(branchTargets.find((edge) => edge.fromPort === 'new_visit')!.to).toBe('n_summary_new');
      expect(branchTargets.find((edge) => edge.fromPort === 'revisit')!.to).toBe('n_summary_revisit');
      expect(branchTargets.find((edge) => edge.fromPort === 'else')!.to).toBe('n_summary_new');
    }
  });

  it('assignments: one DEPARTMENT row per department plus the TENANT default → General Medicine; every slug resolves to a seeded definition', () => {
    const departmentIdByCode = new Map(ARCAAI_DEPARTMENT_TABLE.map((row) => [row.code, `dept-${row.code}`]));
    const { rows, changes } = arcaaiWorkflowAssignments(departmentIdByCode);
    expect(rows.filter((row) => row.scope === 'DEPARTMENT')).toHaveLength(ARCAAI_DEPARTMENT_TABLE.length);
    const tenantRows = rows.filter((row) => row.scope === 'TENANT');
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0]!.workflowDefinitionSlug).toBe(ARCAAI_DEFAULT_WORKFLOW_SLUG);
    expect(ARCAAI_DEFAULT_WORKFLOW_SLUG).toBe('arcaai-gen-consultation');
    expect(changes).toHaveLength(rows.length);

    const seeded = new Set(arcaaiWorkflowDefinitions().map((row) => row.slug));
    for (const row of rows) expect(seeded.has(row.workflowDefinitionSlug)).toBe(true);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(new Set(changes.map((row) => row.id)).size).toBe(changes.length);
  });
});
