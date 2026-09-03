/**
 * the two REGISTERED-BUT-UNSEEDED realtime capabilities, as they are actually SEEDED.
 *
 * reported both, and had already recorded the first as *"Made to work"*. It was
 * made POSSIBLE. This suite is what makes it HAPPEN, and it is written against the two properties
 * that were actually false rather than against a shape:
 *
 *  - **`agent.grammar` runs for at least one tenant.** Lane R added the node type, the realtime
 *    handler and the Python activity; neither ArcaAI graph contained the node, so the live grammar
 *    pass ran for nobody. A node that is merely present is still not enough — an unbound
 *    instruction makes `resolveGovernedNodePrompt` throw and the executor degrade it — so the
 *    binding is asserted alongside the placement.
 *  - **`consultation.realtimeSummary` receives the transcript.** Its `in: transcript` was unwired
 *    in both graphs while its unread `entities` port was wired, so the ONE port the realtime
 *    handler reads (`boundText(ctx, 'in')`) resolved to `''` in graph mode.
 *
 * ## Why the placements are asserted as INVARIANTS, not as edges
 *
 * Both nodes sit between `captureBinding` and `extractEntities`, and neither placement was
 * chosen. Two independent constraints force it, and the tests below state both so that a later
 * "tidy-up" moving either edge goes red for the right reason:
 *
 *  1. **The rule set.** WF-CONS-012 is an `allPathsPassThrough` check, so a branch off capture
 *     that rejoined anywhere downstream of `extractEntities` would open a route around it;
 *     rejoining after synthesis would skip the PHI hop (WF-CONS-009) and synthesis (WF-CONS-010).
 *  2. **Lane filtering.** `buildRealtimeLane` DROPS a binding whose producer is not itself a
 *     realtime node, so a transcript wired from a durable producer (`consultation.phiHop.out` is
 *     also `transcript`-typed) would be silently unbound again at flush time. The only realtime
 *     producer of `transcript` is `consultation.captureBinding`.
 *
 * ## The lane assertion runs the REAL builder over the REAL committed artifact
 *
 * `buildRealtimeLane` is imported from `packages/applications` BY COMPUTED PATH, for the same
 * reason `task-798-arcaai-workflow-authoring.test.ts` imports the engine that way: `packages/
 * database` deliberately takes no dependency on either package. Replicating the filter here
 * instead would test this file's idea of the lane rather than the runtime's.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ARCAAI_CONSULTATION_GRAPH, ARCAAI_RHEUM_CONSULTATION_GRAPH } from '../23-arcaai-workflow-authoring';
import { GEN_COMPILED_CONFIG, RHEUM_COMPILED_CONFIG } from '../23-arcaai-workflow-authoring.generated';
import { DEFAULT_PROMPT_TEMPLATES, TEMPLATE_IDS } from '../07-prompt-template';
import { SYSTEM_TENANT_ID } from '../00-constants';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');
const REALTIME_LANE_SRC = path.resolve(HERE, '../../../../../../applications/src/services/consultation/live-documentation/realtime/realtime-lane.ts');

/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { allPathsPassThrough, registryChecksum, validate, workflowNodeClassLookup, workflowPublishProblems } = contract;
const { buildRealtimeLane }: any = await import(/* @vite-ignore */ REALTIME_LANE_SRC);

const GRAPHS: Array<[string, any]> = [
  ['general medicine', ARCAAI_CONSULTATION_GRAPH],
  ['rheumatology', ARCAAI_RHEUM_CONSULTATION_GRAPH],
];
const COMPILED: Array<[string, any]> = [
  ['general medicine', GEN_COMPILED_CONFIG],
  ['rheumatology', RHEUM_COMPILED_CONFIG],
];

const nodeOf = (graph: any, id: string) => graph.nodes.find((n: any) => n.id === id);
const edge = (graph: any, from: string, to: string) => graph.edges.find((e: any) => e.from === from && e.to === to);

/** Every node of the compiled realtime lane, flattened, with its SURVIVING bindings. */
const laneNodes = (compiled: any) => (buildRealtimeLane(compiled)?.stages ?? []).flatMap((stage: any) => stage.nodes);
const laneNode = (compiled: any, type: string) => laneNodes(compiled).find((n: any) => n.type === type);
/** `true` when this lane node has a binding INTO `toPort` that survived lane filtering. */
const laneBound = (compiled: any, type: string, toPort: string) => (laneNode(compiled, type)?.inputs ?? []).some((b: any) => b.toPort === toPort);

describe('§17e — `agent.grammar` is SEEDED, so the live grammar pass runs for a tenant', () => {
  it.each(GRAPHS)('%s: the node is present and bound to a tenant-overridable instruction', (_label, graph) => {
    expect(nodeOf(graph, 'n_grammar')?.type).toBe('agent.grammar');
    // A node with no bound instruction is not "seeded" in any useful sense: the realtime handler's
    // prompt resolution THROWS on an unbound template and the executor degrades the node, which is
    // the same "runs for nobody" outcome in a different costume.
    expect(nodeOf(graph, 'n_grammar').config.promptTemplateId).toBe(TEMPLATE_IDS.LIVE_GRAMMAR_SYSTEM);
  });

  it.each(GRAPHS)('%s: it corrects what was SAID, never what a model WROTE', (_label, graph) => {
    expect(edge(graph, 'n_capture', 'n_grammar')).toMatchObject({ fromPort: 'out', toPort: 'in' });
    // The laundering path, asserted absent. `agent.grammar.in` is `transcript` precisely so no
    // generation node can be wired in; this pins the seed to that intent as well as the type.
    for (const generator of ['n_synth', 'n_realtime', 'n_presum', 'n_dna']) {
      expect(edge(graph, generator, 'n_grammar')).toBeUndefined();
    }
  });

  it.each(GRAPHS)('%s: it is ordered INTO extraction, so no route skips `extractEntities`', (_label, graph) => {
    expect(edge(graph, 'n_grammar', 'n_entities')).toMatchObject({ fromPort: 'next', toPort: 'after' });
    expect(allPathsPassThrough(graph, ['n_capture'], ['n_synth'], ['n_entities'])).toBe(true);
  });

  it.each(GRAPHS)('%s: it stays ADVISORY — nothing consumes its `edits`', (_label, graph) => {
    // `out: edits` is a proposal surface. Promotion happens only through the accepted-proposal
    // path; an edge out of `out` would be a second promotion channel the clinician never approved.
    expect(graph.edges.filter((e: any) => e.from === 'n_grammar' && e.fromPort === 'out')).toEqual([]);
  });

  it.each(GRAPHS)('%s: the durable correction sibling is NOT deleted by seeding the realtime one', (_label, graph) => {
    // Lane R: flipping `consultation.proposeCorrections` to realtime would have removed
    // the note-level pass from every graph. The two coexist, over different inputs.
    expect(nodeOf(graph, 'n_correct')?.type).toBe('consultation.proposeCorrections');
    expect(edge(graph, 'n_synth', 'n_correct')).toMatchObject({ fromPort: 'out', toPort: 'in' });
  });
});

describe('§17e — `consultation.realtimeSummary` receives a TRANSCRIPT, not an empty string', () => {
  it.each(GRAPHS)('%s: its `in` port is wired from the capture node', (_label, graph) => {
    expect(edge(graph, 'n_capture', 'n_realtime')).toMatchObject({ fromPort: 'out', toPort: 'in' });
  });

  it.each(GRAPHS)('%s: it no longer waits on NER through an `entities` port nothing reads', (_label, graph) => {
    // Two reasons this edge is gone rather than kept alongside the new one. It is a CYCLE once
    // the summary is ordered into extraction; and the platform-default lane leaves the same port
    // unwired on purpose — wiring it "would make the note wait for NER, serialising the two
    // calls". The seeded graph now agrees with the lane it is supposed to be parity with.
    expect(edge(graph, 'n_entities', 'n_realtime')).toBeUndefined();
  });

  it.each(GRAPHS)('%s: it is ordered INTO extraction, exactly like the other two capture branches', (_label, graph) => {
    expect(edge(graph, 'n_realtime', 'n_entities')).toMatchObject({ fromPort: 'next', toPort: 'after' });
    // ...and the ordering edge that used to jump straight to terminology is gone with it: keeping
    // it would open `capture -> realtime -> terms -> ... -> synth`, the route WF-CONS-012 refuses.
    expect(edge(graph, 'n_realtime', 'n_terms')).toBeUndefined();
  });
});

describe('the COMPILED, COMMITTED artifact yields a realtime lane that can actually run', () => {
  it.each(COMPILED)('%s: the lane contains `agent.grammar`, bound to the captured transcript', (_label, compiled) => {
    expect(laneNode(compiled, 'agent.grammar')).toBeDefined();
    expect(laneBound(compiled, 'agent.grammar', 'in')).toBe(true);
  });

  it.each(COMPILED)('%s: the lane binds `realtimeSummary.in` — the port the handler reads', (_label, compiled) => {
    // THE DEFECT, as a test. `RealtimeSummaryHandler` reads exactly one input,
    // `boundText(ctx, 'in')`; with no surviving binding for it the running note was generated
    // from `''` on every flush of every graph-mode session.
    expect(laneBound(compiled, 'consultation.realtimeSummary', 'in')).toBe(true);
  });

  it.each(COMPILED)('%s: every transcript binding survives lane filtering — the producer is realtime', (_label, compiled) => {
    // The second constraint that forced the placement. A binding whose producer is a DURABLE node
    // is dropped by `buildRealtimeLane`, so a transcript sourced from (say) `consultation.phiHop`
    // — also `transcript`-typed — would compile, validate, and then be unbound at flush time.
    const capture = laneNode(compiled, 'consultation.captureBinding');
    expect(capture).toBeDefined();
    for (const type of ['agent.grammar', 'agent.important_findings', 'consultation.extractEntities', 'consultation.realtimeSummary']) {
      const binding = (laneNode(compiled, type)?.inputs ?? []).find((b: any) => b.toPort === 'in');
      expect(binding, `${type} has no surviving \`in\` binding`).toBeDefined();
      expect(binding.fromNodeId).toBe(capture.nodeId);
    }
  });

  it.each(COMPILED)('%s: the three capture branches share ONE stage — the note is not queued behind NER', (_label, compiled) => {
    const stages = buildRealtimeLane(compiled).stages;
    const stageOf = (type: string) => stages.find((s: any) => s.nodes.some((n: any) => n.type === type))?.stageIndex;
    expect(stageOf('consultation.captureBinding')).toBe(0);
    expect(stageOf('agent.grammar')).toBe(1);
    expect(stageOf('agent.important_findings')).toBe(1);
    expect(stageOf('consultation.realtimeSummary')).toBe(1);
    expect(stageOf('consultation.extractEntities')).toBe(2);
  });
});

describe('the platform-default grammar instruction is a SYSTEM row, and it is the only one', () => {
  it('it is seeded, SYSTEM-tenant and approved', () => {
    const row = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === TEMPLATE_IDS.LIVE_GRAMMAR_SYSTEM)!;
    expect(row, 'the live grammar instruction is not seeded').toBeDefined();
    // `PromptTemplate` is a SYSTEM_SHARED_READ_MODEL, so a SYSTEM row is the FALLBACK every tenant
    // inherits. Seeding it under the "Global" CUSTOMER tenant would make one customer's
    // configuration the platform default for everyone.
    expect(row.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(row.approvedVersionNumber).toBe(1);
    // The row carries no `status` of its own, and must not: `seedPromptTemplate` DERIVES it with
    // `resolvePromptStatus(category)`, which publishes everything except `DNA_ANALYSIS`. That
    // derivation is load-bearing here — the realtime handler refuses a template that is not
    // APPROVED — so the category is the thing worth pinning.
    expect(row.category).toBe('SYSTEM');
  });

  it('it speaks the verifier’s wire contract and nothing clinical', () => {
    const content = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === TEMPLATE_IDS.LIVE_GRAMMAR_SYSTEM)!.content;
    // The three categories are the CLOSED wire vocabulary `verifyCorrectionProposals` enforces at
    // both producers, not a clinical taxonomy the platform is inventing on a tenant's behalf. A
    // proposal in any other category is dropped, so the instruction has to name them.
    for (const category of ['spelling', 'medicalTerm', 'drugName']) expect(content).toContain(category);
    // The patient-safety half: this pass proposes, and it must never be told it may apply.
    for (const forbidden of ['dose', 'apply']) expect(content.toLowerCase()).toContain(forbidden);
  });
});

describe('both graphs still validate after the two insertions', () => {
  it.each(GRAPHS)('%s: validate() reports no findings', (_label, graph) => {
    const report = validate(
      graph,
      { paletteKey: 'consultation', registry: workflowNodeClassLookup },
      { ruleSetVersion: 1, registryChecksum: registryChecksum() },
    );
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it.each(GRAPHS)('%s: workflowPublishProblems is empty', (_label, graph) => {
    expect(workflowPublishProblems(graph)).toEqual([]);
  });

  it.each(GRAPHS)('%s: the four mandatory hops are still on EVERY route to the terminal', (_label, graph) => {
    for (const through of ['n_capture', 'n_phi', 'n_synth', 'n_sensors']) {
      expect(allPathsPassThrough(graph, ['n_consent'], ['n_gate'], [through]), `${through} is skippable`).toBe(true);
    }
  });
});
