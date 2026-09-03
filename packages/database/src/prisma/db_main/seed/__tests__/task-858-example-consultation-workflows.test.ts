/**
 * the three example consultation workflows.
 *
 * ## What this suite is actually for
 *
 * Two things, and the second is the one worth having.
 *
 *  - **Provenance.** `graph`, `compiledConfig` and the three checksums are
 *    ENGINE OUTPUT. This suite re-runs the REAL `validate()` / `compile()` /
 *    `registryChecksum()` and asserts the seeded literals equal what the engine
 *    produces RIGHT NOW, so a fabricated or stale blob fails CI.
 *  - **The realtime lane each workflow actually yields.** The whole claim of D3
 *    is that these three graphs differ in WHICH AGENTS RUN LIVE. That is not a
 *    property of the graph JSON — it is what `buildRealtimeLane` derives from
 *    the compiled config at flush time, after lane filtering drops every
 *    durable node and every binding whose producer is durable. So the lane is
 *    built with the REAL builder over the REAL committed artifact, exactly as
 *    `task-821-realtime-lane-seeding.test.ts` does. Asserting the node list in
 *    the graph instead would test this file's idea of the runtime.
 *
 * The grammar-fix case is the one that would otherwise ship broken: NER is
 * present-but-disabled there, and "disabled" is a `config.enabled: false` the
 * lane must CARRY rather than a node it must drop. A lane that reported the
 * node absent, or reported it enabled, would both look fine in a graph diff.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ARCAAI_EXAMPLE_WORKFLOW_DEFINITIONS,
  COMPILED_AT,
  EXAMPLE_WORKFLOW_VARIANTS,
  PLATFORM_EXAMPLE_WORKFLOW_DEFINITIONS,
} from '../24-example-consultation-workflows';
import { TEMPLATE_IDS } from '../07-prompt-template';
import { SEED_CUSTOMER_TENANT_IDS, SEED_USER_IDS, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from '../00-constants';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');
const REALTIME_LANE_SRC = path.resolve(HERE, '../../../../../../applications/src/services/consultation/live-documentation/realtime/realtime-lane.ts');

/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { allPathsPassThrough, canonicalJson, compile, nodeInfo, registryChecksum, validate, workflowNodeClassLookup, workflowPublishProblems } =
  contract;
const { buildRealtimeLane }: any = await import(/* @vite-ignore */ REALTIME_LANE_SRC);

/** Mirrors `WorkflowDefinitionService`'s own publish constants — what a REAL publish stamps. */
const COMPILER_VERSION = '0.1.0';
const RULE_SET_VERSION = 1;
const DEFAULT_CAPS = { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 };
const DEFAULT_POLICY_BINDINGS = {
  guardrailProfile: 'STANDARD',
  redactionRuleSetId: null,
  promptTemplateRefs: [],
  documentTemplateRefs: [],
  contextSchemaVersionId: null,
  entitlementKeys: [],
};

const ALL_ROWS = [...PLATFORM_EXAMPLE_WORKFLOW_DEFINITIONS, ...ARCAAI_EXAMPLE_WORKFLOW_DEFINITIONS];
const VARIANT_KEYS = EXAMPLE_WORKFLOW_VARIANTS.map((v) => v.key);
const variantOf = (key: string) => EXAMPLE_WORKFLOW_VARIANTS.find((v) => v.key === key)!;
const rowFor = (key: string, scope: 'platform' | 'arcaai') => {
  const variant = variantOf(key);
  const slug = scope === 'platform' ? variant.platformSlug : variant.arcaaiSlug;
  return ALL_ROWS.find((r) => r.slug === slug)!;
};

// ---------------------------------------------------------------------------------------------
describe(' D3 — six PUBLISHED consultation definitions, three graphs', () => {
  it('seeds three SYSTEM templates and three ArcaAI copies', () => {
    expect(PLATFORM_EXAMPLE_WORKFLOW_DEFINITIONS).toHaveLength(3);
    expect(ARCAAI_EXAMPLE_WORKFLOW_DEFINITIONS).toHaveLength(3);
    expect(new Set(ALL_ROWS.map((r) => r.id)).size).toBe(6);
    expect(new Set(ALL_ROWS.map((r) => r.slug)).size).toBe(6);
  });

  it('names them exactly as specified', () => {
    expect(PLATFORM_EXAMPLE_WORKFLOW_DEFINITIONS.map((r) => r.slug)).toEqual([
      'platform-consultation-grammar-fix',
      'platform-consultation-medical-ner',
      'platform-consultation-ner-grammar-fix',
    ]);
    expect(ARCAAI_EXAMPLE_WORKFLOW_DEFINITIONS.map((r) => r.slug)).toEqual([
      'arcaai-consultation-grammar-fix',
      'arcaai-consultation-medical-ner',
      'arcaai-consultation-ner-grammar-fix',
    ]);
  });

  it.each(ALL_ROWS.map((r) => [r.slug, r] as const))('%s is PUBLISHED, active, v1, consultation palette', (_slug, row) => {
    expect(row.paletteKey).toBe('consultation');
    expect(row.status).toBe('PUBLISHED');
    expect(row.isActive).toBe(true);
    expect(row.versionNumber).toBe(1);
    expect(row.description).toBeTruthy();
  });

  it('attributes the SYSTEM half to SYSTEM and the ArcaAI half to the tenant admin', () => {
    for (const row of PLATFORM_EXAMPLE_WORKFLOW_DEFINITIONS) {
      expect(row.tenantId).toBe(SYSTEM_TENANT_ID);
      expect(row.createdBy).toBe(SYSTEM_USER_ID);
    }
    for (const row of ARCAAI_EXAMPLE_WORKFLOW_DEFINITIONS) {
      expect(row.tenantId).toBe(SEED_CUSTOMER_TENANT_IDS.ARCAAI);
      // The whole claim of the tenant half: a TENANT admin authored it.
      expect(row.createdBy).toBe(SEED_USER_IDS.ARCAAI_ADMIN);
    }
  });

  it('carries NO guardrail, harness-policy or pre-summarization node', () => {
    // The owner put harness policy and guardrail out of scope for this
    // programme. `agent.presummarization` goes with them, not by preference:
    // it declares `requires: ['guard.groundedness']`, so including it would
    // drag the groundedness guard back in through the publish check.
    for (const variant of EXAMPLE_WORKFLOW_VARIANTS) {
      const types = (variant.graph.nodes as any[]).map((n) => n.type);
      expect(types.filter((t) => t.startsWith('guard.') || t.startsWith('guardrail.'))).toEqual([]);
      expect(types).not.toContain('agent.presummarization');
      // …and none of the SOAP graph's extra stages, which stay.
      for (const excluded of [
        'consultation.retrieveEvidence',
        'consultation.bindTerminology',
        'agent.dna_redaction',
        'consultation.suggestions',
        'consultation.proposeCorrections',
        'agent.important_findings',
      ]) {
        expect(types).not.toContain(excluded);
      }
    }
  });

  it('keeps the mandatory consultation subgraph on EVERY route', () => {
    for (const variant of EXAMPLE_WORKFLOW_VARIANTS) {
      for (const through of ['n_capture', 'n_phi', 'n_synth', 'n_sensors']) {
        expect(allPathsPassThrough(variant.graph, ['n_consent'], ['n_gate'], [through]), `${through} is skippable in ${variant.key}`).toBe(true);
      }
      // WF-CONS-012 — and the reason the realtime branches rejoin AT extraction.
      expect(allPathsPassThrough(variant.graph, ['n_capture'], ['n_synth'], ['n_entities'])).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe(' D3 — derived blobs are real compiler output', () => {
  it.each(VARIANT_KEYS)('%s: graphChecksum equals sha256(canonicalJson(graph)) from the real engine', (key) => {
    const variant = variantOf(key);
    expect(variant.graphChecksum).toBe(createHash('sha256').update(canonicalJson(variant.graph)).digest('hex'));
    // Both rows of a variant share the graph, so both share the checksum.
    expect(rowFor(key, 'platform').graphChecksum).toBe(variant.graphChecksum);
    expect(rowFor(key, 'arcaai').graphChecksum).toBe(variant.graphChecksum);
  });

  it('the three graphs are genuinely different', () => {
    expect(new Set(EXAMPLE_WORKFLOW_VARIANTS.map((v) => v.graphChecksum)).size).toBe(3);
  });

  it.each(VARIANT_KEYS)('%s: validate() returns ok with ZERO findings against the FULL rule set', (key) => {
    const report = validate(
      variantOf(key).graph,
      { paletteKey: 'consultation', registry: workflowNodeClassLookup },
      { ruleSetVersion: RULE_SET_VERSION, registryChecksum: registryChecksum(), evaluatedAt: COMPILED_AT },
    );
    // Not `ok` alone: `ok` only means "no ERROR". A clean report has no
    // WARNINGs either, and printing them makes a failure diagnosable.
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(variantOf(key).validationReport).toEqual(report);
  });

  it.each(VARIANT_KEYS)('%s: passes the PUBLISH gate, so every requires[] guard is really attached', (key) => {
    // `workflowPublishProblems` is the only check that enforces `requires[]`,
    // and it has NO production caller — a seeded graph could otherwise ship
    // with a generation node whose mandatory guard was never wired.
    expect(workflowPublishProblems(variantOf(key).graph)).toEqual([]);
  });

  it.each(ALL_ROWS.map((r) => [r.slug, r] as const))('%s: the seeded compiledConfig is byte-identical to compile() now', (_slug, row) => {
    const variant = EXAMPLE_WORKFLOW_VARIANTS.find((v) => v.platformSlug === row.slug || v.arcaaiSlug === row.slug)!;
    const result = compile(variant.graph, {
      definitionId: row.id,
      slug: row.slug,
      versionNumber: 1,
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
  });

  it.each(ALL_ROWS.map((r) => [r.slug, r] as const))('%s: carries the CURRENT registry checksum', (_slug, row) => {
    const current = registryChecksum();
    expect(row.registryChecksum).toBe(current);
    expect((row.compiledConfig as { registryChecksum: string }).registryChecksum).toBe(current);
    expect((row.compiledConfig as { compilerVersion: string }).compilerVersion).toBe(COMPILER_VERSION);
  });
});

// ---------------------------------------------------------------------------------------------
// The REALTIME LANE — what actually runs live, per workflow.
// ---------------------------------------------------------------------------------------------
describe(' D3 — the realtime lane each workflow yields', () => {
  /** `[type, enabled]` for every lane node, flattened in stage order. */
  const laneNodes = (compiled: any): Array<[string, boolean]> =>
    (buildRealtimeLane(compiled)?.stages ?? []).flatMap((stage: any) => stage.nodes.map((n: any) => [n.type, n.enabled] as [string, boolean]));

  const EXPECTED: Record<string, Array<[string, boolean]>> = {
    // Grammar fix: the grammar agent and the running note run; NER is present
    // (WF-CONS-012 requires the node) and switched OFF.
    GRAMMAR_FIX: [
      ['consultation.captureBinding', true],
      ['agent.grammar', true],
      ['consultation.realtimeSummary', true],
      ['consultation.extractEntities', false],
    ],
    MEDICAL_NER: [
      ['consultation.captureBinding', true],
      ['consultation.realtimeSummary', true],
      ['consultation.extractEntities', true],
    ],
    NER_GRAMMAR_FIX: [
      ['consultation.captureBinding', true],
      ['agent.grammar', true],
      ['consultation.realtimeSummary', true],
      ['consultation.extractEntities', true],
    ],
  };

  it.each(VARIANT_KEYS)('%s (platform template): lane node types and enabled flags', (key) => {
    expect(laneNodes(variantOf(key).platformCompiledConfig)).toEqual(EXPECTED[key]);
  });

  it.each(VARIANT_KEYS)('%s (arcaai copy): lane node types and enabled flags', (key) => {
    expect(laneNodes(variantOf(key).arcaaiCompiledConfig)).toEqual(EXPECTED[key]);
  });

  it.each(VARIANT_KEYS)('%s: the running note reads a binding that SURVIVES lane filtering', (key) => {
    // `RealtimeSummaryHandler` reads exactly one input, `boundText(ctx, 'in')`.
    // A binding whose producer is a DURABLE node is dropped by
    // `buildRealtimeLane`, so a transcript sourced anywhere but
    // `consultation.captureBinding` would compile, validate, and then generate
    // the note from `''` on every flush — the defect.
    const lane = buildRealtimeLane(variantOf(key).arcaaiCompiledConfig);
    const all = lane.stages.flatMap((s: any) => s.nodes);
    const capture = all.find((n: any) => n.type === 'consultation.captureBinding');
    const summary = all.find((n: any) => n.type === 'consultation.realtimeSummary');
    const binding = summary.inputs.find((b: any) => b.toPort === 'in');
    expect(binding, 'realtimeSummary has no surviving `in` binding').toBeDefined();
    expect(binding.fromNodeId).toBe(capture.nodeId);
  });

  it.each(['GRAMMAR_FIX', 'NER_GRAMMAR_FIX'])('%s: the grammar pass reads the CAPTURED transcript, not a generated note', (key) => {
    const lane = buildRealtimeLane(variantOf(key).arcaaiCompiledConfig);
    const all = lane.stages.flatMap((s: any) => s.nodes);
    const capture = all.find((n: any) => n.type === 'consultation.captureBinding');
    const grammar = all.find((n: any) => n.type === 'agent.grammar');
    expect(grammar.inputs.find((b: any) => b.toPort === 'in').fromNodeId).toBe(capture.nodeId);
    // An unbound instruction makes prompt resolution THROW and the executor
    // degrade the node — "seeded" in name only.
    expect(grammar.config.promptTemplateId).toBe(TEMPLATE_IDS.LIVE_GRAMMAR_SYSTEM);
    expect(grammar.config.taskKey).toBe('text.live');
  });

  it('the note is NOT queued behind NER — both branches share one stage', () => {
    for (const key of VARIANT_KEYS) {
      const stages = buildRealtimeLane(variantOf(key).arcaaiCompiledConfig).stages;
      const stageOf = (type: string) => stages.find((s: any) => s.nodes.some((n: any) => n.type === type))?.stageIndex;
      expect(stageOf('consultation.captureBinding')).toBe(0);
      expect(stageOf('consultation.realtimeSummary')).toBe(1);
      expect(stageOf('consultation.extractEntities')).toBe(2);
    }
    // The grammar pass runs alongside the note, not after it.
    for (const key of ['GRAMMAR_FIX', 'NER_GRAMMAR_FIX']) {
      const stages = buildRealtimeLane(variantOf(key).arcaaiCompiledConfig).stages;
      const stageOf = (type: string) => stages.find((s: any) => s.nodes.some((n: any) => n.type === type))?.stageIndex;
      expect(stageOf('agent.grammar')).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe(' D3 — seed-mode posture', () => {
  it('gates the ArcaAI half out of `safe` and keeps the SYSTEM templates in', async () => {
    const { SEED_PHASES_EXCLUDED_FROM_SAFE, isPhaseEnabled } = await import('../seed-mode');
    // `createdBy: <the ArcaAI tenant admin>` on a PUBLISHED clinical workflow
    // is a fabricated governance act in a real database — the same objection
    // that gates `23-arcaai-workflow-authoring`.
    expect(SEED_PHASES_EXCLUDED_FROM_SAFE).toContain('24-example-consultation-workflows-arcaai');
    expect(SEED_PHASES_EXCLUDED_FROM_SAFE).not.toContain('24-example-consultation-workflows');
    expect(isPhaseEnabled('24-example-consultation-workflows', 'safe')).toBe(true);
    expect(isPhaseEnabled('24-example-consultation-workflows-arcaai', 'safe')).toBe(false);
  });
});
