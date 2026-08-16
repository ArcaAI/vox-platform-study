/**
 * The `{ nodeType } | { nodeClass }` selector shape used throughout the closed predicate
 * catalogue (`REQUIRED_NODE_TYPE`, `FORBIDDEN_NODE_TYPE`, `REQUIRED_PATH_THROUGH`,
 * `FORBIDDEN_PATH`, `ORDERED_BEFORE`). Selecting by CLASS (not just type) is what lets a rule
 * say "any node whose descriptor declares `phiBearing`" and survive palette growth
 * (TASK-716 §4 Task 4) without enumerating every current type.
 */
import type { WorkflowGraph, WorkflowGraphNode } from '../graph-model';
import type { WorkflowEvaluationContext } from './context';
import { isNonEmptyString } from './types';

export interface NodeTypeOrClass {
  nodeType?: string;
  nodeClass?: string;
}

function nodeMatches(node: WorkflowGraphNode, selector: NodeTypeOrClass, ctx: WorkflowEvaluationContext): boolean {
  if (selector.nodeType !== undefined) return node.type === selector.nodeType;
  if (selector.nodeClass !== undefined) return ctx.registry.classesOf(node.type).includes(selector.nodeClass);
  return false;
}

export function selectIds(graph: WorkflowGraph, ctx: WorkflowEvaluationContext, selector: NodeTypeOrClass): string[] {
  return graph.nodes.filter((node) => nodeMatches(node, selector, ctx)).map((node) => node.id);
}

/** Problems with a `{ nodeType } | { nodeClass }` selector at `path` — exactly one must be set. */
export function nodeSelectorProblems(config: unknown, path: string): string[] {
  if (typeof config !== 'object' || config === null) return [`${path}: must be an object`];
  const record = config as Record<string, unknown>;
  const hasType = isNonEmptyString(record.nodeType);
  const hasClass = isNonEmptyString(record.nodeClass);
  if (hasType === hasClass) {
    return [`${path}: exactly one of \`nodeType\` or \`nodeClass\` must be a non-empty string`];
  }
  return [];
}
