/**
 * PromptResolutionService
 *
 * Resolves prompt configuration (summary template, prompt ID, context
 * variables). The chain is SPLIT BY CAPABILITY, because pre-summary and
 * summary are not the same shape of prompt:
 *
 *   promptType ∈ { 'new-patient', 'revisit' } — the SUMMARY (clinical note)
 *   chain (highest priority first), unchanged:
 *     Tier-0  (preferred)  — the consulting doctor's preferred prompt template,
 *       from `UserProfile.preferredPromptTemplateId`.
 *     Tier-1a (agent)      — the department's default `DepartmentAgent`.
 *     Tier-1b (department) — the department's visit-type prompt column.
 *     Tier-2  (default)    — `SYSTEM_DEFAULTS.promptId` (CATCHALL_SOAP).
 *
 *   promptType === 'pre-summary' — the PRE-SUMMARY chain:
 *     Tier-1t (tenant)     — the tenant's TENANT_DEFAULT pre-summary template.
 *     Tier-2  (default)    — `SYSTEM_DEFAULTS.preSummaryPromptId`.
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
}

/**
 * Which tier produced the resolved `promptId`.
 *
 * `'tenant'` is the pre-summary-only tenant-default tier; the summary chain
 * never reports it, and the pre-summary chain never reports
 * `'preferred' | 'agent' | 'department'`.
 */
export type PromptResolutionTier = 'preferred' | 'agent' | 'department' | 'tenant' | 'default';

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
   * a column: `'pre-summary'` runs the tenant chain, everything else the
   * summary chain.
   */
  promptType?: 'pre-summary' | 'new-patient' | 'revisit';

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
} as const;

/**
 * The tag that marks a prompt template as the tenant's PRE-SUMMARY prompt.
 *
 * There is no first-class `tenantPreSummaryTemplateId` pointer field today, so
 * the tenant's pre-summary prompt is identified BY CONVENTION — see
 * `findTenantPreSummaryTemplateId` for the tradeoff and the migration path.
 */
const PRE_SUMMARY_TEMPLATE_TAG = 'pre-summary';

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
    // TASK-546 tier-1a: department default agent (movable-pointer resolution).
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

    // Tier-1a (TASK-546): the department's DEFAULT DepartmentAgent, inserted
    // BEFORE the legacy department prompt-id columns and only when no doctor-
    // preferred template took tier-0. It serves the IMMUTABLE PromptVersion
    // snapshot content at `pinnedVersionNumber ?? latest APPROVED`, never the
    // mutable template row — this is what makes version pinning meaningful. If
    // the agent's template is not APPROVED (or has no snapshot) at the resolved
    // version, it falls through to the legacy chain. No default agent ⇒ the
    // whole branch is skipped and resolution is byte-identical to before.
    if (!preferredPromptId && department && params.departmentId) {
      const agentResolution = await this.resolveDepartmentAgent(department.tenantId, params.departmentId);
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

    if (tenantId) {
      const tenantTemplateId = await this.findTenantPreSummaryTemplateId(tenantId);
      trace.tenantPromptId = tenantTemplateId;
      if (tenantTemplateId) {
        return { promptId: tenantTemplateId, tier: 'tenant', ...(await this.governedSnapshot(tenantTemplateId)) };
      }
    } else {
      trace.tenantPromptId = null;
    }

    if (await this.isApprovedTemplate(SYSTEM_DEFAULTS.preSummaryPromptId)) {
      trace.usedDefaults.push('promptId');
      return {
        promptId: SYSTEM_DEFAULTS.preSummaryPromptId,
        tier: 'default',
        ...(await this.governedSnapshot(SYSTEM_DEFAULTS.preSummaryPromptId)),
      };
    }

    this.logger.error({
      message: 'No approved pre-summary prompt could be resolved — failing closed',
      tenantId,
      departmentId: params.departmentId,
      systemPreSummaryPromptId: SYSTEM_DEFAULTS.preSummaryPromptId,
    });
    throw new ServiceUnavailableException('No approved pre-summary prompt is configured. Pre-summary generation is unavailable.');
  }

  /**
   * The tenant's pre-summary prompt id, or null when the tenant has none.
   *
   * TRADEOFF — there is no first-class `tenantPreSummaryTemplateId` pointer
   * field on any model today, so the tenant's pre-summary prompt is identified
   * BY CONVENTION: an APPROVED, tenant-scoped (`scope = TENANT_DEFAULT`),
   * department-unbound (`departmentId = null`) template tagged
   * `pre-summary` — exactly what
   * `seed/07b-arcaai-clinical-templates.ts` seeds and what
   * `ARCAAI_FALLBACK_TEMPLATE_IDS.PRE_SUMMARY` points at. A convention is
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
   * A lookup ERROR is NOT swallowed into the SYSTEM default: per the
   * fail-mode doctrine a backend error must propagate rather than be disguised
   * as "the default" (`resolvePreSummaryPromptId` turns it into a 503).
   */
  private async findTenantPreSummaryTemplateId(tenantId: string): Promise<string | null> {
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
        tags: { has: PRE_SUMMARY_TEMPLATE_TAG },
      } as unknown as IFindAllProps<PromptTemplate>['filters'],
      sort: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      this.logger.warn({
        message: 'Tenant has more than one candidate pre-summary template — resolving the first deterministically',
        tenantId,
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
   * Tier-1a resolution (TASK-546): the department's default DepartmentAgent →
   * the immutable PromptVersion snapshot content at
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
  ): Promise<{ templateId: string; content: string; versionNumber: number; agentId: string } | null> {
    try {
      const agent = await this.departmentAgentRepository.findDefaultForDepartment(tenantId, departmentId);
      if (!agent) return null;

      const template = await this.promptTemplateRepository.findById(agent.promptTemplateId);
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
