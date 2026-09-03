/**
 * Lane N — the two capabilities, as they are actually SEEDED.
 *
 * The finding was that the finalization chain does not exist in the seed: *"`agent.dna_redaction`
 * is absent from both seeded graphs"*, so nothing redacted the note before the verifier scored it.
 * The other finding was that important findings did not exist at all. This suite holds the seeded graphs to
 * the owner's two sentences rather than to a shape:
 *
 *  - **ordering** — grounding evaluates the REDACTED summary, so redaction precedes it. Earlier
 *    programme notes had that backwards, and the test is written so the wrong order goes red;
 *  - **configuration** — every instruction and every policy is a BOUND, seeded prompt template.
 *    A dangling id would mean the platform silently doing nothing, and an in-code body would mean
 *    the platform deciding what "important" and "grounded" mean for a tenant.
 *
 * The engine is imported from SOURCE by a computed path for the reason
 * `task-798-arcaai-workflow-authoring.test.ts` documents: `packages/database` deliberately takes
 * no dependency on `@arcaai/workflow-contract`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ARCAAI_CONSULTATION_GRAPH, ARCAAI_RHEUM_CONSULTATION_GRAPH } from '../23-arcaai-workflow-authoring';
import { DEFAULT_PROMPT_TEMPLATES, TEMPLATE_IDS } from '../07-prompt-template';
import { SYSTEM_TENANT_ID } from '../00-constants';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');

/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { allPathsPassThrough, registryChecksum, validate, workflowNodeClassLookup, workflowPublishProblems } = contract;

const GRAPHS: Array<[string, any]> = [
  ['general medicine', ARCAAI_CONSULTATION_GRAPH],
  ['rheumatology', ARCAAI_RHEUM_CONSULTATION_GRAPH],
];

const nodeOf = (graph: any, id: string) => graph.nodes.find((n: any) => n.id === id);
const edge = (graph: any, from: string, to: string) => graph.edges.find((e: any) => e.from === from && e.to === to);

describe('§14b — the finalization chain is SEEDED, and redaction runs BEFORE grounding', () => {
  it.each(GRAPHS)('%s: `agent.dna_redaction` is present — the §14b gap, closed', (_label, graph) => {
    expect(nodeOf(graph, 'n_dna')?.type).toBe('agent.dna_redaction');
    // Rider: the tenant gate is the node's PRESENCE, the doctor's own opt-in still
    // applies, and the retired `DepartmentAgent` veto stays retired.
    expect(nodeOf(graph, 'n_dna').config.requireDoctorOptIn).toBe(true);
  });

  it.each(GRAPHS)('%s: the redactor takes the SYNTHESIZED note and hands on a redacted one', (_label, graph) => {
    expect(edge(graph, 'n_synth', 'n_dna')).toMatchObject({ fromPort: 'out', toPort: 'in' });
    // THE ORDERING ASSERTION. The owner says grounding evaluates the *redacted* summary, so the
    // note must reach every verifier THROUGH the redactor. A graph that kept `n_synth -> n_sensors`
    // would fail here, which is exactly the earlier (wrong) ordering.
    expect(edge(graph, 'n_synth', 'n_sensors')).toBeUndefined();
    expect(edge(graph, 'n_dna', 'n_sensors')).toMatchObject({ fromPort: 'out', toPort: 'in' });
  });

  it.each(GRAPHS)('%s: the POLICY-DRIVEN grounding pass scores the redacted note, not the raw one', (_label, graph) => {
    expect(nodeOf(graph, 'n_ground_note')?.type).toBe('guard.groundedness');
    expect(edge(graph, 'n_dna', 'n_ground_note')).toMatchObject({ fromPort: 'out', toPort: 'in' });
    expect(edge(graph, 'n_synth', 'n_ground_note')).toBeUndefined();
  });

  it.each(GRAPHS)('%s: every route to the redactor still crosses the PHI hop and synthesis', (_label, graph) => {
    // WF-CONS-009/010 as properties rather than as a validator run: inserting a node into the
    // note chain is exactly the edit that can open a route around a mandatory hop.
    expect(allPathsPassThrough(graph, ['n_consent'], ['n_dna'], ['n_phi'])).toBe(true);
    expect(allPathsPassThrough(graph, ['n_consent'], ['n_dna'], ['n_synth'])).toBe(true);
    // And the branch rejoins at the verifier, so no route reaches the terminal around it.
    expect(allPathsPassThrough(graph, ['n_consent'], ['n_gate'], ['n_sensors'])).toBe(true);
  });

  it.each(GRAPHS)('%s: grounding is driven by a TENANT-DECLARED policy, not a platform rubric', (_label, graph) => {
    const policies = nodeOf(graph, 'n_ground_note').config.policies;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ appliesTo: 'summary', promptTemplateId: TEMPLATE_IDS.GROUNDING_POLICY_SYSTEM });
    // No pass mark and no score formula are seeded: the owner assigned both to the tenant admin.
    expect(nodeOf(graph, 'n_ground_note').config.threshold).toBeUndefined();
  });
});

describe('§14a — important findings are seeded, and they mine what was SAID', () => {
  it.each(GRAPHS)('%s: the node is present and bound to a tenant-overridable instruction', (_label, graph) => {
    expect(nodeOf(graph, 'n_findings')?.type).toBe('agent.important_findings');
    expect(nodeOf(graph, 'n_findings').config.promptTemplateId).toBe(TEMPLATE_IDS.IMPORTANT_FINDINGS_SYSTEM);
  });

  it.each(GRAPHS)('%s: its source is the CAPTURED TRANSCRIPT — never the generated note', (_label, graph) => {
    expect(edge(graph, 'n_capture', 'n_findings')).toMatchObject({ fromPort: 'out', toPort: 'in' });
    // The laundering path, asserted absent: no generation node feeds the findings pass.
    for (const generator of ['n_synth', 'n_realtime', 'n_presum', 'n_dna']) {
      expect(edge(graph, generator, 'n_findings')).toBeUndefined();
    }
  });

  it.each(GRAPHS)('%s: it is ordered INTO extraction, so no route skips `extractEntities`', (_label, graph) => {
    // WF-CONS-012 is an allPathsPassThrough check, and a findings branch that rejoined ANYWHERE
    // downstream of extraction would open a route around it. This is the constraint that decided
    // the placement; asserting it here is what stops a later "tidy-up" moving the edge.
    expect(edge(graph, 'n_findings', 'n_entities')).toMatchObject({ fromPort: 'next', toPort: 'after' });
    expect(allPathsPassThrough(graph, ['n_capture'], ['n_synth'], ['n_entities'])).toBe(true);
  });
});

describe('both graphs still validate, and every bound instruction actually exists', () => {
  it.each(GRAPHS)('%s: validate() reports no findings', (_label, graph) => {
    const report = validate(
      graph,
      { paletteKey: 'consultation', registry: workflowNodeClassLookup },
      { ruleSetVersion: 1, registryChecksum: registryChecksum() },
    );
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it.each(GRAPHS)('%s: workflowPublishProblems is empty — every required guard is attached', (_label, graph) => {
    expect(workflowPublishProblems(graph)).toEqual([]);
  });

  it.each(GRAPHS)('%s: no node binds a prompt template the seed does not create', (_label, graph) => {
    const seeded = new Set<string>(DEFAULT_PROMPT_TEMPLATES.map((t) => t.id as string));
    for (const node of graph.nodes) {
      const bound = [node.config?.promptTemplateId, ...((node.config?.policies ?? []) as any[]).map((p) => p.promptTemplateId)].filter(Boolean);
      for (const id of bound) {
        // ArcaAI's own clinical templates live in 07b; only the two Lane N platform defaults are
        // expected to come from 07 — a dangling id here would mean the node degrades on every run.
        if (id === TEMPLATE_IDS.IMPORTANT_FINDINGS_SYSTEM || id === TEMPLATE_IDS.GROUNDING_POLICY_SYSTEM) {
          expect(seeded.has(id as string), `${node.id} binds a template the seed does not create`).toBe(true);
        }
      }
    }
  });

  it('the two Lane N defaults are SYSTEM-tenant rows — the platform-default tier, not a customer’s', () => {
    // `PromptTemplate` is a SYSTEM_SHARED_READ_MODEL, so a SYSTEM row is readable by every tenant.
    // Seeding these under the "Global" customer tenant (`50000000-…`) would make one customer's
    // configuration the platform default for everyone — the cross-tenant leak
    // `00-project-context.md` calls out by name.
    for (const id of [TEMPLATE_IDS.IMPORTANT_FINDINGS_SYSTEM, TEMPLATE_IDS.GROUNDING_POLICY_SYSTEM]) {
      const row = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === id)!;
      expect(row, `${id} is not seeded`).toBeDefined();
      expect(row.tenantId).toBe(SYSTEM_TENANT_ID);
      expect(row.approvedVersionNumber).toBe(1);
    }
  });

  it('neither default instruction ships an importance or grounding TAXONOMY', () => {
    // The owner assigned the definition of "important" and "grounded" to the tenant admin. A
    // default body may guide FORMAT; it must not enumerate the answer.
    for (const id of [TEMPLATE_IDS.IMPORTANT_FINDINGS_SYSTEM, TEMPLATE_IDS.GROUNDING_POLICY_SYSTEM]) {
      const content = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === id)!.content.toLowerCase();
      for (const forbidden of ['severity', 'red flag', 'red-flag', 'critical value', 'allergy alert', 'grade the', 'score out of']) {
        expect(content, `${id} contains "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });
});
