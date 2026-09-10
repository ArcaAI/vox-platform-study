/**
 * TASK-863 — wire types for `/admin/agents/**`, `/admin/agent-assignments/**` and the
 * registry/template pickers the create wizard needs. Mirrors the gateway DTOs
 * (`packages/applications/src/services/agent/dto`, `agent-assignment/dto`).
 */
export type AgentTask = 'SPEECH_TO_TEXT' | 'TEXT_GENERATION' | 'TEXT_TO_SPEECH' | 'NAMED_ENTITY_RECOGNITION';
export type AgentStatus = 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'DEPRECATED';
export type AgentAssignmentScope = 'TENANT' | 'DEPARTMENT' | 'DOCTOR';

export const AGENT_TASKS: readonly AgentTask[] = ['SPEECH_TO_TEXT', 'TEXT_GENERATION', 'TEXT_TO_SPEECH', 'NAMED_ENTITY_RECOGNITION'];

export const AGENT_TASK_LABEL: Record<AgentTask, string> = {
  SPEECH_TO_TEXT: 'Speech-to-text',
  TEXT_GENERATION: 'Text generation',
  TEXT_TO_SPEECH: 'Text-to-speech',
  NAMED_ENTITY_RECOGNITION: 'Named entity recognition',
};

/** The registry `AiModel.taskType` a model must carry to back each agent task (AGENT_TASK_MODEL_TASK_TYPE). */
export const AGENT_TASK_MODEL_TASK_TYPE: Record<AgentTask, string> = {
  SPEECH_TO_TEXT: 'AUTOMATIC_SPEECH_RECOGNITION',
  TEXT_GENERATION: 'TEXT_GENERATION',
  TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
  NAMED_ENTITY_RECOGNITION: 'TOKEN_CLASSIFICATION',
};

export interface AgentFallback {
  priority: number;
  modelId: string;
  modelSlug?: string | null;
  enabled: boolean;
}

export interface AgentFinding {
  severity: 'ERROR' | 'WARNING';
  code: string;
  path: string;
  message: string;
}

export interface AgentValidationReport {
  checkedAt: string;
  blocking: boolean;
  findings: AgentFinding[];
}

/**
 * TASK-890 §3.3 — a bound instruction variable is either a literal, or a path resolved from the
 * render scope (`context.*`, `trigger.*`, `input.*`, `vars.*`, `nodes.<id>.*`) BEFORE the
 * bare-name overlay. Exactly one of the two is set.
 */
export interface AgentPromptVariableBinding {
  value?: unknown;
  path?: string;
}

/** `Agent.instruction` for a TEXT_GENERATION agent bound to an approved prompt template. */
export interface TemplateInstruction {
  promptTemplateId: string;
  /** Pin a specific approved version; omitted ⇒ "follow the template's own approved version". */
  promptVersionNumber?: number | null;
  variables?: Record<string, AgentPromptVariableBinding>;
}

/**
 * TASK-947 §4.1 — the third TEXT_GENERATION instruction form: an ordered list of prompt
 * fragments, each a template reference or an inline body, each with an optional CEL `when`
 * condition (absent ⇒ always included — the "base"). Mirrors
 * `packages/workflow-contract/src/agent-schemas.ts` (`Fragment`); this console feature
 * hand-writes its own minimal type guards below rather than importing the not-yet-shipped
 * `@arcaai/workflow-contract` helpers (`isCompositeInstruction` etc. land in a later lane —
 * ticket §4.2 OD-13).
 */
export interface PromptFragment {
  key: string;
  promptTemplateId?: string;
  systemPrompt?: string;
  /** Only meaningful together with `promptTemplateId`; absent ⇒ follow the template's own approved version. */
  promptVersionNumber?: number;
  /** CEL string, ≤ 2,000 chars. Absent ⇒ always included. */
  when?: string;
}

/** `Agent.instruction` for a TEXT_GENERATION agent composed from an ordered fragment list. */
export interface CompositeInstruction {
  fragments: PromptFragment[];
  variables?: Record<string, AgentPromptVariableBinding>;
}

/** The 2-48 char `^[a-z0-9_]+$` handle a fragment key must match, unique within the list (agent-schemas.ts `KEY_PATTERN`). */
export const FRAGMENT_KEY_PATTERN = /^[a-z0-9_]{2,48}$/;
export const MIN_FRAGMENTS = 1;
export const MAX_FRAGMENTS = 16;
export const FRAGMENT_WHEN_MAX_LENGTH = 2000;

export type InstructionForm = 'template' | 'inline' | 'fragments' | 'none';

function isFragmentArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Which of the three mutually exclusive TEXT_GENERATION instruction shapes a raw instruction is. */
export function instructionForm(instruction: Record<string, unknown> | null | undefined): InstructionForm {
  if (!instruction) return 'none';
  if (isFragmentArray(instruction.fragments)) return 'fragments';
  if (typeof instruction.promptTemplateId === 'string') return 'template';
  if (typeof instruction.systemPrompt === 'string') return 'inline';
  return 'none';
}

/** One fragment out of a raw, possibly-malformed value — `null` when it does not even carry a `key`. */
function toPromptFragment(value: unknown): PromptFragment | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== 'string') return null;
  const fragment: PromptFragment = { key: record.key };
  if (typeof record.promptTemplateId === 'string') fragment.promptTemplateId = record.promptTemplateId;
  if (typeof record.systemPrompt === 'string') fragment.systemPrompt = record.systemPrompt;
  if (typeof record.promptVersionNumber === 'number') fragment.promptVersionNumber = record.promptVersionNumber;
  if (typeof record.when === 'string') fragment.when = record.when;
  return fragment;
}

/** The fragment list of a composite instruction, in authored order; `[]` for any other form or malformed input. */
export function readFragments(instruction: Record<string, unknown> | null | undefined): PromptFragment[] {
  if (!instruction || !isFragmentArray(instruction.fragments)) return [];
  return instruction.fragments.map(toPromptFragment).filter((fragment): fragment is PromptFragment => fragment !== null);
}

export interface Agent {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  task: AgentTask;
  versionNumber: number;
  parentVersionId: string | null;
  /** TASK-884 — the version this row was CLONED or SYNCED from; `sourceTenantId === SYSTEM` names a platform-origin clone. */
  sourceAgentId: string | null;
  sourceTenantId: string | null;
  sourceSlug: string | null;
  sourceVersionNumber: number | null;
  status: AgentStatus;
  isActive: boolean;
  modelId: string;
  /** TASK-890 §3.4 — the tenant context schema this agent pins; `null` ⇒ none bound. */
  contextSchemaId: string | null;
  /** The pinned schema VERSION; `null` ⇒ follow the schema's own pin. */
  contextSchemaVersionNumber: number | null;
  modelSlug: string | null;
  fallbacks: AgentFallback[];
  instruction: Record<string, unknown> | null;
  parameters: Record<string, unknown> | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  tools: Array<Record<string, unknown>> | null;
  compiledConfig: Record<string, unknown> | null;
  compiledConfigChecksum: string | null;
  validationReport: AgentValidationReport | null;
  validatedAt: string | null;
  publishedAt: string | null;
  deprecatedAt: string | null;
  resourceStatus: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  version: number;
}

export interface CreateAgentRequest {
  slug: string;
  name: string;
  description?: string;
  task: AgentTask;
  modelId: string;
  /** TASK-890 §3.4 — pin one of THIS tenant's consultation context schemas; frozen at publish. */
  contextSchemaId?: string | null;
  contextSchemaVersionNumber?: number | null;
  fallbackModelIds?: string[];
  instruction?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  tags?: string[];
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  modelId?: string;
  contextSchemaId?: string | null;
  contextSchemaVersionNumber?: number | null;
  fallbackModelIds?: string[];
  instruction?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  tags?: string[];
  expectedVersion?: number;
}

export interface PublishAgentRequest {
  activate?: boolean;
}

export interface NewAgentVersionRequest {
  slug?: string;
  name?: string;
  description?: string;
}

/** A gateway 400 on create/validate/publish carries the coded findings. */
export interface AgentProblemBody {
  message?: string;
  code?: string;
  findings?: AgentFinding[];
}

export interface AgentAssignment {
  id: string;
  tenantId: string;
  scope: AgentAssignmentScope;
  scopeId: string | null;
  task: AgentTask;
  agentSlug: string;
  /** TASK-884 — the canonical selector qualifying this assignment; empty = the tier's unqualified row. */
  selectorTags: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface UpsertAgentAssignmentRequest {
  scope: AgentAssignmentScope;
  scopeId?: string | null;
  task: AgentTask;
  agentSlug: string;
  /**
   * TASK-884 — the `key:value` selector this assignment is qualified by. It is part of the
   * row's IDENTITY, not one of its fields: changing it addresses a DIFFERENT assignment.
   */
  selectorTags?: string[];
  reason?: string;
  expectedVersion?: number;
}

/** TASK-884 — the portable bundle `GET admin/agents/{slug}/export` returns. */
export interface AgentBundle {
  kind: string;
  schemaVersion: number;
  exportedAt: string;
  source: { tenantKind: 'system' | 'global' | 'tenant'; slug: string; version: number };
  payload: Record<string, unknown> & { notes?: string[] };
}

export interface CloneAgentRequest {
  newSlug: string;
  name?: string;
  description?: string;
  sourceVersionNumber?: number;
  tenantId?: string;
  tags?: string[];
}

export interface ImportAgentRequest {
  bundle: Record<string, unknown>;
  slug?: string;
  name?: string;
}

/**
 * TASK-890 §3.8 — the draft-agent test bench (`POST admin/agents/:id/test` + `:id/test/finalize`).
 * Mirrors `TestAgentRequest` / `AgentTestAckResponse` / `AgentTestResultResponse`
 * (`packages/applications/src/services/agent/dto`).
 */
export interface FinalizeAgentTestRequest {
  taskId: string;
}

export interface TestAgentRequest {
  input?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  context?: Record<string, unknown>;
  provider?: string;
  model?: string;
  /** Default `true` — a dry run generates nothing and meters nothing. */
  dryRun?: boolean;
}

export interface AgentTestTarget {
  provider: string;
  model: string;
  fundingTier: 'platform' | 'tenant';
  source: 'row' | 'override';
}

/** TASK-947 §3 OD-11 — which fragments of a composite instruction ran. Keys only, never a condition string or a fragment body (no PHI-bearing text in telemetry). */
export interface AgentTestAckExcludedFragment {
  key: string;
  reason: 'condition_false' | 'condition_error';
  detail?: string;
}

export interface AgentTestAckComposition {
  selected: string[];
  excluded: AgentTestAckExcludedFragment[];
}

export interface AgentTestAck {
  mode: 'dry-run' | 'stream';
  findings: AgentFinding[];
  assembledSystemPrompt: string | null;
  assembledUserPrompt: string;
  resolved: AgentTestTarget;
  /** TASK-947 — present only when the instruction is the fragments form; absent ⇒ render nothing extra. */
  composition?: AgentTestAckComposition;
  /** Stream mode only. */
  taskId?: string;
  streamUrl?: string;
}

export interface AgentTestUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentTestResult {
  output: string;
  provider: string;
  model: string;
  usage: AgentTestUsage | null;
}

export interface Department {
  id: string;
  name: string;
}
