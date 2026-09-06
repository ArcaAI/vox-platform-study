import { AgentTask } from '@arcaai/domains';
import {
  AgentBundleResponse,
  AgentResponse,
  AgentSummaryResponse,
  AgentSyncResponse,
  AgentTestAckResponse,
  AgentTestResultResponse,
  CloneAgentRequest,
  CreateAgentRequest,
  FinalizeAgentTestRequest,
  ImportAgentRequest,
  NewAgentVersionRequest,
  PublishAgentRequest,
  SyncAgentRequest,
  TestAgentRequest,
  UpdateAgentRequest,
} from './dto';

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

  /**
   * TASK-884 portability (owner decisions #2 and #4). All four land a DRAFT, never an active
   * version, and copy VALUES — a reference that is meaningless in the target is re-resolved or
   * refused with a named 409, never written dangling.
   */
  /** Clone a SYSTEM template or any visible agent into a NEW lineage (a SUPER_ADMIN may name another tenant). */
  clone(slug: string, dto: CloneAgentRequest): Promise<AgentResponse>;
  /** The portable JSON bundle for one version: values only, models by slug, no credential, no server-owned column. */
  exportBySlug(slug: string, versionNumber?: number): Promise<AgentBundleResponse>;
  /** Import a bundle into the caller's tenant, re-resolving every reference against what that tenant can see. */
  importBundle(dto: ImportAgentRequest): Promise<AgentResponse>;
  /** Push one of the caller's own agents into other tenants the caller manages; an unmanaged target is 404. */
  syncToTenants(slug: string, dto: SyncAgentRequest): Promise<AgentSyncResponse>;

  /**
   * TASK-890 §3.8 — the draft-agent test bench. Compiles the DRAFT in memory through the SAME
   * path publish uses, renders its prompt over the §3.3 scope and (unless `dryRun`, the default)
   * streams one generation on the tenant's own `monthlyLlmTokens` quota.
   *
   * A PUBLISHED row is refused with 409 — it is INVOKED, not tested.
   */
  testDraft(id: string, dto: TestAgentRequest): Promise<AgentTestAckResponse>;
  /** Read the finished run back SERVER-SIDE by task id and record it (`trigger: AGENT_TEST`). */
  finalizeDraftTest(id: string, dto: FinalizeAgentTestRequest): Promise<AgentTestResultResponse>;

  /** Business plane: the published, active agents visible to the tenant (one per slug), optionally by task. */
  listPublished(task?: AgentTask): Promise<AgentSummaryResponse[]>;
  getPublishedBySlug(slug: string): Promise<AgentSummaryResponse>;
}
