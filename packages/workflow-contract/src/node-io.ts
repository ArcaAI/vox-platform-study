/**
 * TASK-1036 §9.1 (OD-29) — the STANDARD NODE I/O CONTRACT.
 *
 * Ports (`node-ports.ts`) type the CHANNEL an edge draws; this module types the DATA a node takes
 * and returns, field by field. One declaration drives the canvas handles, the binding picker
 * (`binding-source-paths.ts`), the publish type check (`bindings.ts`), the Test tab's "Last run"
 * view, `node.completed` events and the SDK types — one source of truth instead of five.
 *
 * ## The vocabulary
 *
 * `text | number | boolean | date | json | list<T> | audio | file | document`, plus `any`.
 *
 *  - `audio`, `file` and `document` are REFERENCES (a claim-check ref, a media id), never inline
 *    bytes. They never CONVERT to or from anything: handing a transcript to a node that wants a
 *    file, or a recording to one that wants text, is a modelling error, not a formatting choice.
 *  - `list<T>` is a whole value (OD-32). Iteration is an explicit `core.loop`, never implicit.
 *    Two ELEMENT-ONLY names exist for the clinical shapes that only ever travel as lists:
 *    `entity` (an NER span) and `segment` (an ASR utterance).
 *  - `any` is the CONSUMER-SIDE wildcard the owner's node table already uses (`core.output.in`,
 *    the routers' `in`). It accepts everything, references included; as a SOURCE it is unknown
 *    data, which a typed consumer may take only by conversion. It mirrors `ANY_PORT_PRIMITIVE`.
 *
 * ## Field names ARE the runtime keys
 *
 * Every non-agent output field is named after the `outputKey` of the port that carries it today,
 * and every non-agent input after its port. That is what makes the legacy edge → binding
 * translation (`bindings.ts`) faithful by construction: a translated `nodes.<id>.outputs.<key>`
 * reads exactly the key the interpreter threads today. `node-io.task1036.test.ts` pins it.
 *
 * `core.agent` is the exception, deliberately: its sockets depend on the referenced agent's TASK
 * (a per-instance fact), so `agentNodeIO(task)` names them after the agent contract (§9.1 table)
 * and the translation maps the legacy ports onto them (`legacyAgentInputName`).
 */
import { ACTION_CATALOGUE } from './action-catalogue';
import type { AgentTask } from './agent-schemas';
import { NODE_PORTS, type WorkflowNodePorts } from './node-ports';
import type { WorkflowPortPrimitive } from './port-model';

// =============================================================================================
// The type vocabulary
// =============================================================================================

/** The closed base vocabulary (§9.1) plus the consumer wildcard `any`. `list<T>` is built on it. */
export const IO_BASE_TYPES = Object.freeze(['text', 'number', 'boolean', 'date', 'json', 'audio', 'file', 'document', 'any'] as const);
export type IoBaseType = (typeof IO_BASE_TYPES)[number];

/** Element-only names: they appear inside `list<…>` and nowhere else. */
export const IO_ELEMENT_TYPES = Object.freeze(['entity', 'segment'] as const);

/** The three REFERENCE types — never converted, never inlined. */
export const IO_REFERENCE_TYPES: ReadonlySet<string> = new Set(['audio', 'file', 'document']);

/** A node I/O type: a base type, or `list<T>` over a base or element type. A plain string on the wire. */
export type IoType = string;

/** The result of placing a SOURCE value into a TARGET input. */
export type TypeFit = 'match' | 'convert' | 'blocked';

export type PhiClass = 'PHI' | 'NON_PHI';

const BASE_SET: ReadonlySet<string> = new Set(IO_BASE_TYPES);
const ELEMENT_SET: ReadonlySet<string> = new Set(IO_ELEMENT_TYPES);

function listElement(type: string): string | undefined {
  return type.startsWith('list<') && type.endsWith('>') ? type.slice(5, -1) : undefined;
}

function isElementType(type: string): boolean {
  return ELEMENT_SET.has(type) || isIoType(type);
}

/** Whether `value` is a well-formed I/O type. */
export function isIoType(value: unknown): value is IoType {
  if (typeof value !== 'string') return false;
  if (BASE_SET.has(value)) return true;
  const element = listElement(value);
  return element !== undefined && element.length > 0 && isElementType(element);
}

/** Scalars a `json` input takes as-is: every JSON value that is not a reference. */
const JSON_COMPATIBLE: ReadonlySet<string> = new Set(['text', 'number', 'boolean', 'date', 'json', 'entity', 'segment']);
/** What a `text` input takes by FORMATTING it ("Formatted as text"). */
const TEXT_CONVERTIBLE: ReadonlySet<string> = new Set(['number', 'boolean', 'date', 'json']);

function elementFits(target: string, source: string): boolean {
  if (target === source) return true;
  if (target === 'any') return true;
  if (target === 'json') return !IO_REFERENCE_TYPES.has(source) && source !== 'any';
  const targetElement = listElement(target);
  const sourceElement = listElement(source);
  if (targetElement !== undefined && sourceElement !== undefined) return elementFits(targetElement, sourceElement);
  return false;
}

/**
 * Can a value of type `source` feed an input of type `target`?
 *
 *  - `match`   — as-is.
 *  - `convert` — formatted on the way in (a number, date, JSON value or list rendered as text; an
 *    untyped `any` coerced into a scalar). Publish reports it as INFO, never as an error.
 *  - `blocked` — refused. References never convert; `list<entity>` needs `list<entity>`; a
 *    single value never becomes a list, and a list only becomes text by formatting.
 */
export function typeFits(target: IoType, source: IoType): TypeFit {
  if (!isIoType(target) || !isIoType(source)) return 'blocked';
  if (target === 'any' || target === source) return 'match';

  const targetElement = listElement(target);
  const sourceElement = listElement(source);
  if (targetElement !== undefined) {
    return sourceElement !== undefined && elementFits(targetElement, sourceElement) ? 'match' : 'blocked';
  }

  if (IO_REFERENCE_TYPES.has(target) || IO_REFERENCE_TYPES.has(source)) return 'blocked';

  if (source === 'any') return target === 'json' ? 'match' : 'convert';
  if (target === 'json') return sourceElement !== undefined || JSON_COMPATIBLE.has(source) ? 'match' : 'blocked';
  if (target === 'text') return sourceElement !== undefined || TEXT_CONVERTIBLE.has(source) ? 'convert' : 'blocked';
  return 'blocked';
}

// =============================================================================================
// Mapping the other type systems onto this one
// =============================================================================================

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The I/O type a JSON Schema describes. Unknown or untyped is `json` — a value, shape unstated. */
export function ioTypeOfJsonSchema(schema: unknown): IoType {
  const object = asObject(schema);
  const raw = object?.type;
  const types = (Array.isArray(raw) ? raw : [raw]).filter((entry): entry is string => typeof entry === 'string' && entry !== 'null');
  const type = types[0];
  switch (type) {
    case 'string':
      return object?.format === 'date' || object?.format === 'date-time' ? 'date' : 'text';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return `list<${object?.items === undefined ? 'json' : ioTypeOfJsonSchema(object.items)}>`;
    default:
      return 'json';
  }
}

/**
 * The I/O type of a `schemaVariablePaths` entry's `type` — a context-schema PRIMITIVE for a kind
 * (`TEXT`, `STRUCTURED`, …) or a JSON Schema type name for a field (`string`, `integer|null`, …).
 */
export function ioTypeOfVariableType(type: string): IoType {
  switch (type) {
    case 'TEXT':
      return 'text';
    case 'STRUCTURED':
      return 'json';
    case 'DOCUMENT':
      return 'document';
    case 'IMAGE':
      return 'file';
    case 'STREAM_AUDIO':
    case 'AUDIO':
      return 'audio';
    default:
      return ioTypeOfJsonSchema({ type: type.split('|') });
  }
}

/** The I/O type a legacy port primitive carries at runtime. `document` and `transcript` are TEXT values. */
const PORT_PRIMITIVE_IO_TYPE: Readonly<Record<Exclude<WorkflowPortPrimitive, 'control'>, IoType>> = Object.freeze({
  'stream<audio>': 'audio',
  audio: 'audio',
  transcript: 'text',
  text: 'text',
  object: 'json',
  entities: 'list<entity>',
  // A `document` PORT carries the generated text itself (`persistDraft.out` → outputKey `text`),
  // not a file reference — so it is `text` here. The port lattice still keeps document and
  // transcript apart on EDGES (anti-laundering); NodeIO types the value, not its provenance.
  document: 'text',
  edits: 'json',
  verdict: 'json',
  'context<schemaRef>': 'json',
  any: 'any',
});

// =============================================================================================
// The declaration
// =============================================================================================

export interface NodeIOInput {
  readonly type: IoType;
  readonly required: boolean;
  readonly description: string;
}

export interface NodeIOOutput {
  readonly type: IoType;
  readonly description: string;
  /** The PHI class of the VALUE, when the node type can say. Absent = depends on what flowed in. */
  readonly phiClass?: PhiClass;
  /** For a `json` output with a known shape (an agent's structured `data`): its JSON Schema. */
  readonly schema?: Readonly<Record<string, unknown>>;
}

export interface NodeIO {
  readonly inputs: Readonly<Record<string, NodeIOInput>>;
  readonly outputs: Readonly<Record<string, NodeIOOutput>>;
}

function input(type: IoType, required: boolean, description: string): NodeIOInput {
  return Object.freeze({ type, required, description });
}

function output(type: IoType, description: string, phiClass?: PhiClass, schema?: Readonly<Record<string, unknown>>): NodeIOOutput {
  return Object.freeze({ type, description, ...(phiClass === undefined ? {} : { phiClass }), ...(schema === undefined ? {} : { schema }) });
}

function io(inputs: Record<string, NodeIOInput>, outputs: Record<string, NodeIOOutput>): NodeIO {
  return Object.freeze({ inputs: Object.freeze(inputs), outputs: Object.freeze(outputs) });
}

/** One canonical description per agent field, shared by every task that declares it. */
const AGENT_FIELDS = Object.freeze({
  message: input('text', true, 'The text the agent works on: the user turn, or the document to operate on.'),
  context: input('json', false, 'Structured context for the prompt (the run input, or an earlier step`s data).'),
  audio: input('audio', true, 'The recording to transcribe (a reference, never inline bytes).'),
  speechText: input('text', true, 'The text to speak.'),
  nerText: input('text', true, 'The document to extract entities from.'),
});

const AGENT_OUTPUTS = Object.freeze({
  text: output('text', 'The generated text.', 'PHI'),
  transcript: output('text', 'The transcript text, utterances joined in spoken order.', 'PHI'),
  segments: output('list<segment>', 'Per-utterance timing, speaker and correlation over the transcript.', 'PHI'),
  language: output('text', 'The capture-level language the speech was recognised in.', 'NON_PHI'),
  audio: output('audio', 'The synthesised speech (a reference).', 'PHI'),
  durationMs: output('number', 'Length of the synthesised speech, in milliseconds.', 'NON_PHI'),
  entities: output('list<entity>', 'The recognised entities: text, label, character offsets and score.', 'PHI'),
  nerText: output('text', 'The classified text, passed through so a later step still sees the document.', 'PHI'),
});

/** Whether an agent output schema is STRUCTURED — anything beyond the default `{ text }`. */
function isStructuredOutput(outputSchema: Readonly<Record<string, unknown>> | null | undefined): boolean {
  const properties = asObject(outputSchema?.properties);
  if (properties === undefined) return false;
  return Object.keys(properties).some((name) => name !== 'text');
}

/**
 * The I/O of a `core.agent` node whose agent has `task`. A TEXT_GENERATION agent publishes `data`
 * only when its `outputSchema` is structured (anything beyond the default `{ text }`), and `data`
 * then carries that schema so the picker can offer its fields.
 */
export function agentNodeIO(task: AgentTask, outputSchema?: Readonly<Record<string, unknown>> | null): NodeIO {
  switch (task) {
    case 'TEXT_GENERATION':
      return io(
        { message: AGENT_FIELDS.message, context: AGENT_FIELDS.context },
        isStructuredOutput(outputSchema)
          ? {
              text: AGENT_OUTPUTS.text,
              data: output('json', 'The structured result, shaped by the agent`s output schema.', 'PHI', outputSchema as Readonly<Record<string, unknown>>),
            }
          : { text: AGENT_OUTPUTS.text },
      );
    case 'SPEECH_TO_TEXT':
      return io(
        { audio: AGENT_FIELDS.audio },
        { transcript: AGENT_OUTPUTS.transcript, segments: AGENT_OUTPUTS.segments, language: AGENT_OUTPUTS.language },
      );
    case 'TEXT_TO_SPEECH':
      return io({ text: AGENT_FIELDS.speechText }, { audio: AGENT_OUTPUTS.audio, durationMs: AGENT_OUTPUTS.durationMs });
    case 'NAMED_ENTITY_RECOGNITION':
      return io({ text: AGENT_FIELDS.nerText }, { entities: AGENT_OUTPUTS.entities, text: AGENT_OUTPUTS.nerText });
  }
}

/** The I/O an action instance offers, DERIVED from its delegate's port table (inputs by port name, outputs by outputKey). */
function ioFromPorts(ports: WorkflowNodePorts, summary: string): NodeIO {
  const inputs: Record<string, NodeIOInput> = {};
  for (const port of ports.inputs) {
    if (port.primitive === 'control') continue;
    inputs[port.name] = input(PORT_PRIMITIVE_IO_TYPE[port.primitive], port.required, `${summary} — input \`${port.name}\` (${port.primitive}).`);
  }
  const outputs: Record<string, NodeIOOutput> = {};
  for (const port of ports.outputs) {
    if (port.primitive === 'control' || port.outputKey === undefined) continue;
    if (outputs[port.outputKey] !== undefined) continue;
    outputs[port.outputKey] = output(PORT_PRIMITIVE_IO_TYPE[port.primitive], `${summary} — output \`${port.outputKey}\` (${port.primitive}).`);
  }
  return io(inputs, outputs);
}

/** The I/O of one `core.action` instance by its `actionKey`, or `undefined` for an unknown key. */
export function actionNodeIO(actionKey: string): NodeIO | undefined {
  const descriptor = ACTION_CATALOGUE[actionKey];
  return descriptor === undefined ? undefined : ioFromPorts(descriptor.ports, descriptor.label);
}

/**
 * The 11 core node types. `core.agent` is the UNION of every task's sockets, all optional — the
 * honest answer when the task is not known; `agentNodeIO(task)` is the exact one. `core.action`
 * is the static SUPERSET; `actionNodeIO(key)` is the exact one.
 */
export const NODE_IO: Readonly<Record<string, NodeIO>> = Object.freeze({
  'core.trigger': io({}, { context: output('json', 'The validated run input (the Input shape).', 'PHI') }),
  'core.agent': io(
    {
      message: input('text', false, AGENT_FIELDS.message.description),
      context: AGENT_FIELDS.context,
      audio: input('audio', false, AGENT_FIELDS.audio.description),
      text: input('text', false, 'The text to speak (speech) or classify (entity recognition).'),
    },
    {
      text: AGENT_OUTPUTS.text,
      data: output('json', 'The structured result, shaped by the agent`s output schema.', 'PHI'),
      transcript: AGENT_OUTPUTS.transcript,
      segments: AGENT_OUTPUTS.segments,
      language: AGENT_OUTPUTS.language,
      audio: AGENT_OUTPUTS.audio,
      durationMs: AGENT_OUTPUTS.durationMs,
      entities: AGENT_OUTPUTS.entities,
    },
  ),
  'core.classify': io(
    { in: input('any', true, 'What to classify: a transcript, a generated text, or a structured value.') },
    {
      classification: output('json', 'The class taken and its score.', 'NON_PHI'),
      input: output('any', 'The classified input, carried through to the branch taken (OD-19).'),
    },
  ),
  'core.humanReview': io(
    { in: input('any', false, 'What the reviewer is shown.') },
    { decision: output('json', 'The review outcome, reviewer, comment and any edited payload.', 'PHI') },
  ),
  'core.variable': io({ set: input('json', false, 'Values to merge into the run variables.') }, { vars: output('json', 'The run variables after this step.') }),
  'core.condition': io(
    { in: input('any', false, 'The value the conditions read (they may also read the run context).') },
    {
      evaluation: output('json', 'Which branch was taken and whether a condition matched.', 'NON_PHI'),
      input: output('any', 'The router`s input, carried through to the branch taken (OD-19).'),
    },
  ),
  'core.loop': io(
    { in: input('any', false, 'The list to iterate.') },
    { item: output('any', 'The current item, inside the loop body.'), result: output('json', 'What the loop collected when it finished.') },
  ),
  'core.note': io({}, {}),
  'core.output': io({ in: input('any', false, 'The workflow result, validated against the Output shape.') }, {}),
  'core.data': io(
    { in: input('json', true, 'The value to reshape.') },
    { data: output('json', 'The reshaped value.'), text: output('text', 'The reshaped value`s `text` field, when it is text.') },
  ),
  'core.action': ioFromPorts(NODE_PORTS['core.action'] as WorkflowNodePorts, 'Platform action'),
});

/** What a caller resolved about the agent a `core.agent` node references, by slug. */
export interface AgentIOResolution {
  readonly task?: AgentTask;
  readonly outputSchema?: Readonly<Record<string, unknown>> | null;
}

export type AgentIOResolver = Readonly<Record<string, AgentIOResolution>>;

function slugOf(config: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const ref = asObject(config?.agentRef);
  return typeof ref?.slug === 'string' ? ref.slug : undefined;
}

/** The task of the agent a `core.agent` node references, when the resolver knows it. */
export function agentTaskOf(config: Readonly<Record<string, unknown>> | undefined, agents?: AgentIOResolver): AgentTask | undefined {
  const slug = slugOf(config);
  return slug === undefined ? undefined : agents?.[slug]?.task;
}

/**
 * The EXACT I/O of one node instance: an agent by its task, an action by its key, anything else
 * by its type. `undefined` for an unregistered type.
 */
export function nodeIOFor(node: { readonly type: string; readonly config?: Readonly<Record<string, unknown>> }, agents?: AgentIOResolver): NodeIO | undefined {
  if (node.type === 'core.agent') {
    const slug = slugOf(node.config);
    const resolved = slug === undefined ? undefined : agents?.[slug];
    if (resolved?.task !== undefined) return agentNodeIO(resolved.task, resolved.outputSchema);
  }
  if (node.type === 'core.action') {
    const key = node.config?.actionKey;
    const exact = typeof key === 'string' ? actionNodeIO(key) : undefined;
    if (exact !== undefined) return exact;
  }
  return NODE_IO[node.type];
}

// =============================================================================================
// The one envelope every node returns
// =============================================================================================

export interface NodeResultArtifact {
  readonly kind: string;
  readonly ref: string;
  readonly mime: string;
  readonly size: number;
}

/**
 * What every node returns (§9.1). `outputs` holds exactly the node's declared output fields;
 * references (`audio`, `file`, `document`) travel as `artifacts`, never inline.
 */
export interface NodeResultEnvelope {
  readonly status: 'SUCCEEDED' | 'DEGRADED' | 'FAILED' | 'SKIPPED';
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly NodeResultArtifact[];
  readonly usage: { readonly tokens: number; readonly costUnits: number };
  readonly timing: { readonly startedAt: string; readonly durationMs: number };
  readonly error?: { readonly code: string; readonly message: string };
}
