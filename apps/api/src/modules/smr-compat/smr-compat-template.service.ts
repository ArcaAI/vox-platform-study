import { PromptResolutionService } from '@arcaai/applications';
import { DepartmentRepository } from '@arcaai/domains';
import { Injectable, Logger } from '@nestjs/common';
import { matchTenantDepartment } from './department-match';
import { normalizeVisitType } from './dept-templates';

/** The resolver's summary prompt-type union (`PromptResolutionParams.promptType`). */
export type SummaryPromptType = 'new-patient' | 'revisit' | 'pre-summary';

/**
 * Bridges the v1-compat SMR shim to HOPE v2's real tenant `Department` +
 * governed `PromptTemplate` domain (TASK-592).
 *
 * The v1 endpoints carry a free-form department NAME string; the canonical
 * `PromptResolutionService` needs a Department UUID. This service resolves the
 * name to one of the tenant's real Department rows, then returns that
 * department's APPROVED, version-pinned instruction-template content — the same
 * governed content the non-compat summary processors use. When no real
 * department matches (or it carries no department-specific governed template),
 * it returns `undefined` so the caller falls back to the static dept×visit
 * field-set steering (`dept-templates.ts`), preserving pre-TASK-592 behavior.
 *
 * It NEVER throws — a resolution failure must degrade to the static path, never
 * fail the summarization request.
 */
@Injectable()
export class SmrCompatTemplateService {
  private readonly logger = new Logger(SmrCompatTemplateService.name);

  constructor(
    private readonly departmentRepository: DepartmentRepository,
    private readonly promptResolutionService: PromptResolutionService,
  ) {}

  /** Map a v1 visit-type string to the resolver's summary prompt-type bucket. */
  toSummaryPromptType(visitType?: string | null): 'new-patient' | 'revisit' {
    return normalizeVisitType(visitType) === 'followup' ? 'revisit' : 'new-patient';
  }

  /**
   * Resolve the tenant's governed department instruction template for a
   * free-form department name + prompt type. Returns the APPROVED PromptVersion
   * content when a real tenant `Department` matches AND resolves to a
   * department-specific (non-system-default) governed template; otherwise
   * `undefined` (→ caller uses the static field-set steering). Never throws.
   */
  async resolveGovernedInstruction(tenantId: string, department: string | undefined, promptType: SummaryPromptType): Promise<string | undefined> {
    if (!department?.trim()) return undefined;

    try {
      const departments = await this.departmentRepository.findAllByTenant(tenantId);
      const match = matchTenantDepartment(departments, department);
      if (!match) return undefined;

      const resolved = await this.promptResolutionService.resolve({ departmentId: match.id, promptType });

      // A bare SYSTEM default (CATCHALL_SOAP) means this department has no
      // department-specific governed template — defer to the static dept×visit
      // steering, which is richer than a generic SOAP instruction here.
      if (resolved.resolvedFrom === 'default') return undefined;

      const content = resolved.content?.trim();
      return content ? content : undefined;
    } catch (err) {
      this.logger.warn({
        message: 'Failed to resolve governed department instruction — falling back to static dept×visit steering',
        reason: err instanceof Error ? err.message : undefined,
      });
      return undefined;
    }
  }
}
