/**
 * Lane N — the two capabilities recorded as ABSENT, expressed as contract.
 *
 * ##: "important information highlighted — DOES NOT EXIST"
 *
 * The owner's specification for it is a configuration statement, not an algorithm:
 *
 * > "'Important' information or findings will be mined/generated/extracted by agent following a
 * > set of instructions defined/declared/overwriten by tenant admin for using LLM to detect,
 * > extract, picking-up knowledge from consultation context (transcription, consultation context
 * > items, etc...)"
 *
 * So there is NO severity table, NO red-flag term list and NO importance threshold anywhere in
 * this package — a literal of any of those is exactly the hardcoded configuration
 * `00-project-context.md` §Configuration Principles forbids. What the contract owes instead is a
 * node whose INSTRUCTIONS are a bound, tenant-authored prompt template, whose INPUTS are the
 * consultation context the owner named, and whose OUTPUT rides the existing highlight path.
 *
 * ##: grounding, and the ORDERING correction
 *
 * > "Grounding is a set of policies defined/declared/overwriten by tenant admin where LLM will
 * > follow and evaluate the: redacted transcript ..., redacted summary ..., highlighted important
 * > information/findings."
 *
 * Two things fall out, and both are asserted below. Grounding evaluates THREE inputs, not one —
 * `guard.groundedness` declared only `in: document`. And the inputs are REDACTED, so redaction
 * runs BEFORE grounding; earlier programme notes had that order backwards.
 */
import { describe, expect, it } from 'vitest';
import { GROUNDING_POLICY_TARGETS, NODE_CONFIG_SCHEMAS } from '../node-config-schemas';
import { NODE_PORTS } from '../node-ports';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';
import { portPrimitiveSatisfies } from '../port-model';
import { nodeDescriptorContractProblems } from '../port-validation';

const FINDINGS = 'agent.important_findings';
const GROUNDEDNESS = 'guard.groundedness';

describe(`${FINDINGS} — important findings as a tenant-instructed agent node`, () => {
  it('is registered, implemented, and dispatchable as a real interpreter activity', () => {
    const descriptor = WORKFLOW_NODE_REGISTRY[FINDINGS];
    expect(descriptor).toBeDefined();
    expect(descriptor.implemented).toBe(true);
    expect(descriptor.activityName).toBe('interpreter.agent_important_findings');
    expect(descriptor.paletteKey).toBe('consultation');
  });

  it('runs on the REALTIME lane, per turn — the owner asked for findings DURING the session', () => {
    const descriptor = WORKFLOW_NODE_REGISTRY[FINDINGS];
    expect(descriptor.lane).toBe('realtime');
    expect(descriptor.trigger).toBe('per-turn');
    // A realtime retry inside a flush a newer one supersedes is discarded as `stale`, so a second
    // attempt buys latency and nothing else — the same budget shape `agent.grammar` carries.
    expect(descriptor.defaultMaxAttempts).toBe(1);
    expect(descriptor.defaultTimeoutSeconds).toBeLessThan(WORKFLOW_NODE_REGISTRY['agent.ner'].defaultTimeoutSeconds);
  });

  it('satisfies every descriptor contract rule', () => {
    expect(nodeDescriptorContractProblems(WORKFLOW_NODE_REGISTRY[FINDINGS])).toEqual([]);
    expect(WORKFLOW_NODE_REGISTRY[FINDINGS].idempotent).toBe(true);
    expect(WORKFLOW_NODE_REGISTRY[FINDINGS].schemaVersion).toBe(1);
  });

  it('mines the CONSULTATION CONTEXT the owner named — transcript, plus context items', () => {
    const inputs = NODE_PORTS[FINDINGS].inputs;
    // "transcription" — required, and typed `transcript` for the same anti-laundering reason
    // `agent.ner`'s input is: an important finding must be something that was SAID.
    expect(inputs.find((port) => port.name === 'in')).toMatchObject({ primitive: 'transcript', required: true });
    // "consultation context items, etc..." — optional, because a session with no case notes must
    // still surface findings from what was said.
    expect(inputs.find((port) => port.name === 'context')).toMatchObject({ primitive: 'context<schemaRef>', required: false, multiple: true });
    // Detector hints from the SAME flush's NER, so the pass costs one model call rather than a
    // second round trip — the shape `agent.grammar` already uses.
    expect(inputs.find((port) => port.name === 'entities')).toMatchObject({ primitive: 'entities', required: false, multiple: true });
  });

  it('REFUSES a generated document as its source — a hallucinated finding can never be "important"', () => {
    const generated = NODE_PORTS['consultation.realtimeSummary'].outputs.find((port) => port.name === 'out')!;
    expect(generated.primitive).toBe('document');
    // `document` and `transcript` are lattice siblings under `text`, so the edge is a TYPE ERROR.
    expect(portPrimitiveSatisfies(generated.primitive as never, 'transcript')).toBe(false);
  });

  it('produces `entities` under its OWN output key, so findings ride the existing highlight path', () => {
    const output = NODE_PORTS[FINDINGS].outputs.find((port) => port.name === 'out');
    // Same primitive as NER output — that is what lets `groundEntitiesToNote` re-anchor findings
    // into the rendered note with no second anchoring mechanism ( path, reused).
    expect(output).toMatchObject({ primitive: 'entities', required: true, multiple: true });
    // A DISTINCT runtime key, so a consumer can tell a tenant-declared important finding apart
    // from an NER entity rather than merging two different claims into one highlight set.
    expect(output?.outputKey).toBe('findings');
    expect(NODE_PORTS['agent.ner'].outputs.find((port) => port.name === 'out')?.outputKey).toBe('entities');
  });

  it('takes its INSTRUCTIONS from a bound prompt template, never from a literal', () => {
    const schema = NODE_CONFIG_SCHEMAS[FINDINGS];
    const properties = schema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toContain('promptTemplateId');
    expect(Object.keys(properties)).toContain('promptVersionNumber');
    // The owner's sentence is a configuration statement. Anything that reads as a shipped
    // importance taxonomy — a severity ladder, a red-flag list, a criticality threshold — would
    // be the platform deciding what "important" means on the tenant's behalf.
    const serialized = JSON.stringify(schema).toLowerCase();
    for (const forbidden of ['severity', 'redflag', 'red_flag', 'criticalvalue', 'critical_value', 'allergyalert', 'importancethreshold']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('carries no config schema forked from another engine — it has no engine to inherit from', () => {
    // Every other catalogue entry REUSES the schema of the pipeline node it delegates to (DD-9,
    // "do not fork the engine"). This one has no pipeline counterpart, so it owns its schema —
    // the same reason `agent.dna_redaction` and `guard.groundedness` own theirs.
    const shared = Object.entries(NODE_CONFIG_SCHEMAS).filter(([key, schema]) => key !== FINDINGS && schema === NODE_CONFIG_SCHEMAS[FINDINGS]);
    expect(shared).toEqual([]);
  });
});

describe(`${GROUNDEDNESS} — grounding as a set of TENANT-AUTHORED policies`, () => {
  it('still requires the generated document — the redacted summary is what is being grounded', () => {
    expect(NODE_PORTS[GROUNDEDNESS].inputs.find((port) => port.name === 'in')).toMatchObject({ primitive: 'document', required: true });
  });

  it('also accepts the REDACTED TRANSCRIPT and the HIGHLIGHTED FINDINGS the owner named', () => {
    const inputs = NODE_PORTS[GROUNDEDNESS].inputs;
    expect(inputs.find((port) => port.name === 'transcript')).toMatchObject({ primitive: 'transcript', required: false });
    expect(inputs.find((port) => port.name === 'findings')).toMatchObject({ primitive: 'entities', required: false, multiple: true });
  });

  it('adds those inputs ADDITIVELY — no existing port is retyped, so schemaVersion stays 1', () => {
    // A node type is a contract with every saved tenant graph: reshaping a published port is what
    // `schemaVersion`'s `@N` suffix rule exists for. Adding OPTIONAL inputs cannot invalidate a
    // saved graph, so it is not a reshape and needs no new key.
    expect(WORKFLOW_NODE_REGISTRY[GROUNDEDNESS].schemaVersion).toBe(1);
    expect(nodeDescriptorContractProblems(WORKFLOW_NODE_REGISTRY[GROUNDEDNESS])).toEqual([]);
    // The OUTPUT side is untouched — `outputKeys` is the one port field mirrored into Python, so
    // an output change here would be a cross-language parity change.
    expect(NODE_PORTS[GROUNDEDNESS].outputs.map((port) => port.name)).toEqual(['out', 'next']);
  });

  it('declares tenant-authored POLICIES, each one a bound prompt template over a named input', () => {
    const properties = NODE_CONFIG_SCHEMAS[GROUNDEDNESS].properties as Record<string, { items?: { properties?: Record<string, unknown>; required?: string[] } }>;
    const policies = properties.policies;
    expect(policies).toBeDefined();
    expect(Object.keys(policies.items?.properties ?? {}).sort()).toEqual(['appliesTo', 'enabled', 'key', 'promptTemplateId', 'promptVersionNumber']);
    // The instruction is a TEMPLATE reference, so the rubric is authored, versioned and approved
    // through the same governance every other governed prompt goes through.
    expect(policies.items?.required).toContain('promptTemplateId');
  });

  it('scopes each policy to one of the THREE things the owner said grounding evaluates', () => {
    // Not an invented clinical taxonomy: this set IS the node's own evaluation inputs, so it can
    // never drift from what the node can actually be handed.
    expect([...GROUNDING_POLICY_TARGETS]).toEqual(['transcript', 'summary', 'findings']);
    const properties = NODE_CONFIG_SCHEMAS[GROUNDEDNESS].properties as Record<string, { items?: { properties?: Record<string, { enum?: readonly string[] }> } }>;
    expect(properties.policies.items?.properties?.appliesTo?.enum).toEqual([...GROUNDING_POLICY_TARGETS]);
  });

  it('ships NO rubric of its own — the platform never decides what "grounded" means for a tenant', () => {
    const serialized = JSON.stringify(NODE_CONFIG_SCHEMAS[GROUNDEDNESS]).toLowerCase();
    for (const forbidden of ['rubric', 'criteria:', 'defaultpolicy', 'default_policy']) {
      expect(serialized).not.toContain(forbidden);
    }
    // `threshold` survives and is deliberately UNDEFAULTED — `guard-memo.ts` keys its memo on the
    // guard's config precisely because two thresholds are two genuinely different verdicts.
    const threshold = (NODE_CONFIG_SCHEMAS[GROUNDEDNESS].properties as Record<string, Record<string, unknown>>).threshold;
    expect(threshold).toBeDefined();
    expect(threshold.default).toBeUndefined();
  });
});

describe('redaction runs BEFORE grounding — the ordering the owner corrected', () => {
  it('the redactor produces a document the grounding guard can consume', () => {
    const redacted = NODE_PORTS['agent.dna_redaction'].outputs.find((port) => port.name === 'out')!;
    expect(redacted.primitive).toBe('document');
    // The whole ordering claim in one assertion: `agent.dna_redaction -> guard.groundedness.in`
    // is a legal edge, so a graph CAN ground the redacted note.
    expect(portPrimitiveSatisfies(redacted.primitive as never, 'document')).toBe(true);
  });

  it('the reverse is NOT how the chain is meant to run — grounding emits a verdict, not a document', () => {
    // `guard.groundedness -> agent.dna_redaction.in` cannot be wired, because a guard's product
    // is a verdict and the redactor consumes a document. The ordering is therefore structural:
    // redaction can feed grounding, and grounding cannot feed redaction.
    const verdict = NODE_PORTS[GROUNDEDNESS].outputs.find((port) => port.name === 'out')!;
    expect(portPrimitiveSatisfies(verdict.primitive as never, 'document')).toBe(false);
  });
});
