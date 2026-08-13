import { PromptResolutionService } from '@arcaai/applications';
import { DepartmentRepository } from '@arcaai/domains';
import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { matchTenantDepartment } from './department-match';
import { normalizeVisitType } from './dept-templates';

/** The resolver's summary prompt-type union (`PromptResolutionParams.promptType`). */
export type SummaryPromptType = 'new-patient' | 'revisit' | 'pre-summary';

/**
 * Request-scoped identifiers the resolver itself never sees, carried purely so
 * the INFO audit line can answer "which template did THIS doctor's request for
 * THIS department and visit type actually get?".
 *
 * Deliberately NOT resolution inputs: `visitType` is the RAW v1 string (the
 * resolver takes the already-bucketed `new-patient`/`revisit`), and `doctorId`
 * selects no template today — it only drives DNA writing style. Passing them
 * here keeps the audit line complete without implying either is a selector.
 */
export interface GovernedInstructionAudit {
  /** Raw v1 `visit_type` as the client sent it, before bucketing. */
  visitType?: string;
  /** v1 `doctor_id` as the client sent it (a clinician id, not PHI). */
  doctorId?: string;
}

/**
 * Bridges the v1-compat SMR shim to HOPE v2's real tenant `Department` +
 * governed `PromptTemplate` domain.
 *
 * The v1 endpoints carry a free-form department NAME string; the canonical
 * `PromptResolutionService` needs a Department UUID. This service resolves the
 * name to one of the tenant's real Department rows, then returns that
 * department's APPROVED, version-pinned instruction-template content — the same
 * governed content the non-compat summary processors use. When no real
 * department matches (or it carries no department-specific governed template),
 * it returns `undefined` so the caller falls back to the static dept×visit
 * field-set steering (`dept-templates.ts`), preserving the previous implementation behavior.
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
    private readonly clsService: ClsService,
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
   * The two capabilities take DIFFERENT routes:
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
  async resolveGovernedInstruction(
    tenantId: string,
    department: string | undefined,
    promptType: SummaryPromptType,
    audit: GovernedInstructionAudit = {},
  ): Promise<string | undefined> {
    let departmentId: string | null = null;

    try {
      let resolved: Awaited<ReturnType<PromptResolutionService['resolve']>> | null;
      if (promptType === 'pre-summary') {
        resolved = await this.promptResolutionService.resolve({ tenantId, promptType });
      } else {
        const scoped = await this.resolveDepartmentScoped(tenantId, department, promptType);
        departmentId = scoped?.departmentId ?? null;
        resolved = scoped?.resolved ?? null;
      }

      // A `default`-tier resolution is deliberately DISCARDED (see the doc block
      // above), so it is reported as static steering — not as a served template.
      const governed = !resolved || resolved.resolvedFrom === 'default' ? undefined : resolved.content?.trim() || undefined;

      this.logResolution({ tenantId, department, departmentId, promptType, audit, resolved, served: governed !== undefined });
      return governed;
    } catch (err) {
      // Includes the pre-summary chain's fail-closed 503: the compat shim must
      // degrade to the static v1 pre-summary path, never fail the request.
      this.logger.warn({
        message: 'Failed to resolve governed instruction — falling back to the static v1 steering',
        promptType,
        reason: err instanceof Error ? err.message : undefined,
      });
      this.logResolution({
        tenantId,
        department,
        departmentId,
        promptType,
        audit,
        resolved: null,
        served: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * The ONE INFO-level line that makes prompt selection answerable in production
   * without a debug build.
   *
   * `PromptResolutionService` already traces the same decision, but at `debug`
   * and one layer down, and this shim discards everything except the content —
   * so on a normal deployment there was no way to tell WHICH template served a
   * given request, or why a department fell back. That is the first question
   * every "wrong summary" investigation asks.
   *
   * Emitted on EVERY resolution, including the misses: `served: false` with
   * `resolvedFrom: 'default'` means the governed tier was skipped and the static
   * v1 dept×visit steering ran instead, and a null `departmentId` alongside a
   * non-empty `department` means the free-form name matched no tenant row.
   *
   * Identifiers only — never prompt content, and no patient-identifying field.
   * `doctorId` is a clinician id (not PHI) and is carried because per-doctor
   * behaviour is the next thing this chain will grow.
   */
  private logResolution(input: {
    tenantId: string;
    department: string | undefined;
    departmentId: string | null;
    promptType: SummaryPromptType;
    audit: GovernedInstructionAudit;
    resolved: Awaited<ReturnType<PromptResolutionService['resolve']>> | null;
    served: boolean;
    error?: string;
  }): void {
    const { resolved } = input;
    this.logger.log({
      message: 'SMR compat instruction template resolved',
      capability: input.promptType === 'pre-summary' ? 'pre-summary' : 'summary',
      promptType: input.promptType,
      tenantId: input.tenantId,
      doctorId: input.audit.doctorId ?? null,
      department: input.department?.trim() || null,
      departmentId: input.departmentId,
      visitType: input.audit.visitType?.trim() || null,
      promptTemplateId: resolved?.promptId ?? null,
      promptVersionNumber: resolved?.resolvedVersionNumber ?? null,
      departmentAgentId: resolved?.resolvedAgentId ?? null,
      resolvedFrom: resolved?.resolvedFrom ?? null,
      // What actually steered the LLM — the governed template, or the hardcoded
      // v1 field-set guidance in `dept-templates.ts`.
      served: input.served ? 'governed-template' : 'static-v1-steering',
      correlationId: this.clsService.getId(),
      ...(input.error ? { error: input.error } : {}),
    });
  }

  /**
   * Summary route: free-form department NAME → real tenant `Department` UUID →
   * that department's governed visit-type template. `null` when no tenant
   * department matches (→ static steering). Returns the matched department id
   * alongside the resolution so the audit line can report which row was hit.
   */
  private async resolveDepartmentScoped(
    tenantId: string,
    department: string | undefined,
    promptType: Exclude<SummaryPromptType, 'pre-summary'>,
  ): Promise<{ resolved: Awaited<ReturnType<PromptResolutionService['resolve']>>; departmentId: string } | null> {
    if (!department?.trim()) return null;

    const departments = await this.departmentRepository.findAllByTenant(tenantId);
    const match = matchTenantDepartment(departments, department);
    if (!match) return null;

    return { resolved: await this.promptResolutionService.resolve({ departmentId: match.id, promptType }), departmentId: match.id };
  }
}
