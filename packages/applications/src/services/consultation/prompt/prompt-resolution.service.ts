/**
 * PromptResolutionService
 *
 * Resolves prompt configuration (summary template, prompt ID, context variables)
 * using a three-tier fallback chain (highest priority first):
 *
 *   Tier-0 (preferred) — the consulting doctor's preferred prompt template,
 *     from `UserProfile.preferredPromptTemplateId`. When it
 *     resolves, its id wins over the department/default tiers.
 *   Tier-1 (department) — from Department model prompt config fields.
 *   Tier-2 (default) — hardcoded system fallback values.
 *
 * The chosen tier is reported back on `ResolvedPromptConfig.resolvedFrom`
 * (`'preferred' | 'department' | 'default'`).
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

import { Injectable, Logger } from '@nestjs/common';
import {
  DepartmentRepository,
  DepartmentEntity,
  PromptTemplateRepository,
  DepartmentAgentRepository,
  PromptVersionRepository,
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
   * The immutable prompt CONTENT snapshot, present ONLY when a department
   * default `DepartmentAgent` resolved (tier-1a; TASK-546). Read from
   * `PromptVersion.content` at `pinnedVersionNumber ?? latest APPROVED`, never
   * the mutable template row — this is what makes version PINNING meaningful.
   * Absent on every legacy path (so no-agent resolution is byte-identical).
   */
  content?: string | null;

  /** The resolved PromptVersion number when an agent resolved (tier-1a). */
  resolvedVersionNumber?: number | null;

  /** The default DepartmentAgent id when tier-1a resolved. */
  resolvedAgentId?: string;
}

/** Which tier of the fallback chain was used */
export type PromptResolutionTier = 'preferred' | 'agent' | 'department' | 'default';

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
  usedDefaults: string[];
}

/**
 * Input parameters for prompt resolution.
 * All fields are optional to support various calling contexts.
 */
export interface PromptResolutionParams {
  /** Department ID — used to look up department-level defaults */
  departmentId?: string;

  /** Prompt type — determines which prompt ID to resolve */
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
} as const;

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
   * Resolve prompt configuration using the Department → Default chain.
   *
   * If an explicit template is provided (e.g., from a manual API call),
   * it takes precedence over the department lookup for template.
   *
   * The resolution trace is always populated for audit/debugging purposes.
   */
  async resolve(params: PromptResolutionParams): Promise<ResolvedPromptConfig> {
    const trace: PromptResolutionTrace = {
      usedDefaults: [],
    };

    // Tier-0: the doctor's preferred prompt template, when it exists,
    // wins over the department/default tiers. Resolved up-front so its id can override
    // the promptId computed below while still keeping department context variables.
    const preferredPromptId = await this.resolvePreferredPromptId(params.preferredPromptTemplateId);
    trace.preferredPromptId = preferredPromptId;

    // If explicit template is provided, use it and skip department lookup for template
    const department = await this.resolveDepartment(params.departmentId);

    if (department) {
      trace.departmentTemplate = department.defaultSummaryTemplate ?? null;
      switch (params.promptType) {
        case 'pre-summary':
          trace.departmentPromptId = department.preSummaryPromptId ?? null;
          break;
        case 'revisit':
          trace.departmentPromptId = department.revisitPromptId ?? null;
          break;
        case 'new-patient':
        default:
          trace.departmentPromptId = department.newPatientPromptId ?? null;
          break;
      }
    }

    // --- template ---
    let template = params.explicitTemplate ?? null;
    if (!template && department?.defaultSummaryTemplate) {
      template = department.defaultSummaryTemplate;
    }
    if (!template) {
      template = SYSTEM_DEFAULTS.template;
      trace.usedDefaults.push('template');
    }

    // --- promptId ---
    let promptId: string | null = null;
    let resolvedContent: string | null | undefined;
    let resolvedVersionNumber: number | null | undefined;
    let resolvedAgentId: string | undefined;

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
        promptId = agentResolution.templateId;
        resolvedContent = agentResolution.content;
        resolvedVersionNumber = agentResolution.versionNumber;
        resolvedAgentId = agentResolution.agentId;
        trace.agentId = agentResolution.agentId;
        trace.agentVersionNumber = agentResolution.versionNumber;
      }
    }

    // Legacy department prompt-id columns (skipped when tier-1a resolved).
    if (!promptId) {
      let departmentPromptId: string | null = null;
      if (department) {
        switch (params.promptType) {
          case 'pre-summary':
            departmentPromptId = department.preSummaryPromptId ?? null;
            break;
          case 'revisit':
            departmentPromptId = department.revisitPromptId ?? null;
            break;
          case 'new-patient':
          default:
            departmentPromptId = department.newPatientPromptId ?? null;
            break;
        }
      }

      // prompt governance: a department template is only
      // resolvable for clinical generation flows once it is APPROVED. A not-yet-
      // approved (DRAFT/PUBLISHED) department template is SKIPPED so resolution
      // falls through to the APPROVED system default (fallback chain otherwise
      // unchanged). The system default (CATCHALL_SOAP) is seeded APPROVED.
      if (departmentPromptId && (await this.isApprovedTemplate(departmentPromptId))) {
        promptId = departmentPromptId;
      }
      if (!promptId) {
        promptId = SYSTEM_DEFAULTS.promptId;
        trace.usedDefaults.push('promptId');
      }
    }

    // Tier-0 override: the preferred template id supersedes department/default promptId.
    if (preferredPromptId) {
      promptId = preferredPromptId;
    }

    // --- contextVariables ---
    const contextVariables = this.extractContextVariables(department);
    if (!department?.promptConfig) {
      trace.usedDefaults.push('contextVariables');
    }

    const resolvedFrom: PromptResolutionTier = preferredPromptId
      ? 'preferred'
      : resolvedAgentId
        ? 'agent'
        : department && trace.usedDefaults.length < 3
          ? 'department'
          : 'default';

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

    // Attach the immutable snapshot ONLY when tier-1a resolved, so every legacy
    // path returns a byte-identical object (regression-locked).
    if (resolvedAgentId) {
      result.content = resolvedContent ?? null;
      result.resolvedVersionNumber = resolvedVersionNumber ?? null;
      result.resolvedAgentId = resolvedAgentId;
    }

    return result;
  }

  /**
   * Tier-1a resolution (TASK-546): the department's default DepartmentAgent →
   * the immutable PromptVersion snapshot content at `pinnedVersionNumber ??
   * latest APPROVED`. Returns null (fall through to the legacy chain) when there
   * is no default agent, the bound template is not APPROVED, or the resolved
   * version has no snapshot. Reads `PromptVersion.content`, never the mutable
   * template row.
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

      const version =
        agent.pinnedVersionNumber !== null && agent.pinnedVersionNumber !== undefined
          ? await this.promptVersionRepository.findByVersionNumber(template.id, agent.pinnedVersionNumber)
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
