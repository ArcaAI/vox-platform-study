/**
 * TASK-893 Phase 2 — the ACTION CATALOGUE behind `core.action`, as a FIRST-CLASS table.
 *
 * ## Why this is its own table
 *
 * Until this ticket `ACTION_CATALOGUE` was a filtered VIEW of the node registry: every action a
 * `core.action` node could perform was a deprecated legacy node type still resident in
 * `WORKFLOW_NODE_REGISTRY`, and `actionDelegateOf()` returned that legacy descriptor. That is why
 * the deprecated entries could never be deleted — they were the implementation, not residue
 * (TASK-893 README §2.7). Promoting the catalogue to a table of its own is what lets Phase 4
 * retire the legacy vocabulary without deleting a single capability.
 *
 * ## What an action descriptor is
 *
 * Exactly what the interpreter and the Studio need to run and author one fixed-purpose clinical
 * step: its config schema (validated under the node's `action` sub-config), its ports (the
 * instance's EFFECTIVE sockets), its safety flags, the Temporal activity it dispatches, and the
 * runtime lane that owns it. Every value was copied VERBATIM from the registry entry it replaces
 * (INTERFACES §7.2); the `summary` is the one new field — plain-language copy for the inspector.
 *
 * ## The cross-language constraint
 *
 * `apps/harness/src/harness/temporal/interpreter/action_catalogue.py` is the runtime twin. Both
 * project onto `__tests__/fixtures/action-catalogue.snapshot.json` (regenerate:
 * `pnpm --filter @arcaai/workflow-contract regen:action-snapshot`), exactly as the node registry
 * does — see `node-registry.ts`'s module docstring for why a shared fixture and not a cross-import.
 */
import { NODE_CONFIG_SCHEMAS, type NodeConfigSchema } from './node-config-schemas';
import { NODE_PORTS, type WorkflowNodePorts } from './node-ports';
import type { WorkflowNodeLane } from './node-registry';

/** The port set an action instance offers — `WorkflowNodePorts` under the contract's name. */
export type NodePortSet = WorkflowNodePorts;

export interface CoreActionDescriptor {
  /** The `actionKey` a `core.action` node carries. */
  readonly key: string;
  readonly label: string;
  /** ≤ 80 characters, plain language — what the inspector shows beside the key. */
  readonly summary: string;
  /** The Temporal-registered activity name the interpreter dispatches. */
  readonly activityName: string;
  /** The schema the node's `action` sub-config must satisfy. */
  readonly configSchema: NodeConfigSchema;
  /** The instance's effective sockets (`effectivePorts('core.action', config)`). */
  readonly ports: NodePortSet;
  /** Registry-style classes — `classesOf()` resolves a `core.action` instance to these ∪ `{'action'}`. */
  readonly classes: readonly string[];
  readonly critical: boolean;
  readonly externalWrite: boolean;
  readonly defaultTimeoutSeconds: number;
  readonly defaultMaxAttempts: number;
  readonly lane: WorkflowNodeLane;
  readonly entitlementKey?: string;
  /** The runtime keys of the DATA output ports, in port order (`ports.outputs[].outputKey`). */
  readonly outputKeys: readonly string[];
}

/** The dispatch half of a descriptor — everything a schema/port table does not hold. */
interface ActionDispatch {
  readonly label: string;
  readonly summary: string;
  readonly activityName: string;
  readonly classes: readonly string[];
  readonly critical: boolean;
  readonly externalWrite: boolean;
  readonly defaultTimeoutSeconds: number;
  readonly defaultMaxAttempts: number;
  readonly lane: WorkflowNodeLane;
  readonly entitlementKey?: string;
}

/**
 * The 17 kept action keys, in contract order (INTERFACES §7.2). The 17 agent-shaped keys the
 * old view also carried (`consultation.captureBinding`, `consultation.extractEntities`,
 * `consultation.assemblePrompt`, `consultation.realtimeSummary`, `consultation.suggestions`,
 * `consultation.proposeCorrections`, `agent.*`, `guardrail.check`, `agentic.guardrail`) are
 * `core.agent` now and are NOT actions.
 */
const ACTION_DISPATCH: Readonly<Record<string, ActionDispatch>> = Object.freeze({
  'consultation.consentGate': Object.freeze({
    label: 'Consent gate',
    summary: 'Checks the patient’s consent before any clinical processing starts.',
    activityName: 'interpreter.consultation_consent_gate',
    classes: Object.freeze(['consentGate', 'mandatory']),
    critical: true,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 3,
    lane: 'durable',
  }),
  'consultation.bindTerminology': Object.freeze({
    label: 'Bind terminology',
    summary: 'Maps extracted entities to standard clinical codes.',
    activityName: 'interpreter.consultation_bind_terminology',
    classes: Object.freeze(['activity']),
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 1,
    lane: 'durable',
  }),
  'consultation.phiHop': Object.freeze({
    label: 'Phi hop',
    summary: 'Redacts personal health information from the transcript.',
    activityName: 'interpreter.consultation_phi_hop',
    classes: Object.freeze(['activity', 'redaction', 'mandatory']),
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    lane: 'durable',
  }),
  'consultation.retrieveEvidence': Object.freeze({
    label: 'Retrieve evidence',
    summary: 'Looks up supporting evidence for the extracted entities.',
    activityName: 'interpreter.consultation_retrieve_evidence',
    classes: Object.freeze(['activity']),
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    lane: 'durable',
  }),
  'consultation.sensors': Object.freeze({
    label: 'Sensors',
    summary: 'Runs the safety checks over the draft note.',
    activityName: 'interpreter.consultation_sensors',
    classes: Object.freeze(['activity']),
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    lane: 'durable',
  }),
  'consultation.inferentialSensors': Object.freeze({
    label: 'Inferential sensors',
    summary: 'Runs the deeper, model-based safety checks over the draft note.',
    activityName: 'interpreter.consultation_inferential_sensors',
    classes: Object.freeze(['activity']),
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 900,
    defaultMaxAttempts: 2,
    lane: 'durable',
  }),
  'consultation.persistDraft': Object.freeze({
    label: 'Persist draft',
    summary: 'Saves the draft note into the consultation.',
    activityName: 'interpreter.consultation_persist_draft',
    classes: Object.freeze(['activity', 'mandatory']),
    critical: false,
    externalWrite: true,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 3,
    lane: 'durable',
  }),
  'consultation.finalizeAssurance': Object.freeze({
    label: 'Finalize assurance',
    summary: 'Records the assurance verdicts on the saved draft.',
    activityName: 'interpreter.consultation_finalize_assurance',
    classes: Object.freeze(['activity', 'mandatory']),
    critical: false,
    externalWrite: true,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 3,
    lane: 'durable',
  }),
  'guard.phi': Object.freeze({
    label: 'Phi',
    summary: 'Screens text for personal health information and redacts it.',
    activityName: 'interpreter.guard_phi',
    classes: Object.freeze(['guard', 'redaction']),
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    lane: 'durable',
  }),
  'guard.moderation': Object.freeze({
    label: 'Moderation',
    summary: 'Screens text for unsafe or inappropriate content.',
    activityName: 'interpreter.guard_moderation',
    classes: Object.freeze(['guard']),
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    lane: 'durable',
  }),
  'guard.groundedness': Object.freeze({
    label: 'Groundedness',
    summary: 'Checks that the note is grounded in what was actually said.',
    activityName: 'interpreter.guard_groundedness',
    classes: Object.freeze(['guard']),
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 150,
    defaultMaxAttempts: 2,
    lane: 'durable',
  }),
  'session.timeout': Object.freeze({
    label: 'Timeout',
    summary: 'Closes an idle session and records why it ended.',
    activityName: 'interpreter.session_timeout',
    classes: Object.freeze(['activity', 'endpoint']),
    critical: false,
    externalWrite: true,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 3,
    lane: 'durable',
  }),
  'feedback.capture': Object.freeze({
    label: 'Capture',
    summary: 'Records an accepted transcript correction.',
    activityName: 'interpreter.feedback_capture',
    classes: Object.freeze(['activity', 'endpoint']),
    critical: false,
    externalWrite: true,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 3,
    lane: 'durable',
  }),
  'livedoc.stop': Object.freeze({
    label: 'Stop',
    summary: 'Stops the live documentation session.',
    activityName: 'interpreter.livedoc_stop',
    classes: Object.freeze(['activity', 'endpoint']),
    critical: false,
    externalWrite: true,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 3,
    lane: 'durable',
  }),
  'harness.finalize': Object.freeze({
    label: 'Finalize',
    summary: 'Marks the point where the documentation workflow finishes.',
    activityName: 'interpreter.harness_finalize',
    classes: Object.freeze(['activity', 'endpoint']),
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 3,
    lane: 'durable',
  }),
  'summary.finalize': Object.freeze({
    label: 'Finalize',
    summary: 'Locks every document of the consultation.',
    activityName: 'interpreter.summary_finalize',
    classes: Object.freeze(['activity', 'endpoint']),
    critical: false,
    externalWrite: true,
    defaultTimeoutSeconds: 60,
    defaultMaxAttempts: 3,
    lane: 'durable',
  }),
  'prompt.template_ref': Object.freeze({
    label: 'Template ref',
    summary: 'Loads a prompt template by reference.',
    activityName: 'interpreter.template_ref',
    classes: Object.freeze(['activity']),
    critical: false,
    externalWrite: false,
    defaultTimeoutSeconds: 30,
    defaultMaxAttempts: 3,
    lane: 'durable',
  }),
});

/** The kept action keys, in contract order. */
export const ACTION_KEYS: readonly string[] = Object.freeze(Object.keys(ACTION_DISPATCH));

function descriptorOf(key: string, dispatch: ActionDispatch): CoreActionDescriptor {
  const configSchema = NODE_CONFIG_SCHEMAS[key];
  const ports = NODE_PORTS[key];
  if (configSchema === undefined || ports === undefined) {
    // A table that lost a row is a capability that vanished; fail at module load, not at publish.
    throw new Error(`action catalogue: \`${key}\` has no ${configSchema === undefined ? 'config schema' : 'port table'}`);
  }
  return Object.freeze({
    key,
    ...dispatch,
    configSchema,
    ports,
    outputKeys: Object.freeze(ports.outputs.flatMap((port) => (port.outputKey ? [port.outputKey] : []))),
  });
}

/** `actionKey -> descriptor`. */
export const ACTION_CATALOGUE: Readonly<Record<string, CoreActionDescriptor>> = Object.freeze(
  Object.fromEntries(Object.entries(ACTION_DISPATCH).map(([key, dispatch]) => [key, descriptorOf(key, dispatch)])),
);

/** The catalogue descriptor a `core.action` instance delegates to, or `undefined` for an unknown key. */
export function actionDelegateOf(config: Readonly<Record<string, unknown>> | undefined): CoreActionDescriptor | undefined {
  const key = config?.actionKey;
  return typeof key === 'string' ? ACTION_CATALOGUE[key] : undefined;
}
