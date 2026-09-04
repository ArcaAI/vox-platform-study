import { AgentTask } from '@arcaai/domains';
import { AgentResponse, AgentSummaryResponse, CreateAgentRequest, NewAgentVersionRequest, PublishAgentRequest, UpdateAgentRequest } from './dto';

export const IAgentService = Symbol('IAgentService');

/**
 * The Agent authoring lifecycle (TASK-863 §3.3):
 * `create (DRAFT)` → `validate` (VALIDATED or findings) → `publish` (compiledConfig stamped,
 * `isActive` election, immutable from here) → `newVersion` (branch from ANY version) → `deprecate`.
 */
export interface IAgentService {
  /** Admin list: the caller tenant's own rows (every version), plus SYSTEM's when `includeTemplates`. */
  list(task?: AgentTask, includeTemplates?: boolean): Promise<AgentResponse[]>;
  /** A row visible to the tenant (own or SYSTEM); anything else is 404. */
  getById(id: string): Promise<AgentResponse>;
  listVersions(id: string): Promise<AgentResponse[]>;
  create(dto: CreateAgentRequest): Promise<AgentResponse>;
  update(id: string, dto: UpdateAgentRequest, expectedVersion?: number): Promise<AgentResponse>;
  deleteById(id: string): Promise<AgentResponse>;
  /** Runs every publish-time check without publishing; stores the report and advances to VALIDATED when nothing blocks. */
  validate(id: string): Promise<AgentResponse>;
  /** Fails closed (400 with findings, `code: MODEL_UNAVAILABLE` etc.) on any blocking finding. */
  publish(id: string, dto: PublishAgentRequest): Promise<AgentResponse>;
  newVersion(sourceId: string, dto: NewAgentVersionRequest): Promise<AgentResponse>;
  deprecate(id: string): Promise<AgentResponse>;

  /** Business plane: the published, active agents visible to the tenant (one per slug), optionally by task. */
  listPublished(task?: AgentTask): Promise<AgentSummaryResponse[]>;
  getPublishedBySlug(slug: string): Promise<AgentSummaryResponse>;
}
