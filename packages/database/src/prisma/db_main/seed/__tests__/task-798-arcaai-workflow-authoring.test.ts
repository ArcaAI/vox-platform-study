/**
 * the tenant-authored consultation workflow seed.
 *
 * ## What this suite is actually for
 *
 * Two of its groups are ordinary shape assertions. The other two are the point of the ticket:
 *
 *  - **Provenance.** `graph`, `compiledConfig` and the three checksums on a seeded
 *    `WorkflowDefinition` are ENGINE OUTPUT, never hand-typed. This suite re-runs the REAL
 *    `validate()` / `compile()` / `registryChecksum()` out of `packages/workflow-contract` and
 *    asserts the seeded literals equal what the engine produces RIGHT NOW. A fabricated clean
 *    validation report cannot survive it, and neither can a stale one: when the node registry
 *    moves, these tests go red and the literals must be regenerated
 *    (`scripts/regen-arcaai-consultation-workflow-seed.ts`).
 *
 *  - **The assignment safety guard.** Seeding a `WorkflowAssignment` is what makes a
 *    tenant-authored graph actually govern a consultation. Until Substrate A is suppressed for a
 *    governed consultation, that produces TWO writers on one clinical `ContextItem`
 *    (Substrate B's `consultation.persistDraft` calls the same `persist_draft` activity). So the
 *    assignment rows ship behind `CONSULTATION_ASSIGNMENT_ENABLED`, and this suite asserts the
 *    flag tracks the real presence of the exclusivity gate in `@arcaai/applications` — in BOTH
 *    directions.
 *
 * ## Why the contract package is imported dynamically
 *
 * `packages/database` deliberately declares no dependency on `@arcaai/workflow-contract` (adding
 * one edits the shared root `pnpm-lock.yaml`). The engine is therefore loaded from its SOURCE by
 * a computed relative path: a non-literal specifier is invisible to `tsc` (whose `rootDir` is
 * `./src`), so this test can reach outside the package without breaking `pnpm build`, while
 * Vitest resolves and transpiles it normally. `@arcaai/workflow-contract` has zero runtime
 * dependencies (`node:crypto` only), so importing its source costs nothing.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ARCAAI_CONSULTATION_GRAPH,
  ARCAAI_RHEUM_CONSULTATION_GRAPH,
  ARCAAI_WORKFLOW_ASSIGNMENT_CHANGES,
  ARCAAI_WORKFLOW_ASSIGNMENTS,
  ARCAAI_WORKFLOW_DEFINITIONS,
  ARCAAI_WORKFLOW_TEST_FIXTURES,
  COMPILED_AT,
  CONSULTATION_ASSIGNMENT_ENABLED,
  seedArcaaiWorkflowAuthoring,
} from '../23-arcaai-workflow-authoring';
import { detectSubstrateExclusivityGate } from '../substrate-exclusivity-guard';
import { SEED_CUSTOMER_TENANT_IDS, SEED_DEPARTMENT_IDS, SEED_USER_IDS, SYSTEM_USER_ID } from '../00-constants';
import { ARCAAI_CLINICAL_TEMPLATE_IDS } from '../07b-arcaai-clinical-templates';

/** `SYSTEM_DEFAULTS.preSummaryPromptId` in `PromptResolutionService` — the tier a tenant node
 *  must NOT re-point at. Restated here rather than imported so this seed test does not take a
 *  dependency on the applications package. */
const SYSTEM_DEFAULT_PRE_SUMMARY_PROMPT_ID = '71000000-0000-0000-0000-000000000040';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');

/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { canonicalJson, compile, nodeInfo, registryChecksum, validate, workflowNodeClassLookup } = contract;

// TASK-890 §3.5 — `workflowPublishProblems` is GONE: it was a real publish gate nothing called
// (BLOCKER 1c), and its checks now run inside `publishFindings`, which the gateway's
// `WorkflowDefinitionService.publishEntity` actually invokes. A SEED never goes through that
// service, so this suite keeps running the same gate directly. The contract takes its
// JSON-Schema value checker from the caller (it has zero runtime dependencies) and
// `packages/database` does not depend on `@arcaai/json-schema-subset`, so it is loaded by path
// exactly as the contract is. ERROR severity only: a WARNING never blocked a publish.
const SUBSET_SRC = path.resolve(HERE, '../../../../../../json-schema-subset/src/index.ts');
const { jsonSchemaValueProblems }: any = await import(/* @vite-ignore */ SUBSET_SRC);
const workflowPublishProblems = (graph: any): string[] =>
  contract
    .publishFindings(graph, { schemaValueProblems: jsonSchemaValueProblems, templateReferenceSeverity: 'WARNING' })
    .filter((finding: any) => finding.severity === 'ERROR')
    .map((finding: any) => finding.message);

/** Mirrors `WorkflowDefinitionService`'s own publish constants — what a REAL publish stamps. */
const COMPILER_VERSION = '0.1.0';
const RULE_SET_VERSION = 1;
const DEFAULT_CAPS = { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 };
const DEFAULT_POLICY_BINDINGS = {
  guardrailProfile: 'STANDARD',
  redactionRuleSetId: null,
  promptTemplateRefs: [],
  // derived per compile like its siblings; for these graphs, whose
  // generation nodes bind no document template yet.
  documentTemplateRefs: [],
  contextSchemaVersionId: null,
  entitlementKeys: [],
};

const definitionBySlug = (slug: string) => {
  const row = ARCAAI_WORKFLOW_DEFINITIONS.find((d) => d.slug === slug);
  if (!row) throw new Error(`No seeded definition for slug ${slug}`);
  return row;
};

const graphFor = (slug: string) => (slug === 'arcaai-consultation-soap' ? ARCAAI_CONSULTATION_GRAPH : ARCAAI_RHEUM_CONSULTATION_GRAPH);

// ---------------------------------------------------------------------------------------------
// W1 — a real, tenant-authored consultation workflow
// ---------------------------------------------------------------------------------------------
describe(' W1 — tenant-authored consultation WorkflowDefinition', () => {
  it('seeds exactly two definitions, both on the consultation palette', () => {
    expect(ARCAAI_WORKFLOW_DEFINITIONS).toHaveLength(2);
    for (const row of ARCAAI_WORKFLOW_DEFINITIONS) {
      expect(row.paletteKey).toBe('consultation');
    }
  });

  it('is owned and AUTHORED by the ArcaAI customer tenant, not by SYSTEM', () => {
    for (const row of ARCAAI_WORKFLOW_DEFINITIONS) {
      expect(row.tenantId).toBe(SEED_CUSTOMER_TENANT_IDS.ARCAAI);
      // The whole claim of R1 is "a TENANT admin authored this". A SYSTEM createdBy would make
      // the row read as another platform default wearing a tenant id.
      expect(row.createdBy).toBe(SEED_USER_IDS.ARCAAI_ADMIN);
      expect(row.createdBy).not.toBe(SYSTEM_USER_ID);
    }
  });

  it('is PUBLISHED and active, so the assignment cascade can resolve it', () => {
    for (const row of ARCAAI_WORKFLOW_DEFINITIONS) {
      expect(row.status).toBe('PUBLISHED');
      expect(row.isActive).toBe(true);
      expect(row.publishedAt).toBeTruthy();
      expect(row.validatedAt).toBeTruthy();
    }
  });

  it('is measurably different from the SYSTEM platform default (which is 4 nodes on the summarization palette)', () => {
    for (const row of ARCAAI_WORKFLOW_DEFINITIONS) {
      expect(graphFor(row.slug).nodes.length).toBeGreaterThan(10);
    }
  });

  it('exercises the full capability chain the requirement names', () => {
    // capture -> transcribe -> extract entities -> realtime summary -> assemble/synthesize
    // -> verify -> persist -> clinician gate. Each is a node type, not a comment.
    const types = ARCAAI_CONSULTATION_GRAPH.nodes.map((n) => n.type);
    for (const required of [
      'consultation.consentGate',
      'consultation.captureBinding',
      'consultation.extractEntities',
      'consultation.realtimeSummary',
      'consultation.assemblePrompt',
      'consultation.synthesize',
      'consultation.sensors',
      'consultation.persistDraft',
      'consultation.finalizeAssurance',
      'consultation.hitlGate',
    ]) {
      expect(types).toContain(required);
    }
  });

  it('gives the two departments materially different graphs', () => {
    const gen = ARCAAI_CONSULTATION_GRAPH.nodes.map((n) => n.type);
    const rheum = ARCAAI_RHEUM_CONSULTATION_GRAPH.nodes.map((n) => n.type);
    expect(rheum).toContain('consultation.inferentialSensors');
    expect(gen).not.toContain('consultation.inferentialSensors');
  });
});

// ---------------------------------------------------------------------------------------------
// W1 — PROVENANCE. The blobs are engine output or this suite fails.
// ---------------------------------------------------------------------------------------------
describe(' W1 — derived blobs are real compiler output', () => {
  it.each(['arcaai-consultation-soap', 'arcaai-rheum-consultation-soap'])(
    '%s: graphChecksum equals sha256(canonicalJson(graph)) computed by the real engine',
    (slug) => {
      const row = definitionBySlug(slug);
      const expected = createHash('sha256')
        .update(canonicalJson(graphFor(slug)))
        .digest('hex');
      expect(row.graphChecksum).toBe(expected);
    },
  );

  it.each(['arcaai-consultation-soap', 'arcaai-rheum-consultation-soap'])(
    '%s: validate() returns ok with ZERO findings against the FULL rule set',
    (slug) => {
      const report = validate(
        graphFor(slug),
        { paletteKey: 'consultation', registry: workflowNodeClassLookup },
        { ruleSetVersion: RULE_SET_VERSION, registryChecksum: registryChecksum(), evaluatedAt: COMPILED_AT },
      );
      // Not `ok` alone: `ok` only means "no ERROR". A clean report must have no WARNINGs either,
      // and printing them is what makes a failure diagnosable rather than a bare `false`.
      expect(report.findings).toEqual([]);
      expect(report.ok).toBe(true);
    },
  );

  it.each(['arcaai-consultation-soap', 'arcaai-rheum-consultation-soap'])(
    '%s: the seeded validationReport is byte-identical to what validate() produces now',
    (slug) => {
      const row = definitionBySlug(slug);
      const report = validate(
        graphFor(slug),
        { paletteKey: 'consultation', registry: workflowNodeClassLookup },
        { ruleSetVersion: RULE_SET_VERSION, registryChecksum: registryChecksum(), evaluatedAt: COMPILED_AT },
      );
      expect(row.validationReport).toEqual(report);
    },
  );

  it.each(['arcaai-consultation-soap', 'arcaai-rheum-consultation-soap'])(
    '%s: the seeded compiledConfig is byte-identical to what compile() produces now',
    (slug) => {
      const row = definitionBySlug(slug);
      const result = compile(graphFor(slug), {
        definitionId: row.id,
        slug: row.slug,
        versionNumber: row.versionNumber,
        tenantId: row.tenantId,
        paletteKey: 'consultation',
        compilerVersion: COMPILER_VERSION,
        registryChecksum: registryChecksum(),
        ruleSetVersion: RULE_SET_VERSION,
        caps: DEFAULT_CAPS,
        policyBindings: DEFAULT_POLICY_BINDINGS,
        compiledAt: COMPILED_AT,
        nodeInfo,
      });
      expect('config' in result).toBe(true);
      expect(row.compiledConfig).toEqual((result as { config: unknown }).config);
      expect(row.compiledConfigChecksum).toBe((result as { config: { checksum: string } }).config.checksum);
    },
  );

  it('carries the CURRENT registry checksum — never the stale one on the SYSTEM row', () => {
    const current = registryChecksum();
    for (const row of ARCAAI_WORKFLOW_DEFINITIONS) {
      expect(row.registryChecksum).toBe(current);
      // The SYSTEM platform-default row's value, computed over a 7-entry registry.
      expect(row.registryChecksum).not.toBe('2ae7222a1e7dc97191309a71a6e438a5088d07174f649d541e1d98878478f97b');
    }
    for (const row of ARCAAI_WORKFLOW_DEFINITIONS) {
      expect((row.compiledConfig as { registryChecksum: string }).registryChecksum).toBe(current);
      // A publish through the real service would stamp these; drifting from them is exactly
      // what made the SYSTEM row's compiledConfig unreproducible.
      expect((row.compiledConfig as { compilerVersion: string }).compilerVersion).toBe(COMPILER_VERSION);
      expect((row.compiledConfig as { caps: { maxNodeSeconds: number } }).caps.maxNodeSeconds).toBe(DEFAULT_CAPS.maxNodeSeconds);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// W2 — the assignment safety guard
// ---------------------------------------------------------------------------------------------
describe(' W2 — WorkflowAssignment is gated on the Substrate-A exclusivity mechanism', () => {
  it('the flag tracks the real presence of the gate, in both directions', () => {
    const gate = detectSubstrateExclusivityGate();
    expect(CONSULTATION_ASSIGNMENT_ENABLED).toBe(gate.present);
  });

  it('writes NO assignment row while the gate is absent', async () => {
    const calls: string[] = [];
    const client = mockClient(calls);
    await seedArcaaiWorkflowAuthoring(client, { assignmentsEnabled: false });

    expect(calls.filter((c) => c.startsWith('workflowAssignment.'))).toEqual([]);
    expect(calls.filter((c) => c.startsWith('workflowAssignmentChange.'))).toEqual([]);
    // …but the definitions and fixtures still land: the workflow is authored and visible in
    // Workflow Studio, it simply governs nothing yet.
    expect(calls.filter((c) => c.startsWith('workflowDefinition.')).length).toBeGreaterThan(0);
  });

  it('says so LOUDLY rather than skipping in silence', async () => {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args.join(' '));
    try {
      await seedArcaaiWorkflowAuthoring(mockClient([]), { assignmentsEnabled: false });
    } finally {
      console.warn = original;
    }
    const message = lines.join('\n');
    expect(message).toMatch(/WorkflowAssignment/);
    expect(message).toMatch(/NOT seeded/);
    expect(message).toMatch(/exclusiv/i);
  });

  it('writes both assignment rows and their WORM change rows once enabled', async () => {
    const calls: string[] = [];
    await seedArcaaiWorkflowAuthoring(mockClient(calls), { assignmentsEnabled: true });
    expect(calls.filter((c) => c === 'workflowAssignment.upsert')).toHaveLength(2);
    expect(calls.filter((c) => c === 'workflowAssignmentChange.create')).toHaveLength(2);
  });

  it('binds one assignment to the tenant and one to the Rheumatology department', () => {
    expect(ARCAAI_WORKFLOW_ASSIGNMENTS).toHaveLength(2);
    const tenantScoped = ARCAAI_WORKFLOW_ASSIGNMENTS.find((a) => a.scope === 'TENANT');
    const deptScoped = ARCAAI_WORKFLOW_ASSIGNMENTS.find((a) => a.scope === 'DEPARTMENT');

    expect(tenantScoped?.scopeId).toBeNull();
    expect(tenantScoped?.workflowDefinitionSlug).toBe('arcaai-consultation-soap');
    expect(deptScoped?.scopeId).toBe(SEED_DEPARTMENT_IDS.RHEUM_ARCAAI);
    expect(deptScoped?.workflowDefinitionSlug).toBe('arcaai-rheum-consultation-soap');

    for (const assignment of ARCAAI_WORKFLOW_ASSIGNMENTS) {
      expect(assignment.tenantId).toBe(SEED_CUSTOMER_TENANT_IDS.ARCAAI);
      expect(assignment.paletteKey).toBe('consultation');
      // Referential: the service's write-time check is "a PUBLISHED definition for this tenant
      // on this palette". Assert the seed cannot violate its own precondition.
      expect(ARCAAI_WORKFLOW_DEFINITIONS.some((d) => d.slug === assignment.workflowDefinitionSlug && d.status === 'PUBLISHED')).toBe(true);
    }
  });

  it('records a creation entry in the append-only change log for each assignment', () => {
    expect(ARCAAI_WORKFLOW_ASSIGNMENT_CHANGES).toHaveLength(2);
    for (const change of ARCAAI_WORKFLOW_ASSIGNMENT_CHANGES) {
      expect(change.beforeSlug).toBeNull();
      expect(change.afterSlug).toBeTruthy();
      expect(change.changedBy).toBe(SEED_USER_IDS.ARCAAI_ADMIN);
    }
  });
});

describe(' W2 — the gate detector itself', () => {
  it('does not mistake a prose mention of the workflow for a governance check', () => {
    // The probed file names `ConsultationLoopWorkflow` in its own docstring. A detector that
    // matched raw text would report the gate present today, which is exactly backwards.
    const gate = detectSubstrateExclusivityGate();
    expect(gate.probedPath).toMatch(/loop-context-signal\.service\.ts$/);
    expect(typeof gate.present).toBe('boolean');
    expect(Array.isArray(gate.evidence)).toBe(true);
  });

  it('reports absent when the probed source has the concept only in comments', () => {
    const source = `
      /** signals the ConsultationLoopWorkflow — see the workflow docs. */
      private async loopAllowedFor(tenantId: string): Promise<boolean> {
        if (this.emergencyStopEngaged) return false; // no workflow here
        return true;
      }`;
    expect(detectSubstrateExclusivityGate({ source }).present).toBe(false);
  });

  it('reports present when executable code consults workflow governance', () => {
    const source = `
      private async loopAllowedFor(tenantId: string, consultationId: string): Promise<boolean> {
        if (await this.workflowGovernance.isGovernedByTenantWorkflow(consultationId)) return false;
        return true;
      }`;
    const gate = detectSubstrateExclusivityGate({ source });
    expect(gate.present).toBe(true);
    expect(gate.evidence.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// W4 — fixtures the sandbox can actually run
// ---------------------------------------------------------------------------------------------
describe(' W4 — WorkflowTestFixture rows', () => {
  it('seeds a definition-scoped fixture and a tenant-wide one', () => {
    expect(ARCAAI_WORKFLOW_TEST_FIXTURES).toHaveLength(2);
    expect(ARCAAI_WORKFLOW_TEST_FIXTURES.filter((f) => f.workflowDefinitionId !== null)).toHaveLength(1);
    expect(ARCAAI_WORKFLOW_TEST_FIXTURES.filter((f) => f.workflowDefinitionId === null)).toHaveLength(1);
  });

  it('carries the run_payload keys every consultation node actually reads', () => {
    for (const fixture of ARCAAI_WORKFLOW_TEST_FIXTURES) {
      for (const key of ['consultationId', 'externalPatientId', 'userId', 'sessionId', 'transcriptText']) {
        expect(Object.keys(fixture.input)).toContain(key);
      }
      expect(fixture.tenantId).toBe(SEED_CUSTOMER_TENANT_IDS.ARCAAI);
      expect(fixture.paletteId).toBe('consultation');
    }
  });

  it('is synthetic — the transcript names no seeded patient and no real-looking identifier', () => {
    for (const fixture of ARCAAI_WORKFLOW_TEST_FIXTURES) {
      expect(fixture.input.externalPatientId).toMatch(/^SYNTH-/);
      expect(fixture.input.transcriptText).not.toMatch(/PAT-\d{8}-\d{3}/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// A minimal recording stand-in for the extended Prisma client.
// ---------------------------------------------------------------------------------------------
function mockClient(calls: string[]): any {
  const model = (name: string) => ({
    findUnique: async (..._a: unknown[]) => {
      calls.push(`${name}.findUnique`);
      return null;
    },
    findFirst: async (..._a: unknown[]) => {
      calls.push(`${name}.findFirst`);
      return null;
    },
    create: async (..._a: unknown[]) => {
      calls.push(`${name}.create`);
      return {};
    },
    upsert: async (..._a: unknown[]) => {
      calls.push(`${name}.upsert`);
      return {};
    },
  });
  return {
    workflowDefinition: model('workflowDefinition'),
    workflowAssignment: model('workflowAssignment'),
    workflowAssignmentChange: model('workflowAssignmentChange'),
    workflowTestFixture: model('workflowTestFixture'),
  };
}

// ---------------------------------------------------------------------------------------------
// Seed-mode posture — these rows claim a HUMAN authored them.
// ---------------------------------------------------------------------------------------------
describe('the tenant-authored rows are excluded from `safe` mode', () => {
  it('names both phases in the safe-mode deny-list', async () => {
    const { SEED_PHASES_EXCLUDED_FROM_SAFE } = await import('../seed-mode');
    // `safe` is documented as "suitable for a production day-1 bootstrap". These rows carry
    // `createdBy: <the ArcaAI tenant admin>` — which is the whole point of R1 in a demo database
    // and a FABRICATED GOVERNANCE ACT in a real one: a published clinical workflow attributed to
    // a named human who never authored it. The same objection that keeps `AgentPromotion` out of
    // this dataset entirely. A real tenant authors its own; the seed must not pre-forge one.
    expect(SEED_PHASES_EXCLUDED_FROM_SAFE).toContain('23-arcaai-workflow-authoring');
    expect(SEED_PHASES_EXCLUDED_FROM_SAFE).toContain('07f-arcaai-department-context-schemas');
  });

  it('keeps the SYSTEM platform default in every mode — only the TENANT-authored rows are gated', async () => {
    const { SEED_PHASES_EXCLUDED_FROM_SAFE } = await import('../seed-mode');
    // `21-workflow-definition` is SYSTEM-owned, `createdBy: SYSTEM_USER_ID`, and asserts no human
    // authorship. It stays platform configuration.
    expect(SEED_PHASES_EXCLUDED_FROM_SAFE).not.toContain('21-workflow-definition');
  });
});

// ---------------------------------------------------------------------------------------------
describe('Lane R (R2) — a pre-summarization node exists BY DEFAULT (owner ruling, §11)', () => {
  const GRAPHS = [
    ['arcaai-consultation-soap', ARCAAI_CONSULTATION_GRAPH],
    ['arcaai-rheum-consultation-soap', ARCAAI_RHEUM_CONSULTATION_GRAPH],
  ] as const;

  it.each(GRAPHS)('%s carries an ACTIVE agent.presummarization node with a prompt bound', (_slug, graph) => {
    // These three predicates are exactly what `PromptResolutionService.resolvePreSummaryPromptId`
    // filters on (`activePresummarizationNodes`). Assert them as a set, because a node that
    // satisfies two of the three resolves to nothing and looks identical in a diff.
    const nodes = (graph.nodes as { id: string; type: string; config?: Record<string, unknown> }[]).filter(
      (node) => node.type === 'agent.presummarization',
    );
    expect(nodes).toHaveLength(1);
    const [node] = nodes;
    expect(node?.config?.enabled).not.toBe(false);
    expect(typeof node?.config?.promptTemplateId).toBe('string');
  });

  it.each(GRAPHS)('%s binds the TENANT’s own pre-summary prompt, not the SYSTEM default', (_slug, graph) => {
    // The ruling's substance: pre-summary is TENANT tier. A tenant node pointing at the platform
    // row would resolve to the platform's bytes and satisfy the letter of "a node exists" while
    // reinstating exactly the silent fallback refuses.
    const node = (graph.nodes as { type: string; config?: Record<string, unknown> }[]).find((n) => n.type === 'agent.presummarization');
    expect(node?.config?.promptTemplateId).toBe(ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY);
    expect(node?.config?.promptTemplateId).not.toBe(SYSTEM_DEFAULT_PRE_SUMMARY_PROMPT_ID);
  });

  it.each(GRAPHS)('%s passes the PUBLISH gate, so every requires[] guard is really attached', (_slug, graph) => {
    // `publishFindings` is the only check that enforces `requires[]`. TASK-890 wired it into
    // `WorkflowDefinitionService.publishEntity`, but a SEED never goes through that service, so
    // this assertion is still the only thing standing between a seeded graph and shipping a
    // generation node whose mandatory guard was never wired.
    // `agent.presummarization` requires `guard.groundedness`; this is what proves it is attached.
    expect(workflowPublishProblems(graph)).toEqual([]);
  });
});
