import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ResourceType,
  SysEventType,
  WorkflowInvariantRuleEntity,
  WorkflowInvariantRuleFactory,
  WorkflowInvariantRuleRepository,
} from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { BaseService, FetchResponse, isSuperAdmin, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { KNOWN_PALETTE_KEYS } from '../workflow-exposure/exposure-palette-policy';
import {
  CreateWorkflowInvariantRuleRequest,
  PaginatedWorkflowInvariantRuleResponse,
  UpdateWorkflowInvariantRuleRequest,
  WorkflowInvariantRuleResponse,
} from './dto';
import { IWorkflowInvariantRuleService } from './IWorkflowInvariantRuleService';
import { SYSTEM_TENANT_ID } from './system-tenant';
import { WorkflowInvariantRuleDtoMapper } from './workflow-invariant-rule.dto.mapper';

const FILTER_MODEL = 'WorkflowInvariantRule';

/**
 * `WorkflowInvariantRule` CRUD (TASK-790 W3b, closing TASK-789 finding H-1).
 *
 * Zero controllers referenced this model, so a tenant admin could not write a rule row and
 * `WorkflowValidatorService` — the 169 lines that resolve and merge those rows — was imported
 * nowhere. W3(a) wired the validator into the definition lifecycle; this service is what lets a
 * row exist outside a seed.
 *
 * ## The ownership rule (imperative, by necessity)
 *
 * `workflow-invariant-rule.prisma`'s header states it and says it is "enforced imperatively in
 * the service": SYSTEM-tenant rows are the platform's invariant register made executable; a
 * tenant row may only ADD strictness for its own tenant, and may never disable, loosen, or
 * delete a SYSTEM-owned row.
 *
 * That cannot be expressed declaratively. There is no "super admin" SUBJECT, and tenant admins
 * legitimately hold `manage:WorkflowInvariantRule` for every operation on their OWN rows — the
 * same shape as `SUPER_ADMIN_ONLY_POLICY_KEYS` (rule 05 §Imperative Privilege Checks). The route
 * carries an `// AUTH-NOTE:` marker pointing here.
 *
 * ## Two failure modes, two different codes
 *
 * - Another TENANT's row -> **404**. Cross-tenant, so existence stays hidden (rule 05).
 * - The SYSTEM row       -> **403**. A privilege boundary, NOT the 404-over-403 posture: every
 *   tenant legitimately READS the platform register (the model is in
 *   `SYSTEM_SHARED_READ_MODELS`), so its existence is already known and pretending otherwise
 *   would be incoherent — the caller can see the row in `list()` on the next line.
 *
 * The read-time half of the same rule lives in `mergeRuleSets` (`workflow-validator/rule-merge.ts`),
 * whose own doc notes this write path enforces it "at authoring time" so a row that predates or
 * slipped past this gate still cannot weaken a platform rule. Both halves are deliberate.
 */
@Injectable()
export class WorkflowInvariantRuleService extends BaseService implements IWorkflowInvariantRuleService {
  constructor(
    private readonly workflowInvariantRuleRepository: WorkflowInvariantRuleRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.WorkflowInvariantRule);
  }

  async list(query: PaginatedQuery): Promise<PaginatedWorkflowInvariantRuleResponse> {
    const { limit, page } = query;

    // The tenant-scope extension injects the caller's tenantId, and the model is a SYSTEM-shared
    // READ model — so a tenant admin sees its own rows plus the platform register it is adding
    // to, which is the only way an "add strictness" UI can show what it is adding strictness TO.
    const rows = await this.workflowInvariantRuleRepository.findAll(withFormattedPaginatedProps(query, FILTER_MODEL));
    const count = await this.workflowInvariantRuleRepository.count(withFormattedCountProps(query, FILTER_MODEL));

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { items: rows.map((row) => row.id) } });

    return WorkflowInvariantRuleDtoMapper.toPaginatedResponse(new FetchResponse({ data: rows, count, limit: limit ?? 10, page: page ?? 0 }));
  }

  async getById(id: string): Promise<WorkflowInvariantRuleResponse> {
    const entity = await this.workflowInvariantRuleRepository.findById(id);
    this.assertReadable(entity);

    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: entity.id });

    return WorkflowInvariantRuleDtoMapper.toResponse(entity);
  }

  async create(dto: CreateWorkflowInvariantRuleRequest): Promise<WorkflowInvariantRuleResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException('Tenant context required');
    }

    this.assertKnownPaletteKey(dto.paletteKey);

    const entity = WorkflowInvariantRuleFactory.CreateWorkflowInvariantRule({
      // From CLS, NEVER the body (rule 05 §S-3). A caller writing rules for another tenant — or
      // planting one in the SYSTEM register — is exactly what this line prevents.
      tenantId,
      ruleId: dto.ruleId,
      registerRefs: dto.registerRefs ?? [],
      title: dto.title,
      rationale: dto.rationale ?? null,
      predicateType: dto.predicateType,
      predicateConfig: dto.predicateConfig as never,
      paletteKey: dto.paletteKey ?? null,
      severity: dto.severity,
      ruleVersion: dto.ruleVersion,
      createdBy: this.requestUserId ?? undefined,
    });

    const saved = await this.workflowInvariantRuleRepository.create(entity);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { ruleId: saved.ruleId, paletteKey: saved.paletteKey, severity: String(saved.severity), ruleVersion: saved.ruleVersion },
    });

    return WorkflowInvariantRuleDtoMapper.toResponse(saved);
  }

  async update(id: string, dto: UpdateWorkflowInvariantRuleRequest): Promise<WorkflowInvariantRuleResponse> {
    const entity = await this.workflowInvariantRuleRepository.findById(id);
    this.assertWritable(entity);

    const { expectedVersion, ...editableChanges } = dto;

    await this.updateEntity(entity, editableChanges);

    // OCC precondition BEFORE the no-changes short-circuit: a stale client gets 412, not 400,
    // even when the payload would change nothing (RFC 7232 evaluates preconditions independently
    // of the payload) — the `WorkflowDefinitionService.update` discipline.
    this.assertExpectedVersion(entity, expectedVersion);
    if (!entity.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    const previousVersion = entity.version;
    const updated = await this.workflowInvariantRuleRepository.updateWithVersion(id, entity, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...entity.changes, previousVersion, newVersion: updated.version },
    });

    return WorkflowInvariantRuleDtoMapper.toResponse(updated);
  }

  async deleteById(id: string): Promise<WorkflowInvariantRuleResponse> {
    const entity = await this.workflowInvariantRuleRepository.findById(id);
    this.assertWritable(entity);

    const deleted = await this.workflowInvariantRuleRepository.softDelete(id, this.requestUserId ?? undefined);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: { ruleId: deleted.ruleId },
    });

    return WorkflowInvariantRuleDtoMapper.toResponse(deleted);
  }

  // ============================================================
  // Internals
  // ============================================================

  /** Readable = the caller's own row, or the SYSTEM register (a SYSTEM-shared read model).
   *  Anything else is another tenant's -> 404, existence hidden. */
  private assertReadable(entity: Pick<WorkflowInvariantRuleEntity, 'tenantId'>): void {
    if (entity.tenantId === this.tenantId || entity.tenantId === SYSTEM_TENANT_ID) return;
    throw new NotFoundException('Workflow invariant rule not found.');
  }

  /**
   * AUTH-NOTE: the one-way-strictness ownership boundary. Read `workflow-invariant-rule.prisma`'s
   * header before widening this — the declarative `manage:WorkflowInvariantRule` ability
   * UNDERSTATES the gate on purpose (rule 05 §Imperative Privilege Checks).
   *
   * A SYSTEM-owned row is SUPER_ADMIN-only: 403, because the row is readable by every tenant so
   * hiding its existence would be incoherent. Another tenant's row is 404.
   */
  private assertWritable(entity: Pick<WorkflowInvariantRuleEntity, 'tenantId'>): void {
    this.assertReadable(entity);

    if (entity.tenantId === SYSTEM_TENANT_ID && !isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(
        'This is a platform invariant rule. A tenant may add its own stricter rule, but cannot modify the platform register.',
      );
    }
  }

  /** A rule naming a palette the node registry does not declare can never fire — `validate()`
   *  skips every rule whose paletteKey does not match the graph's. Same set, and same reasoning,
   *  as `WorkflowDefinitionService.assertKnownPaletteKey`. `undefined`/null = every palette. */
  private assertKnownPaletteKey(paletteKey: string | null | undefined): void {
    if (paletteKey === null || paletteKey === undefined) return;
    if (KNOWN_PALETTE_KEYS.has(paletteKey)) return;
    throw new BadRequestException(`Unknown paletteKey '${paletteKey}'. Known palettes: ${[...KNOWN_PALETTE_KEYS].sort().join(', ')}.`);
  }
}
