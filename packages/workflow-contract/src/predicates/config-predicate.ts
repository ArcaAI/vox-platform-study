/** CONFIG_PREDICATE — a node's own `config` field satisfies a comparison. The one predicate
 * kind that reasons about node CONFIG rather than graph shape. */
import type { WorkflowGraph, WorkflowGraphNode } from '../graph-model';
import type { WorkflowEvaluationContext } from './context';
import { nodeSelectorProblems, selectIds, type NodeTypeOrClass } from './node-selector';
import { isNonEmptyString, isPlainObject, type RawFinding } from './types';

export type ConfigPredicateOp = 'lte' | 'gte' | 'eq' | 'in' | 'present';
const OPS: readonly ConfigPredicateOp[] = ['lte', 'gte', 'eq', 'in', 'present'];

export interface ConfigPredicateConfig {
  appliesTo: NodeTypeOrClass;
  field: string;
  op: ConfigPredicateOp;
  value?: unknown;
}

function fieldPath(field: string): string {
  return `/${field.split('.').join('/')}`;
}

function readField(config: Record<string, unknown>, field: string): unknown {
  let cursor: unknown = config;
  for (const segment of field.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function satisfies(op: ConfigPredicateOp, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'present':
      return actual !== undefined;
    case 'eq':
      return deepEqual(actual, expected);
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'in':
      return Array.isArray(expected) && expected.some((candidate) => deepEqual(candidate, actual));
    default:
      return false;
  }
}

export function configPredicateEvaluate(graph: WorkflowGraph, ctx: WorkflowEvaluationContext, config: ConfigPredicateConfig): RawFinding[] {
  const matches: WorkflowGraphNode[] = selectIds(graph, ctx, config.appliesTo)
    .map((id) => graph.nodes.find((node) => node.id === id))
    .filter((node): node is WorkflowGraphNode => node !== undefined);

  const findings: RawFinding[] = [];
  for (const node of matches) {
    const actual = readField(node.config ?? {}, config.field);
    if (!satisfies(config.op, actual, config.value)) {
      findings.push({
        nodeId: node.id,
        path: fieldPath(config.field),
        message:
          `node "${node.id}" config${fieldPath(config.field)} fails "${config.op}" ${config.value !== undefined ? JSON.stringify(config.value) : ''}`.trim(),
      });
    }
  }
  return findings;
}

export function configPredicateConfigProblems(config: unknown): string[] {
  if (!isPlainObject(config)) return ['predicateConfig must be an object'];
  const problems: string[] = [...nodeSelectorProblems(config.appliesTo, '/appliesTo')];
  if (!isNonEmptyString(config.field)) {
    problems.push('predicateConfig.field must be a non-empty string');
  }
  if (typeof config.op !== 'string' || !OPS.includes(config.op as ConfigPredicateOp)) {
    problems.push(`predicateConfig.op must be one of ${OPS.join(', ')}`);
  } else if (config.op !== 'present' && config.value === undefined) {
    problems.push(`predicateConfig.value is required for op "${config.op}"`);
  }
  return problems;
}
