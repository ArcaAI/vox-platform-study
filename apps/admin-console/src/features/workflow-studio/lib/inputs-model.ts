/**
 * TASK-1036 §8.4 item 5 / §10.1 "Inputs come from the prompt" — the rows of the Inputs panel.
 *
 * Two kinds of input, one row shape:
 *
 *  - the node's declared NodeIO inputs (`message`, `context`, `audio`, …), bound in
 *    `config.inputs` (OD-29) — or, on a legacy node, implied by a data edge (shown as bound, and
 *    marked `implied` so the panel can say where it comes from);
 *  - the variables of the agent's pinned prompt, bound in `config.overrides.promptVariables` — the
 *    map the runtime already renders into the prompt (`prompt-scope.ts`: bare names overlaid by
 *    the node's overrides). A picked field is stored as `{{path}}`, a fixed value as its text, a
 *    template as itself, so nothing changes about how a published graph runs.
 *
 * Status: `bound`, `missing` (required and unbound — red at the field and a canvas problem), or
 * `empty` (optional and unbound — "renders empty", OD-10).
 *
 * A NodeIO input counts as `missing` only on a node that authors `config.inputs` — the same rule as
 * the server's `REQUIRED_INPUT_UNBOUND` (`bindingIssues` → `checkRequired`). A legacy node gets its
 * value from the runtime (a realtime-lane ASR agent reads the live session's audio), so flagging it
 * here put an error chip on a graph the publish gate accepts with 0 errors.
 */
import type { AgentIOResolver, Binding, IoType } from '@arcaai/workflow-contract';
import type { GraphStoreEdge, GraphStoreNode } from '../store/types';
import { canvasPortsOf } from './composer-io';
import { effectiveBindings } from './connection-plan';

export const PROMPT_VARIABLES_PATH = 'overrides.promptVariables';

export interface PromptVariableInfo {
  name: string;
  required: boolean;
  /** The declaration's type (`string`, `number`, …); `string` when undeclared. */
  type?: string;
  description?: string;
}

export interface InputRow {
  /** Stable React key: `io:<name>` or `var:<name>`. */
  key: string;
  name: string;
  type: IoType;
  required: boolean;
  description: string;
  origin: 'io' | 'prompt';
  binding: Binding | null;
  /** Bound by a legacy data edge rather than authored. */
  implied: boolean;
  status: 'bound' | 'missing' | 'empty';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SINGLE_REFERENCE = /^\{\{\s*([A-Za-z_][\w.]*)\s*\}\}$/;

/** A stored prompt-variable string as a binding: `{{path}}` → from, text with `{{` → template, else a value. */
export function promptVariableBinding(text: string | undefined | null): Binding | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const single = SINGLE_REFERENCE.exec(text.trim());
  if (single) return { from: single[1] as string };
  if (text.includes('{{')) return { template: text };
  return { value: text };
}

/** The inverse: what `overrides.promptVariables[name]` stores for a binding. */
export function promptVariableText(binding: Binding): string {
  if ('from' in binding) return `{{${binding.from}}}`;
  if ('template' in binding) return binding.template;
  if ('firstOf' in binding) return `{{${binding.firstOf[0] ?? ''}}}`;
  const value = binding.value;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function promptVariablesOf(config: Record<string, unknown>): Record<string, string> {
  const overrides = config.overrides;
  const variables = isRecord(overrides) ? overrides.promptVariables : undefined;
  if (!isRecord(variables)) return {};
  return Object.fromEntries(Object.entries(variables).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function ioTypeOfVariable(type: string | undefined): IoType {
  switch (type) {
    case 'number':
    case 'boolean':
    case 'date':
    case 'json':
      return type;
    default:
      return 'text';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function status(binding: Binding | null, required: boolean): InputRow['status'] {
  if (binding !== null) return 'bound';
  return required ? 'missing' : 'empty';
}

export interface InputRowsInput {
  node: GraphStoreNode;
  nodes: readonly GraphStoreNode[];
  edges: readonly GraphStoreEdge[];
  agents: AgentIOResolver;
  /** The pinned prompt's variables (the agent's declarations, else its template's). */
  promptVariables: readonly PromptVariableInfo[];
}

export function inputRows({ node, nodes, edges, agents, promptVariables }: InputRowsInput): InputRow[] {
  const rows: InputRow[] = [];
  const ports = canvasPortsOf(node, agents);
  if (ports) {
    const effective = effectiveBindings(nodes, edges, node.id, agents);
    const authorsInputs = isPlainObject((node.config as Record<string, unknown> | undefined)?.inputs);
    for (const port of ports.inputs) {
      const entry = effective[port.name];
      const binding = entry?.binding ?? null;
      rows.push({
        key: `io:${port.name}`,
        name: port.name,
        type: port.type,
        required: port.required,
        description: port.description,
        origin: 'io',
        binding,
        implied: entry?.implied ?? false,
        status: status(binding, port.required && authorsInputs),
      });
    }
  }
  const stored = promptVariablesOf(node.config);
  const declared = new Set<string>();
  for (const variable of promptVariables) {
    if (declared.has(variable.name)) continue;
    declared.add(variable.name);
    const binding = promptVariableBinding(stored[variable.name]);
    rows.push({
      key: `var:${variable.name}`,
      name: variable.name,
      type: ioTypeOfVariable(variable.type),
      required: variable.required,
      description: variable.description ?? 'A variable in this step’s prompt.',
      origin: 'prompt',
      binding,
      implied: false,
      status: status(binding, variable.required),
    });
  }
  // A value stored for a name the current prompt does not declare is never hidden: it still
  // renders into the prompt (the interpolation is generic), so the author must be able to see it.
  for (const [name, text] of Object.entries(stored)) {
    if (declared.has(name)) continue;
    const binding = promptVariableBinding(text);
    rows.push({
      key: `var:${name}`,
      name,
      type: 'text',
      required: false,
      description: 'Not declared by the current prompt — kept, and still rendered if the prompt uses it.',
      origin: 'prompt',
      binding,
      implied: false,
      status: status(binding, false),
    });
  }
  return rows;
}

/** `config` with prompt variable `name` set to `binding`'s text (or removed for `null`). */
export function withPromptVariable(config: Record<string, unknown>, name: string, binding: Binding | null): Record<string, unknown> {
  const overrides = isRecord(config.overrides) ? config.overrides : {};
  const current = isRecord(overrides.promptVariables) ? (overrides.promptVariables as Record<string, unknown>) : {};
  const { [name]: _previous, ...others } = current;
  const promptVariables = binding === null ? others : { ...others, [name]: promptVariableText(binding) };
  const { promptVariables: _variables, ...otherOverrides } = overrides;
  const nextOverrides = Object.keys(promptVariables).length > 0 ? { ...otherOverrides, promptVariables } : otherOverrides;
  const { overrides: _overrides, ...rest } = config;
  return Object.keys(nextOverrides).length > 0 ? { ...rest, overrides: nextOverrides } : rest;
}
