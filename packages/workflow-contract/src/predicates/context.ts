/**
 * The registry-lookup surface every predicate evaluator needs but this package never owns:
 * "any node whose descriptor declares `phiBearing`" requires resolving a
 * node TYPE to its registry-declared CLASSES, and the registry itself is code-owned
 * ( `WORKFLOW_NODE_REGISTRY`, not yet built at the time this package was authored
 *
 * `WorkflowEvaluationContext` is therefore an INTERFACE this package depends on, not an
 * implementation. Tests supply a fake; the impure service supplies the real
 * one built from `WORKFLOW_NODE_REGISTRY`. This keeps the predicate evaluators pure — no I/O,
 * no import of `@arcaai/applications` — exactly the pure/impure split of
 * `departmentAgent/constants.ts`.
 */

import type { WorkflowGraph, WorkflowGraphNode } from '../graph-model';

export interface WorkflowNodeClassLookup {
  /** The registry-declared classes for a node type (e.g. `['phiBearing', 'mandatory']`). */
  classesOf(nodeType: string): readonly string[];
  /** The palette a node type belongs to, if registered. */
  paletteOf(nodeType: string): string | undefined;
}

export interface WorkflowEvaluationContext {
  paletteKey: string;
  registry: WorkflowNodeClassLookup;
}

/** Selects nodes either by exact registered `type` or by a registry-declared `class`. */
export type WorkflowNodeSelector = { type: string; class?: undefined } | { class: string; type?: undefined };

function nodeMatches(node: WorkflowGraphNode, selector: WorkflowNodeSelector, ctx: WorkflowEvaluationContext): boolean {
  if (selector.type !== undefined) return node.type === selector.type;
  if (selector.class !== undefined) return ctx.registry.classesOf(node.type).includes(selector.class);
  return false;
}

/** Node ids in `graph` matching a selector, in authored order. */
export function selectNodeIds(graph: WorkflowGraph, ctx: WorkflowEvaluationContext, selector: WorkflowNodeSelector): string[] {
  return graph.nodes.filter((node) => nodeMatches(node, selector, ctx)).map((node) => node.id);
}

/** Problems with a selector shape itself — used by each predicate's `predicateConfigProblems`. */
export function selectorProblems(value: unknown, path: string): string[] {
  if (typeof value !== 'object' || value === null) return [`${path}: selector must be an object`];
  const record = value as Record<string, unknown>;
  const hasType = typeof record.type === 'string' && record.type.length > 0;
  const hasClass = typeof record.class === 'string' && record.class.length > 0;
  if (hasType === hasClass) {
    return [`${path}: selector must declare exactly one of \`type\` or \`class\``];
  }
  return [];
}
