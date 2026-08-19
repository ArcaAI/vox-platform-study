/** ACYCLIC, SINGLE_ENTRY, REACHABLE_FROM_ENTRY, REACHES_TERMINAL, BOUND — shape-only
 * predicates. The two REACHABILITY kinds consult the registry for exactly one thing: the
 * `boundary` class (see `BOUNDARY_CLASS`). */
import type { WorkflowGraph } from '../graph-model';
import { reachableFrom, reachesAny, topologicalLevels } from '../graph-algorithms';
import type { WorkflowEvaluationContext } from './context';
import { isNonEmptyString, isPlainObject, type RawFinding } from './types';

/**
 * The registry class marking a node as a GRAPH BOUNDARY MARKER rather than work — `core.start`
 * and `core.end` today.
 *
 * Why the two reachability predicates skip these nodes: a palette declares its OWN entry and
 * terminal (`REACHABLE_FROM_ENTRY consultation.consentGate` = "no node precedes the consent
 * gate"; `REACHES_TERMINAL consultation.hitlGate` = "no node executes after the gate"), while
 * the palette-agnostic WF-S-003/004 declare the universal bookends. Both are correct and both
 * must hold at once, which is impossible if a bookend counts as a node the palette's own rule
 * has to account for: `core.start` is by construction NOT reachable from the consent gate, and
 * `core.end` by construction does NOT reach the HITL gate. Exempting markers is what lets a
 * graph satisfy both families instead of trading one set of errors for the other.
 *
 * The exemption is deliberately narrow — it suppresses only "unreachable"/"dead end" REPORTING
 * for a marker. Markers still take part in every other rule: they are counted by SINGLE_ENTRY,
 * traversed by REQUIRED_PATH_THROUGH, and bounded by BOUND. A marker cannot be used to smuggle
 * work past a gate, because a marker executes nothing.
 */
export const BOUNDARY_CLASS = 'boundary';

function isBoundary(nodeType: string, ctx: WorkflowEvaluationContext): boolean {
  return ctx.registry.classesOf(nodeType).includes(BOUNDARY_CLASS);
}

// ---------------------------------------------------------------------------------------------
// ACYCLIC
// ---------------------------------------------------------------------------------------------
export function acyclicEvaluate(graph: WorkflowGraph): RawFinding[] {
  const result = topologicalLevels(graph);
  if ('cycle' in result) {
    return [{ nodeId: null, message: `graph contains a cycle involving: ${result.cycle.join(', ')}` }];
  }
  return [];
}
export function acyclicConfigProblems(): string[] {
  return [];
}

// ---------------------------------------------------------------------------------------------
// SINGLE_ENTRY
// ---------------------------------------------------------------------------------------------
export interface SingleEntryConfig {
  entryType: string;
}
export function singleEntryEvaluate(graph: WorkflowGraph, config: SingleEntryConfig): RawFinding[] {
  const matches = graph.nodes.filter((node) => node.type === config.entryType);
  if (matches.length !== 1) {
    return [{ nodeId: null, message: `expected exactly one node of type "${config.entryType}", found ${matches.length}` }];
  }
  return [];
}
export function singleEntryConfigProblems(config: unknown): string[] {
  if (!isPlainObject(config) || !isNonEmptyString(config.entryType)) {
    return ['predicateConfig.entryType must be a non-empty string'];
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// REACHABLE_FROM_ENTRY
// ---------------------------------------------------------------------------------------------
export interface ReachableFromEntryConfig {
  entryType: string;
}
export function reachableFromEntryEvaluate(
  graph: WorkflowGraph,
  ctx: WorkflowEvaluationContext,
  config: ReachableFromEntryConfig,
): RawFinding[] {
  const entries = graph.nodes.filter((node) => node.type === config.entryType).map((node) => node.id);
  const reachable = new Set<string>();
  for (const entry of entries) {
    for (const id of reachableFrom(graph, entry)) reachable.add(id);
  }
  return graph.nodes
    .filter((node) => !reachable.has(node.id) && !isBoundary(node.type, ctx))
    .map((node) => ({ nodeId: node.id, message: `node "${node.id}" is not reachable from any "${config.entryType}" node` }));
}
export function reachableFromEntryConfigProblems(config: unknown): string[] {
  return singleEntryConfigProblems(config);
}

// ---------------------------------------------------------------------------------------------
// REACHES_TERMINAL
// ---------------------------------------------------------------------------------------------
export interface ReachesTerminalConfig {
  terminalType: string;
}
export function reachesTerminalEvaluate(
  graph: WorkflowGraph,
  ctx: WorkflowEvaluationContext,
  config: ReachesTerminalConfig,
): RawFinding[] {
  const terminals = graph.nodes.filter((node) => node.type === config.terminalType).map((node) => node.id);
  const canReach = reachesAny(graph, terminals);
  return graph.nodes
    .filter((node) => !canReach.has(node.id) && !isBoundary(node.type, ctx))
    .map((node) => ({ nodeId: node.id, message: `node "${node.id}" does not reach any "${config.terminalType}" node (dead end)` }));
}
export function reachesTerminalConfigProblems(config: unknown): string[] {
  if (!isPlainObject(config) || !isNonEmptyString(config.terminalType)) {
    return ['predicateConfig.terminalType must be a non-empty string'];
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// BOUND
// ---------------------------------------------------------------------------------------------
export interface BoundConfig {
  maxNodes?: number;
  maxEdges?: number;
  maxDepth?: number;
}
export function boundEvaluate(graph: WorkflowGraph, config: BoundConfig): RawFinding[] {
  const findings: RawFinding[] = [];
  if (typeof config.maxNodes === 'number' && graph.nodes.length > config.maxNodes) {
    findings.push({ nodeId: null, message: `graph has ${graph.nodes.length} nodes, exceeding the bound of ${config.maxNodes}` });
  }
  if (typeof config.maxEdges === 'number' && graph.edges.length > config.maxEdges) {
    findings.push({ nodeId: null, message: `graph has ${graph.edges.length} edges, exceeding the bound of ${config.maxEdges}` });
  }
  if (typeof config.maxDepth === 'number') {
    const result = topologicalLevels(graph);
    // A cycle makes "depth" undefined — ACYCLIC is the rule that owns reporting that.
    if ('levels' in result && result.levels.length > config.maxDepth) {
      findings.push({ nodeId: null, message: `graph depth ${result.levels.length} exceeds the bound of ${config.maxDepth}` });
    }
  }
  return findings;
}
export function boundConfigProblems(config: unknown): string[] {
  if (!isPlainObject(config)) return ['predicateConfig must be an object'];
  const problems: string[] = [];
  for (const key of ['maxNodes', 'maxEdges', 'maxDepth'] as const) {
    const value = config[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      problems.push(`predicateConfig.${key} must be a positive number when present`);
    }
  }
  if (config.maxNodes === undefined && config.maxEdges === undefined && config.maxDepth === undefined) {
    problems.push('predicateConfig must declare at least one of maxNodes, maxEdges, maxDepth');
  }
  return problems;
}
