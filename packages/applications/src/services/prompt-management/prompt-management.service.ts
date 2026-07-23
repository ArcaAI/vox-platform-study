import { Injectable, Inject, Logger, Optional, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
// Server-side prompt-version diff. Same `diff` (jsdiff)
// engine the SDK used client-side, so the combined line diff is byte-identical.
import { diffLines, createPatch } from 'diff';
import { encryptPhiFields } from '../../common';
import {
  PromptTemplateRepository,
  PromptVersionRepository,
  PromptUsageRecordRepository,
  PromptTemplateFactory,
  PromptVersionFactory,
  PromptTemplateEntityMapper,
  PromptTemplateEntity,
  ResourceType,
  ResourceStatusType,
  SysEventType,
  CoreDatabaseService,
} from '@arcaai/domains';
import {
  IPromptManagementService,
  ListPromptTemplatesFilters,
  PaginatedPromptTemplates,
} from './IPromptManagementService';
import {
  PromptTemplateResponse,
  PromptVersionResponse,
  CreatePromptTemplateRequest,
  UpdatePromptTemplateRequest,
  AssignDepartmentPromptRequest,
  ApprovePromptTemplateRequest,
  TestPromptTemplateRequest,
  PromptTestResultResponse,
  PromptUsageAnalyticsResponse,
  PreferredPromptTemplateResponse,
  PromptVersionDiffResponse,
  PromptFieldDiffDto,
  PromptDiffChangeDto,
  PromptDiffStatsDto,
  PromptUsageRecordResponse,
} from './dto';
import { Paginated } from '../../common/dto/paginated.response';
import { PromptManagementDtoMapper } from './prompt-management.dto.mapper';
import { mapSmrGenerateResponse } from '../consultation/summary/smr-v2-generate';
import { SecretsService } from '../baseServices/_meta/secrets';
import { HarnessPolicyService } from '../harness-policy/harness-policy.service';
import { IDepartmentService } from '../department/IDepartmentService';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
// The doctor self-service "set my preferred template"
// write delegates to the existing UserProfile upsert (which is read back for resolution).
import { IUserProfileService } from '../user/userProfile/IUserProfileService';
import { DepartmentResponse } from '../department/dto';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';

const SCOPE_TENANT_DEFAULT = 'TENANT_DEFAULT';
const SCOPE_USER_PERSONAL = 'USER_PERSONAL';

// Reserved SYSTEM tenant that owns the platform-wide / library prompt templates.
// Mirrors `SYSTEM_TENANT_ID` in `base.service.ts` / `tenant.service.ts`
// (duplicated as a literal per the established convention). A template owned by
// this tenant is the shared library and its approval stays global-admin-only
// (OD-3); tenant-owned templates devolve to `manage:PromptTemplate`.
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

// Word count at which a generated test output earns the full
// quality score. The score is a deterministic, testable proxy for "did the
// template produce a substantive response", not a semantic judgement.
const FULL_SCORE_WORD_COUNT = 50;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Deterministic output-quality rubric helpers. Kept as
// pure module functions so they are trivially unit-testable in isolation.

/** Context the `scoreOutput` rubric branches on (a slice of the template). */
interface PromptScoreContext {
  category?: string | null;
  content?: string | null;
  variables?: Record<string, unknown> | null;
}

/** Per-dimension sub-scores surfaced to the UI for an honest breakdown. */
interface PromptScoreMetrics {
  wordCount: number;
  nonEmpty: boolean;
  lengthScore: number;
  /** Whether the template declares JSON output (DNA_ANALYSIS / JSON cue). */
  jsonExpected: boolean;
  /** `null` when JSON output is not expected, else whether the output parsed. */
  jsonValid: boolean | null;
  variablesDeclared: number;
  /** `null` when the template declares no variables, else [0,1] coverage. */
  variableCoverage: number | null;
}

interface PromptScoreResult {
  score: number;
  metrics: PromptScoreMetrics;
}

/** True when the template is meant to emit JSON (category or content cue). */
function templateExpectsJson(category?: string | null, content?: string | null): boolean {
  if (category === 'DNA_ANALYSIS') return true;
  if (!content) return false;
  return /json/i.test(content);
}

function isValidJson(value: string): boolean {
  if (!value) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Declared variable names for the coverage dimension. The admin UI persists
 * `variables` as an array of `{ name, type, required, … }`; fall back to a
 * plain `{ name: definition }` object whose keys are the variable names.
 */
function extractDeclaredVariableNames(variables?: Record<string, unknown> | null): string[] {
  if (!variables) return [];
  if (Array.isArray(variables)) {
    return variables
      .map((v) => (v && typeof v === 'object' ? (v as { name?: unknown }).name : undefined))
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
  }
  return Object.keys(variables);
}

@Injectable()
export class PromptManagementService extends BaseService implements IPromptManagementService {
  private readonly smrServiceUrl: string;

  constructor(
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly promptVersionRepository: PromptVersionRepository,
    private readonly promptUsageRecordRepository: PromptUsageRecordRepository,
    @Inject(IDepartmentService) private readonly departmentService: IDepartmentService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // `baseClient.$transaction(callback)` is the canonical Prisma-7
    // atomic idiom in this codebase. Required so the version-history insert
    // and the OCC compare-and-set commit (or roll back) together.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // SMR/text-generation client (mirrors SummaryService). These
    // are @Optional() so existing unit-test fixtures that construct the service
    // directly without the SMR deps keep compiling; the live API always wires
    // HttpModule + ConfigModule via PromptManagementServiceModule.
    @Optional() private readonly httpService?: HttpService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Resolver for the tenant's effective SMR {provider, model}.
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // Doctor self-service "set my preferred template"
    // delegates the WRITE to the existing UserProfile upsert (which resolution
    // reads back). Optional + trailing so existing positional unit fixtures keep
    // their arity; production DI supplies it via UserProfileServiceModule.
    @Optional() @Inject(IUserProfileService) private readonly userProfileService?: IUserProfileService,
    // Optional (append-only DI); enforces the plan
    // `maxPromptTemplates` quota on the create paths (kill-switch-gated, no-op OFF).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
  ) {
    super(eventEmitter, clsService, ResourceType.PromptTemplate);
    this.smrServiceUrl = this.configService?.get<string>('SMR_URL') ?? 'http://localhost:8862';
  }

  /**
   * Shared quota precheck for both create paths. The
   * plan `maxPromptTemplates` count spans ALL of a tenant's templates
   * (tenant-default + personal), matching the usage snapshot in
   * `EntitlementsService.getCapabilities`. Kill-switch-gated so the COUNT
   * only runs when enforcement is ON; a no-op for unlimited/ungated tenants.
   */
  private async assertPromptTemplateQuota(tenantId: string): Promise<void> {
    if (!this.entitlements?.isEnforcementEnabled()) return;
    const currentCount = await this.promptTemplateRepository.count({ where: { tenantId } });
    await this.entitlements.assertQuantityQuota(tenantId, 'maxPromptTemplates', currentCount);
  }

  private readonly logger = new Logger(PromptManagementService.name);

  /**
   * Encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  async createPromptTemplate(dto: CreatePromptTemplateRequest): Promise<PromptTemplateResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');
    if (!this.callerCanManageTemplates()) {
      throw new ForbiddenException('Caller cannot create tenant-default prompt templates');
    }
    await this.assertPromptTemplateQuota(tenantId);

    const existing = await this.promptTemplateRepository.findByName(tenantId, dto.name);
    if (existing) throw new BadRequestException(`Prompt template with name '${dto.name}' already exists`);

    // Resolve the requested scope + owner. Default stays
    // TENANT_DEFAULT. USER_PERSONAL provisions a personal prompt owned by
    // `ownerUserId` (an in-tenant user, surfaced by the admin UI; falls back to
    // the caller when omitted). `ownerUserId` is meaningless for the shared
    // scopes, so a mismatch is a client error rather than a silently-ignored
    // field. The prompt row is always tenant-stamped to the caller's tenant, so
    // an owner outside the tenant cannot leak (reads are tenant+owner scoped).
    const scope = dto.scope ?? SCOPE_TENANT_DEFAULT;
    let ownerUserId: string | null = null;
    if (scope === SCOPE_USER_PERSONAL) {
      ownerUserId = dto.ownerUserId ?? userId ?? null;
      if (!ownerUserId) {
        throw new BadRequestException('ownerUserId (or a caller user context) is required for USER_PERSONAL scope');
      }
    } else if (dto.ownerUserId) {
      throw new BadRequestException('ownerUserId is only valid when scope=USER_PERSONAL');
    }

    const template = PromptTemplateFactory.CreatePromptTemplate({
      tenantId,
      name: dto.name,
      description: dto.description ?? null,
      content: dto.content,
      category: dto.category,
      // Persist the publication status (defaults DRAFT).
      status: dto.status ?? 'DRAFT',
      variables: dto.variables ?? null,
      departmentId: dto.departmentId ?? null,
      scope,
      ownerUserId,
      tags: dto.tags ?? [],
      createdBy: userId ?? null,
    });

    const saved = await this.promptTemplateRepository.create(template);

    const version = PromptVersionFactory.CreatePromptVersion({
      tenantId,
      promptTemplateId: saved.id,
      versionNumber: 1,
      content: dto.content,
      variables: dto.variables ?? null,
      changeReason: 'Initial version',
      changedBy: userId ?? null,
    });

    await this.promptVersionRepository.create(version);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      data: { name: dto.name, category: dto.category },
    });

    return PromptManagementDtoMapper.toTemplateResponse(saved);
  }

  async createPersonal(dto: CreatePromptTemplateRequest): Promise<PromptTemplateResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');
    if (!userId) throw new BadRequestException('Caller user ID is required');
    await this.assertPromptTemplateQuota(tenantId);

    const template = PromptTemplateFactory.CreatePromptTemplate({
      tenantId,
      name: dto.name,
      description: dto.description ?? null,
      content: dto.content,
      category: dto.category,
      variables: dto.variables ?? null,
      departmentId: dto.departmentId ?? null,
      scope: SCOPE_USER_PERSONAL,
      ownerUserId: userId,
      tags: dto.tags ?? [],
      createdBy: userId,
    });

    const saved = await this.promptTemplateRepository.create(template);

    const version = PromptVersionFactory.CreatePromptVersion({
      tenantId,
      promptTemplateId: saved.id,
      versionNumber: 1,
      content: dto.content,
      variables: dto.variables ?? null,
      changeReason: 'Initial personal version',
      changedBy: userId,
    });

    await this.promptVersionRepository.create(version);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      data: { name: dto.name, category: dto.category, scope: SCOPE_USER_PERSONAL },
    });

    return PromptManagementDtoMapper.toTemplateResponse(saved);
  }

  /**
   * Update a prompt template.
   *
   * Write path is now Compare-And-Set
   * against the row's `_version` column. The `expectedVersion` carried
   * on the DTO is the CAS predicate input. The `@RequiresIfMatch()`
   * HTTP route folds the `If-Match` header value over the body-field
   * at the controller.
   *
   * **Important**: the `_version` column is the OCC token; the
   * `currentVersionNumber` field on `PromptTemplate` (bumped by
   * `incrementVersion()`) is the human-meaningful PromptVersion
   * counter — they are distinct concepts.
   *
   * @throws OptimisticConcurrencyException — version drift; HTTP 412.
   */
  async updatePromptTemplate(id: string, dto: UpdatePromptTemplateRequest): Promise<PromptTemplateResponse> {
    const userId = this.requestUserId;

    const template = await this.promptTemplateRepository.findById(id);
    if (!template) throw new NotFoundException(`Prompt template ${id} not found`);

    this.assertOwnedByTenant(template, id);
    this.assertCanMutate(template);

    const hasContentChanges =
      dto.name !== undefined || dto.description !== undefined || dto.content !== undefined || dto.variables !== undefined || dto.tags !== undefined;

    if (hasContentChanges) {
      if (dto.name !== undefined) template.name = dto.name;
      if (dto.description !== undefined) template.description = dto.description;
      if (dto.content !== undefined) template.content = dto.content;
      if (dto.variables !== undefined) template.variables = dto.variables;
      if (dto.tags !== undefined) template.tags = dto.tags;
      template.incrementVersion();
    }

    if (dto.resourceStatus !== undefined) {
      if (dto.resourceStatus === ResourceStatusType.DISABLED) {
        template.disable(userId ?? undefined);
      } else if (dto.resourceStatus === ResourceStatusType.ENABLED) {
        template.enable(userId ?? undefined);
      }
    }

    // A publication-status change is a mutating edit (it does
    // NOT spawn a new PromptVersion snapshot, but it marks the row dirty so the
    // OCC write proceeds). Set it before the `hasChanges` gate below.
    if (dto.status !== undefined) {
      template.status = dto.status;
    }

    if (!template.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    // Snapshot pre-write `_version` BEFORE the CAS bumps it, for
    // audit correlation.
    const previousVersion = template.version;

    // The version-history insert and the OCC Compare-And-Set run
    // inside a SINGLE interactive transaction (canonical Prisma-7 idiom). The
    // next versionNumber is `max(existing) + 1`
    // queried via the tx client — NOT `currentVersionNumber + 1` — so a lagging
    // counter or an orphaned history row cannot recompute an existing
    // versionNumber and trip the `(promptTemplateId, versionNumber)` unique
    // constraint (which would brick further edits of the template). When the
    // CAS matches 0 rows the repository throws `OptimisticConcurrencyException`
    // (HTTP 412) from inside the callback, aborting the transaction so the
    // version row rolls back and NO orphan persists. `expectedVersion` is the
    // CAS predicate input only; it never reaches the entity (the `_version`
    // getter is read-only per B.5).
    const updated = await this.databaseService.baseClient.$transaction(async (tx) => {
      if (hasContentChanges) {
        const maxVersionNumber = await this.promptVersionRepository.findMaxVersionNumber(id, tx);
        const version = PromptVersionFactory.CreatePromptVersion({
          tenantId: template.tenantId,
          promptTemplateId: id,
          versionNumber: maxVersionNumber + 1,
          content: dto.content ?? template.content,
          variables: dto.variables ?? template.variables,
          changeReason: dto.changeReason ?? null,
          changedBy: userId ?? null,
        });
        await this.promptVersionRepository.create(version, tx);
      }

      return this.promptTemplateRepository.updateWithVersion(id, template, dto.expectedVersion, tx);
    });

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: {
        changeReason: dto.changeReason,
        previousVersion,
        newVersion: updated.version,
      },
    });

    return PromptManagementDtoMapper.toTemplateResponse(updated);
  }

  /**
   * prompt governance approval (OD-3 split gate).
   *
   * Flips the template to `status = APPROVED` (the gate `prompt-resolution`
   * requires for clinical flows), PINS a `PromptVersion` snapshot of the
   * approved content, and emits the audit sys-event — the version-pin + the OCC
   * compare-and-set commit (or roll back) together in a single interactive
   * transaction (mirrors `updatePromptTemplate`). Idempotent: approving an
   * already-APPROVED template is a no-op that returns the current row.
   *
   * Authorization is split by ownership (OD-3):
   * - **SYSTEM/library** template (tenantId = SYSTEM) — the shared library is
   *   globally visible, so approval is a GLOBAL_ADMIN-only PRIVILEGE (403, not
   *   404: existence is not hidden for the shared library).
   * - **Tenant-owned** template (tenantId ≠ SYSTEM) — a caller holding
   *   `manage:PromptTemplate` for that tenant (or a global admin) may approve.
   *   Cross-tenant ids are hidden behind `assertOwnedByTenant` (404-over-403).
   *
   * Both are privilege rules → `ForbiddenException` (403). The cross-tenant 404
   * posture applies to tenant-owned rows only.
   *
   * @throws ForbiddenException — caller lacks the required privilege (403).
   * @throws NotFoundException — unknown, or cross-tenant, tenant-owned id (404).
   * @throws OptimisticConcurrencyException — version drift; HTTP 412.
   */
  async approveTemplate(id: string, dto: ApprovePromptTemplateRequest): Promise<PromptTemplateResponse> {
    const template = await this.promptTemplateRepository.findById(id);
    if (!template) throw new NotFoundException(`Prompt template ${id} not found`);

    this.assertCanApprove(template, id);

    // Idempotent — already approved: no version-pin, no audit noise.
    if (template.status === 'APPROVED') {
      return PromptManagementDtoMapper.toTemplateResponse(template);
    }

    template.status = 'APPROVED';
    const previousVersion = template.version;
    const userId = this.requestUserId;

    const updated = await this.databaseService.baseClient.$transaction(async (tx) => {
      const maxVersionNumber = await this.promptVersionRepository.findMaxVersionNumber(id, tx);
      const version = PromptVersionFactory.CreatePromptVersion({
        tenantId: template.tenantId,
        promptTemplateId: id,
        versionNumber: maxVersionNumber + 1,
        content: template.content,
        variables: template.variables,
        changeReason: dto.reason ?? 'Approved for clinical use',
        changedBy: userId ?? null,
      });
      await this.promptVersionRepository.create(version, tx);
      return this.promptTemplateRepository.updateWithVersion(id, template, dto.expectedVersion, tx);
    });

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'approve', status: 'APPROVED', previousVersion, newVersion: updated.version, reason: dto.reason ?? null },
    });

    return PromptManagementDtoMapper.toTemplateResponse(updated);
  }

  async getPromptTemplate(id: string): Promise<PromptTemplateResponse | null> {
    const template = await this.promptTemplateRepository.findById(id);
    if (!template) return null;
    if (this.tenantId && template.tenantId !== this.tenantId) return null;
    // A USER_PERSONAL prompt is readable by its owner OR by an
    // admin holding `manage:PromptTemplate` (tenant-scoped, so the cross-tenant
    // guard above already confines an admin to their own tenant). Non-owner,
    // non-admin callers are denied (null — no existence leak), preserving the
    // end-user self-only contract.
    if (
      template.scope === SCOPE_USER_PERSONAL &&
      template.ownerUserId !== this.requestUserId &&
      !this.callerCanManageTemplates()
    ) {
      return null;
    }
    return PromptManagementDtoMapper.toTemplateResponse(template);
  }

  async listPromptTemplates(filters?: ListPromptTemplatesFilters): Promise<PromptTemplateResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');

    const qb = this.promptTemplateRepository.$();
    qb.Where({ tenantId });
    if (!filters?.includeDisabled) {
      qb.Where({ resourceStatus: ResourceStatusType.ENABLED });
    }
    if (filters?.category) qb.Where({ category: filters.category });
    if (filters?.status) qb.Where({ status: filters.status });
    if (filters?.departmentId) qb.Where({ departmentId: filters.departmentId });
    // Admin scope/owner narrowing (e.g. list a user's personal prompts).
    if (filters?.scope) qb.Where({ scope: filters.scope });
    if (filters?.ownerUserId) qb.Where({ ownerUserId: filters.ownerUserId });
    if (filters?.search) qb.Where({ name: { contains: filters.search, mode: 'insensitive' } });
    const models = await qb.ToList();
    const mapper = PromptTemplateEntityMapper.getInstance();
    const templates = models.map((m) => mapper.toDomainEntity(m));
    return templates.map(PromptManagementDtoMapper.toTemplateResponse);
  }

  /**
   * Repository-level pagination for the admin list.
   *
   * The filtered count and the page slice are resolved in the repository
   * (`countWhere` + `findPaginated`) so we no longer materialize the full
   * tenant result set in memory just to slice it at the controller.
   */
  async listPromptTemplatesPaginated(filters?: ListPromptTemplatesFilters): Promise<PaginatedPromptTemplates> {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');

    const page = filters?.page && filters.page > 0 ? filters.page : 1;
    const limit = filters?.limit && filters.limit > 0 ? filters.limit : 50;

    const where: Record<string, unknown> = { tenantId };
    if (!filters?.includeDisabled) where.resourceStatus = ResourceStatusType.ENABLED;
    if (filters?.category) where.category = filters.category;
    if (filters?.status) where.status = filters.status;
    if (filters?.departmentId) where.departmentId = filters.departmentId;
    // Admin scope/owner narrowing folded into the paginated where.
    if (filters?.scope) where.scope = filters.scope;
    if (filters?.ownerUserId) where.ownerUserId = filters.ownerUserId;
    if (filters?.search) where.name = { contains: filters.search, mode: 'insensitive' };

    const { data, count } = await this.promptTemplateRepository.findPaginated(where, page, limit);
    return {
      data: data.map(PromptManagementDtoMapper.toTemplateResponse),
      count,
      page,
      limit,
    };
  }

  async listDefaultsForDepartment(departmentId: string): Promise<PromptTemplateResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');

    const qb = this.promptTemplateRepository.$();
    qb.Where({ tenantId });
    qb.Where({ resourceStatus: ResourceStatusType.ENABLED });
    qb.WhereOr({ scope: SCOPE_TENANT_DEFAULT });
    qb.WhereOr({ scope: 'DEPARTMENT_DEFAULT', departmentId });

    const models = await qb.ToList();
    const mapper = PromptTemplateEntityMapper.getInstance();
    const templates = models.map((m) => mapper.toDomainEntity(m));
    return templates.map(PromptManagementDtoMapper.toTemplateResponse);
  }

  async listMyPersonalForDepartment(departmentId: string): Promise<PromptTemplateResponse[]> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');
    if (!userId) throw new BadRequestException('Caller user ID is required');

    const templates = await this.promptTemplateRepository.findMyPersonalForDepartment(tenantId, userId, departmentId);
    return templates.map(PromptManagementDtoMapper.toTemplateResponse);
  }

  /**
   * End-user readable templates for the calling clinician.
   *
   * Serves the doctor-facing template selector WITHOUT the admin
   * `/admin/prompt-templates` plane or the `manage:PromptTemplate` ability.
   * Returns only what the caller may consume for generation: the tenant's
   * defaults, any department defaults, and the caller's OWN personal overlays.
   * Other users' `USER_PERSONAL` templates are never returned — the owner
   * predicate is bound to the caller, so this cannot leak peers' personal
   * prompts the way the admin list would.
   *
   * Resulting predicate (top-level AND of the OR group, per query-builder
   * semantics):
   *   tenantId = caller AND resourceStatus = ENABLED [AND category = ?]
   *   AND ( ( scope = TENANT_DEFAULT      AND status != DRAFT )
   *         OR ( scope = DEPARTMENT_DEFAULT AND status != DRAFT )
   *         OR ( scope = USER_PERSONAL      AND ownerUserId = caller ) )
   *
   * The publication gate (`status != DRAFT`) applies only to
   * the shared DEFAULT scopes; personal overlays are never publication-gated.
   */
  async listAvailableForCaller(filters?: { category?: string }): Promise<PromptTemplateResponse[]> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');
    if (!userId) throw new BadRequestException('Caller user ID is required');

    const qb = this.promptTemplateRepository.$();
    qb.Where({ tenantId });
    qb.Where({ resourceStatus: ResourceStatusType.ENABLED });
    if (filters?.category) qb.Where({ category: filters.category });
    // Enforce publication status on the clinician path: the
    // shared tenant/department DEFAULT templates must be non-DRAFT so doctors
    // never consume an admin's in-progress draft. `{ not: 'DRAFT' }` is the safe
    // fallback — it keeps PUBLISHED plus any legacy/unset (NULL) rows visible,
    // so pre-publication-status data is not silently hidden. The caller's OWN
    // personal overlays are intentionally NOT gated (a clinician may use their
    // own drafts).
    qb.WhereOr({ scope: SCOPE_TENANT_DEFAULT, status: { not: 'DRAFT' } });
    qb.WhereOr({ scope: 'DEPARTMENT_DEFAULT', status: { not: 'DRAFT' } });
    qb.WhereOr({ scope: SCOPE_USER_PERSONAL, ownerUserId: userId });

    const models = await qb.ToList();
    const mapper = PromptTemplateEntityMapper.getInstance();
    const templates = models.map((m) => mapper.toDomainEntity(m));
    return templates.map(PromptManagementDtoMapper.toTemplateResponse);
  }

  async getVersions(templateId: string): Promise<PromptVersionResponse[]> {
    const versions = await this.promptVersionRepository.findByTemplate(templateId);
    return versions.map(PromptManagementDtoMapper.toVersionResponse);
  }

  async getVersion(templateId: string, versionNumber: number): Promise<PromptVersionResponse | null> {
    const version = await this.promptVersionRepository.findByVersionNumber(templateId, versionNumber);
    if (!version) return null;
    return PromptManagementDtoMapper.toVersionResponse(version);
  }

  /**
   * Compute a structured, field-level diff between two
   * versions of a prompt template SERVER-side (previously the SDK GET both
   * versions and diffed locally). Returns:
   *   - `fields[]`  — per-field (`content`, `variables`) line diffs, each
   *     flagged `changed` for a future field-aware UI;
   *   - `changes/patch/stats` — the COMBINED (content + variables) line diff,
   *     byte-identical to the SDK's prior `serializeVersionForDiff` +
   *     `computePromptDiff`, so `compareVersions` keeps returning `DiffResult`.
   *
   * Tenant-scoped: the template is loaded + ownership-asserted first, so a
   * cross-tenant id is a 404 (never leaks another tenant's version history).
   *
   * @throws NotFoundException — template missing/cross-tenant, or either
   *   requested version does not exist.
   */
  async diffVersions(templateId: string, fromVersion: number, toVersion: number): Promise<PromptVersionDiffResponse> {
    const template = await this.promptTemplateRepository.findById(templateId);
    if (!template) throw new NotFoundException(`Prompt template ${templateId} not found`);
    this.assertOwnedByTenant(template, templateId);

    const [from, to] = await Promise.all([
      this.getVersion(templateId, fromVersion),
      this.getVersion(templateId, toVersion),
    ]);
    if (!from) throw new NotFoundException(`Version ${fromVersion} not found for template ${templateId}`);
    if (!to) throw new NotFoundException(`Version ${toVersion} not found for template ${templateId}`);

    const fields: PromptFieldDiffDto[] = [];

    // Field: content (always compared).
    const contentDiff = this.buildLineDiff(from.content ?? '', to.content ?? '');
    fields.push({
      field: 'content',
      changed: contentDiff.stats.additions > 0 || contentDiff.stats.deletions > 0,
      before: from.content ?? '',
      after: to.content ?? '',
      changes: contentDiff.changes,
      stats: contentDiff.stats,
    });

    // Field: variables (only when either version declares them).
    if ((from.variables ?? null) !== null || (to.variables ?? null) !== null) {
      const beforeVars = JSON.stringify(from.variables ?? null, null, 2);
      const afterVars = JSON.stringify(to.variables ?? null, null, 2);
      const varsDiff = this.buildLineDiff(beforeVars, afterVars);
      fields.push({
        field: 'variables',
        changed: varsDiff.stats.additions > 0 || varsDiff.stats.deletions > 0,
        before: beforeVars,
        after: afterVars,
        changes: varsDiff.changes,
        stats: varsDiff.stats,
      });
    }

    // Combined diff — parity with the SDK's previous client-side blob so the
    // returned `DiffResult` is unchanged for existing consumers.
    const combined = this.buildLineDiff(
      this.serializeVersionForDiff(from.content ?? '', from.variables),
      this.serializeVersionForDiff(to.content ?? '', to.variables),
    );

    return {
      promptTemplateId: templateId,
      fromVersion,
      toVersion,
      fields,
      changes: combined.changes,
      patch: combined.patch,
      stats: combined.stats,
    };
  }

  /**
   * Serialize a version's content + variables into one text blob
   * (mirrors the SDK's `serializeVersionForDiff`). When `variables` is absent
   * the blob is just the content, preserving the content-only diff behaviour.
   */
  private serializeVersionForDiff(content: string, variables?: unknown): string {
    if (variables === undefined || variables === null) return content;
    return `${content}\n\n--- variables ---\n${JSON.stringify(variables, null, 2)}`;
  }

  /**
   * Line-level diff (jsdiff `diffLines`) → the SDK `DiffResult`
   * shape (changes/patch/stats), matching the SDK `computeDiff('lines')`.
   */
  private buildLineDiff(oldText: string, newText: string): { changes: PromptDiffChangeDto[]; patch: string; stats: PromptDiffStatsDto } {
    const raw = diffLines(oldText, newText);
    const changes: PromptDiffChangeDto[] = raw.map((c) => ({
      value: c.value,
      added: c.added || undefined,
      removed: c.removed || undefined,
      count: c.count,
    }));
    let additions = 0;
    let deletions = 0;
    let unchanged = 0;
    for (const c of changes) {
      const count = c.count ?? 1;
      if (c.added) additions += count;
      else if (c.removed) deletions += count;
      else unchanged += count;
    }
    const patch = createPatch('content', oldText, newText, '', '');
    return { changes, patch, stats: { additions, deletions, unchanged } };
  }

  async getUsageStats(templateId: string): Promise<{ totalUsages: number; lastUsedAt: string | null }> {
    const records = await this.promptUsageRecordRepository.findByTemplate(templateId);
    const totalUsages = records.length;
    const lastUsedAt = totalUsages > 0 ? (records[0].createdAt?.toISOString() ?? null) : null;
    return { totalUsages, lastUsedAt };
  }

  /**
   * Run a prompt template against the SMR/text-generation
   * service, score the output, and persist `lastTestScore/lastTestOutput/
   * lastTestAt` via a Compare-And-Set write (OCC parity with the PATCH route).
   *
   * The SMR call is an injected `HttpService` dependency so the path is
   * unit-testable with a mock; the live SMR call is exercised in CI.
   *
   * @throws OptimisticConcurrencyException — version drift; HTTP 412.
   */
  async testPromptTemplate(id: string, dto: TestPromptTemplateRequest): Promise<PromptTestResultResponse> {
    const template = await this.promptTemplateRepository.findById(id);
    if (!template) throw new NotFoundException(`Prompt template ${id} not found`);

    this.assertOwnedByTenant(template, id);
    this.assertCanMutate(template);

    const prompt = this.interpolateTemplate(template.content ?? '', dto.variables, dto.sampleInput);
    const output = await this.callSmrGenerate(prompt);
    const { score, metrics } = this.scoreOutput(output, {
      category: template.category,
      content: template.content,
      variables: template.variables,
    });
    const testedAt = new Date();

    template.lastTestScore = score;
    template.lastTestOutput = output;
    template.lastTestAt = testedAt;

    // Encrypt the free-text test output into the ciphertext
    // column before the CAS persist (dual-write; plaintext retained for soak).
    await this.encryptBestEffort('PromptTemplate', () =>
      this.promptTemplateRepository.encryptFieldsIntoEntity(template, this.secretsService!),
    );

    // Compare-And-Set against the row `_version` (mirrors updatePromptTemplate).
    const updated = await this.promptTemplateRepository.updateWithVersion(id, template, dto.expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'test', score },
    });

    return {
      id: updated.id,
      score,
      output,
      testedAt: testedAt.toISOString(),
      version: updated.version,
      metrics,
    };
  }

  /**
   * Tenant-scoped usage analytics for `PromptUsageRecord`,
   * grouped by department, doctor, and UTC day. An optional `promptTemplateId`
   * narrows the aggregation to a single template.
   */
  async getUsageAnalytics(filters?: { promptTemplateId?: string }): Promise<PromptUsageAnalyticsResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');

    const promptTemplateId = filters?.promptTemplateId;
    const [byDepartment, byDoctor, byDay] = await Promise.all([
      this.promptUsageRecordRepository.groupByDepartment(tenantId, promptTemplateId),
      this.promptUsageRecordRepository.groupByDoctor(tenantId, promptTemplateId),
      this.promptUsageRecordRepository.groupByDay(tenantId, promptTemplateId),
    ]);

    const totalUsages = byDoctor.reduce((sum, row) => sum + row.count, 0);

    return { totalUsages, byDepartment, byDoctor, byDay };
  }

  /**
   * Tenant-scoped raw `PromptUsageRecord` listing (newest first)
   * for the tenant-detail "Agent Jobs" surface. Complements the aggregated
   * `getUsageAnalytics` with the individual run rows. Read-only; the optional
   * `promptTemplateId` narrows to a single agent.
   */
  async listUsageRecords(filters?: {
    page?: number;
    limit?: number;
    promptTemplateId?: string;
  }): Promise<Paginated<PromptUsageRecordResponse>> {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');

    const page = filters?.page ?? 0;
    const limit = filters?.limit ?? 20;
    const where: Record<string, unknown> = { tenantId };
    if (filters?.promptTemplateId) where.promptTemplateId = filters.promptTemplateId;

    const [records, count] = await Promise.all([
      this.promptUsageRecordRepository.findAll({
        page,
        limit,
        filters: where,
        sort: [{ createdAt: 'desc' }],
      }),
      this.promptUsageRecordRepository.count({ filters: where }),
    ]);

    const data: PromptUsageRecordResponse[] = records.map((r) => ({
      id: r.id,
      promptTemplateId: r.promptTemplateId ?? null,
      promptVersionNumber: r.promptVersionNumber ?? null,
      consultationId: r.consultationId ?? null,
      doctorId: r.doctorId ?? null,
      departmentId: r.departmentId ?? null,
      createdAt: r.createdAt.toISOString(),
    }));

    return new Paginated({ count, page, limit, data });
  }

  async softDeletePromptTemplate(id: string): Promise<PromptTemplateResponse> {
    const template = await this.promptTemplateRepository.findById(id);
    if (!template) throw new NotFoundException(`Prompt template ${id} not found`);

    this.assertOwnedByTenant(template, id);
    this.assertCanMutate(template);

    const deleted = await this.promptTemplateRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: id,
    });

    return PromptManagementDtoMapper.toTemplateResponse(deleted);
  }

  // ─── doctor self-service surface ──────────
  //
  // These are the END-USER (non-admin) entry points. Unlike the admin
  // `updatePromptTemplate` / `softDeletePromptTemplate` (which also accept a
  // `manage PromptTemplate` grant for DEFAULT-scoped rows), these are scoped to
  // STRICT caller-ownership of a USER_PERSONAL row — a doctor may only ever edit
  // or delete their own personal prompts. They re-use the proven admin write
  // paths after the ownership gate so OCC + version-history behaviour is shared.

  /** Update a personal prompt the caller owns (strict ownership, no admin path). */
  async updatePersonal(id: string, dto: UpdatePromptTemplateRequest): Promise<PromptTemplateResponse> {
    await this.assertPersonalOwned(id);
    return this.updatePromptTemplate(id, dto);
  }

  /** Soft-delete a personal prompt the caller owns (strict ownership, no admin path). */
  async deletePersonal(id: string): Promise<PromptTemplateResponse> {
    await this.assertPersonalOwned(id);
    return this.softDeletePromptTemplate(id);
  }

  /**
   * Set (or clear) the caller's preferred backend prompt template. `null` clears
   * the preference. A non-null id MUST be visible to the caller via
   * `listAvailableForCaller` (their own personal prompts + published defaults) —
   * this blocks preferring another doctor's personal/unpublished template. The
   * write delegates to the existing `UserProfile` upsert used for resolution.
   */
  async setPreferredPromptTemplate(templateId: string | null): Promise<PreferredPromptTemplateResponse> {
    const userId = this.requestUserId;
    if (!userId) throw new BadRequestException('User context is required');

    if (templateId !== null) {
      const available = await this.listAvailableForCaller();
      if (!available.some((t) => t.id === templateId)) {
        throw new ForbiddenException('Prompt template is not available to set as preferred');
      }
    }

    const profile = await this.requireUserProfileService().upsertByUserId(userId, { preferredPromptTemplateId: templateId });
    return { preferredPromptTemplateId: profile.preferredPromptTemplateId ?? null };
  }

  async assignToDepartment(dto: AssignDepartmentPromptRequest): Promise<DepartmentResponse> {
    // `updatePromptConfig` now enforces OCC,
    // so the caller MUST carry the Department row's `expectedVersion`.
    // Cross-service callers (e.g. the prompt-management UI) read the
    // Department first and echo back its version on this DTO.
    return this.departmentService.updatePromptConfig(dto.departmentId, {
      preSummaryPromptId: dto.preSummaryPromptId,
      newPatientPromptId: dto.newPatientPromptId,
      revisitPromptId: dto.revisitPromptId,
      expectedVersion: dto.expectedVersion,
    });
  }

  // ─── prompt-test internals ─────────────────────────────

  /**
   * Substitute `{{var}}` placeholders in the template content with the
   * supplied sample values, then append any free-text `sampleInput`. Unmatched
   * placeholders are left intact so the operator can see what was missing.
   */
  private interpolateTemplate(content: string, variables?: Record<string, unknown>, sampleInput?: string): string {
    let prompt = content;
    if (variables) {
      for (const [key, value] of Object.entries(variables)) {
        prompt = prompt.replace(new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, 'g'), String(value));
      }
    }
    if (sampleInput) {
      prompt = `${prompt}\n\n${sampleInput}`;
    }
    return prompt;
  }

  /**
   * Call the SMR/text-generation service `/api/v1/generate` endpoint and
   * return the generated text. Reuses `mapSmrGenerateResponse` (the same
   * response normalizer the summary path uses).
   */
  private async callSmrGenerate(prompt: string): Promise<string> {
    if (!this.httpService) {
      throw new BadRequestException('SMR/text-generation client is not configured');
    }
    try {
      const token = (await this.secretsService?.getSecretOptional('SMR_SERVICE_TOKEN')) ?? '';
      // Admin prompt-test resolves the tenant's effective
      // {provider, model} via the policy cascade (parity with prod), since the SMR
      // gateway requires an explicit caller-supplied model (no in-gateway default).
      let provider: string | undefined;
      let model: string | undefined;
      if (this.harnessPolicyService) {
        ({ provider, model } = await this.harnessPolicyService.resolveSmrSelection(this.tenantId));
      }
      const response = await this.httpService.axiosRef.post(
        `${this.smrServiceUrl}/api/v1/generate`,
        { prompt, stream: false, provider, model },
        { headers: { 'Content-Type': 'application/json', 'X-Service-Token': token } },
      );
      return mapSmrGenerateResponse(response.data).summary;
    } catch (error) {
      throw new BadRequestException(`Failed to call SMR service: ${error}`);
    }
  }

  /**
   * Deterministic, testable output-quality proxy in
   * [0, 1] for a prompt test run.
   *
   * This is **not** a semantic or clinical judgement. The previous heuristic
   * (`min(1, words/50)`) let any ≥50-word output score 100%, which read as a
   * clinical-looking quality %. This composite is a transparent rubric that
   * answers "did the template produce a well-formed, substantive response?".
   *
   * The score is the unweighted mean of the *applicable* dimensions:
   *  - **length** (always): word count vs `FULL_SCORE_WORD_COUNT`, capped at 1.
   *  - **json** (only when the template declares JSON output — category
   *    `DNA_ANALYSIS` or a JSON-enforcement cue in the content): 1 if the
   *    output parses as JSON, else 0.
   *  - **coverage** (only when the template declares `{{variables}}`): the
   *    fraction of declared variable names that appear (case-insensitive) in
   *    the output.
   *
   * An empty output short-circuits to 0. Rounded to 2 decimals. The
   * per-dimension `metrics` are returned so the UI can present an honest
   * breakdown rather than a single opaque percentage.
   */
  private scoreOutput(output: string, context?: PromptScoreContext): PromptScoreResult {
    const trimmed = (output ?? '').trim();
    const nonEmpty = trimmed.length > 0;
    const wordCount = nonEmpty ? trimmed.split(/\s+/).filter(Boolean).length : 0;
    const lengthScore = Math.min(1, wordCount / FULL_SCORE_WORD_COUNT);

    const jsonExpected = templateExpectsJson(context?.category, context?.content);
    const jsonValid = jsonExpected ? isValidJson(trimmed) : null;

    const declaredVariables = extractDeclaredVariableNames(context?.variables);
    const variablesDeclared = declaredVariables.length;
    const variableCoverage =
      variablesDeclared > 0
        ? declaredVariables.filter((name) => trimmed.toLowerCase().includes(name.toLowerCase())).length / variablesDeclared
        : null;

    const metrics: PromptScoreMetrics = {
      wordCount,
      nonEmpty,
      lengthScore: Math.round(lengthScore * 100) / 100,
      jsonExpected,
      jsonValid,
      variablesDeclared,
      variableCoverage: variableCoverage === null ? null : Math.round(variableCoverage * 100) / 100,
    };

    if (!nonEmpty) {
      return { score: 0, metrics };
    }

    const dimensions: number[] = [lengthScore];
    if (jsonValid !== null) dimensions.push(jsonValid ? 1 : 0);
    if (variableCoverage !== null) dimensions.push(variableCoverage);

    const raw = dimensions.reduce((sum, value) => sum + value, 0) / dimensions.length;
    return { score: Math.round(raw * 100) / 100, metrics };
  }

  // ─── Internal authorization helpers ────────────────

  private assertOwnedByTenant(template: PromptTemplateEntity, id: string): void {
    const callerTenant = this.tenantId;
    if (callerTenant && template.tenantId !== callerTenant) {
      throw new NotFoundException(`Prompt template ${id} not found`);
    }
  }

  /**
   * OD-3 approval gate. SYSTEM/library templates (tenantId = SYSTEM) are
   * globally visible and stay GLOBAL_ADMIN-only (privilege → 403, existence not
   * hidden). Tenant-owned templates hide cross-tenant existence (404) and then
   * require `manage:PromptTemplate` for that tenant (or a global admin).
   */
  private assertCanApprove(template: PromptTemplateEntity, id: string): void {
    if (template.tenantId === SYSTEM_TENANT_ID) {
      if (!isSuperAdmin(this.requestUser)) {
        throw new ForbiddenException('Approval of SYSTEM/library prompt templates is restricted to global administrators.');
      }
      return;
    }
    // Tenant-owned: hide cross-tenant existence first (404), then privilege (403).
    this.assertOwnedByTenant(template, id);
    if (!isSuperAdmin(this.requestUser) && !this.callerCanManageTemplates()) {
      throw new ForbiddenException('Caller cannot approve this prompt template.');
    }
  }

  private assertCanMutate(template: PromptTemplateEntity): void {
    if (template.scope === SCOPE_USER_PERSONAL) {
      if (template.ownerUserId !== this.requestUserId) {
        throw new ForbiddenException('Caller does not own this personal prompt template');
      }
      return;
    }
    if (!this.callerCanManageTemplates()) {
      throw new ForbiddenException('Caller cannot mutate default prompt templates');
    }
  }

  private callerCanManageTemplates(): boolean {
    const ability = this.clsService.get('userAbility') as { can?: (action: string, subject: string) => boolean } | undefined;
    if (!ability || typeof ability.can !== 'function') return false;
    return ability.can('manage', 'PromptTemplate');
  }

  // ─── strict ownership gate for self-service ───
  //
  // Fetches the row, hides cross-tenant rows behind NotFound (no existence
  // leak — mirrors `assertOwnedByTenant`), then requires the row be a
  // USER_PERSONAL prompt owned by the caller. Unlike `assertCanMutate`, a
  // `manage` grant is NOT a substitute for ownership here: the doctor surface
  // never lets one user mutate another's (or a DEFAULT) template.
  private async assertPersonalOwned(id: string): Promise<void> {
    const template = await this.promptTemplateRepository.findById(id);
    if (!template) throw new NotFoundException(`Prompt template ${id} not found`);

    this.assertOwnedByTenant(template, id);

    if (template.scope !== SCOPE_USER_PERSONAL) {
      throw new ForbiddenException('Only personal prompt templates can be managed from the doctor surface');
    }
    if (template.ownerUserId !== this.requestUserId) {
      throw new ForbiddenException('Caller does not own this personal prompt template');
    }
  }

  private requireUserProfileService(): IUserProfileService {
    if (!this.userProfileService) {
      throw new Error('UserProfileService is not wired (import UserProfileServiceModule into PromptManagementServiceModule)');
    }
    return this.userProfileService;
  }
}
