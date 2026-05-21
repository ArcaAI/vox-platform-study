/**
 * PromptResolutionService
 *
 * Resolves prompt configuration (summary template, prompt ID, context variables)
 * using a two-tier fallback chain:
 *
 *   1. Department-level — from Department model prompt config fields
 *   2. System default — hardcoded fallback values
 *
 * DNA resolution is no longer part of this service; DNA style is per-doctor
 * and resolved elsewhere.
 *
 * This service does NOT depend on ClsService (request context) because it is
 * invoked from background job processors (BullMQ workers) that have no HTTP
 * request context. All identifying information is passed as parameters.
 *
 * Implements GAP-3 of TASK-021: Department-to-Prompt Mapping.
 */

import { Injectable, Logger } from '@nestjs/common';
import { DepartmentRepository, DepartmentEntity } from '@arcaai/domains';

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
}

/** Which tier of the fallback chain was used */
export type PromptResolutionTier = 'department' | 'default';

/** Trace of what each tier contributed */
export interface PromptResolutionTrace {
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

  constructor(private readonly departmentRepository: DepartmentRepository) {}

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
    if (department) {
      switch (params.promptType) {
        case 'pre-summary':
          promptId = department.preSummaryPromptId ?? null;
          break;
        case 'revisit':
          promptId = department.revisitPromptId ?? null;
          break;
        case 'new-patient':
        default:
          promptId = department.newPatientPromptId ?? null;
          break;
      }
    }
    if (!promptId) {
      promptId = SYSTEM_DEFAULTS.promptId;
      trace.usedDefaults.push('promptId');
    }

    // --- contextVariables ---
    const contextVariables = this.extractContextVariables(department);
    if (!department?.promptConfig) {
      trace.usedDefaults.push('contextVariables');
    }

    const resolvedFrom: PromptResolutionTier = department && trace.usedDefaults.length < 3 ? 'department' : 'default';

    this.logger.debug({
      message: 'Prompt config resolved',
      resolvedFrom,
      template,
      promptId,
      departmentId: params.departmentId,
      promptType: params.promptType,
      trace,
    });

    return {
      template,
      promptId,
      contextVariables,
      resolvedFrom,
      resolutionTrace: trace,
    };
  }

  // =========================================================================
  // Private Resolution Methods
  // =========================================================================

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
