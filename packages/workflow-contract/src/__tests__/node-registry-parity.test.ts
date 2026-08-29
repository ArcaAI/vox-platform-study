/**
 * Cross-language parity guard (TASK-734 Task 3): `WORKFLOW_NODE_REGISTRY` (this package) and
 * `NODE_REGISTRY` (`apps/harness/src/harness/temporal/interpreter/registry.py`) must agree on
 * every key, or a definition that validates in the gateway fails admission in the interpreter
 * (see `node-registry.ts`'s module docstring). Neither runtime can import the other's module,
 * so both sides assert against the SAME committed fixture instead of against each other —
 * `test_node_registry_parity.py` is the Python half of this guard.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../docs/implementation/TASK-734-Workflow-Substrate-Second-Pass/contracts/node-registry.snapshot.json',
);

interface FixtureEntry {
  key: string;
  implemented: boolean;
  activityName: string;
  critical: boolean;
  externalWrite: boolean;
  defaultTimeoutSeconds: number;
  defaultMaxAttempts: number;
  entitlementKey: string | null;
  /** TASK-809 OD-15 — the FIRST port field that is SHARED, not TS-only. See the projection below. */
  outputKeys: Record<string, string | null>;
  /** TASK-806 lane A item 7 — the SECOND shared field: it decides which runtime executes a node,
   *  and the durable interpreter has to read it in order to skip a `realtime` one. */
  lane: 'realtime' | 'durable';
}

function loadFixtureEntries(): FixtureEntry[] {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { entries: FixtureEntry[] };
  return raw.entries;
}

/**
 * Projects this package's registry onto exactly the fields the fixture carries — mirrors what
 * the Python test does to `NODE_REGISTRY` on its side.
 *
 * ## `outputKeys` — TASK-809 OD-15 deliberately reopened the parity surface for ONE field
 *
 * Task 10 closed the port contract as TS-only, and the fixture's own `_comment` still says
 * `classes`/`paletteKey` are excluded for that reason. `outputKey` is the exception, and it has
 * to be: it is the ONLY thing that tells `_resolve_bound_inputs` which key of a producing
 * activity's output a socket named `out` actually carries. Leaving it TS-only would put the
 * mapping in a second table, in the other language, free to drift — which is the failure mode
 * this whole fixture exists to prevent.
 *
 * The map is over EVERY output port, not just the data ones: a `null` says "this is a control
 * port, ordering only, it carries no payload", which is what lets the interpreter tell a
 * legitimate ordering edge apart from an edge naming a port that does not exist (the latter
 * raises).
 */
function projectRegistry(): FixtureEntry[] {
  return Object.values(WORKFLOW_NODE_REGISTRY)
    .map((descriptor) => ({
      key: descriptor.key,
      implemented: descriptor.implemented,
      activityName: descriptor.activityName,
      critical: descriptor.critical,
      externalWrite: descriptor.externalWrite,
      defaultTimeoutSeconds: descriptor.defaultTimeoutSeconds,
      defaultMaxAttempts: descriptor.defaultMaxAttempts,
      entitlementKey: descriptor.entitlementKey,
      outputKeys: Object.fromEntries(descriptor.outputs.map((port) => [port.name, port.outputKey ?? null])),
      lane: descriptor.lane,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

describe('WORKFLOW_NODE_REGISTRY <-> registry.py parity fixture', () => {
  it('matches the committed cross-language fixture exactly', () => {
    expect(projectRegistry()).toEqual(loadFixtureEntries());
  });

  it('the fixture is sorted by key (so a diff never looks like an unrelated reorder)', () => {
    const entries = loadFixtureEntries();
    const sorted = entries.slice().sort((a, b) => a.key.localeCompare(b.key));
    expect(entries).toEqual(sorted);
  });

  it('carries exactly the seed + boundary + summarization + stt + consultation + endpoint-stage keys, no more, no less', () => {
    expect(Object.keys(WORKFLOW_NODE_REGISTRY).sort()).toEqual([
      // TASK-806 lane A — the target catalogue (DD-6/DD-9) and the guards (DD-7).
      'agent.discharge_summary',
      'agent.dna_redaction',
      'agent.feedback',
      // Lane R (R1) — the realtime grammar/spelling pass.
      'agent.grammar',
      // Lane N (TASK-815 §14a) — the first catalogue entry with NO pipeline counterpart: important
      // findings did not exist in any form, so this is a real implementation rather than a delegation.
      'agent.important_findings',
      'agent.ner',
      'agent.normalization',
      'agent.presummarization',
      'agent.retrieval',
      'agent.summarization',
      'agent.transcription',
      'consultation.assemblePrompt',
      'consultation.bindTerminology',
      'consultation.captureBinding',
      'consultation.consentGate',
      'consultation.extractEntities',
      'consultation.finalizeAssurance',
      'consultation.hitlGate',
      'consultation.inferentialSensors',
      'consultation.persistDraft',
      'consultation.phiHop',
      'consultation.proposeCorrections',
      'consultation.realtimeSummary',
      'consultation.retrieveEvidence',
      'consultation.sensors',
      'consultation.suggestions',
      'consultation.synthesize',
      'core.end',
      'core.start',
      // TASK-812 — the endpoint stage. Sorted position, not pipeline position; the list is
      // asserted sorted so a future addition never looks like a reorder.
      'feedback.capture',
      'generate.text',
      'guard.groundedness',
      'guard.moderation',
      'guard.phi',
      'guardrail.check',
      'input.context_binding',
      'noop',
      'output.deliver',
      'passthrough',
      'prompt.template_ref',
      'session.timeout',
      'stt.asrEngine',
      'stt.audioInput',
      'stt.diarization',
      'stt.languageDetection',
      'stt.noiseFilter',
      'stt.phiHop',
      'stt.transcriptOutput',
      'stt.vad',
      'summary.finalize',
    ]);
  });
});
