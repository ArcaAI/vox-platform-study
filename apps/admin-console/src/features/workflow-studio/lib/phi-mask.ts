/**
 * TASK-1036 review R-C #7 — "Hide PHI" in the Composer (§10.2 Privacy: "PHI is shown to admins
 * with a one-click Hide PHI").
 *
 * The switch is studio state (the graph store's `hidePhi`); this module only answers WHICH values
 * it masks. A value is PHI when the FIELD it came from is PHI-classed by the contract: a step's
 * output by its NodeIO (`transcript`, `text`, …), an input by what its binding reads — directly, as
 * an ordered fallback, or as a `{{path}}` inside text. A fixed value the author typed is not a test
 * run's data and is never masked.
 */
import type { AgentIOResolver, Binding, WorkflowSettings } from '@arcaai/workflow-contract';
import type { GraphStoreEdge, GraphStoreNode } from '../store/types';
import { canvasPortsOf } from './composer-io';
import { inputRows } from './inputs-model';
import { PHI_MASK, pickerGroups } from './picker-model';

export { PHI_MASK };

const TEMPLATE_REFERENCE = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

/** Every stored path a binding reads. */
export function bindingReads(binding: Binding | null): string[] {
  if (binding === null) return [];
  if ('from' in binding) return [binding.from];
  if ('firstOf' in binding) return [...binding.firstOf];
  if ('template' in binding) return [...binding.template.matchAll(TEMPLATE_REFERENCE)].map((match) => match[1] as string);
  return [];
}

export interface LastRunPhiFieldsInput {
  node: GraphStoreNode;
  nodes: readonly GraphStoreNode[];
  edges: readonly GraphStoreEdge[];
  agents: AgentIOResolver;
  settings?: WorkflowSettings;
  contextSchema?: unknown;
}

/** The input and output NAMES of one step whose last-run values are PHI. */
export function lastRunPhiFields({ node, nodes, edges, agents, settings, contextSchema }: LastRunPhiFieldsInput): { inputs: Set<string>; outputs: Set<string> } {
  const ports = canvasPortsOf(node, agents);
  const outputs = new Set((ports?.outputs ?? []).filter((port) => port.phiClass === 'PHI').map((port) => port.name));
  const phiPaths = new Set(
    pickerGroups({ nodes, edges, settings, nodeId: node.id, agents, contextSchema })
      .flatMap((group) => group.items)
      .filter((item) => item.phiClass === 'PHI')
      .map((item) => item.raw),
  );
  const reads = (path: string) => phiPaths.has(path) || [...phiPaths].some((phi) => path.startsWith(`${phi}.`));
  const inputs = new Set<string>();
  for (const port of ports?.inputs ?? []) if (port.phiClass === 'PHI') inputs.add(port.name);
  for (const row of inputRows({ node, nodes, edges, agents, promptVariables: [] })) {
    if (bindingReads(row.binding).some(reads)) inputs.add(row.name);
  }
  return { inputs, outputs };
}
