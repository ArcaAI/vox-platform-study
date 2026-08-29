/**
 * PromptResolutionService
 *
 * Resolves prompt configuration (summary template, prompt ID, context
 * variables). The chain is SPLIT BY CAPABILITY, because pre-summary and
 * summary are not the same shape of prompt:
 *
 *   promptType ∈ { 'new-patient', 'revisit' } — the SUMMARY (clinical note)
 *   chain (highest priority first):
 *     Tier-0  (preferred)  — the consulting doctor's preferred prompt template,
 *       from `UserProfile.preferredPromptTemplateId`.
 *     Tier-0b (visit type) — the tenant's `(task, visitType)` PROMPT BINDING,
 *       from its `consultation.visitTypes` catalogue (tenant -> SYSTEM). See
 *       `resolveVisitTypeBinding` for the axis and `serveVisitTypeBinding` for
 *       the tier; it runs on ALL THREE chains, not just this one.
 *     Tier-1a (node)       — the GOVERNING WORKFLOW DEFINITION's finalize
 *       generation node (`taskKey: 'text.finalize'`), serving that node's
 *       `promptTemplateId` at its own `promptVersionNumber` pin. The definition
 *       is resolved through the `department -> tenant -> platform default`
 *       assignment cascade, so the tier keeps the department axis it always had.
 *     Tier-1b (department) — the department's visit-type prompt column. This is
 *       where the VISIT-TYPE AXIS now lives on its own: the node substrate has
 *       none by design (DD-2 — a generation node binds its prompt statically).
 *       WHICH column is a tenant-configured question now, not a literal: the
 *       tenant's `consultation.visitTypes` catalogue (tenant → SYSTEM) maps the
 *       `promptType` value onto one of the department's two prompt slots.
 *     Tier-2  (default)    — `SYSTEM_DEFAULTS.promptId` (CATCHALL_SOAP).
 *
 *   promptType === 'pre-summary' — the PRE-SUMMARY chain:
 *     Tier-0b (visit type) — as above. This chain had NO visit-type axis at all
 *       until the owner's 2026-08-29 directive: `promptType` is the PHASE here,
 *       so the visit type could not reach the resolver and arrived only as the
 *       `{visit_type}` VARIABLE. `params.visitTypeKey` is what states it.
 *     (no node tier — the pre-summarisation node type does not exist yet; see
 *      `resolvePreSummaryPromptId` for why the tier is absent rather than
 *      pointed at some other node's prompt.)
 *     Tier-1t (tenant)     — the tenant's TENANT_DEFAULT pre-summary template
 *       for the requested SURFACE (RF-2, refined by OD-7(b)): the `'v1'`
 *       surface matches any `pre-summary`-tagged row EXCEPT one also tagged
 *       `dept-free`, so a legacy/untagged tenant row keeps resolving; the
 *       `'dept-free'` surface still requires the explicit opt-in
 *       `hasEvery(['pre-summary', 'dept-free'])` — a row must OPT IN to being
 *       dept-free, never be inferred into it.
 *     Tier-2  (default)    — the SYSTEM default for that surface.
 *     …otherwise it FAILS CLOSED (503).
 *
 * Why the split: pre-summary has NO department axis, and had no visit-type axis
 * either — v1 carries exactly ONE pre-summary prompt per tenant, and department
 * and visit type are VARIABLES INSIDE it, never selectors for a different
 * prompt. The DEPARTMENT half of that is unchanged. The VISIT-TYPE half is what
 * the owner's 2026-08-29 directive reopened: a tenant may now bind a
 * pre-summary prompt per visit type, and until it does, nothing changes.
 * The old single chain ran the promptType-AGNOSTIC agent tier first, so every
 * department with a default agent served a clinical NOTE prompt for
 * `promptType: 'pre-summary'`, and a department without one fell through to
 * CATCHALL_SOAP — also a note prompt. Both are silent clinical wrong-prompt
 * failures, so the pre-summary chain raises rather than substituting a
 * summary-shaped prompt.
 *
 * WHY THE TIER IS STILL CALLED `'agent'`. `ResolvedPromptConfig` is reached by
 * a FROZEN v1-compat wire route (`TextCompatController` ->
 * `TextCompatTemplateService.resolveGovernedInstruction()`), so its field set —
 * `resolvedFrom`, `resolvedAgentId`, `content`, `resolvedVersionNumber` — and
 * the values `resolvedFrom` may take are a published contract. TASK-815 moved
 * the tier's SOURCE from `DepartmentAgent` onto workflow node config and left
 * the contract exactly where it was; `resolvedAgentId` now carries the
 * WORKFLOW NODE ID that supplied the prompt. Renaming either would break a
 * frozen route for a cosmetic gain.
 *
 * The chosen tier is reported back on `ResolvedPromptConfig.resolvedFrom`
 * (`'preferred' | 'agent' | 'department' | 'tenant' | 'default'`), and it
 * reflects WHICH TIER PRODUCED THE PROMPT ID — a resolution that fell through
 * to the system default reports `'default'` even when the department supplied
 * the summary template. (Before, such a resolution reported `'department'`,
 * which made the compat shim's `resolvedFrom === 'default'` guard dead code.)
 *
 * DNA resolution is no longer part of this service; DNA style is per-doctor
 * and resolved elsewhere.
 *
 * This service does NOT depend on ClsService (request context) because it is
 * invoked from background job processors (BullMQ workers) that have no HTTP
 * request context. All identifying information is passed as parameters.
 *
 * Implements Department-to-Prompt Mapping.
 */

import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import {
  DepartmentRepository,
  DepartmentEntity,
  PromptTemplateRepository,
  PromptVersionRepository,
  PromptTemplateScope,
  PromptTemplateStatus,
  ResourceStatusType,
  WorkflowDefinitionRepository,
  type IFindAllProps,
  type PromptTemplate,
} from '@arcaai/domains';
import { WORKFLOW_NODE_REGISTRY, type WorkflowGraph, type WorkflowGraphNode } from '@arcaai/workflow-contract';

import { IWorkflowAssignmentService } from '../../workflow-assignment/IWorkflowAssignmentService';
import { DEFAULT_VISIT_TYPE_SERVICE, VisitTypeService } from '../visit-type/visit-type.service';
import { type VisitTypeDefinition, type VisitTypePromptBinding, type VisitTypePromptTask } from '../visit-type/visit-type.catalogue';

// ============================================================================
// Types
// ============================================================================

/**
 * A prompt PHASE selector: WHICH capability chain runs. Not a visit type — the
 * resolver has always known the difference, it just never named it (it derives
 * `resolvedCapability` from the same parameter, below).
 */
export type PromptPhase = 'pre-summary' | 'live';

/**
 * What `promptType` accepts. It carries BOTH axes, and that is a frozen wire
 * contract (TASK-815 §2), so the phase selectors keep travelling here rather
 * than moving to a parameter of their own.
 *
 * Anything that is not a phase is a VISIT-TYPE KEY from the tenant's
 * `consultation.visitTypes` catalogue. `'new-patient'` and `'revisit'` are
 * spelled out because they are the two keys the platform SHIPS — a tenant that
 * has expressed no opinion still resolves exactly those — and `(string & {})`
 * admits a tenant's own keys while keeping the four literals in autocomplete.
 */
export type PromptTypeSelector = PromptPhase | 'new-patient' | 'revisit' | (string & {});

/**
 * Resolved prompt configuration returned by the service.
 *
 * All fields are guaranteed to be defined (falling through to system defaults).
 */
export interface ResolvedPromptConfig {
  /** The summary template (e.g., 'SOAP', 'Radiology-Report') */
  template: string;

  /** The prompt registry ID for the specific patient type */
  promptId: string;

  /** Additional context variables from department promptConfig */
  contextVariables: Record<string, unknown>;

  /** Which tier of the fallback chain provided the values */
  resolvedFrom: PromptResolutionTier;

  /** Full resolution trace for debugging and audit */
  resolutionTrace: PromptResolutionTrace;

  /**
   * The governed prompt CONTENT snapshot for whatever tier resolved. Read from
   * `PromptVersion.content` at the agent pin / `approvedVersionNumber`, never the
   * mutable `PromptTemplate.content` row — this is what makes version pinning and
   * eval-gated approval actually reach the LLM (F-01/F-02). The sole consumer,
   * `PromptAssemblyService.assemble()`, uses this for the prompt body. Absent
   * only when no snapshot could be resolved (legacy data with no version rows and
   * no content column), leaving the assembler's transcript fallback to apply.
   */
  content?: string | null;

  /** The resolved PromptVersion number backing `content`. */
  resolvedVersionNumber?: number | null;

  /**
   * The identifier of whatever supplied tier-1a, when tier-1a resolved.
   *
   * Since TASK-815 that is the WORKFLOW NODE ID of the generation node whose
   * config carried the prompt binding (it was the `DepartmentAgent` row id
   * before). The FIELD is part of the frozen v1-compat contract and does not
   * move; only what it names does. Consumers treat it as an opaque lineage
   * token — `SummaryMeta.sessionAgentId`, the live snapshot's `agentId`, and
   * `PromptResolutionParams.pinnedAgentId` all round-trip it without parsing.
   */
  resolvedAgentId?: string;

  /**
   * Which CAPABILITY CHAIN produced this result. Additive, trace/telemetry only
   * — no branching keys on it. Present so a caller (and the live/finalize
   * lineage in Lane C5) can record what kind of prompt it was handed without
   * re-deriving it from `promptType`.
   */
  resolvedCapability?: 'summary' | 'pre-summary' | 'live';
}

/**
 * Which tier produced the resolved `promptId`.
 *
 * `'tenant'` is the pre-summary-only tenant-default tier; the summary chain
 * never reports it, and the pre-summary chain never reports
 * `'preferred' | 'agent' | 'department'`.
 *
 * `'code-default'` is LIVE-ONLY: the live chain's fail-open
 * tail, meaning "no governed template could be resolved — serve the in-code
 * constants". It is never reported by the summary or pre-summary chains, which
 * keep their fail-closed / SYSTEM-default posture.
 */
export type PromptResolutionTier = 'preferred' | 'agent' | 'department' | 'tenant' | 'default' | 'code-default';

/** Trace of what each tier contributed */
export interface PromptResolutionTrace {
  /** The doctor's preferred prompt template id, when it resolved (Tier-0) */
  preferredPromptId?: string | null;
  /** The workflow NODE id that supplied tier-1a, when tier-1a resolved. */
  agentId?: string | null;
  /** The resolved PromptVersion number for the node tier */
  agentVersionNumber?: number | null;
  departmentTemplate?: string | null;
  departmentPromptId?: string | null;
  /**
   * The tenant-default template id, when the pre-summary tenant tier resolved.
   * Always null on the summary chain (that chain has no tenant tier).
   */
  tenantPromptId?: string | null;
  usedDefaults: string[];
  /**
   * The visit type this resolution used (its catalogue KEY), or null when the
   * request carried no visit-type opinion — a bare phase selector, or a
   * spelling no entry in the tenant's catalogue claims.
   */
  visitTypeKey?: string | null;
  /** The TEXT-GENERATION TASK the `(task, visitType)` binding was looked up for. */
  visitTypeTask?: string | null;
  /**
   * The template a `(task, visitType)` binding SERVED, or null when none did —
   * either because the tenant bound nothing for this pairing or because what it
   * bound was not APPROVED. A miss is visible here rather than silent, which is
   * what makes a typo in an open-ended task key diagnosable.
   */
  visitTypePromptId?: string | null;
  /**
   * CONFIGURATION errors surfaced during resolution — a tenant setup problem the caller should
   * see, distinct from `usedDefaults`, which records a legitimate tier miss.
   *
   * Added by TASK-806 lane A item 1 for the owner's ruling that the pre-summary tier's loss is
   * "not accepted as a silent fallback": a tenant with no ACTIVE `agent.presummarization` node
   * still gets a prompt, but the absence is NAMED here and logged at error level rather than
   * disappearing into `usedDefaults`. Additive and optional — no existing consumer branches on it.
   */
  configurationErrors?: string[];
}

/**
 * Input parameters for prompt resolution.
 * All fields are optional to support various calling contexts.
 */
export interface PromptResolutionParams {
  /** Department ID — used to look up department-level defaults */
  departmentId?: string;

  /**
   * Tenant ID — required by the pre-summary chain, which has no department
   * axis and therefore cannot derive the tenant from a Department row.
   *
   * OPTIONAL so existing callers keep compiling: when absent the tenant is
   * derived from `departmentId`'s Department, and when neither is available a
   * pre-summary request degrades to the SYSTEM pre-summary default (and fails
   * closed if that is missing). It is ignored by the summary chain.
   */
  tenantId?: string;

  /**
   * Prompt type — selects the CAPABILITY CHAIN (see the file header), not just
   * a column: `'pre-summary'` runs the tenant chain, `'live'` the live chain
   * everything else the summary chain.
   */
  promptType?: PromptTypeSelector;

  /**
   * The VISIT TYPE, stated on its own axis — a key or any alias from the
   * tenant's `consultation.visitTypes` catalogue.
   *
   * WHY IT EXISTS. `promptType` carries both the phase and the visit type
   * because it is a frozen wire contract (TASK-815 §2), and that conflation is
   * exactly what stopped visit type being the general prompt-composition
   * identifier the owner specified: a request that says `'pre-summary'` cannot
   * ALSO say `'revisit'`, so the pre-summary chain could never see a visit type
   * at all. This parameter separates the axes WITHOUT narrowing `promptType`.
   *
   * ADDITIVE AND OPTIONAL. Absent ⇒ the visit type is derived from `promptType`
   * exactly as before, so every existing call site is byte-identical. Present ⇒
   * it WINS, because a caller that names the axis explicitly is stating
   * something `promptType` cannot.
   */
  visitTypeKey?: string;

  /**
   * Which PRE-SUMMARY template FAMILY the caller wants.
   *
   * NOT a compat/native flag (RF-5 forbids that for agent eligibility, which
   * stays derived from the call signature): a NATIVE consultation may
   * legitimately carry no department and must still get the department-free
   * family, while a COMPAT call with the same signature must get the v1 family.
   * The two families are discriminated by a surface TAG on the tenant row and
   * by distinct SYSTEM defaults.
   *
   * Defaults to `'v1'`, which is why every existing call site is untouched by
   * C2. Native callers opt in to `'dept-free'` in Lane D2, once the fork is
   * seeded; until then the mechanism ships dormant.
   *
   * Ignored by the summary chain.
   */
  preSummaryVariant?: 'v1' | 'dept-free';

  /**
   * Finalize PINS the summary chain's node tier to the NODE that actually ran
   * the LIVE session, instead of re-selecting the graph's first finalize node.
   *
   * Why: a graph re-authored mid-visit (or an assignment re-pointed between
   * `start()` and finalize) would otherwise silently change the prompt that
   * reviews the very note the live pass produced — exactly the "same specific
   * agent reviews and finalizes" contract R-N2 exists to close.
   *
   * FALLS THROUGH, NEVER THROWS. The pin must still name a node present in the
   * governing graph that serves the requested task; a removed / renamed node
   * (or a failed lookup) degrades to the graph's own first node — a finalize
   * must never 500 because the graph was tidied up.
   *
   * Tier-0 (doctor-preferred) still outranks it (DR-2): an explicit clinician
   * choice is a stronger signal than the department default that happened to
   * run live. Lineage is still recorded on `SummaryMeta` in that case, so
   * provenance is never lost.
   *
   * Ignored by the pre-summary and live chains.
   */
  pinnedAgentId?: string;

  /** Explicit template override from the request */
  explicitTemplate?: string;

  /**
   * The requesting doctor's preferred prompt template id (Tier-0).
   * When set and the template exists, it wins over the department/default tiers.
   */
  preferredPromptTemplateId?: string | null;
}

// ============================================================================
// Constants
// ============================================================================

/** System default values — the final fallback tier */
export const SYSTEM_DEFAULTS = {
  template: 'SOAP',
  promptId: '71000000-0000-0000-0000-000000000036', // CATCHALL_SOAP — see seed/00-constants.ts
  /**
   * The SYSTEM pre-summary prompt (`TEMPLATE_IDS.PRE_SUMMARY_DEFAULT` in
   * seed/00-constants.ts). The pre-summary chain NEVER falls back to
   * `promptId` — CATCHALL_SOAP is a clinical NOTE prompt, and serving it for a
   * pre-summary request is the defect this split exists to kill.
   */
  preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
  /**
   * The SYSTEM live-summarization default (`SYSTEM_LIVE_SOAP_TEMPLATE_ID` in
   * seed/00-constants.ts, seeded by seed/07c-live-agent-defaults.ts). Its
   * content is byte-identical to the live loop's in-code constants, which is
   * what makes the live chain's code-default fail-open tier safe. The `'live'`
   * CHAIN itself lands in Lane C3; C2 seeds the row and claims the pointer.
   */
  livePromptId: '71000000-0000-0000-0004-000000000001',
  /**
   * The department-free pre-summary fork served to NATIVE callers
   * (`preSummaryVariant: 'dept-free'`). RESERVED: Lane D2 seeds the row and
   * flips the native call sites. Until then nothing requests that variant, and
   * a request for it correctly fails closed rather than silently serving the v1
   * body with its `{current_department}` / `{visit_type}` placeholders.
   */
  deptFreePreSummaryPromptId: '71000000-0000-0000-0004-000000000002',
} as const;

/**
 * The tag that marks a prompt template as the tenant's PRE-SUMMARY prompt.
 *
 * There is no first-class `tenantPreSummaryTemplateId` pointer field today, so
 * the tenant's pre-summary prompt is identified BY CONVENTION — see
 * `findTenantPreSummaryTemplateId` for the tradeoff and the migration path.
 */
const PRE_SUMMARY_TEMPLATE_TAG = 'pre-summary';

/**
 * The SURFACE tag that discriminates the two pre-summary
 * families within one tenant.
 *
 * With a department-free fork (Lane D2) a tenant may legitimately own TWO
 * `pre-summary`-tagged TENANT_DEFAULT rows. Without a second discriminator the
 * fork would recreate B-01 (two candidates, first-by-createdAt silently wins),
 * so the single-candidate rule becomes per-(tenant, SURFACE).
 *
 * OD-7(b) — the two surfaces are NOT symmetric queries:
 *   - `'dept-free'` is a POSITIVE opt-in match, requiring BOTH tags
 *     (`hasEvery(['pre-summary', 'dept-free'])`) — a row must OPT IN to being
 *     the fork, never be inferred into it.
 *   - `'v1'` is a NEGATIVE match — any `pre-summary` row EXCEPT one also
 *     tagged `dept-free` — so a legacy/untagged tenant row (no `text-v1` tag)
 *     keeps resolving instead of silently falling through to the SYSTEM
 *     default, which is what the original `hasEvery(['pre-summary',
 *     'text-v1'])` predicate did to hand-created tenant data. `text-v1` remains
 *     as a label (seeded rows still carry it) but is no longer part of the
 *     'v1' query itself.
 */
const PRE_SUMMARY_SURFACE_TAG = {
  v1: 'text-v1',
  'dept-free': 'dept-free',
} as const;

/** What a capability chain returns: the prompt id, its tier, and its snapshot. */
interface ResolvedPromptId {
  promptId: string;
  tier: PromptResolutionTier;
  content?: string | null;
  versionNumber?: number | null;
  agentId?: string;
  /**
   * The CONTEXT half of a `(task, visitType)` composition, merged over the
   * department's own `promptConfig.contextVariables` by `resolve()`.
   *
   * Carried on the winning tier rather than applied out-of-band so the two
   * halves cannot separate: a binding's context variables reach the prompt only
   * when that binding's INSTRUCTIONS did, never composed into some other tier's
   * template. Set by the visit-type tier alone; every other tier omits it.
   */
  contextVariables?: Record<string, unknown>;
}

/** A `(task, visitType)` pairing the tenant's catalogue actually answered. */
interface ResolvedVisitTypeBinding {
  visitType: VisitTypeDefinition;
  task: VisitTypePromptTask;
  binding: VisitTypePromptBinding;
}

// ============================================================================
// Tier-1a source: the governing workflow definition's node config (TASK-815)
// ============================================================================

/** The palette whose assigned definition governs a consultation. */
const CONSULTATION_PALETTE_KEY = 'consultation';

/**
 * The generation task a node serves, as declared by its `taskKey` config key.
 * Only the two clinical ones are selectable here — `text.test` is a Studio
 * dry-run task and must never be reachable from a clinical resolution.
 */
type NodeTaskKey = 'text.finalize' | 'text.live';

/** Node config keys carrying the DD-11 prompt binding (mirrors `node-prompt-binding.ts`). */
const PROMPT_TEMPLATE_ID_KEY = 'promptTemplateId';
const PROMPT_VERSION_NUMBER_KEY = 'promptVersionNumber';
const TASK_KEY = 'taskKey';

function nodeConfig(node: WorkflowGraphNode): Record<string, unknown> {
  const config = node.config;
  return typeof config === 'object' && config !== null && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
}

function readPromptTemplateId(node: WorkflowGraphNode): string | null {
  const value = nodeConfig(node)[PROMPT_TEMPLATE_ID_KEY];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The node's OWN pin onto one immutable `PromptVersion`, or null when unpinned. */
function readPromptVersionPin(node: WorkflowGraphNode): number | null {
  const value = nodeConfig(node)[PROMPT_VERSION_NUMBER_KEY];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The task a node ACTUALLY serves: its authored `taskKey`, or the registry
 * schema's declared default for that node type when the key is absent.
 *
 * The default matters. `consultation.realtimeSummary` declares
 * `taskKey: { …, default: 'text.live' }`, so a node authored without the key is
 * still a live node — to the interpreter and therefore to this resolver too.
 * Reading the default from `WORKFLOW_NODE_REGISTRY` rather than restating it
 * here is what keeps the two from drifting: a node type whose default changes
 * changes here in the same commit.
 */
function effectiveTaskKey(node: WorkflowGraphNode): string | undefined {
  const authored = nodeConfig(node)[TASK_KEY];
  if (typeof authored === 'string' && authored.length > 0) return authored;

  const declared = WORKFLOW_NODE_REGISTRY[node.type]?.configSchema?.properties?.[TASK_KEY];
  const fallback = typeof declared === 'object' && declared !== null ? (declared as { default?: unknown }).default : undefined;
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : undefined;
}

/**
 * Every node in the graph that carries a prompt binding AND serves `taskKey`,
 * in AUTHORED ORDER — which is what makes "the first one" a deterministic
 * choice rather than a Postgres tie-break.
 *
 * Keyed off the presence of `promptTemplateId` plus the effective task, never
 * off a list of node TYPES, for the reason `collectPromptBindings` gives: a
 * type allow-list silently misses the next generation node someone registers,
 * and missing one here means resolving a different prompt than the interpreter
 * would run.
 */
function promptBearingNodesForTask(graph: WorkflowGraph | null | undefined, taskKey: NodeTaskKey): WorkflowGraphNode[] {
  if (!graph || !Array.isArray(graph.nodes)) return [];
  return graph.nodes.filter((node) => readPromptTemplateId(node) !== null && effectiveTaskKey(node) === taskKey);
}

/** DD-6's pre-summarization node type — the successor to the department default agent's
 *  `preSummaryTemplateId` column (TASK-815 §11, owner ruling). */
const PRESUMMARIZATION_NODE_TYPE = 'agent.presummarization';

/**
 * A node the tenant has switched OFF. `config.enabled === false` is the platform-wide
 * "authored, but not running" convention — the realtime executor reads exactly this key
 * (`realtime-lane.ts`) — so an inactive node must not supply a prompt either. The owner's ruling
 * says a tenant must configure an ACTIVE pre-summarization node; this is what "active" means.
 */
function isNodeDisabled(node: WorkflowGraphNode): boolean {
  return nodeConfig(node).enabled === false;
}

/**
 * Every ACTIVE, prompt-bearing pre-summarization node, in authored order.
 *
 * Selected by node TYPE rather than by `taskKey`, unlike the summary/live tiers, and that
 * difference is the point: `taskKey` distinguishes which GENERATION TASK a node in the note
 * pipeline serves, while pre-summary is a different CAPABILITY with its own node type. Keying it
 * off `taskKey` would make a pre-summary request selectable by a note node again, which is the
 * exact wrong-prompt failure the capability split exists to prevent.
 */
function activePresummarizationNodes(graph: WorkflowGraph | null | undefined): WorkflowGraphNode[] {
  if (!graph || !Array.isArray(graph.nodes)) return [];
  return graph.nodes.filter((node) => node.type === PRESUMMARIZATION_NODE_TYPE && !isNodeDisabled(node) && readPromptTemplateId(node) !== null);
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class PromptResolutionService {
  private readonly logger = new Logger(PromptResolutionService.name);

  constructor(
    private readonly departmentRepository: DepartmentRepository,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly promptVersionRepository: PromptVersionRepository,
    // Tier-1a: the tenant's GOVERNING workflow definition, resolved through the
    // `department -> tenant -> platform default` assignment cascade. Both are
    // `@Optional()` for the same reason `LiveDocumentationService`'s copies are:
    // this service is constructed in background job processors and in a long
    // tail of unit tests with a positional argument list, and an unwired
    // resolver must degrade to "no tier-1a" — exactly the shape a department
    // with no configured agent had before TASK-815 — never to a throw on a
    // clinical generation path.
    @Optional() @Inject(IWorkflowAssignmentService) private readonly workflowAssignments?: IWorkflowAssignmentService,
    @Optional() @Inject(WorkflowDefinitionRepository) private readonly workflowDefinitionRepository?: WorkflowDefinitionRepository,
    // Tier-1b's VISIT-TYPE axis, which is tenant-configured data now
    // (TASK-815 §11 row 3) rather than the `promptType === 'revisit'` literal
    // this replaces. `@Optional()` for the same reason as the two above; an
    // unwired resolver serves the two shipped visit types, which maps the two
    // legacy `promptType` values onto exactly the columns they always read.
    @Optional() @Inject(VisitTypeService) private readonly visitTypes?: VisitTypeService,
  ) {}

  /**
   * Resolve prompt configuration.
   *
   * The summary template and context variables are department-derived for BOTH
   * capabilities; the prompt ID comes from the capability chain selected by
   * `params.promptType` (see the file header).
   *
   * If an explicit template is provided (e.g., from a manual API call),
   * it takes precedence over the department lookup for template.
   *
   * The resolution trace is always populated for audit/debugging purposes.
   *
   * @throws ServiceUnavailableException — pre-summary only, when no approved
   *   pre-summary prompt can be resolved. Fail-closed by design: substituting a
   *   clinical NOTE prompt here is a silent wrong-prompt failure.
   */
  async resolve(params: PromptResolutionParams): Promise<ResolvedPromptConfig> {
    const trace: PromptResolutionTrace = {
      usedDefaults: [],
    };

    const department = await this.resolveDepartment(params.departmentId);
    if (department) {
      trace.departmentTemplate = department.defaultSummaryTemplate ?? null;
    }

    // --- template (identical for both capability chains) ---
    let template = params.explicitTemplate ?? null;
    if (!template && department?.defaultSummaryTemplate) {
      template = department.defaultSummaryTemplate;
    }
    if (!template) {
      template = SYSTEM_DEFAULTS.template;
      trace.usedDefaults.push('template');
    }

    // --- the TASK axis, named once ---
    // `resolvedCapability`'s own three values. It was already derived from
    // `promptType` at the bottom of this method; deriving it HERE instead makes
    // it available as the first half of the `(task, visitType)` key.
    const task: VisitTypePromptTask = params.promptType === 'pre-summary' ? 'pre-summary' : params.promptType === 'live' ? 'live' : 'summary';

    // --- the VISIT-TYPE axis, resolved through the tenant's catalogue ---
    const visitTypeBinding = this.resolveVisitTypeBinding(params, department, trace, task);

    // --- promptId (capability chain) ---
    const resolvedPrompt =
      params.promptType === 'pre-summary'
        ? await this.resolvePreSummaryPromptId(params, department, trace, visitTypeBinding)
        : params.promptType === 'live'
          ? await this.resolveLivePromptId(params, department, trace, visitTypeBinding)
          : await this.resolveSummaryPromptId(params, department, trace, visitTypeBinding);

    // --- contextVariables ---
    // The department's, then the winning `(task, visitType)` binding's on top.
    // Only the tier that actually SERVED contributes (see `ResolvedPromptId`),
    // so context and instructions can never come from different compositions.
    const departmentContextVariables = this.extractContextVariables(department);
    const contextVariables = resolvedPrompt.contextVariables
      ? { ...departmentContextVariables, ...resolvedPrompt.contextVariables }
      : departmentContextVariables;
    if (!department?.promptConfig) {
      trace.usedDefaults.push('contextVariables');
    }

    const { promptId, tier: resolvedFrom, content: resolvedContent, versionNumber: resolvedVersionNumber, agentId: resolvedAgentId } = resolvedPrompt;

    this.logger.debug({
      message: 'Prompt config resolved',
      resolvedFrom,
      template,
      promptId,
      departmentId: params.departmentId,
      promptType: params.promptType,
      trace,
    });

    const result: ResolvedPromptConfig = {
      template,
      promptId,
      contextVariables,
      resolvedFrom,
      resolutionTrace: trace,
      resolvedCapability: task as 'summary' | 'pre-summary' | 'live',
    };

    // Attach the immutable/governed snapshot whenever one resolved (agent OR any
    // non-agent tier). The assembler consumes `resolved.content` for the prompt
    // body. When no snapshot could be resolved (genuinely legacy data with no
    // version rows and no content column), `content` is left absent so the
    // assembler's transcript fallback applies.
    if (resolvedContent !== undefined && resolvedContent !== null) {
      result.content = resolvedContent;
      result.resolvedVersionNumber = resolvedVersionNumber ?? null;
    }
    if (resolvedAgentId) {
      result.resolvedAgentId = resolvedAgentId;
    }

    return result;
  }

  // =========================================================================
  // Capability chains
  // =========================================================================

  /**
   * SUMMARY (clinical note) chain — preferred → agent → department column →
   * SYSTEM default. Unchanged from before the capability split; the only
   * difference is that the tier is now RETURNED rather than inferred from
   * `usedDefaults.length`.
   */
  private async resolveSummaryPromptId(
    params: PromptResolutionParams,
    department: DepartmentEntity | null,
    trace: PromptResolutionTrace,
    visitTypeBinding: ResolvedVisitTypeBinding | null,
  ): Promise<ResolvedPromptId> {
    // Tier-0: the doctor's preferred prompt template, when it exists,
    // wins over the department/default tiers.
    const preferredPromptId = await this.resolvePreferredPromptId(params.preferredPromptTemplateId);
    trace.preferredPromptId = preferredPromptId;

    // The department's visit-type column for this prompt type, recorded in the
    // trace whether or not it ends up being served.
    let departmentPromptId: string | null = null;
    if (department) {
      // The visit-type axis, resolved through the tenant's own catalogue
      // (`consultation.visitTypes`, tenant → SYSTEM) instead of a literal
      // comparison. A tenant that has defined no catalogue inherits the two
      // shipped types, whose keys ARE the two legacy values — so this is
      // byte-identical to the ternary it replaces until a tenant says otherwise.
      const promptSlot = (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).promptSlot(
        department.tenantId ?? params.tenantId ?? null,
        params.promptType,
      );
      departmentPromptId = (promptSlot === 'revisit' ? department.revisitPromptId : department.newPatientPromptId) ?? null;
      trace.departmentPromptId = departmentPromptId;
    }

    // TIER-0b — the tenant's `(task, visitType)` binding.
    //
    // ABOVE the node tier, and that placement is the whole point: the node
    // substrate has NO visit-type axis by design (DD-2 — a generation node binds
    // its prompt statically), so it cannot answer a question that names one. A
    // tier that cannot express the distinction must not pre-empt the tier that
    // can. BELOW tier-0 for the mirror-image reason: an individual clinician's
    // explicit template choice is a stronger signal than a tenant-wide default
    // (DR-2), and a tenant setting must not silently overrule it.
    const bound = await this.serveVisitTypeBinding(visitTypeBinding, trace, preferredPromptId !== null);
    if (bound) return bound;

    // Tier-1a: the tenant's GOVERNING WORKFLOW NODE for finalize generation,
    // inserted BEFORE the legacy department prompt-id columns and only when no
    // doctor-preferred template took tier-0. It serves the IMMUTABLE
    // PromptVersion snapshot content at the node's own pin (`promptVersionNumber`)
    // ?? the template's `approvedVersionNumber` ?? latest, never the mutable
    // template row — this is what makes version pinning meaningful. If the
    // node's template is not APPROVED (or has no snapshot) at the resolved
    // version, it falls through to the legacy chain. No governing definition,
    // or none carrying a finalize node, ⇒ the whole branch is skipped and
    // resolution is byte-identical to a department with no agent before TASK-815.
    //
    // VISIT-TYPE AXIS: the node substrate deliberately has none (DD-2, "no
    // runtime shape switching" — a generation node binds its prompt and its
    // document shape STATICALLY). The visit-type distinction therefore lives
    // exactly where it always also lived, one tier down: the department's
    // `newPatientPromptId` / `revisitPromptId` columns, which are unchanged.
    if (!preferredPromptId && department && params.departmentId) {
      const nodeResolution = await this.resolveNodePrompt(
        department.tenantId,
        params.departmentId,
        'text.finalize',
        // Finalize pins the SESSION's node here (R-N2).
        params.pinnedAgentId,
      );
      if (nodeResolution) {
        trace.agentId = nodeResolution.nodeId;
        trace.agentVersionNumber = nodeResolution.versionNumber;
        return {
          promptId: nodeResolution.templateId,
          tier: 'agent',
          content: nodeResolution.content,
          versionNumber: nodeResolution.versionNumber,
          agentId: nodeResolution.nodeId,
        };
      }
    }

    // Tier-0 override: the preferred template id supersedes department/default.
    if (preferredPromptId) {
      return { promptId: preferredPromptId, tier: 'preferred', ...(await this.governedSnapshot(preferredPromptId)) };
    }

    // Tier-1b — the legacy department prompt-id column. Prompt governance: a
    // department template is only resolvable for clinical generation flows once
    // it is APPROVED. A not-yet-approved (DRAFT/PUBLISHED) department template
    // is SKIPPED so resolution falls through to the APPROVED system default
    // (fallback chain otherwise unchanged). The system default (CATCHALL_SOAP)
    // is seeded APPROVED.
    if (departmentPromptId && (await this.isApprovedTemplate(departmentPromptId))) {
      return { promptId: departmentPromptId, tier: 'department', ...(await this.governedSnapshot(departmentPromptId)) };
    }

    // Tier-2 — SYSTEM default. This is reported as `'default'` EVEN WHEN the
    // department supplied the summary template: the tier names which template
    // is actually being served, so a consumer that special-cases "no
    // department-specific prompt" (the compat shim) can act on it.
    trace.usedDefaults.push('promptId');
    return { promptId: SYSTEM_DEFAULTS.promptId, tier: 'default', ...(await this.governedSnapshot(SYSTEM_DEFAULTS.promptId)) };
  }

  /**
   * PRE-SUMMARY chain — tenant TENANT_DEFAULT pre-summary → SYSTEM pre-summary
   * default → FAIL CLOSED.
   *
   * Deliberately consults NEITHER the preferred tier, NOR the department
   * default agent, NOR the department visit-type columns: all three select a
   * clinical NOTE prompt, and pre-summary has no department or visit-type axis
   * at all (department and visit type are variables INSIDE the one tenant
   * pre-summary prompt). The department is still read by `resolve()` for the
   * summary template and context variables.
   *
   * @throws ServiceUnavailableException when no approved pre-summary prompt
   *   exists. Falling through to `SYSTEM_DEFAULTS.promptId` (CATCHALL_SOAP)
   *   would silently serve a note prompt for a pre-summary request — the exact
   *   defect this chain exists to prevent — so absence is an outage, not a
   *   substitution.
   */
  private async resolvePreSummaryPromptId(
    params: PromptResolutionParams,
    department: DepartmentEntity | null,
    trace: PromptResolutionTrace,
    visitTypeBinding: ResolvedVisitTypeBinding | null,
  ): Promise<ResolvedPromptId> {
    // Explicitly recorded as "not consulted" rather than left absent, so a
    // trace never reads as though a department/preferred tier was considered.
    trace.preferredPromptId = null;
    if (department) {
      trace.departmentPromptId = null;
    }

    // Pre-summary has no department axis, so the tenant must be supplied
    // directly; the department is only a fallback source for it.
    const tenantId = params.tenantId ?? department?.tenantId ?? null;
    const variant = params.preSummaryVariant ?? 'v1';

    // TIER-1a' — RESTORED (TASK-806 lane A item 1) onto the node the owner ruled
    // a tenant must configure.
    //
    // The tier used to read the department default `DepartmentAgent`'s
    // `preSummaryTemplateId`; TASK-815 retired it with nothing in its place,
    // because `agent.presummarization` (DD-6) did not exist. It does now, and the
    // owner's ruling on the delta was that the loss is NOT accepted as a silent
    // fallback: pre-summary must be TENANT TIER, and a tenant must configure an
    // ACTIVE pre-summarization node.
    //
    // `null` department, deliberately: pre-summary has no department axis (see
    // this method's docstring), so the assignment cascade resolves
    // tenant -> platform default and the DEPARTMENT tier is never consulted.
    // Selection is by node TYPE, never by `taskKey` — keying it off `taskKey`
    // would make a clinical NOTE node selectable for a pre-summary request, which
    // is the exact wrong-prompt failure this capability split exists to kill.
    trace.agentId = null;

    // The tenant's `(task, visitType)` binding, FIRST. This is the chain the
    // owner named first ("pre-summarization"), and until now it had no
    // visit-type axis whatsoever — the visit type reached it only as the
    // `{visit_type}` VARIABLE inside one tenant-wide body. A miss falls straight
    // through, so the node tier's fail-closed rule below is untouched: a tenant
    // that governs consultations but configured this pairing incompletely still
    // gets the 503, never a substituted body.
    const bound = await this.serveVisitTypeBinding(visitTypeBinding, trace, false);
    if (bound) return bound;

    if (tenantId) {
      const node = await this.resolveGraphNodePrompt(tenantId, null, activePresummarizationNodes, undefined, {
        nodeType: PRESUMMARIZATION_NODE_TYPE,
      });
      if (node) {
        trace.agentId = node.nodeId;
        trace.agentVersionNumber = node.versionNumber;
        return {
          promptId: node.templateId,
          tier: 'tenant',
          content: node.content,
          versionNumber: node.versionNumber,
          agentId: node.nodeId,
        };
      }

      // NOT SILENT — and, for a tenant that actually governs consultations, NOT SURVIVABLE
      // either (Lane R, R2; owner ruling TASK-815 §11).
      //
      // The ruling is that absence is "a configuration error to surface, not a silent drop to a
      // platform default". Enforcing that for EVERY tenant is still unsafe, and seeding the node
      // did not make it safe: `WorkflowDefinition` is deliberately excluded from
      // `SYSTEM_SHARED_READ_MODELS` and the assignment cascade is department -> tenant -> null,
      // so a tenant reads only its OWN definitions. There is no platform-default consultation
      // graph every tenant inherits, which means a blanket fail-closed would take out pre-summary
      // for every tenant that has not authored a consultation workflow — the frozen v1-compat
      // route's whole population included.
      //
      // The line the ruling actually draws is between an absent opinion and an INCOMPLETE one:
      //
      //  * no governing consultation graph  -> the tenant has not adopted the substrate. It
      //    expressed nothing, so the platform default applies. That is tenant -> SYSTEM working
      //    as designed, and it stays loud-but-not-lethal.
      //  * a governing graph WITHOUT an active, prompt-bound pre-summarization node -> the tenant
      //    IS configuring, and configured this incompletely. Serving the platform default there
      //    is precisely the silent drop §11 refuses, so it fails closed with the misconfiguration
      //    named.
      const configurationError =
        `no ACTIVE ${PRESUMMARIZATION_NODE_TYPE} node with a bound prompt template is configured in this tenant's ` +
        'governing consultation workflow';
      const governed = await this.hasGoverningConsultationGraph(tenantId);
      trace.configurationErrors = [
        ...(trace.configurationErrors ?? []),
        governed ? configurationError : `${configurationError} — pre-summary is falling through to the tenant/SYSTEM default`,
      ];
      this.logger.error({ message: configurationError, tenantId, preSummaryVariant: variant, governed });

      if (governed) {
        throw new ServiceUnavailableException(
          `${configurationError}. Add an enabled ${PRESUMMARIZATION_NODE_TYPE} node with a prompt template to the published ` +
            'consultation workflow, or unassign the workflow to use the platform default.',
        );
      }
    }

    if (tenantId) {
      const tenantTemplateId = await this.findTenantPreSummaryTemplateId(tenantId, variant);
      trace.tenantPromptId = tenantTemplateId;
      if (tenantTemplateId) {
        return { promptId: tenantTemplateId, tier: 'tenant', ...(await this.governedSnapshot(tenantTemplateId)) };
      }
    } else {
      trace.tenantPromptId = null;
    }

    // Tier-2 — the SYSTEM default FOR THE REQUESTED SURFACE. The v1 branch
    // (…040) is reachable cross-tenant since the fold-in re-owned
    // it to the SYSTEM tenant and PromptTemplate/PromptVersion joined
    // SYSTEM_SHARED_READ_MODELS; before that, any tenant without its own row
    // fell straight through to the 503 below.
    const systemDefaultId = variant === 'dept-free' ? SYSTEM_DEFAULTS.deptFreePreSummaryPromptId : SYSTEM_DEFAULTS.preSummaryPromptId;

    if (await this.isApprovedTemplate(systemDefaultId)) {
      trace.usedDefaults.push('promptId');
      return {
        promptId: systemDefaultId,
        tier: 'default',
        ...(await this.governedSnapshot(systemDefaultId)),
      };
    }

    this.logger.error({
      message: 'No approved pre-summary prompt could be resolved — failing closed',
      tenantId,
      departmentId: params.departmentId,
      preSummaryVariant: variant,
      systemPreSummaryPromptId: systemDefaultId,
    });
    throw new ServiceUnavailableException('No approved pre-summary prompt is configured. Pre-summary generation is unavailable.');
  }

  /**
   * LIVE chain — agent `livePromptTemplateId` → the seeded
   * SYSTEM live default → the in-code constants.
   *
   * THIS METHOD NEVER THROWS, and that is the point. It is the DOCUMENTED
   * EXCEPTION to the fail-closed doctrine (binding): a
   * live consultation must never be failed by a prompt-resolution error —
   * patient-safety of the running clinical view outranks selection strictness.
   * The exception is safe ONLY because tier 3's bytes are proven byte-identical
   * to tier 2's seeded content (the paired sha256 guards in
   * `live-soap-prompt-checksum.test.ts` /
   * `system-live-soap-default-checksum.test.ts`), so "fail-open" degrades to
   * IDENTICAL behavior rather than to different behavior. Finalize and
   * pre-summary keep their fail-closed posture, unchanged.
   *
   * Tier 3 returns NO `content`: the absence is the signal to the live loop
   * that its in-code constants apply. `promptId` still names the SYSTEM pointer
   * so a trace records what was aimed at.
   *
   * There is deliberately NO tenant tag-scan tier: that would re-create B-01's
   * multi-candidate convention. A tenant-wide live prompt is expressed by
   * binding `livePromptTemplateId` on its department default agents, and a
   * tenant tier can be added later additively if it is ever wanted.
   */
  private async resolveLivePromptId(
    params: PromptResolutionParams,
    department: DepartmentEntity | null,
    trace: PromptResolutionTrace,
    visitTypeBinding: ResolvedVisitTypeBinding | null,
  ): Promise<ResolvedPromptId> {
    // Neither the doctor-preferred tier nor the legacy department columns are
    // consulted: live is a department/tenant-GOVERNED surface, and a per-doctor
    // live prompt is not a v1 concept (it would also add a read to the
    // session-start path for no requirement). Recorded as "not consulted".
    trace.preferredPromptId = null;
    if (department) trace.departmentPromptId = null;

    const tenantId = params.tenantId ?? department?.tenantId ?? null;

    // The tenant's `(task, visitType)` binding, above the node tier for the same
    // reason as on the summary chain. FAIL-OPEN IS PRESERVED: a miss, an
    // unapproved template or a missing snapshot all fall through to the node /
    // SYSTEM / in-code tiers below, so this can only ever ADD a governed prompt,
    // never take a live session down.
    const bound = await this.serveVisitTypeBinding(visitTypeBinding, trace, false);
    if (bound) return bound;

    // Tier 1a — the governing workflow's LIVE generation node (effective
    // `taskKey: 'text.live'`). Skipped entirely when the consultation carries no
    // department, or when the graph declares no live generation node. There is
    // deliberately NO fallback onto a finalize node's prompt: that is a clinical
    // NOTE prompt, and serving it as the live running-note prompt is the same
    // wrong-prompt class the pre-summary split exists to kill.
    if (tenantId && params.departmentId) {
      const nodeResolution = await this.resolveNodePrompt(tenantId, params.departmentId, 'text.live');
      if (nodeResolution) {
        trace.agentId = nodeResolution.nodeId;
        trace.agentVersionNumber = nodeResolution.versionNumber;
        return {
          promptId: nodeResolution.templateId,
          tier: 'agent',
          content: nodeResolution.content,
          versionNumber: nodeResolution.versionNumber,
          agentId: nodeResolution.nodeId,
        };
      }
    }

    // Tier 2 — the seeded SYSTEM live default (readable cross-tenant since the
    // B-12 fold-in put PromptTemplate/PromptVersion in SYSTEM_SHARED_READ_MODELS).
    if (await this.isApprovedTemplate(SYSTEM_DEFAULTS.livePromptId)) {
      const governed = await this.governedSnapshot(SYSTEM_DEFAULTS.livePromptId);
      if (governed.content !== undefined) {
        trace.usedDefaults.push('promptId');
        return { promptId: SYSTEM_DEFAULTS.livePromptId, tier: 'default', ...governed };
      }
    }

    // Tier 3 — fail open to the in-code constants.
    this.logger.warn({
      message: 'No governed live prompt resolved — falling open to the in-code constants (byte-identical to the SYSTEM default)',
      tenantId,
      departmentId: params.departmentId,
      systemLivePromptId: SYSTEM_DEFAULTS.livePromptId,
    });
    trace.usedDefaults.push('promptId');
    return { promptId: SYSTEM_DEFAULTS.livePromptId, tier: 'code-default' };
  }

  /**
   * The tenant's pre-summary prompt id, or null when the tenant has none.
   *
   * TRADEOFF — there is no first-class `tenantPreSummaryTemplateId` pointer
   * field on any model today, so the tenant's pre-summary prompt is identified
   * BY CONVENTION: an APPROVED, tenant-scoped (`scope = TENANT_DEFAULT`),
   * department-unbound (`departmentId = null`) template tagged
   * `pre-summary` — exactly what
   * `seed/07b-arcaai-clinical-templates.ts` seeds (PRE_SUMMARY_SPEC,
   * `ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY`). A convention is
   * weaker than a pointer (a tenant admin can create a second matching row),
   * which is why this is the ONLY place that knows it: a later phase can
   * replace the body with a settings-descriptor read
   * (`09-infrastructure-devops.md` §Configuration Tiers, `db-config` tier)
   * without touching the chain or any caller.
   *
   * DETERMINISM — the query is ordered `createdAt asc, id asc` (ids are
   * UUIDv7, so the pair is a total order) and the FIRST row wins, so a tenant
   * with several candidates always resolves the same template instead of
   * letting Postgres tie-break; extra candidates are logged as a warning so
   * the ambiguity is visible rather than silent.
   *
   * SURFACE MATCH (refined by OD-7(b)) — the two
   * surfaces are asymmetric queries over the SAME `pre-summary` tag:
   *   - `'dept-free'` is a POSITIVE opt-in match: `hasEvery(['pre-summary',
   *     'dept-free'])`. A row must explicitly carry the `dept-free` tag; it
   *     is never inferred.
   *   - `'v1'` is a NEGATIVE match: `has('pre-summary')` MINUS any row also
   *     tagged `dept-free`. OD-7(a) (the originally approved spec) required
   *     BOTH `pre-summary` AND `text-v1`, which silently stopped resolving any
   *     hand-created tenant row tagged only `pre-summary` (falling through to
   *     the SYSTEM default). The negative match keeps that legacy/untagged
   *     row resolving while still excluding the dept-free fork cleanly.
   *
   * A lookup ERROR is NOT swallowed into the SYSTEM default: per the
   * fail-mode doctrine a backend error must propagate rather than be disguised
   * as "the default" (`resolvePreSummaryPromptId` turns it into a 503).
   */
  private async findTenantPreSummaryTemplateId(tenantId: string, variant: 'v1' | 'dept-free' = 'v1'): Promise<string | null> {
    const surfaceTag = PRE_SUMMARY_SURFACE_TAG[variant];
    // OD-7(b): 'dept-free' stays a positive hasEvery match; 'v1' becomes a
    // has-minus-NOT match so untagged legacy tenant rows keep resolving.
    const surfaceTagFilter =
      variant === 'dept-free'
        ? { tags: { hasEvery: [PRE_SUMMARY_TEMPLATE_TAG, surfaceTag] } }
        : { tags: { has: PRE_SUMMARY_TEMPLATE_TAG }, NOT: { tags: { has: PRE_SUMMARY_SURFACE_TAG['dept-free'] } } };
    const candidates = await this.promptTemplateRepository.findAll({
      // `tags: { has }` is a Prisma list operator; `DbFilters` models scalar
      // operators only, but `formatFindAllProps` passes `filters` through to
      // `findMany` verbatim, so this is the shape the query actually needs.
      filters: {
        tenantId,
        scope: PromptTemplateScope.TENANT_DEFAULT,
        status: PromptTemplateStatus.APPROVED,
        departmentId: null,
        resourceStatus: ResourceStatusType.ENABLED,
        ...surfaceTagFilter,
      } as unknown as IFindAllProps<PromptTemplate>['filters'],
      sort: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      this.logger.warn({
        message: 'Tenant has more than one candidate pre-summary template for this surface — resolving the first deterministically',
        tenantId,
        surfaceTag,
        candidateIds: candidates.map((candidate) => candidate.id),
      });
    }

    return candidates[0].id ?? null;
  }

  /**
   * `resolveGovernedContent` shaped for spreading into a `ResolvedPromptId`.
   * Keeps the "no snapshot ⇒ omit content" contract in one place.
   */
  private async governedSnapshot(promptId: string): Promise<{ content?: string; versionNumber?: number | null }> {
    const governed = await this.resolveGovernedContent(promptId);
    return governed ? { content: governed.content, versionNumber: governed.versionNumber } : {};
  }

  /**
   * Governed CONTENT for a NON-agent tier's resolved template. Serves the
   * PromptVersion snapshot pinned at approval (`approvedVersionNumber`) so a
   * post-approval content edit is never served until the next (eval-gated)
   * re-approval — the same integrity guarantee the agent tier gets (F-02).
   *
   * Fallback order:
   *  1. `PromptVersion` at `template.approvedVersionNumber` when set and present;
   *  2. the mutable `template.content` column ONLY for genuinely legacy templates
   *     that never carried an approval pin (or whose pinned snapshot is missing).
   *     For an APPROVED legacy template the content column IS the approved
   *     content — approval never mutated it — so this stays safe (it never serves
   *     an unapproved *latest* edit).
   *
   * Missing template / lookup error → null (the caller keeps whatever it had,
   * so behaviour degrades to the pre-change transcript/template fallback rather
   * than throwing on the generation hot path).
   */
  private async resolveGovernedContent(promptId: string): Promise<{ content: string; versionNumber: number | null } | null> {
    try {
      const template = await this.promptTemplateRepository.findById(promptId);
      if (!template) return null;

      const approved = template.approvedVersionNumber;
      if (approved !== null && approved !== undefined) {
        const version = await this.promptVersionRepository.findByVersionNumber(promptId, approved);
        if (version?.content !== null && version?.content !== undefined) {
          return { content: version.content, versionNumber: version.versionNumber };
        }
      }

      // Legacy fallback: no approval pin (or its snapshot vanished). The plain
      // content column is the operative content for pre-scheme templates.
      if (template.content !== null && template.content !== undefined) {
        return { content: template.content, versionNumber: template.currentVersionNumber ?? null };
      }
      return null;
    } catch (error) {
      this.logger.warn({
        message: 'Failed to resolve governed prompt content — falling back to template row / transcript',
        promptId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Tier-1a resolution, sourced from WORKFLOW NODE CONFIG (TASK-815).
   *
   * The tenant's governing `consultation` definition is resolved through the
   * SAME `department -> tenant -> platform default` assignment cascade the
   * realtime executor uses, so the DEPARTMENT AXIS the department-default agent
   * gave this tier is preserved exactly. Within that definition's graph, the
   * node serving `taskKey` supplies `promptTemplateId` and its own pin
   * (`promptVersionNumber`, DD-11) — and the approval + snapshot discipline
   * below is byte-identical to the discipline the agent tier applied.
   *
   * Returns null (fall through to the legacy chain) when: the resolvers are not
   * wired, no tier assigned a definition, the definition has no graph, no node
   * serves the requested task, the bound template is not APPROVED, or the
   * resolved version has no snapshot. Reads `PromptVersion.content`, never the
   * mutable template row.
   *
   * The `approvedVersionNumber` step is the eval-gate integrity property: an
   * UNPINNED node serves the version snapshot pinned at the last approval, NOT
   * whatever content the template was last edited to. So a plain content edit on
   * an APPROVED template accumulates un-served versions until the next
   * (eval-gated) re-approval. The bare `latest` tail only fires for genuinely
   * legacy templates that carry no approval pin.
   *
   * TOTAL BY CONSTRUCTION. Every failure — a rejected assignment read, a missing
   * definition, a malformed graph — is caught and reported as "no tier-1a".
   * `resolve()` is on the live and finalize generation paths; it must degrade,
   * never throw.
   */
  private async resolveNodePrompt(
    tenantId: string,
    departmentId: string,
    taskKey: NodeTaskKey,
    pinnedNodeId?: string,
  ): Promise<{ templateId: string; content: string; versionNumber: number; nodeId: string } | null> {
    return this.resolveGraphNodePrompt(tenantId, departmentId, (graph) => promptBearingNodesForTask(graph, taskKey), pinnedNodeId, { taskKey });
  }

  /**
   * The shared body of every NODE tier: assignment cascade -> published definition -> a caller
   * supplied node SELECTION -> that node's DD-11 prompt binding, under the approval + snapshot
   * discipline described on `resolveNodePrompt`.
   *
   * Extracted (TASK-806 lane A) so the PRE-SUMMARY tier can select by node TYPE while the
   * summary/live tiers keep selecting by `taskKey`, without a second copy of the template
   * approval, pin resolution and degrade-never-throw logic — which is the half that actually
   * carries the safety properties.
   */
  /**
   * Does this tenant have a PUBLISHED consultation graph governing it?
   *
   * The one question that separates "expressed no opinion" from "expressed an incomplete one",
   * and therefore the one that decides whether a missing pre-summarization node is fatal. Read
   * only on the MISS path, so the happy path costs nothing extra.
   *
   * TOTAL, like every other read in this service: a rejected assignment read or a rotted slug
   * answers `false`, because an operational failure must never be reported to a tenant admin as
   * "your graph is misconfigured".
   */
  private async hasGoverningConsultationGraph(tenantId: string): Promise<boolean> {
    if (!this.workflowAssignments || !this.workflowDefinitionRepository) return false;
    try {
      const assignment = await this.workflowAssignments.resolve(tenantId, CONSULTATION_PALETTE_KEY, null as unknown as string);
      if (!assignment.workflowDefinitionSlug) return false;
      return (await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, assignment.workflowDefinitionSlug)) !== null;
    } catch {
      return false;
    }
  }

  private async resolveGraphNodePrompt(
    tenantId: string,
    departmentId: string | null,
    selectNodes: (graph: WorkflowGraph | null | undefined) => WorkflowGraphNode[],
    pinnedNodeId?: string,
    logContext: Record<string, unknown> = {},
  ): Promise<{ templateId: string; content: string; versionNumber: number; nodeId: string } | null> {
    if (!this.workflowAssignments || !this.workflowDefinitionRepository) return null;

    try {
      const assignment = await this.workflowAssignments.resolve(tenantId, CONSULTATION_PALETTE_KEY, departmentId as string);
      if (!assignment.workflowDefinitionSlug) return null;

      const definition = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, assignment.workflowDefinitionSlug);
      const candidates = selectNodes(definition?.graph as unknown as WorkflowGraph | null | undefined);
      if (candidates.length === 0) return null;

      // WHICH node, before WHICH template. A pinned session node replaces the
      // first-node selection entirely, but only when it is still present in the
      // governing graph and still serves this task; otherwise the graph's own
      // first node answers, exactly as an unpinned resolve would. A finalize
      // must never fail because the graph was re-authored mid-visit.
      const node = (pinnedNodeId ? candidates.find((candidate) => candidate.id === pinnedNodeId) : undefined) ?? candidates[0];
      const selectedTemplateId = readPromptTemplateId(node);
      if (!selectedTemplateId) return null;

      const template = await this.promptTemplateRepository.findById(selectedTemplateId);
      // Node template unapproved => legacy fallback.
      if (!template || template.status !== 'APPROVED') return null;

      const targetVersionNumber = readPromptVersionPin(node) ?? template.approvedVersionNumber ?? null;
      const version =
        targetVersionNumber !== null && targetVersionNumber !== undefined
          ? await this.promptVersionRepository.findByVersionNumber(template.id, targetVersionNumber)
          : await this.promptVersionRepository.findLatestVersion(template.id);

      if (!version || version.content === null || version.content === undefined) return null;

      return { templateId: template.id, content: version.content, versionNumber: version.versionNumber, nodeId: node.id };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to resolve the governing workflow node — skipping the node tier',
        tenantId,
        departmentId,
        ...logContext,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // =========================================================================
  // Private Resolution Methods
  // =========================================================================

  /**
   * Tier-0: verify the doctor's preferred prompt template exists AND is APPROVED.
   * an unapproved (DRAFT/PUBLISHED) preferred template is
   * skipped (returns null) so resolution falls through to the department/default
   * tiers. Returns the template id only when it resolves to an APPROVED template.
   */
  private async resolvePreferredPromptId(preferredPromptTemplateId?: string | null): Promise<string | null> {
    if (!preferredPromptTemplateId) return null;

    try {
      const template = await this.promptTemplateRepository.findById(preferredPromptTemplateId);
      if (template && template.status === 'APPROVED') return template.id;
      return null;
    } catch (error) {
      this.logger.warn({
        message: 'Failed to resolve preferred prompt template — skipping preferred tier',
        preferredPromptTemplateId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * a template id is resolvable for a clinical flow only
   * when it maps to an APPROVED template. Missing / unapproved / lookup-error →
   * false (the caller then falls through to the APPROVED system default).
   */
  private async isApprovedTemplate(promptTemplateId: string): Promise<boolean> {
    try {
      const template = await this.promptTemplateRepository.findById(promptTemplateId);
      return template?.status === 'APPROVED';
    } catch (error) {
      this.logger.warn({
        message: 'Failed to verify prompt-template approval — treating as unapproved',
        promptTemplateId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Look up the department entity with prompt config fields.
   * Returns null if not found or on error.
   */
  private async resolveDepartment(departmentId?: string): Promise<DepartmentEntity | null> {
    if (!departmentId) return null;

    try {
      return await this.departmentRepository.findById(departmentId);
    } catch (error) {
      this.logger.warn({
        message: 'Failed to resolve department — skipping department tier',
        departmentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Extract context variables from department's promptConfig.
   * Returns an empty object if no config exists.
   */
  /**
   * THE `(task, visitType)` KEY — resolved once per `resolve()`, before any
   * chain runs.
   *
   * OWNER DIRECTIVE (2026-08-29): "Visit type is an identifier where the hope
   * platform configure and compose the instructions and consultation context as
   * prompt for agent to work on: pre-summarization OR summarization OR any text
   * generation task."
   *
   * The visit type comes from `params.visitTypeKey` when the caller named the
   * axis, and otherwise from `params.promptType` — which is where every existing
   * caller still carries it. Either way it is MATCHED against the tenant's
   * `consultation.visitTypes` catalogue (tenant -> SYSTEM), so a tenant's own
   * key or any alias it declared resolves, and one tenant's vocabulary can never
   * select another's prompt.
   *
   * `matchVisitType`, deliberately, NOT `selectVisitType`: this is a RESOLVER,
   * not a consultation. It knows nothing about `parentConsultationId`, so it
   * must never guess a visit type from a parent link that was not passed to it.
   * No opinion in ⇒ no `(task, visitType)` binding consulted, and the chain runs
   * exactly as it did before this tier existed. That is what makes a bare phase
   * selector (`'pre-summary'`, `'live'`) — and any unrecognised string — a
   * no-op here rather than a silent selection.
   *
   * Synchronous: the catalogue read is an in-memory settings cascade, so this
   * costs no I/O on a clinical generation path.
   */
  private resolveVisitTypeBinding(
    params: PromptResolutionParams,
    department: DepartmentEntity | null,
    trace: PromptResolutionTrace,
    task: VisitTypePromptTask,
  ): ResolvedVisitTypeBinding | null {
    const visitTypes = this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE;
    const tenantId = params.tenantId ?? department?.tenantId ?? null;
    const spelling = params.visitTypeKey ?? params.promptType;

    const visitType = visitTypes.match(tenantId, spelling);
    trace.visitTypeKey = visitType?.key ?? null;
    trace.visitTypeTask = visitType ? task : null;
    trace.visitTypePromptId = null;
    if (!visitType) return null;

    const binding = visitTypes.promptBindingFor(visitType, task);
    return binding ? { visitType, task, binding } : null;
  }

  /**
   * Serve a `(task, visitType)` binding, or fall through.
   *
   * FALLS THROUGH, NEVER THROWS — the same posture as the node tier. An
   * unapproved template, a missing snapshot or a lookup error all return null,
   * so the chain below answers exactly as it would have with no binding at all.
   * Prompt governance is unchanged: only an APPROVED template is servable, and
   * the CONTENT comes from an immutable `PromptVersion` — the binding's own pin
   * when it declared one, otherwise the template's `approvedVersionNumber`
   * snapshot, never the mutable content row.
   *
   * `resolvedFrom` is `'tenant'`, an EXISTING member of the tier vocabulary,
   * and no new one is added. `ResolvedPromptConfig` is reached by a frozen
   * v1-compat wire route (TASK-815 §2), so its value set is a published
   * contract; `'tenant'` already means precisely "a tenant-configured template,
   * not the department column and not the SYSTEM default", which is what this
   * tier is. The pairing that produced it is recorded in `resolutionTrace`,
   * which is additive and internal.
   */
  private async serveVisitTypeBinding(
    resolved: ResolvedVisitTypeBinding | null,
    trace: PromptResolutionTrace,
    supersededByPreferred: boolean,
  ): Promise<ResolvedPromptId | null> {
    if (!resolved || supersededByPreferred) return null;

    const { binding } = resolved;
    try {
      const template = await this.promptTemplateRepository.findById(binding.promptTemplateId);
      if (!template || template.status !== 'APPROVED') return null;

      const targetVersionNumber = binding.promptVersionNumber ?? template.approvedVersionNumber ?? null;
      const version =
        targetVersionNumber !== null && targetVersionNumber !== undefined
          ? await this.promptVersionRepository.findByVersionNumber(template.id, targetVersionNumber)
          : await this.promptVersionRepository.findLatestVersion(template.id);
      if (!version || version.content === null || version.content === undefined) return null;

      trace.visitTypePromptId = template.id;
      return {
        promptId: template.id,
        tier: 'tenant',
        content: version.content,
        versionNumber: version.versionNumber,
        ...(binding.contextVariables ? { contextVariables: binding.contextVariables } : {}),
      };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to resolve the visit-type prompt binding — skipping the tier',
        visitType: resolved.visitType.key,
        task: resolved.task,
        promptTemplateId: binding.promptTemplateId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private extractContextVariables(department: DepartmentEntity | null): Record<string, unknown> {
    if (!department?.promptConfig) return {};

    const config = department.promptConfig as Record<string, unknown>;
    return (config.contextVariables as Record<string, unknown>) ?? {};
  }
}
