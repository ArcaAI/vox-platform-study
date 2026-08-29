/**
 * @arcaai/workflow-contract
 *
 * The pure workflow-graph validator + deterministic compiler engine for the
 * agentic-workflow-platform substrate (TASK-716). Zero runtime dependencies.
 *
 * IMPORTANT — rule-set status: the rule INSTANCES exported from `./rule-catalogue` are a
 * DRAFT, authored by this ticket's engineering pass and NOT YET clinician-reviewed (see
 * `docs/implementation/TASK-716-Workflow-Compiler-Validator/contracts/rule-model.md`). The
 * ENGINE in this package (graph algorithms, the closed predicate catalogue, the compiler) is
 * mechanism, not policy, and is safe to build against; the *specific 22 rules* are safe to
 * TEST against but must not be presented as a validated safety boundary or wired as an
 * enforcing gate until that review completes.
 */

export type { WorkflowGraph, WorkflowGraphNode, WorkflowGraphEdge, WorkflowNodePosition } from './graph-model';
export { MAX_GRAPH_NODES, MAX_GRAPH_EDGES, MAX_GRAPH_DEPTH, WORKFLOW_NODE_ID_PATTERN, workflowGraphProblems } from './graph-model';

export { topologicalLevels, reachableFrom, reachesAny, pathExists, allPathsPassThrough } from './graph-algorithms';
export type { TopologicalLevelsResult } from './graph-algorithms';

export type { WorkflowFinding, WorkflowFindingSeverity, WorkflowRuleClass, WorkflowValidationReport } from './report';
export { hasBlockingFindings, buildValidationReport, internalErrorFinding } from './report';

export { WORKFLOW_RULE_PREDICATE_TYPES, evaluatePredicate, predicateConfigProblems } from './predicates';
export type {
  WorkflowRulePredicateType,
  WorkflowEvaluationContext,
  WorkflowNodeClassLookup,
  NodeTypeOrClass,
  ConfigPredicateOp,
  ConfigPredicateConfig,
  EvaluatePredicateOptions,
} from './predicates';

export { canonicalJson } from './canonical-json';

export { WORKFLOW_NODE_REGISTRY, classesOf, paletteOf, nodeInfo, workflowNodeClassLookup, registryChecksum } from './node-registry';
export type { WorkflowNodeDescriptor, WorkflowNodeEvalGate, WorkflowNodeLane, WorkflowNodeTrigger } from './node-registry';

export { NODE_CONFIG_SCHEMAS, TERMINOLOGY_PURPOSE_SCOPES } from './node-config-schemas';
export type { NodeConfigSchema } from './node-config-schemas';

// TASK-809 — the node CONTRACT: typed ports, their compatibility lattice, and the publish-time
// checks built on it. `document -> ner` being a TYPE ERROR is a property of
// `portPrimitiveSatisfies` + the port tables, not of any caller — see
// `__tests__/anti-laundering.test.ts`.
export {
  CONTEXT_PRIMITIVES_MIRROR,
  PORT_PRIMITIVE_CONTEXT_PRIMITIVE,
  WORKFLOW_PORT_PRIMITIVES,
  WORKFLOW_PORT_SUPERTYPE,
  isWorkflowPortPrimitive,
  portPrimitiveSatisfies,
} from './port-model';
export type { WorkflowPortDescriptor, WorkflowPortPrimitive } from './port-model';

export { NODE_PORTS } from './node-ports';
export type { WorkflowNodePorts } from './node-ports';

export { isValidConnection, nodeDescriptorContractProblems, workflowEdgePortProblems, workflowPublishProblems } from './port-validation';
export type { PortValidationOptions } from './port-validation';

export { compile } from './compiler';
export type {
  CompiledWorkflowConfig,
  CompiledStage,
  CompiledNode,
  CompiledGate,
  CompiledPolicyBindings,
  CompiledCaps,
  CompiledRetryPolicy,
  CompiledInputBinding,
  CompiledGuardrailProfile,
  CompilerContext,
  CompilerNodeInfo,
  CompileResult,
} from './compiler';

export { DRAFT_SUMMARIZATION_RULE_SET } from './rule-catalogue';
export type { DraftWorkflowRule } from './rule-catalogue';

// `ALL_DRAFT_RULES` — every palette's bundled rule set, which is also `validate()`'s own
// default. A consumer that supplies its OWN `rules` (the DB-backed resolver in
// `@arcaai/applications`) needs this to stand in when no row applies: handing it
// `DRAFT_SUMMARIZATION_RULE_SET` alone silently drops every non-summarization palette's rules,
// because `validate()` filters by `paletteKey` and a consultation graph then matches only the
// palette-agnostic rows.
export { validate, ALL_DRAFT_RULES } from './validate';
export type { ValidateOptions } from './validate';
