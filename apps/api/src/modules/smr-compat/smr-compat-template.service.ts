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
   * Resolve the tenant's governed instruction template for a free-form
   * department name + prompt type. Returns the APPROVED PromptVersion content
   * when a tenant-specific (non-system-default) governed template resolves;
   * otherwise `undefined` (→ caller uses the static field-set steering). Never
   * throws.
   *
   * TASK-634 — the two capabilities take DIFFERENT routes:
   *
   * - `'new-patient' | 'revisit'` (summary): the free-form department name is
   *   matched to a real tenant `Department` row, whose governed visit-type
   *   template is resolved. Unchanged.
   * - `'pre-summary'`: there is no department axis at all — v1 carries exactly
   *   ONE pre-summary prompt per tenant, with department and visit type as
   *   variables inside it — so NO department matching happens and the resolver
   *   is asked for the tenant's pre-summary prompt directly. This is what makes
   *   a request with a missing or unknown department still resolve.
   *
   * The `resolvedFrom === 'default'` guard (previously dead code, because the
   * resolver mislabelled system-default resolutions as `'department'`) is now
   * live and carries its intended meaning for BOTH routes: a bare SYSTEM
   * default means "nothing tenant-specific is configured", and the static v1
   * steering is the better answer — for summary because the static dept×visit
   * field sets are richer than a generic SOAP instruction, and for pre-summary
   * because the SYSTEM pre-summary template still carries un-interpolated
   * single-brace `{placeholders}` that would reach the LLM literally.
   */
  async resolveGovernedInstruction(tenantId: string, department: string | undefined, promptType: SummaryPromptType): Promise<string | undefined> {
    try {
      const resolved =
        promptType === 'pre-summary'
          ? await this.promptResolutionService.resolve({ tenantId, promptType })
          : await this.resolveDepartmentScoped(tenantId, department, promptType);

      if (!resolved || resolved.resolvedFrom === 'default') return undefined;

      const content = resolved.content?.trim();
      return content ? content : undefined;
    } catch (err) {
      // Includes the pre-summary chain's fail-closed 503: the compat shim must
      // degrade to the static v1 pre-summary path, never fail the request.
      this.logger.warn({
        message: 'Failed to resolve governed instruction — falling back to the static v1 steering',
        promptType,
        reason: err instanceof Error ? err.message : undefined,
      });
      return undefined;
    }
  }

  /**
   * Summary route: free-form department NAME → real tenant `Department` UUID →
   * that department's governed visit-type template. `null` when no tenant
   * department matches (→ static steering).
   */
  private async resolveDepartmentScoped(
    tenantId: string,
    department: string | undefined,
    promptType: Exclude<SummaryPromptType, 'pre-summary'>,
  ): Promise<Awaited<ReturnType<PromptResolutionService['resolve']>> | null> {
    if (!department?.trim()) return null;

    const departments = await this.departmentRepository.findAllByTenant(tenantId);
    const match = matchTenantDepartment(departments, department);
    if (!match) return null;

    return this.promptResolutionService.resolve({ departmentId: match.id, promptType });
  }
}
