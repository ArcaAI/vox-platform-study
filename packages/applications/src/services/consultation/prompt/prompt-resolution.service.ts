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
 *     Tier-1a (agent)      — the department's default `DepartmentAgent`, serving
 *       `newPatientTemplateId` / `revisitTemplateId` ?? the base
 *       `promptTemplateId` (the VISIT-TYPE AXIS that closes
 *       F-01; an agent with null bindings resolves exactly as it did before).
 *     Tier-1b (department) — the department's visit-type prompt column.
 *       DEPRECATED fallback (RF-3), retained for departments with no agent.
 *     Tier-2  (default)    — `SYSTEM_DEFAULTS.promptId` (CATCHALL_SOAP).
 *
 *   promptType === 'pre-summary' — the PRE-SUMMARY chain:
 *     Tier-1a′(agent)      — the default agent's `preSummaryTemplateId`, and
 *       ONLY when the caller supplied a `departmentId` (RF-5: the compat shim
 *       never does, so it can never reach this tier). No base-binding fallback:
 *       a null binding skips the tier rather than substituting a note prompt.
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
 * Why the split: pre-summary has NO department axis and NO visit-type axis —
 * v1 carries exactly ONE pre-summary prompt per tenant, and department and
 * visit type are VARIABLES INSIDE it, never selectors for a different prompt.
 * The old single chain ran the promptType-AGNOSTIC agent tier first, so every
 * department with a default agent served a clinical NOTE prompt for
 * `promptType: 'pre-summary'`, and a department without one fell through to
 * CATCHALL_SOAP — also a note prompt. Both are silent clinical wrong-prompt
 * failures, so the pre-summary chain raises rather than substituting a
 * summary-shaped prompt.
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

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  DepartmentRepository,
  DepartmentEntity,
  PromptTemplateRepository,
  DepartmentAgentRepository,
  type DepartmentAgentEntity,
  PromptVersionRepository,
  PromptTemplateScope,
  PromptTemplateStatus,
  ResourceStatusType,
  type IFindAllProps,
  type PromptTemplate,
} from '@arcaai/domains';

// ============================================================================
// Types
// ============================================================================

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

  /** The default DepartmentAgent id when tier-1a resolved. */
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
  /** The department default agent id, when tier-1a resolved */
  agentId?: string | null;
  /** The resolved PromptVersion number for the agent tier */
  agentVersionNumber?: number | null;
  departmentTemplate?: string | null;
  departmentPromptId?: string | null;
  /**
   * The tenant-default template id, when the pre-summary tenant tier resolved.
   * Always null on the summary chain (that chain has no tenant tier).
   */
  tenantPromptId?: string | null;
  usedDefaults: string[];
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
  promptType?: 'pre-summary' | 'new-patient' | 'revisit' | 'live';

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
   * Finalize PINS the summary chain's agent tier to the
   * agent that actually ran the LIVE session, instead of re-resolving
   * `findDefaultForDepartment` at finalize time.
   *
   * Why: a department default re-pointed mid-visit (or a new default agent
   * created between `start()` and finalize) would otherwise silently change the
   * prompt that reviews the very note the live agent produced — exactly the
   * "same specific agent reviews and finalizes" contract R-N2 exists to close.
   *
   * FALLS THROUGH, NEVER THROWS. The pinned row must match the SAME tenant and
   * department and be ENABLED; a deleted / re-departmented / disabled agent (or
   * a failed lookup) degrades to the normal `findDefaultForDepartment` chain —
   * a finalize must never 500 because the session's agent was tidied up.
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
 *     tagged `dept-free` — so a legacy/untagged tenant row (no `smr-v1` tag)
 *     keeps resolving instead of silently falling through to the SYSTEM
 *     default, which is what the original `hasEvery(['pre-summary',
 *     'smr-v1'])` predicate did to hand-created tenant data. `smr-v1` remains
 *     as a label (seeded rows still carry it) but is no longer part of the
 *     'v1' query itself.
 */
const PRE_SUMMARY_SURFACE_TAG = {
  v1: 'smr-v1',
  'dept-free': 'dept-free',
} as const;

/** What a capability chain returns: the prompt id, its tier, and its snapshot. */
interface ResolvedPromptId {
  promptId: string;
  tier: PromptResolutionTier;
  content?: string | null;
  versionNumber?: number | null;
  agentId?: string;
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
    // Tier-1a: department default agent (movable-pointer resolution).
    private readonly departmentAgentRepository: DepartmentAgentRepository,
    private readonly promptVersionRepository: PromptVersionRepository,
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

    // --- promptId (capability chain) ---
    const resolvedPrompt =
      params.promptType === 'pre-summary'
        ? await this.resolvePreSummaryPromptId(params, department, trace)
        : params.promptType === 'live'
          ? await this.resolveLivePromptId(params, department, trace)
          : await this.resolveSummaryPromptId(params, department, trace);

    // --- contextVariables ---
    const contextVariables = this.extractContextVariables(department);
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
      resolvedCapability: params.promptType === 'pre-summary' ? 'pre-summary' : params.promptType === 'live' ? 'live' : 'summary',
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
  ): Promise<ResolvedPromptId> {
    // Tier-0: the doctor's preferred prompt template, when it exists,
    // wins over the department/default tiers.
    const preferredPromptId = await this.resolvePreferredPromptId(params.preferredPromptTemplateId);
    trace.preferredPromptId = preferredPromptId;

    // The department's visit-type column for this prompt type, recorded in the
    // trace whether or not it ends up being served.
    let departmentPromptId: string | null = null;
    if (department) {
      departmentPromptId = (params.promptType === 'revisit' ? department.revisitPromptId : department.newPatientPromptId) ?? null;
      trace.departmentPromptId = departmentPromptId;
    }

    // Tier-1a: the department's DEFAULT DepartmentAgent, inserted
    // BEFORE the legacy department prompt-id columns and only when no doctor-
    // preferred template took tier-0. It serves the IMMUTABLE PromptVersion
    // snapshot content at `pinnedVersionNumber ?? latest APPROVED`, never the
    // mutable template row — this is what makes version pinning meaningful. If
    // the agent's template is not APPROVED (or has no snapshot) at the resolved
    // version, it falls through to the legacy chain. No default agent ⇒ the
    // whole branch is skipped and resolution is byte-identical to before.
    if (!preferredPromptId && department && params.departmentId) {
      const agentResolution = await this.resolveDepartmentAgent(
        department.tenantId,
        params.departmentId,
        (agent) =>
          // The agent tier is now VISIT-TYPE AWARE. The
          // capability binding wins; the base `promptTemplateId` is the
          // within-tier fallback, which is what makes every previous row
          // (all six columns null) resolve byte-identically to before.
          (params.promptType === 'revisit' ? agent.revisitTemplateId : agent.newPatientTemplateId) ?? agent.promptTemplateId,
        // Finalize pins the SESSION's agent here.
        params.pinnedAgentId,
      );
      if (agentResolution) {
        trace.agentId = agentResolution.agentId;
        trace.agentVersionNumber = agentResolution.versionNumber;
        return {
          promptId: agentResolution.templateId,
          tier: 'agent',
          content: agentResolution.content,
          versionNumber: agentResolution.versionNumber,
          agentId: agentResolution.agentId,
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

    // Tier-1a′ (scope extension) — the department default
    // agent's `preSummaryTemplateId`.
    //
    // ELIGIBILITY IS SIGNATURE-DERIVED (RF-5), not flag-driven: this tier is
    // reachable only when the caller supplied a `departmentId`. The v1-compat
    // shim calls `resolve({ tenantId, promptType: 'pre-summary' })` with no
    // department, so it can never reach the agent tier — no compat/native flag
    // exists, and none is needed. A native caller that DOES pass a department
    // opts its department's agent in.
    //
    // Unlike the summary chain there is no visit-type axis here: pre-summary
    // has exactly one prompt per surface, with department and visit type as
    // VARIABLES inside it.
    if (tenantId && params.departmentId) {
      const agentResolution = await this.resolveDepartmentAgent(
        tenantId,
        params.departmentId,
        // No base-binding fallback: `promptTemplateId` is a clinical NOTE
        // prompt, and serving it for a pre-summary request is precisely the
        // defect this capability split exists to kill. A null binding must skip
        // the tier, not substitute the summary template.
        (agent) => agent.preSummaryTemplateId ?? null,
      );
      if (agentResolution) {
        trace.agentId = agentResolution.agentId;
        trace.agentVersionNumber = agentResolution.versionNumber;
        return {
          promptId: agentResolution.templateId,
          tier: 'agent',
          content: agentResolution.content,
          versionNumber: agentResolution.versionNumber,
          agentId: agentResolution.agentId,
        };
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
  ): Promise<ResolvedPromptId> {
    // Neither the doctor-preferred tier nor the legacy department columns are
    // consulted: live is a department/tenant-GOVERNED surface, and a per-doctor
    // live prompt is not a v1 concept (it would also add a read to the
    // session-start path for no requirement). Recorded as "not consulted".
    trace.preferredPromptId = null;
    if (department) trace.departmentPromptId = null;

    const tenantId = params.tenantId ?? department?.tenantId ?? null;

    // Tier 1a — the department default agent's live binding. Skipped entirely
    // when the consultation carries no department. NO base-`promptTemplateId`
    // fallback: that is a clinical NOTE prompt, and serving it as the live
    // running-note prompt is the same wrong-prompt class the pre-summary split
    // exists to kill.
    if (tenantId && params.departmentId) {
      const agentResolution = await this.resolveDepartmentAgent(tenantId, params.departmentId, (agent) => agent.livePromptTemplateId ?? null);
      if (agentResolution) {
        trace.agentId = agentResolution.agentId;
        trace.agentVersionNumber = agentResolution.versionNumber;
        return {
          promptId: agentResolution.templateId,
          tier: 'agent',
          content: agentResolution.content,
          versionNumber: agentResolution.versionNumber,
          agentId: agentResolution.agentId,
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
   *     BOTH `pre-summary` AND `smr-v1`, which silently stopped resolving any
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
   * Agent-tier resolution (capability-keyed since): the
   * department's default DepartmentAgent → the template chosen by
   * `selectTemplateId` → the immutable PromptVersion snapshot content at
   * `pinnedVersionNumber ?? template.approvedVersionNumber ?? latest`. Returns
   * null (fall through to the legacy chain) when there is no default agent, the
   * bound template is not APPROVED, or the resolved version has no snapshot.
   * Reads `PromptVersion.content`, never the mutable template row.
   *
   * The `approvedVersionNumber` step is the eval-gate integrity fix (F-02): an
   * UNPINNED default agent serves the version snapshot pinned at the last
   * approval, NOT whatever content the template was last edited to. So a plain
   * content edit on an APPROVED template accumulates un-served versions until the
   * next (eval-gated) re-approval. The bare `latest` tail only fires for
   * genuinely legacy templates that carry no approval pin.
   */
  private async resolveDepartmentAgent(
    tenantId: string,
    departmentId: string,
    selectTemplateId: (agent: DepartmentAgentEntity) => string | null | undefined,
    pinnedAgentId?: string,
  ): Promise<{ templateId: string; content: string; versionNumber: number; agentId: string } | null> {
    try {
      // WHICH agent, before WHICH binding. A pinned session
      // agent replaces the default lookup entirely, but only when it is still
      // the same tenant's, the same department's, and ENABLED; otherwise the
      // department default answers as it always did (no error, no 500).
      const agent =
        (pinnedAgentId ? await this.resolvePinnedAgent(pinnedAgentId, tenantId, departmentId) : null) ??
        (await this.departmentAgentRepository.findDefaultForDepartment(tenantId, departmentId));
      if (!agent) return null;

      // WHICH of the agent's bindings to serve is the CAPABILITY
      // chain's decision, passed in as a selector; this method owns only the
      // shared approval + snapshot discipline. Exactly ONE attempt: if the
      // selected template fails a check the whole tier returns null and
      // resolution falls to the next tier. There is deliberately no second,
      // within-agent retry against another binding — that would make resolution
      // order-dependent and add reads to the hot path.
      const selectedTemplateId = selectTemplateId(agent);
      if (!selectedTemplateId) return null;

      const template = await this.promptTemplateRepository.findById(selectedTemplateId);
      // Agent template unapproved ⇒ legacy fallback.
      if (!template || template.status !== 'APPROVED') return null;

      const targetVersionNumber = agent.pinnedVersionNumber ?? template.approvedVersionNumber ?? null;
      const version =
        targetVersionNumber !== null && targetVersionNumber !== undefined
          ? await this.promptVersionRepository.findByVersionNumber(template.id, targetVersionNumber)
          : await this.promptVersionRepository.findLatestVersion(template.id);

      if (!version || version.content === null || version.content === undefined) return null;

      return { templateId: template.id, content: version.content, versionNumber: version.versionNumber, agentId: agent.id };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to resolve department default agent — skipping agent tier',
        tenantId,
        departmentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Load the SESSION-pinned agent, or null.
   *
   * Total by construction: `Repository.findById` THROWS `DataNotFoundException`
   * on a missing row, and a re-departmented / cross-tenant / disabled agent is
   * treated exactly like a missing one. Every outcome that is not "the same
   * agent, still here, still eligible" returns null, which puts the caller back
   * on `findDefaultForDepartment` — the pre-C5 behaviour.
   *
   * The tenant/department check is defence-in-depth, not the tenancy boundary:
   * the extended Prisma client already scopes the read to the caller's tenant.
   */
  private async resolvePinnedAgent(pinnedAgentId: string, tenantId: string, departmentId: string): Promise<DepartmentAgentEntity | null> {
    try {
      const agent = await this.departmentAgentRepository.findById(pinnedAgentId);
      if (!agent) return null;
      if (agent.tenantId !== tenantId || agent.departmentId !== departmentId) return null;
      if (agent.resourceStatus !== ResourceStatusType.ENABLED) return null;
      return agent;
    } catch (error) {
      this.logger.warn({
        message: 'Session-pinned agent could not be loaded — falling back to the department default agent',
        pinnedAgentId,
        tenantId,
        departmentId,
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
  private extractContextVariables(department: DepartmentEntity | null): Record<string, unknown> {
    if (!department?.promptConfig) return {};

    const config = department.promptConfig as Record<string, unknown>;
    return (config.contextVariables as Record<string, unknown>) ?? {};
  }
}
