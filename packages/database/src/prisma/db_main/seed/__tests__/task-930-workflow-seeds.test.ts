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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SEED_CUSTOMER_TENANT_IDS, SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';
import { ARCAAI_CLINICAL_APPROVED_VERSION, ARCAAI_CLINICAL_TEMPLATES, ARCAAI_CLINICAL_VERSIONS, approvedVersionFor } from '../07b-arcaai-clinical-templates';
import { NOTE_CONTEXT_SCHEMA_DEFINITION } from '../07e-consultation-note-context-schema';
import { GLOBAL_AGENT_SPECS, PLATFORM_AGENT_SPECS } from '../25-agents';
import { CONSULTATION_WORKFLOW_SLUG, SUMMARIZATION_WORKFLOW_SLUG, WORKFLOW_LIBRARY_ASSIGNMENTS, WORKFLOW_LIBRARY_TARGETS, workflowLibraryDefinitions } from '../28-workflow-library';
import { WORKFLOW_LIBRARY_GENERATED, REGISTRY_CHECKSUM } from '../28-workflow-library.generated';
import {
  ARCAAI_AGENT_SPECS,
  ARCAAI_DEPARTMENT_AGENT_SPECS,
  ARCAAI_PRE_SUMMARY_AGENT_SPEC,
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

// `scripts/` sits outside this package's tsconfig `rootDir`, so the regen script is loaded by
// PATH at runtime — the same posture the retired parity tests used for the contract itself.
// Reusing the script's own `engineOutputFor` is the point: the test and the generator cannot
// drift apart into two different "real" engines.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGEN_SRC = path.resolve(HERE, '../../../../../scripts/regen-workflow-seeds.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { engineOutputFor }: any = await import(/* @vite-ignore */ REGEN_SRC);

// The LIVE registry checksum, from the built contract the script itself compiles against.
const CONTRACT_DIST = path.resolve(HERE, '../../../../../../workflow-contract/dist/index.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const contract: any = await import(/* @vite-ignore */ CONTRACT_DIST);
const liveRegistryChecksum: string = contract.registryChecksum();

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

  it('11 departments → 11 workflows and 22 department agents, one per (department, visit type), plus the tenant warm start', () => {
    expect(ARCAAI_DEPARTMENT_TABLE).toHaveLength(11);
    expect(ARCAAI_WORKFLOW_TARGETS).toHaveLength(ARCAAI_DEPARTMENT_TABLE.length);
    expect(ARCAAI_DEPARTMENT_AGENT_SPECS).toHaveLength(ARCAAI_DEPARTMENT_TABLE.length * VISIT_TYPES.length);
    // TASK-932 D-9 — plus ONE tenant-wide agent: the warm start has no department axis and no
    // visit-type axis (`07b`: "there is exactly ONE pre-summary prompt for the whole tenant").
    expect(ARCAAI_AGENT_SPECS).toHaveLength(ARCAAI_DEPARTMENT_AGENT_SPECS.length + 1);
    expect(ARCAAI_PRE_SUMMARY_AGENT_SPEC.slug).toBe('case-notes-pre-summary');
    expect(ARCAAI_AGENT_SPECS.filter((spec) => spec.slug === ARCAAI_PRE_SUMMARY_AGENT_SPEC.slug)).toHaveLength(1);
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
      // The pre-summary agent pins the corpus default; a per-turn agent pins ITS template's approved
      // version (v4 for Breast & Endocrine since 2026-09-13, v3 elsewhere).
      const expectedPin = spec.slug === 'case-notes-pre-summary' ? ARCAAI_CLINICAL_APPROVED_VERSION : approvedVersionFor(instruction.promptTemplateId!);
      expect(instruction.promptVersionNumber, spec.slug).toBe(expectedPin);
      expect(template!.approvedVersionNumber).toBe(instruction.promptVersionNumber);
      expect(versionKeys.has(`${instruction.promptTemplateId}@${instruction.promptVersionNumber}`)).toBe(true);
    }
  });

  /**
   * F6 for the ArcaAI half. The v3 department corpus is SELF-CONTAINED — every one of the 22
   * bodies inlines its instructions and reads no `{{context.*}}` at all (only the shared
   * "Clinical Pre-Summary" template does), so "populate `instruction.variables`" resolves to the
   * empty binding set here, which is what the specs carry. Asserted as an EQUALITY rather than
   * skipped, so the day a v3 body grows a placeholder without a binding, this goes red.
   */
  it('every ArcaAI agent binds `instruction.variables` for exactly the `{{context.*}}` its template reads, each to a field the trigger schema declares', () => {
    const kinds = (NOTE_CONTEXT_SCHEMA_DEFINITION as unknown as { kinds: Array<{ key: string; fields: { properties: Record<string, unknown> } }> }).kinds;
    const contextFields = new Set(Object.keys(kinds.find((kind) => kind.key === 'context')!.fields.properties));
    const contentById = new Map(ARCAAI_CLINICAL_TEMPLATES.map((template) => [template.id, String(template.content)]));
    for (const spec of ARCAAI_AGENT_SPECS) {
      const instruction = spec.instruction as { promptTemplateId: string; variables?: Record<string, { value: string } | { path: string }> };
      const used = new Set([...contentById.get(instruction.promptTemplateId)!.matchAll(/\{\{\s*context\.([a-zA-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]!));
      const bound = instruction.variables ?? {};
      for (const name of used) {
        expect(bound[name], `${spec.slug} leaves {{context.${name}}} unbound`).toEqual({ path: `trigger.context.${name}` });
        expect(contextFields.has(name), `the trigger schema declares no ${name}`).toBe(true);
      }
      // No binding the template never reads — a stray variable is dead config that looks live.
      expect(Object.keys(bound).sort()).toEqual([...used].sort());
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
      // `case-notes-pre-summary` is a LINEAGE KEY both tiers carry: the graph names the slug and
      // the tenant's own row (seeded in this phase) is what resolves — never the SYSTEM one, which
      // `copyAgents` does not make because the slug is already taken.
      const platform = new Set(['realtime-transcription', 'medical-ner', 'casenote-finalization', 'case-notes-pre-summary']);
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

  /**
   * TASK-932 D-9 — the WARM START is on every department graph, in the shape the live executor
   * dispatches on: a `core.agent` naming the tenant's own pre-summary lineage key, on the
   * realtime lane at the `onStart` cadence, degrading rather than failing.
   *
   * The two edges are the whole of the design claim. `n_trigger.next -> n_presummary.after` is a
   * PARALLEL branch (both handles are `multiple`), so the compiler puts the warm start in the
   * same stage as the capture node and the pre-summary is generated WHILE the microphone opens
   * — sequencing it ahead of capture would make recording wait on an LLM call. And
   * `n_presummary.next -> n_finalize.after` is what satisfies WF-S-004 (every node reaches a
   * terminal) with an ORDERING edge rather than a data one, so the finalizer's inputs are still
   * exactly the partial summaries and the work notes its own system prompt names.
   */
  it('every department graph carries the `onStart` warm start, parallel to capture and reaching a terminal by ordering alone', () => {
    for (const target of ARCAAI_WORKFLOW_TARGETS) {
      const node = target.graph.nodes.find((candidate) => candidate.id === 'n_presummary');
      expect(node, `${target.slug} has no n_presummary`).toBeDefined();
      expect(node!.type).toBe('core.agent');
      expect(node!.config).toMatchObject({
        agentRef: { slug: 'case-notes-pre-summary' },
        execution: { lane: 'realtime', cadence: 'onStart' },
        guardrail: { enabled: true },
        onError: 'degrade',
      });

      const edgeFrom = (from: string, fromPort: string, to: string) =>
        target.graph.edges.some((edge) => edge.from === from && edge.fromPort === fromPort && edge.to === to);
      expect(edgeFrom('n_trigger', 'next', 'n_presummary')).toBe(true);
      expect(edgeFrom('n_trigger', 'out', 'n_presummary')).toBe(true);
      expect(edgeFrom('n_trigger', 'next', 'n_asr')).toBe(true);
      expect(edgeFrom('n_presummary', 'next', 'n_finalize')).toBe(true);
      // NOT a data edge into the finalizer: `out`/`data` must not leave this node.
      expect(target.graph.edges.filter((edge) => edge.from === 'n_presummary' && edge.fromPort !== 'next')).toEqual([]);
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
