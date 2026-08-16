/**
 * The closed predicate catalogue (TASK-716 §4 Task 4 / §3.3): the CLOSED set of predicate
 * *kinds* is code; a rule *instance* is a parameterization of one kind and lives as a
 * `WorkflowInvariantRule` row (data). Adding a new kind is a deploy — correctly, since it is
 * executable code (a topological sort, a dominator check). Tightening an existing kind's
 * parameters (a new forbidden edge, a raised severity) is a row insert.
 *
 * Every evaluator here is TOTAL: it returns findings, never throws (§3.5 — "a validator that
 * is not total is a validator that can be bypassed"). `evaluatePredicate` is a second line of
 * defense: it wraps the call in try/catch and converts an unexpected throw into the synthetic
 * `WF-INTERNAL` finding rather than ever resolving to "ok".
 */
import type { WorkflowGraph } from '../graph-model';
import { internalErrorFinding } from '../report';
import type { WorkflowFinding, WorkflowFindingSeverity, WorkflowRuleClass } from '../report';
import { configPredicateConfigProblems, configPredicateEvaluate } from './config-predicate';
import type { ConfigPredicateConfig } from './config-predicate';
import type { WorkflowEvaluationContext } from './context';
import {
  forbiddenNodeTypeConfigProblems,
  forbiddenNodeTypeEvaluate,
  forbiddenPathConfigProblems,
  forbiddenPathEvaluate,
  orderedBeforeConfigProblems,
  orderedBeforeEvaluate,
  requiredNodeTypeConfigProblems,
  requiredNodeTypeEvaluate,
  requiredPathThroughConfigProblems,
  requiredPathThroughEvaluate,
} from './shape';
import type { ForbiddenNodeTypeConfig, ForbiddenPathConfig, OrderedBeforeConfig, RequiredNodeTypeConfig, RequiredPathThroughConfig } from './shape';
import {
  acyclicConfigProblems,
  acyclicEvaluate,
  boundConfigProblems,
  boundEvaluate,
  reachableFromEntryConfigProblems,
  reachableFromEntryEvaluate,
  reachesTerminalConfigProblems,
  reachesTerminalEvaluate,
  singleEntryConfigProblems,
  singleEntryEvaluate,
} from './structural';
import type { BoundConfig, ReachableFromEntryConfig, ReachesTerminalConfig, SingleEntryConfig } from './structural';
import type { RawFinding } from './types';

export const WORKFLOW_RULE_PREDICATE_TYPES = [
  'ACYCLIC',
  'SINGLE_ENTRY',
  'REACHABLE_FROM_ENTRY',
  'REACHES_TERMINAL',
  'REQUIRED_NODE_TYPE',
  'FORBIDDEN_NODE_TYPE',
  'REQUIRED_PATH_THROUGH',
  'FORBIDDEN_PATH',
  'ORDERED_BEFORE',
  'BOUND',
  'CONFIG_PREDICATE',
] as const;

export type WorkflowRulePredicateType = (typeof WORKFLOW_RULE_PREDICATE_TYPES)[number];

interface PredicateEntry {
  evaluate: (graph: WorkflowGraph, ctx: WorkflowEvaluationContext, config: unknown) => RawFinding[];
  configProblems: (config: unknown) => string[];
}

const PREDICATE_REGISTRY: Record<WorkflowRulePredicateType, PredicateEntry> = {
  ACYCLIC: { evaluate: (graph) => acyclicEvaluate(graph), configProblems: acyclicConfigProblems },
  SINGLE_ENTRY: {
    evaluate: (graph, _ctx, config) => singleEntryEvaluate(graph, config as SingleEntryConfig),
    configProblems: singleEntryConfigProblems,
  },
  REACHABLE_FROM_ENTRY: {
    evaluate: (graph, _ctx, config) => reachableFromEntryEvaluate(graph, config as ReachableFromEntryConfig),
    configProblems: reachableFromEntryConfigProblems,
  },
  REACHES_TERMINAL: {
    evaluate: (graph, _ctx, config) => reachesTerminalEvaluate(graph, config as ReachesTerminalConfig),
    configProblems: reachesTerminalConfigProblems,
  },
  REQUIRED_NODE_TYPE: {
    evaluate: (graph, ctx, config) => requiredNodeTypeEvaluate(graph, ctx, config as RequiredNodeTypeConfig),
    configProblems: requiredNodeTypeConfigProblems,
  },
  FORBIDDEN_NODE_TYPE: {
    evaluate: (graph, ctx, config) => forbiddenNodeTypeEvaluate(graph, ctx, config as ForbiddenNodeTypeConfig),
    configProblems: forbiddenNodeTypeConfigProblems,
  },
  REQUIRED_PATH_THROUGH: {
    evaluate: (graph, ctx, config) => requiredPathThroughEvaluate(graph, ctx, config as RequiredPathThroughConfig),
    configProblems: requiredPathThroughConfigProblems,
  },
  FORBIDDEN_PATH: {
    evaluate: (graph, ctx, config) => forbiddenPathEvaluate(graph, ctx, config as ForbiddenPathConfig),
    configProblems: forbiddenPathConfigProblems,
  },
  ORDERED_BEFORE: {
    evaluate: (graph, ctx, config) => orderedBeforeEvaluate(graph, ctx, config as OrderedBeforeConfig),
    configProblems: orderedBeforeConfigProblems,
  },
  BOUND: {
    evaluate: (graph, _ctx, config) => boundEvaluate(graph, config as BoundConfig),
    configProblems: boundConfigProblems,
  },
  CONFIG_PREDICATE: {
    evaluate: (graph, ctx, config) => configPredicateEvaluate(graph, ctx, config as ConfigPredicateConfig),
    configProblems: configPredicateConfigProblems,
  },
};

export interface EvaluatePredicateOptions {
  severity?: WorkflowFindingSeverity;
  ruleClass?: WorkflowRuleClass;
  registerRefs?: readonly string[];
}

/**
 * Evaluate one rule instance. Total: an unknown predicate type or a throwing evaluator both
 * resolve to a synthetic `WF-INTERNAL` ERROR finding, never to an empty (= "ok") array.
 */
export function evaluatePredicate(
  type: WorkflowRulePredicateType,
  graph: WorkflowGraph,
  ctx: WorkflowEvaluationContext,
  config: unknown,
  ruleId: string,
  options?: EvaluatePredicateOptions,
): WorkflowFinding[] {
  const ruleClass = options?.ruleClass ?? 'structural';
  const entry = PREDICATE_REGISTRY[type];
  if (!entry) {
    return [internalErrorFinding(ruleId, ruleClass, new Error(`unknown predicate type "${type}"`))];
  }

  let raw: RawFinding[];
  try {
    raw = entry.evaluate(graph, ctx, config);
  } catch (error) {
    return [internalErrorFinding(ruleId, ruleClass, error)];
  }

  const severity = options?.severity ?? 'ERROR';
  return raw.map((finding) => ({
    ruleId,
    ruleClass,
    severity,
    nodeId: finding.nodeId,
    ...(finding.edgeId !== undefined ? { edgeId: finding.edgeId } : {}),
    ...(finding.path !== undefined ? { path: finding.path } : {}),
    message: finding.message,
    ...(options?.registerRefs !== undefined ? { registerRefs: options.registerRefs } : {}),
  }));
}

/** Problems with a predicate's OWN `predicateConfig` — a malformed rule row is itself reportable. */
export function predicateConfigProblems(type: WorkflowRulePredicateType, config: unknown): string[] {
  const entry = PREDICATE_REGISTRY[type];
  if (!entry) return [`unknown predicate type "${type}"`];
  try {
    return entry.configProblems(config);
  } catch (error) {
    return [`predicateConfig validation threw: ${error instanceof Error ? error.message : String(error)}`];
  }
}

export type { WorkflowEvaluationContext, WorkflowNodeClassLookup } from './context';
export type { NodeTypeOrClass } from './node-selector';
export type { ConfigPredicateOp, ConfigPredicateConfig } from './config-predicate';
