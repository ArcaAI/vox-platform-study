/**
 * @arcaai/workflow-contract
 *
 * The pure workflow-graph validator + deterministic compiler engine for the
 * agentic-workflow-platform substrate. Zero runtime dependencies.
 *
 * IMPORTANT — rule-set status: the rule INSTANCES exported from `./rule-catalogue` are a
 * DRAFT, authored by this ticket's engineering pass and NOT YET clinician-reviewed (see
 * ENGINE in this package (graph algorithms, the closed predicate catalogue, the compiler) is
 * mechanism, not policy, and is safe to build against; the *specific 22 rules* are safe to
 * TEST against but must not be presented as a validated safety boundary or wired as an
 * enforcing gate until that review completes.
 */

export type { WorkflowGraph, WorkflowGraphNode, WorkflowGraphEdge, WorkflowNodePosition } from './graph-model';

// TASK-864 — the `core` vocabulary's contract: the action catalogue behind `core.action`,
// per-instance (dynamic) branch handles, loop-body rules, the publish-time checks a JSON
// Schema cannot express, and the protocol/trigger/schema readers the exposure plane and the
// OpenAPI generator consume.
export {
  ACTION_CATALOGUE,
  ANNOTATION_NODE_CLASS,
  CORE_OUTPUT_PROTOCOLS,
  CORE_TRIGGER_KINDS,
  DEFAULT_OUTPUT_PROTOCOLS,
  LOOP_NODE_CLASS,
  REVIEW_NODE_CLASS,
  ROUTER_NODE_CLASS,
  actionConfigSchemaOf,
  actionDelegateOf,
  branchHandlesOf,
  coreNodeConfigProblems,
  declaredIoSchemas,
  declaredOutputProtocols,
  declaredTriggerKinds,
  effectivePorts,
  isBranchHandle,
  isCoreGraph,
  loopBodyProblems,
  resolveInputPort,
  resolveOutputPort,
} from './core-contract';
export type { CoreActionDescriptor, CoreNodeView, CoreOutputProtocol, CoreTriggerKind } from './core-contract';

// TASK-864 §3.2 — the CEL-subset expression language `core.condition` / `core.loop` are authored
// in. Pure, total, dependency-free; the Python interpreter mirrors it and both are held to ONE
// committed fixture (`__tests__/fixtures/expressions.fixture.json`).
export {
  EXPRESSION_CONTEXT_ROOTS,
  evaluateCondition,
  evaluateExpression,
  expressionProblems,
  expressionRootIdentifiers,
  parseExpression,
} from './expressions';
export type { ExpressionNode, ExpressionResult, ExpressionValue } from './expressions';
export {
  MAX_GRAPH_NODES,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_DEPTH,
  WORKFLOW_NODE_ID_PATTERN,
  WORKFLOW_DEFINITION_SLUG_PATTERN,
  workflowGraphProblems,
} from './graph-model';

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

// TASK-890 §3.2 — the ONE prompt-template grammar (`{{ path | default("…") }}`) that replaces the
// six flavours §2.4 catalogued, mirrored in Python by the harness's `templating.py` and held to
// `tests/contracts/prompt-template.fixture.json` by two loaders. Every TS renderer imports
// `renderTemplate` from HERE — there is no dispatch, no syntax sniff and no per-caller copy.
export {
  PromptTemplateSyntaxError,
  PromptVariableUnresolvedError,
  renderTemplate,
  templateReferenceProblems,
  templateReferences,
  templateSyntaxProblems,
} from './template';
export type { DeclaredNamespaces, RenderTemplateOptions, TemplateReference } from './template';

// TASK-890 §3.14 (OD-R clause 3) — the guardrail opt-out's ONE precedence function
// (node > workflow > agent > `true`), mirrored in Python by the harness's `guardrail_optout.py`
// and held to `tests/contracts/guardrail-optout.fixture.json`. Guardrail POLICY is untouched:
// this answers only "does the platform's guardrail run for THIS call", and a tenant may only
// opt OUT.
export { GUARDRAIL_DECISION_SOURCES, guardrailOptOutOf, resolveGuardrailDecision } from './guardrail-optout';
export type { GuardrailDecision, GuardrailDecisionSource, GuardrailOptOutInputs } from './guardrail-optout';

export {
  AGENTIC_NODE_TYPES,
  AGENTIC_PALETTE_KEY,
  CORE_NODE_TYPES,
  CORE_PALETTE_KEY,
  WORKFLOW_NODE_REGISTRY,
  classesOf,
  isDeprecatedNodeType,
  paletteOf,
  nodeInfo,
  workflowNodeClassLookup,
  registryChecksum,
} from './node-registry';
export type { WorkflowNodeDescriptor, WorkflowNodeEvalGate, WorkflowNodeLane, WorkflowNodeTrigger } from './node-registry';

export { GROUNDING_POLICY_TARGETS, NODE_CONFIG_SCHEMAS, TERMINOLOGY_PURPOSE_SCOPES } from './node-config-schemas';
export type { NodeConfigSchema } from './node-config-schemas';

// the node CONTRACT: typed ports, their compatibility lattice, and the publish-time
// checks built on it. `document -> ner` being a TYPE ERROR is a property of
// `portPrimitiveSatisfies` + the port tables, not of any caller — see
// `__tests__/anti-laundering.test.ts`.
// adds the TIER 1 surface (`WORKFLOW_PORT_KINDS`/`portKindOf`/`portKindsCompatible`)
// the cheap kind pre-filter the Studio canvas runs on every drag — alongside the lattice, which
// stays the publish-time authority. Tier 1 is coarser on purpose; see `port-model.ts`.
export {
  ANY_PORT_PRIMITIVE,
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

// the `agentic` catalogue's checks a JSON Schema cannot express, and the mechanical
// form of rule 16 (references only). `compiledGraphLeakProblems` is the one to reach for
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

export { isValidConnection, nodeDescriptorContractProblems, workflowEdgePortProblems } from './port-validation';
export type { PortValidationOptions } from './port-validation';

// TASK-890 §3.5 (F-10) — the ONE publish gate, as machine-readable findings. It REPLACES
// `workflowPublishProblems`, which was a real gate nothing ever called (BLOCKER 1c), re-emits
// every one of its checks with a `code`, and adds the per-node config-schema check nobody ran.
export { PUBLISH_FINDING_RULE_ID, TEMPLATE_REFERENCE_SEVERITY_RELEASE_1, WORKFLOW_PUBLISH_FINDING_CODES, publishFindings } from './publish-findings';
export type { GenerationRange, GenerationRanges, PublishAgentView, PublishContext, WorkflowPublishFindingCode } from './publish-findings';
// step 7 TIER 2 — shallow schema compatibility, WARNING-severity only. Tier 1 (the
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
  CompiledBranchGuard,
  CompiledLoop,
  CompiledLoopBody,
  CompiledPolicyBindings,
  CompiledCaps,
  CompiledRetryPolicy,
  CompiledInputBinding,
  CompiledGuardrailProfile,
  CompilerContext,
  CompilerNodeInfo,
  CompileResult,
} from './compiler';

export { DRAFT_CONSULTATION_RULE_SET, DRAFT_CORE_RULE_SET, DRAFT_SUMMARIZATION_RULE_SET } from './rule-catalogue';
export type { DraftWorkflowRule } from './rule-catalogue';

// `ALL_DRAFT_RULES` — every palette's bundled rule set, which is also `validate()`'s own
// default. A consumer that supplies its OWN `rules` (the DB-backed resolver in
// `@arcaai/applications`) needs this to stand in when no row applies: handing it
// `DRAFT_SUMMARIZATION_RULE_SET` alone silently drops every non-summarization palette's rules,
// because `validate()` filters by `paletteKey` and a consultation graph then matches only the
// palette-agnostic rows.
export { validate, ALL_DRAFT_RULES } from './validate';
export type { ValidateOptions } from './validate';

// TASK-863 — the Agent entity's task-typed configuration contract (parameters / instruction /
// default I/O per task, protocols, and the checks a JSON Schema cannot express).
export {
  AGENT_FALLBACK_DEFAULTS,
  AGENT_INSTRUCTION_SCHEMAS,
  AGENT_IO_DEFAULTS,
  AGENT_PARAMETER_SCHEMAS,
  AGENT_PROTOCOLS,
  AGENT_TAG_MAX_COUNT,
  AGENT_TAG_PATTERN,
  AGENT_TASKS,
  AGENT_TASK_MODEL_TASK_TYPE,
  AGENT_TASK_SERVICE,
  AGENT_TOOLS_SCHEMA,
  ASR_ENDPOINTING_MODEL_SLUG_PATH,
  PROMPT_VARIABLE_PATH_PATTERN,
  agentConfigProblems,
  agentTagProblems,
  agentTagsSatisfy,
  canonicalAgentTags,
  hasBlockingAgentProblems,
  isAgentTask,
  parseAgentTag,
  readAgentFallbackGovernance,
} from './agent-schemas';
export type {
  AgentConfigContext,
  AgentFallbackGovernance,
  AgentConfigProblem,
  AgentConfigView,
  AgentIoDefaults,
  AgentModelView,
  AgentProtocol,
  AgentProviderCapabilities,
  AgentTagPair,
  AgentTask,
} from './agent-schemas';

// TASK-884 — the portable bundle envelope a tenant admin exports and imports. Generic over
// `kind` on purpose: agents ship it first, workflow definitions reuse the same envelope.
export {
  PORTABLE_BUNDLE_KINDS,
  PORTABLE_BUNDLE_SCHEMA_VERSION,
  PORTABLE_BUNDLE_TENANT_KINDS,
  buildPortableBundle,
  isPortableBundle,
  portableBundleProblems,
} from './portable-bundle';
export type {
  PortableBundle,
  PortableBundleExpectation,
  PortableBundleKind,
  PortableBundleProblem,
  PortableBundleSource,
  PortableBundleTenantKind,
} from './portable-bundle';
