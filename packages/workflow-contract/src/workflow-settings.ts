/**
 * TASK-1036 §3.5 (R16, R17; OD-4, D-3/OD-5, D-4) — WORKFLOW SETTINGS.
 *
 * ## Where they live
 *
 * `graph.settings`, inside the graph JSON (D-3 / OD-5): checksummed, frozen at publish, exported in
 * bundles and versioned with the graph, with no new column. `WorkflowGraph` (`graph-model.ts`)
 * does not name the key yet; `workflowGraphProblems` ignores unknown top-level keys, so a graph
 * carrying it is already shape-valid, and this module reads it through `graphSettingsOf`.
 *
 * ## What they say (OD-4)
 *
 *  - `connections` — how a CALLER reaches the workflow: `api` (POST runs), `webhook`, `sse`
 *    (stream a run), `socket` (the WS run stream, and live audio).
 *  - `sources` — the platform's own entry points: `consultation` (session open) and `schedule`.
 *  - `contextSchema` — the Input shape: a reference `{ contextSchemaId, versionNumber | null }`
 *    (`null` = follow latest, TASK-982) or `{ inline }`.
 *
 * ## One release of legacy (D-4)
 *
 * `effectiveSettings` reads `settings` first and otherwise derives them from the trigger's `kinds`
 * and the output's `protocols` (`consultation`/`schedule` → sources; `api`/`webhook` →
 * connections; `http` → api, `http-sse` → sse, `socket` → socket). After that release the legacy
 * keys are removed (deprecation register).
 *
 * ## Implications (WF-SET-001..004)
 *
 * `sse` ⇒ `api`; `socket` ⇒ `api`; an ASR / TTS agent node or a STREAM audio kind ⇒ `socket`;
 * BLOB audio or an attachment ⇒ `api`. Exemption (contract freeze): an ASR node does NOT force
 * `socket` when `sources` includes `consultation` — its audio arrives on the consultation SESSION
 * socket, not on the workflow's run socket. A TTS node and a STREAM audio kind keep the rule. The settings dialog applies the same list live (a locked
 * checkbox with its reason) — `settingsImplications` is the one derivation both read.
 *
 * Mirrored in Python (lane B1) against `tests/contracts/workflow-settings.fixture.json`.
 */
import type { WorkflowGraph } from './graph-model';
import { agentTaskOf, type AgentIOResolver } from './node-io';

export const WORKFLOW_CONNECTIONS = Object.freeze(['api', 'webhook', 'sse', 'socket'] as const);
export type WorkflowConnection = (typeof WORKFLOW_CONNECTIONS)[number];

export const WORKFLOW_SOURCES = Object.freeze(['consultation', 'schedule'] as const);
export type WorkflowSource = (typeof WORKFLOW_SOURCES)[number];

export type WorkflowContextSchemaSetting =
  { readonly contextSchemaId: string; readonly versionNumber: number | null } | { readonly inline: Readonly<Record<string, unknown>> };

export interface WorkflowSettings {
  readonly connections: readonly WorkflowConnection[];
  readonly sources: readonly WorkflowSource[];
  readonly contextSchema?: WorkflowContextSchemaSetting;
}

export interface EffectiveWorkflowSettings {
  readonly connections: WorkflowConnection[];
  readonly sources: WorkflowSource[];
  readonly contextSchema: WorkflowContextSchemaSetting | null;
  /** `settings` when `graph.settings` was present and valid; `legacy` when derived from the trigger/output. */
  readonly origin: 'settings' | 'legacy';
}

/** A graph that may carry `settings` (until `WorkflowGraph` declares it). */
export type WorkflowGraphWithSettings = WorkflowGraph & { readonly settings?: unknown };

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The raw `settings` block of a graph, or `undefined`. */
export function graphSettingsOf(graph: unknown): unknown {
  return asObject(graph)?.settings;
}

// =============================================================================================
// Shape
// =============================================================================================

function enumListProblems(value: unknown, pointer: string, allowed: readonly string[]): string[] {
  if (!Array.isArray(value)) return [`${pointer}: must be an array`];
  const problems: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !allowed.includes(entry)) {
      problems.push(`${pointer}/${index}: must be one of ${allowed.map((name) => JSON.stringify(name)).join(', ')} (got ${JSON.stringify(entry)})`);
    }
  });
  if (new Set(value).size !== value.length) problems.push(`${pointer}: must not repeat a value`);
  return problems;
}

function contextSchemaProblems(value: unknown, pointer: string): string[] {
  const object = asObject(value);
  if (object === undefined) return [`${pointer}: must be an object`];
  const byRef = Object.prototype.hasOwnProperty.call(object, 'contextSchemaId');
  const inline = Object.prototype.hasOwnProperty.call(object, 'inline');
  if (byRef === inline) return [`${pointer}: must be exactly one of { contextSchemaId, versionNumber } or { inline }`];
  const problems: string[] = [];
  if (inline) {
    for (const key of Object.keys(object)) if (key !== 'inline') problems.push(`${pointer}/${key}: is not a property of an inline context schema`);
    if (asObject(object.inline) === undefined) problems.push(`${pointer}/inline: must be a JSON Schema object`);
    return problems;
  }
  for (const key of Object.keys(object)) {
    if (key !== 'contextSchemaId' && key !== 'versionNumber') problems.push(`${pointer}/${key}: is not a property of a context schema reference`);
  }
  if (typeof object.contextSchemaId !== 'string' || object.contextSchemaId.length === 0)
    problems.push(`${pointer}/contextSchemaId: must be a non-empty string`);
  const version = object.versionNumber;
  if (version !== undefined && version !== null && !(typeof version === 'number' && Number.isInteger(version) && version >= 1)) {
    problems.push(`${pointer}/versionNumber: must be an integer >= 1, or null to follow the latest version`);
  }
  return problems;
}

/** Every way `value` fails to be a `WorkflowSettings`. `[]` = valid. Pointers are graph-rooted (`/settings/…`). */
export function workflowSettingsProblems(value: unknown): string[] {
  const object = asObject(value);
  if (object === undefined) return ['/settings: must be an object'];
  const problems: string[] = [];
  for (const key of Object.keys(object)) {
    if (key !== 'connections' && key !== 'sources' && key !== 'contextSchema') problems.push(`/settings/${key}: is not a workflow setting`);
  }
  problems.push(...enumListProblems(object.connections, '/settings/connections', WORKFLOW_CONNECTIONS));
  problems.push(...enumListProblems(object.sources, '/settings/sources', WORKFLOW_SOURCES));
  if (object.contextSchema !== undefined) problems.push(...contextSchemaProblems(object.contextSchema, '/settings/contextSchema'));
  return problems;
}

// =============================================================================================
// Effective settings
// =============================================================================================

function ordered<T extends string>(values: Iterable<string>, vocabulary: readonly T[]): T[] {
  const present = new Set(values);
  return vocabulary.filter((name) => present.has(name));
}

function nodeConfig(graph: Pick<WorkflowGraph, 'nodes'>, type: string): Record<string, unknown> | undefined {
  const node = (graph.nodes ?? []).find((candidate) => candidate?.type === type);
  return node === undefined ? undefined : (asObject(node.config) ?? {});
}

/** The trigger's own context-schema reference, normalised to the settings shape. */
function triggerContextSchema(graph: Pick<WorkflowGraph, 'nodes'>): WorkflowContextSchemaSetting | null {
  const authored = asObject(nodeConfig(graph, 'core.trigger')?.contextSchema);
  if (authored === undefined) return null;
  if (typeof authored.contextSchemaId === 'string' && authored.contextSchemaId.length > 0) {
    return { contextSchemaId: authored.contextSchemaId, versionNumber: typeof authored.versionNumber === 'number' ? authored.versionNumber : null };
  }
  const inline = asObject(authored.inline);
  return inline === undefined ? null : { inline };
}

function normaliseContextSchema(value: unknown): WorkflowContextSchemaSetting | null {
  const object = asObject(value);
  if (object === undefined) return null;
  if (typeof object.contextSchemaId === 'string') {
    return { contextSchemaId: object.contextSchemaId, versionNumber: typeof object.versionNumber === 'number' ? object.versionNumber : null };
  }
  const inline = asObject(object.inline);
  return inline === undefined ? null : { inline };
}

const LEGACY_PROTOCOL_CONNECTION: Readonly<Record<string, WorkflowConnection>> = Object.freeze({ http: 'api', 'http-sse': 'sse', socket: 'socket' });
/** `core.output.protocols` default (`DEFAULT_OUTPUT_PROTOCOLS`). */
const LEGACY_DEFAULT_PROTOCOLS = Object.freeze(['http-sse']);

/**
 * The settings a graph runs under: `graph.settings` when present and valid, else derived from the
 * legacy trigger `kinds` and output `protocols`. `contextSchema` falls back to the trigger's even
 * when `settings` exist without one.
 */
export function effectiveSettings(graph: WorkflowGraphWithSettings | Pick<WorkflowGraph, 'nodes'>): EffectiveWorkflowSettings {
  const raw = graphSettingsOf(graph);
  if (raw !== undefined && workflowSettingsProblems(raw).length === 0) {
    const settings = raw as unknown as WorkflowSettings;
    return {
      connections: ordered(settings.connections, WORKFLOW_CONNECTIONS),
      sources: ordered(settings.sources, WORKFLOW_SOURCES),
      contextSchema: normaliseContextSchema(settings.contextSchema) ?? triggerContextSchema(graph),
      origin: 'settings',
    };
  }

  const kinds = nodeConfig(graph, 'core.trigger')?.kinds;
  const kindList = Array.isArray(kinds) ? kinds.filter((kind): kind is string => typeof kind === 'string') : [];
  const output = nodeConfig(graph, 'core.output');
  const protocols = output === undefined ? [] : Array.isArray(output.protocols) ? output.protocols : LEGACY_DEFAULT_PROTOCOLS;
  const connections = [
    ...kindList,
    ...protocols
      .map((protocol) => (typeof protocol === 'string' ? LEGACY_PROTOCOL_CONNECTION[protocol] : undefined))
      .filter((name): name is WorkflowConnection => name !== undefined),
  ];
  return {
    connections: ordered(connections, WORKFLOW_CONNECTIONS),
    sources: ordered(kindList, WORKFLOW_SOURCES),
    contextSchema: triggerContextSchema(graph),
    origin: 'legacy',
  };
}

// =============================================================================================
// Implications — WF-SET-001..004
// =============================================================================================

export type WorkflowSettingsRuleId = 'WF-SET-001' | 'WF-SET-002' | 'WF-SET-003' | 'WF-SET-004';

export interface SettingsImplication {
  readonly ruleId: WorkflowSettingsRuleId;
  /** The connection that must be added. */
  readonly requires: WorkflowConnection;
  /** The node that implies it, when one does. */
  readonly nodeId: string | null;
  readonly message: string;
}

export interface SettingsImplicationContext {
  /** Agent tasks by slug — an ASR / TTS agent node needs `socket`. Unknown agents imply nothing. */
  readonly agents?: AgentIOResolver;
  /** The Input shape's `ConsultationContextSchemaVersion.definition` (its `kinds`), when resolved. */
  readonly contextSchemaDefinition?: unknown;
}

/** How an audio kind arrives. A `STREAM_AUDIO` kind streams unless it says `delivery: 'blob'`. */
function audioDelivery(kind: Record<string, unknown>): 'stream' | 'blob' | null {
  const primitive = typeof kind.primitive === 'string' ? kind.primitive : '';
  if (!primitive.includes('AUDIO')) return null;
  if (kind.delivery === 'blob') return 'blob';
  if (kind.delivery === 'stream') return 'stream';
  return primitive === 'STREAM_AUDIO' ? 'stream' : 'blob';
}

function isAttachmentKind(kind: Record<string, unknown>): boolean {
  return kind.primitive === 'DOCUMENT' || kind.primitive === 'IMAGE' || kind.attachments !== undefined;
}

/**
 * What `settings.connections` is missing, given the graph and its Input shape. Every entry names
 * the rule, the connection it requires, and why — the settings dialog shows exactly this.
 */
export function settingsImplications(
  graph: Pick<WorkflowGraph, 'nodes'>,
  settings: Pick<WorkflowSettings, 'connections'> & { readonly sources?: readonly WorkflowSource[] },
  ctx: SettingsImplicationContext = {},
): SettingsImplication[] {
  const has = new Set<string>(settings.connections);
  // A consultation-sourced run receives its audio on the consultation session socket.
  const consultationAudio = (settings.sources ?? []).includes('consultation');
  const found: SettingsImplication[] = [];

  if (has.has('sse') && !has.has('api')) {
    found.push({
      ruleId: 'WF-SET-001',
      requires: 'api',
      nodeId: null,
      message: 'Streaming a run (SSE) needs the API connection: a stream follows a run started through the API.',
    });
  }
  if (has.has('socket') && !has.has('api')) {
    found.push({
      ruleId: 'WF-SET-002',
      requires: 'api',
      nodeId: null,
      message: 'The socket connection needs the API connection: a socket attaches to a run started through the API.',
    });
  }

  if (!has.has('socket')) {
    for (const node of graph.nodes ?? []) {
      if (node?.type !== 'core.agent') continue;
      const task = agentTaskOf(asObject(node.config), ctx.agents);
      if (task !== 'SPEECH_TO_TEXT' && task !== 'TEXT_TO_SPEECH') continue;
      if (task === 'SPEECH_TO_TEXT' && consultationAudio) continue;
      found.push({
        ruleId: 'WF-SET-003',
        requires: 'socket',
        nodeId: node.id,
        message: `Step \`${node.id}\` ${task === 'SPEECH_TO_TEXT' ? 'transcribes speech' : 'speaks its output'}, which needs the socket connection for live audio.`,
      });
    }
  }

  const kinds = asObject(ctx.contextSchemaDefinition)?.kinds;
  const kindObjects = Array.isArray(kinds)
    ? kinds.map((kind) => asObject(kind)).filter((kind): kind is Record<string, unknown> => kind !== undefined)
    : [];
  if (!has.has('socket')) {
    const streamed = kindObjects.find((kind) => audioDelivery(kind) === 'stream');
    if (streamed !== undefined) {
      found.push({
        ruleId: 'WF-SET-003',
        requires: 'socket',
        nodeId: null,
        message: `The Input shape streams audio (\`${String(streamed.key)}\`), which needs the socket connection.`,
      });
    }
  }
  if (!has.has('api')) {
    const uploaded = kindObjects.find((kind) => audioDelivery(kind) === 'blob' || isAttachmentKind(kind));
    if (uploaded !== undefined) {
      found.push({
        ruleId: 'WF-SET-004',
        requires: 'api',
        nodeId: null,
        message: `The Input shape takes an uploaded file (\`${String(uploaded.key)}\`), which needs the API connection.`,
      });
    }
  }
  return found;
}
