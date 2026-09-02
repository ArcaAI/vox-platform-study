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
export { MAX_GRAPH_NODES, MAX_GRAPH_EDGES, MAX_GRAPH_DEPTH, WORKFLOW_NODE_ID_PATTERN, WORKFLOW_DEFINITION_SLUG_PATTERN, workflowGraphProblems } from './graph-model';

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

export {
  AGENTIC_NODE_TYPES,
  AGENTIC_PALETTE_KEY,
  WORKFLOW_NODE_REGISTRY,
  classesOf,
  paletteOf,
  nodeInfo,
  workflowNodeClassLookup,
  registryChecksum,
} from './node-registry';
export type { WorkflowNodeDescriptor, WorkflowNodeEvalGate, WorkflowNodeLane, WorkflowNodeTrigger } from './node-registry';

export { GROUNDING_POLICY_TARGETS, NODE_CONFIG_SCHEMAS, TERMINOLOGY_PURPOSE_SCOPES } from './node-config-schemas';
export type { NodeConfigSchema } from './node-config-schemas';

// TASK-809 — the node CONTRACT: typed ports, their compatibility lattice, and the publish-time
// checks built on it. `document -> ner` being a TYPE ERROR is a property of
// `portPrimitiveSatisfies` + the port tables, not of any caller — see
// `__tests__/anti-laundering.test.ts`.
// TASK-847 adds the TIER 1 surface (`WORKFLOW_PORT_KINDS`/`portKindOf`/`portKindsCompatible`) —
// the cheap kind pre-filter the Studio canvas runs on every drag — alongside the lattice, which
// stays the publish-time authority. Tier 1 is coarser on purpose; see `port-model.ts`.
export {
  CONTEXT_PRIMITIVES_MIRROR,
  PORT_PRIMITIVE_CONTEXT_PRIMITIVE,
  PORT_PRIMITIVE_KIND,
  WORKFLOW_PORT_KINDS,
  WORKFLOW_PORT_PRIMITIVES,
  WORKFLOW_PORT_SUPERTYPE,
  isWorkflowPortPrimitive,
  portKindOf,
  portKindsCompatible,
  portPrimitiveSatisfies,
} from './port-model';
export type { WorkflowPortDescriptor, WorkflowPortKind, WorkflowPortPrimitive } from './port-model';

// TASK-847 — the `agentic` catalogue's checks a JSON Schema cannot express, and the mechanical
// form of §3.4 rule 16 (references only). `compiledGraphLeakProblems` is the one to reach for
// when reviewing anything that assembles a compiled config outside `compile()`.
export {
  FORBIDDEN_CONFIG_KEYS,
  GENERATION_HYPERPARAMETERS,
  agenticNodeConfigProblems,
  compiledGraphLeakProblems,
  forbiddenSchemaKeyProblems,
  hyperparameterCapabilityProblems,
} from './agentic-contract';
export type {
  AgenticGraphContext,
  AgenticNodeView,
  GenerationHyperparameter,
  HyperparameterCapabilityProblem,
  ProviderGenerationCapabilities,
} from './agentic-contract';

export { NODE_PORTS } from './node-ports';
export type { WorkflowNodePorts } from './node-ports';

export { isValidConnection, nodeDescriptorContractProblems, workflowEdgePortProblems, workflowPublishProblems } from './port-validation';
export type { PortValidationOptions } from './port-validation';

// TASK-847 step 7 TIER 2 — shallow schema compatibility, WARNING-severity only. Tier 1 (the
// port lattice, above) blocks; tier 3 is runtime validation at the node boundary. Never promote
// this to a publish gate: it reads two DECLARATIONS and guesses, which is useful as a hint and
// disqualifying as an authority.
export { schemaCompatWarnings, workflowEdgeSchemaWarnings } from './schema-compat';
export type { SchemaCompatFinding } from './schema-compat';

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
