/** REQUIRED_NODE_TYPE, FORBIDDEN_NODE_TYPE, REQUIRED_PATH_THROUGH, FORBIDDEN_PATH,
 * ORDERED_BEFORE — the five predicate kinds that resolve node sets by type-or-class and reason
 * about paths between them. */
import type { WorkflowGraph } from '../graph-model';
import { allPathsPassThrough, pathExists } from '../graph-algorithms';
import type { WorkflowEvaluationContext } from './context';
import { nodeSelectorProblems, selectIds } from './node-selector';
import { isPlainObject, type RawFinding } from './types';

// ---------------------------------------------------------------------------------------------
// REQUIRED_NODE_TYPE
// ---------------------------------------------------------------------------------------------
export interface RequiredNodeTypeConfig {
  nodeType?: string;
  nodeClass?: string;
  minCount: number;
}
export function requiredNodeTypeEvaluate(graph: WorkflowGraph, ctx: WorkflowEvaluationContext, config: RequiredNodeTypeConfig): RawFinding[] {
  const matches = selectIds(graph, ctx, config);
  if (matches.length < config.minCount) {
    const label = config.nodeType ?? config.nodeClass;
    return [{ nodeId: null, message: `expected at least ${config.minCount} node(s) matching "${label}", found ${matches.length}` }];
  }
  return [];
}
export function requiredNodeTypeConfigProblems(config: unknown): string[] {
  const problems = nodeSelectorProblems(config, '/');
  if (!isPlainObject(config)) return problems;
  if (typeof config.minCount !== 'number' || !Number.isInteger(config.minCount) || config.minCount < 1) {
    problems.push('predicateConfig.minCount must be a positive integer');
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// FORBIDDEN_NODE_TYPE
// ---------------------------------------------------------------------------------------------
export interface ForbiddenNodeTypeConfig {
  nodeType?: string;
  nodeClass?: string;
}
export function forbiddenNodeTypeEvaluate(graph: WorkflowGraph, ctx: WorkflowEvaluationContext, config: ForbiddenNodeTypeConfig): RawFinding[] {
  const label = config.nodeType ?? config.nodeClass;
  return selectIds(graph, ctx, config).map((nodeId) => ({ nodeId, message: `node "${nodeId}" matches forbidden "${label}"` }));
}
export function forbiddenNodeTypeConfigProblems(config: unknown): string[] {
  return nodeSelectorProblems(config, '/');
}

// ---------------------------------------------------------------------------------------------
// REQUIRED_PATH_THROUGH ("nothing routes around a gate")
// ---------------------------------------------------------------------------------------------
export interface RequiredPathThroughConfig {
  fromType?: string;
  fromClass?: string;
  toType?: string;
  toClass?: string;
  throughType?: string;
  throughClass?: string;
}
export function requiredPathThroughEvaluate(graph: WorkflowGraph, ctx: WorkflowEvaluationContext, config: RequiredPathThroughConfig): RawFinding[] {
  const fromIds = selectIds(graph, ctx, { nodeType: config.fromType, nodeClass: config.fromClass });
  const toIds = selectIds(graph, ctx, { nodeType: config.toType, nodeClass: config.toClass });
  const throughIds = selectIds(graph, ctx, { nodeType: config.throughType, nodeClass: config.throughClass });
  if (fromIds.length === 0 || toIds.length === 0) return [];
  if (allPathsPassThrough(graph, fromIds, toIds, throughIds)) return [];
  return [
    {
      nodeId: null,
      message: `a path exists from "${config.fromType ?? config.fromClass}" to "${config.toType ?? config.toClass}" that does not pass through "${config.throughType ?? config.throughClass}"`,
    },
  ];
}
export function requiredPathThroughConfigProblems(config: unknown): string[] {
  return [
    ...nodeSelectorProblems(fieldsAs(config, 'from'), '/from'),
    ...nodeSelectorProblems(fieldsAs(config, 'to'), '/to'),
    ...nodeSelectorProblems(fieldsAs(config, 'through'), '/through'),
  ];
}

// ---------------------------------------------------------------------------------------------
// FORBIDDEN_PATH
// ---------------------------------------------------------------------------------------------
export interface ForbiddenPathConfig {
  fromType?: string;
  fromClass?: string;
  toType?: string;
  toClass?: string;
}
export function forbiddenPathEvaluate(graph: WorkflowGraph, ctx: WorkflowEvaluationContext, config: ForbiddenPathConfig): RawFinding[] {
  const fromIds = selectIds(graph, ctx, { nodeType: config.fromType, nodeClass: config.fromClass });
  const toIds = selectIds(graph, ctx, { nodeType: config.toType, nodeClass: config.toClass });
  if (fromIds.length === 0 || toIds.length === 0) return [];
  if (!pathExists(graph, fromIds, toIds)) return [];
  return [
    {
      nodeId: null,
      message: `a forbidden path exists from "${config.fromType ?? config.fromClass}" to "${config.toType ?? config.toClass}"`,
    },
  ];
}
export function forbiddenPathConfigProblems(config: unknown): string[] {
  return [...nodeSelectorProblems(fieldsAs(config, 'from'), '/from'), ...nodeSelectorProblems(fieldsAs(config, 'to'), '/to')];
}

// ---------------------------------------------------------------------------------------------
// ORDERED_BEFORE
//
// DRAFT SEMANTIC DECISION (flag for clinical/architecture review — see
// `contracts/rule-model.md` questions): this predicate forbids an ORDER INVERSION (a
// path from an "after"-class node back to a "before"-class node) — it does NOT by itself
// require that a "before" node exist on every path to an "after" node. A rule author who needs
// mandatory presence (e.g. "every generation is preceded by a consent gate") must pair this
// with a `REQUIRED_PATH_THROUGH` rule. This split was made explicit rather than silently
// assumed because "ordered before" reads as "guaranteed to occur first", which this predicate
// alone does not guarantee.
// ---------------------------------------------------------------------------------------------
export interface OrderedBeforeConfig {
  beforeType?: string;
  beforeClass?: string;
  afterType?: string;
  afterClass?: string;
}
export function orderedBeforeEvaluate(graph: WorkflowGraph, ctx: WorkflowEvaluationContext, config: OrderedBeforeConfig): RawFinding[] {
  const beforeIds = selectIds(graph, ctx, { nodeType: config.beforeType, nodeClass: config.beforeClass });
  const afterIds = selectIds(graph, ctx, { nodeType: config.afterType, nodeClass: config.afterClass });
  if (beforeIds.length === 0 || afterIds.length === 0) return [];
  if (!pathExists(graph, afterIds, beforeIds)) return [];
  return [
    {
      nodeId: null,
      message: `a path exists from "${config.afterType ?? config.afterClass}" back to "${config.beforeType ?? config.beforeClass}" — ordering inverted`,
    },
  ];
}
export function orderedBeforeConfigProblems(config: unknown): string[] {
  return [...nodeSelectorProblems(fieldsAs(config, 'before'), '/before'), ...nodeSelectorProblems(fieldsAs(config, 'after'), '/after')];
}

function fieldsAs(config: unknown, prefix: string): { nodeType?: unknown; nodeClass?: unknown } {
  if (!isPlainObject(config)) return {};
  return { nodeType: config[`${prefix}Type`], nodeClass: config[`${prefix}Class`] };
}
