/**
 * TASK-1036 §8.4 item 2 / §9.1 — the composer's view of the frozen NodeIO contract.
 *
 * One declaration (`nodeIOFor` in `@arcaai/workflow-contract`) drives the canvas handles, the
 * Inputs panel, the picker and the auto-map; this module only adapts it to the store's node
 * shape and to what the canvas draws:
 *
 *  - an agent's handles are its TASK's fields (`transcript`, `data`, `audio`, `entities` — D-F),
 *    read from the agent the picker already loaded (task + output schema);
 *  - an agent whose task is not known yet draws NO typed handles (`null`): the union of every
 *    task's fields would be four inputs and eight outputs of noise, so the canvas falls back to
 *    the single primary dot until an agent is chosen;
 *  - a node with branch handles (the routers, review, loop) keeps those as its outputs: what
 *    leaves a router is decided by the branch taken, and the data it carries is the router's
 *    `input` (OD-19 / Q3), bound by the composer on connect.
 *
 * Handle ids are `in:<field>` / `out:<field>` — PRESENTATION ids. The wire edge still names real
 * sockets (`next → after`, `out → in`, a branch), resolved by `connection-plan.ts`; the field is
 * what the binding carries.
 */
import {
  isAgentTask,
  nodeIOFor,
  type AgentIOResolver,
  type IoType,
  type NodeIO,
  type PhiClass,
} from '@arcaai/workflow-contract';
import type { GraphStoreNode } from '../store/types';
import { branchHandlesOf } from './core-ports';

export interface PortView {
  name: string;
  type: IoType;
  required: boolean;
  description: string;
  phiClass?: PhiClass;
  /** For a structured `json` output (an agent's `data`): its JSON Schema. */
  schema?: Readonly<Record<string, unknown>>;
}

export interface CanvasPorts {
  inputs: PortView[];
  outputs: PortView[];
}

/** What the composer needs to know about one agent: its task and output schema. */
export interface AgentIoSource {
  slug: string;
  task?: string | null;
  outputSchema?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The resolver `nodeIOFor` / `bindingSourcePaths` read, built from the agent list the inspector's
 * picker already loaded (`GET admin/agents`). An agent with an unknown task contributes nothing.
 */
export function agentResolverOf(agents: readonly AgentIoSource[] | undefined): AgentIOResolver {
  const resolver: Record<string, { task: NonNullable<AgentIOResolver[string]['task']>; outputSchema?: Readonly<Record<string, unknown>> | null }> = {};
  for (const agent of agents ?? []) {
    if (!isAgentTask(agent.task)) continue;
    resolver[agent.slug] = { task: agent.task, outputSchema: isRecord(agent.outputSchema) ? agent.outputSchema : null };
  }
  return resolver;
}

/** The agent slug a `core.agent` node references. */
export function agentSlugOf(node: Pick<GraphStoreNode, 'config'>): string | null {
  const ref = node.config.agentRef;
  return isRecord(ref) && typeof ref.slug === 'string' && ref.slug.length > 0 ? ref.slug : null;
}

/** The node's exact I/O, or `undefined` for an unknown type. An agent of unknown task gets the union. */
export function nodeIoOf(node: Pick<GraphStoreNode, 'type' | 'config'>, agents: AgentIOResolver): NodeIO | undefined {
  return nodeIOFor(node, agents);
}

/** Whether the node's I/O is EXACT — false only for an agent whose task is not known. */
export function hasExactIo(node: Pick<GraphStoreNode, 'type' | 'config'>, agents: AgentIOResolver): boolean {
  if (node.type !== 'core.agent') return true;
  const slug = agentSlugOf(node);
  return slug !== null && agents[slug]?.task !== undefined;
}

function viewsOf(entries: Readonly<Record<string, { type: IoType; description: string; required?: boolean; phiClass?: PhiClass; schema?: Readonly<Record<string, unknown>> }>>): PortView[] {
  return Object.entries(entries).map(([name, field]) => ({
    name,
    type: field.type,
    required: field.required ?? false,
    description: field.description,
    ...(field.phiClass ? { phiClass: field.phiClass } : {}),
    ...(field.schema ? { schema: field.schema } : {}),
  }));
}

/** The typed handles the canvas draws for this node, or `null` to draw the primary dots instead. */
export function canvasPortsOf(node: Pick<GraphStoreNode, 'type' | 'config'>, agents: AgentIOResolver): CanvasPorts | null {
  if (node.type === 'core.note') return null;
  if (!hasExactIo(node, agents)) return null;
  const io = nodeIoOf(node, agents);
  if (!io) return null;
  const branched = branchHandlesOf(node.type, node.config).length > 0 || node.type === 'core.loop';
  return { inputs: viewsOf(io.inputs), outputs: branched ? [] : viewsOf(io.outputs) };
}

/** The handle id a field is drawn under. */
export function portHandleId(direction: 'in' | 'out', field: string): string {
  return `${direction}:${field}`;
}

/** Decodes a typed handle id; `null` for the primary dots and the branch handles. */
export function parsePortHandle(handle: string | null | undefined): { direction: 'in' | 'out'; field: string } | null {
  if (typeof handle !== 'string') return null;
  const match = /^(in|out):(.+)$/.exec(handle);
  return match ? { direction: match[1] as 'in' | 'out', field: match[2] as string } : null;
}

/** The colour family a type is drawn in — one per kind of value, so a glance says what fits. */
export type IoTone = 'text' | 'number' | 'boolean' | 'date' | 'json' | 'list' | 'audio' | 'file' | 'any';

export function ioTone(type: IoType): IoTone {
  if (type.startsWith('list<')) return 'list';
  switch (type) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'json':
    case 'audio':
    case 'any':
      return type;
    case 'file':
    case 'document':
      return 'file';
    default:
      return 'json';
  }
}

/** Plain-language type name for labels and tooltips (`list<entity>` → `list of entities`). */
export function ioTypeLabel(type: IoType): string {
  const element = type.startsWith('list<') && type.endsWith('>') ? type.slice(5, -1) : null;
  if (element === null) return type === 'json' ? 'data' : type;
  const plural: Record<string, string> = { entity: 'entities', segment: 'segments', json: 'values', any: 'values' };
  return `list of ${plural[element] ?? `${element}s`}`;
}
