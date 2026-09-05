/**
 * TASK-863 — wire types for `/admin/agents/**`, `/admin/agent-assignments/**` and the
 * registry/template pickers the create wizard needs. Mirrors the gateway DTOs
 * (`packages/applications/src/services/agent/dto`, `agent-assignment/dto`).
 */
export type AgentTask = 'SPEECH_TO_TEXT' | 'TEXT_GENERATION' | 'TEXT_TO_SPEECH';
export type AgentStatus = 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'DEPRECATED';
export type AgentAssignmentScope = 'TENANT' | 'DEPARTMENT' | 'DOCTOR';

export const AGENT_TASKS: readonly AgentTask[] = ['SPEECH_TO_TEXT', 'TEXT_GENERATION', 'TEXT_TO_SPEECH'];

export const AGENT_TASK_LABEL: Record<AgentTask, string> = {
  SPEECH_TO_TEXT: 'Speech-to-text',
  TEXT_GENERATION: 'Text generation',
  TEXT_TO_SPEECH: 'Text-to-speech',
};

/** The registry `AiModel.taskType` a model must carry to back each agent task (AGENT_TASK_MODEL_TASK_TYPE). */
export const AGENT_TASK_MODEL_TASK_TYPE: Record<AgentTask, string> = {
  SPEECH_TO_TEXT: 'AUTOMATIC_SPEECH_RECOGNITION',
  TEXT_GENERATION: 'TEXT_GENERATION',
  TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
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

export interface Agent {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  task: AgentTask;
  versionNumber: number;
  parentVersionId: string | null;
  status: AgentStatus;
  isActive: boolean;
  modelId: string;
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

/** The registry rows the Model step lists (`GET admin/ai-models`, filtered client-side by task type). */
export interface RegistryModel {
  id: string;
  name: string;
  slug: string;
  taskType: string;
  provider?: string | null;
  localPath?: string | null;
  downloadStatus?: string | null;
  resourceStatus: string;
  tenantId: string;
  metaData?: Record<string, unknown> | null;
}

/** The instruction library the Instruction step picks from (`GET admin/prompt-templates`). */
export interface InstructionTemplate {
  id: string;
  name: string;
  status: 'DRAFT' | 'PUBLISHED' | 'APPROVED';
  category?: string;
  currentVersionNumber: number;
  approvedVersionNumber?: number | null;
}

export interface Department {
  id: string;
  name: string;
}
