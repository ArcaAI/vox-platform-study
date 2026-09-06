import { Injectable, Inject, Logger, Optional, BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
// Server-side prompt-version diff. Same `diff` (jsdiff)
// engine the SDK used client-side, so the combined line diff is byte-identical.
import { diffLines, createPatch } from 'diff';
import type { Readable } from 'node:stream';
import { TENANTLESS, encryptPhiFields, internalServiceHeaders, resolveInternalAccessToken } from '../../common';
import { readGenerationId } from '../text-request/text-stream-open';
import { EvalPromotionGateService } from '../eval/eval-promotion-gate.service';
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
  AiModelRepository,
  GoldenCaseRepository,
  ModelTaskType,
} from '@arcaai/domains';
import { IPromptManagementService, ListPromptTemplatesFilters, PaginatedPromptTemplates } from './IPromptManagementService';
import {
  PromptTemplateResponse,
  PromptVersionResponse,
  CreatePromptTemplateRequest,
  UpdatePromptTemplateRequest,
  AssignDepartmentPromptRequest,
  ApprovePromptTemplateRequest,
  TestPromptTemplateRequest,
  PromptTestResultResponse,
  PromptTestAckResponse,
  FinalizePromptTestRequest,
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
import { SecretsService } from '../baseServices/_meta/secrets';
import { TextAgentResolverService } from '../agent/text-agent-resolver.service';
import { TextRequestEnrichmentService } from '../text-request/text-request-enrichment.service';
import { IDepartmentService } from '../department/IDepartmentService';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
// The doctor self-service "set my preferred template"
// write delegates to the existing UserProfile upsert (which is read back for resolution).
import { IUserProfileService } from '../user/userProfile/IUserProfileService';
import { DepartmentResponse } from '../department/dto';
import { runInTenantContext } from '../agentPromotion/tenant-context';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { renderTemplate, PromptVariableUnresolvedError, PromptTemplateSyntaxError } from '@arcaai/workflow-contract';
import { IUsageLedgerService } from '../usageLedger/IUsageLedgerService';
import {
  buildLlmUsageInput,
  buildLlmUsageInputFromTokenCounts,
  parseTextUsageDetail,
  resolveDeployment,
  toLedgerProvider,
} from '../consultation/summary/text-usage';
import { withUsageTrigger } from '../usageLedger/usage-attributes';
import { PromptVariableDeclarationDto, PromptVariableType, parsePromptVariableDeclarations } from './dto/prompt-variable-declaration.dto';

const SCOPE_TENANT_DEFAULT = 'TENANT_DEFAULT';
const SCOPE_USER_PERSONAL = 'USER_PERSONAL';

// Reserved SYSTEM tenant that owns the platform-wide / library prompt templates.
// Mirrors `SYSTEM_TENANT_ID` in `base.service.ts` / `tenant.service.ts`
// (duplicated as a literal per the established convention). A template owned by
// this tenant is the shared library and its approval stays super-admin-only
// ; tenant-owned templates devolve to `manage:PromptTemplate`.
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

// Word count at which a generated test output earns the full
// quality score. The score is a deterministic, testable proxy for "did the
// template produce a substantive response", not a semantic judgement.
const FULL_SCORE_WORD_COUNT = 50;

// TEXT's terminal success state (`TaskStatus.COMPLETED` in
// `apps/text/src/text/models/task.py`).
const TEXT_TASK_COMPLETED = 'completed';

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
 * Declared variable names for the coverage dimension.
 *
 * TASK-890 §3.6 (OD-K): `variables` is now an ARRAY of typed declarations
 * ONLY — the retired `{ name: definition }` map has NO read-side normaliser.
 * Delegates to {@link parsePromptVariableDeclarations}, which already treats
 * any non-array shape as "no declarations".
 */
function extractDeclaredVariableNames(variables?: Record<string, unknown> | null): string[] {
  return parsePromptVariableDeclarations(variables).map((decl) => decl.name);
}

/** Coerce a caller-supplied or `default` string value to a declaration's `type` (§3.6). */
export function coercePromptVariableValue(type: PromptVariableType, value: unknown): unknown {
  switch (type) {
    case 'number': {
      if (typeof value === 'number') return value;
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    }
    case 'date': {
      if (value instanceof Date) return value.toISOString();
      const raw = String(value).trim();
      // A calendar date stays a calendar date. Running it through
      // `new Date(...).toISOString()` put `2026-09-06T00:00:00.000Z` — a
      // midnight-UTC instant nobody entered, in the wrong day for half the
      // planet — into a prompt that asked for a date.
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? value : d.toISOString();
    }
    case 'json': {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    case 'string':
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

@Injectable()
export class PromptManagementService extends BaseService implements IPromptManagementService {
  private readonly textServiceUrl: string;

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
    // TEXT/text-generation client (mirrors SummaryService). These
    // are @Optional() so existing unit-test fixtures that construct the service
    // directly without the TEXT deps keep compiling; the live API always wires
    // HttpModule + ConfigModule via PromptManagementServiceModule.
    @Optional() private readonly httpService?: HttpService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Doctor self-service "set my preferred template"
    // delegates the WRITE to the existing UserProfile upsert (which resolution
    // reads back). Optional + trailing so existing positional unit fixtures keep
    // their arity; production DI supplies it via UserProfileServiceModule.
    @Optional() @Inject(IUserProfileService) private readonly userProfileService?: IUserProfileService,
    // Optional (append-only DI); enforces the plan
    // `maxPromptTemplates` quota on the create paths (kill-switch-gated, no-op OFF).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    // Optional (append-only DI); the OD-3 eval promotion gate.
    // When present, approving a template whose bound agent references a golden
    // set runs the eval and blocks (409) on a gate failure in block-mode.
    @Optional() @Inject(EvalPromotionGateService) private readonly promotionGate?: EvalPromotionGateService,
    // Validates a caller-supplied test-run provider/model
    // pair against the ENABLED AiModel registry (same source `GET
    // /text/providers` reads). Optional + trailing so existing fixtures keep
    // their arity; absent ⇒ validation is skipped (best-effort, never blocks
    // policy-resolved selections).
    @Optional() @Inject(AiModelRepository) private readonly aiModelRepository?: AiModelRepository,
    // Loads a golden case's decrypted transcript as
    // predefined test-run sample input. Optional + trailing; absent ⇒
    // `goldenCaseId` requests fail closed with a clear configuration error.
    @Optional() @Inject(GoldenCaseRepository) private readonly goldenCaseRepository?: GoldenCaseRepository,
    // BUG-018 — the SHARED tenant-credential + runtime-profile enrichment used
    // by `TextProxyController`. Optional + trailing so existing positional
    // fixtures keep their arity; absent ⇒ the outgoing body is unenriched
    // (exactly the pre-BUG-018 behavior), never a failure.
    @Optional() @Inject(TextRequestEnrichmentService) private readonly textRequestEnrichment?: TextRequestEnrichmentService,
    // TASK-876 — the tenant's ASSIGNED TEXT_GENERATION agent, which is what a prompt test must
    // run on: testing a template against a model no consultation would ever use tells the author
    // nothing. Optional + trailing so existing positional fixtures keep their arity.
    @Optional() @Inject(TextAgentResolverService) private readonly textAgents?: TextAgentResolverService,
    // TASK-890 §3.13 (OD-E) — the prompt test-run is a production inference path and must be
    // metered like every other one. Optional + trailing so existing positional fixtures keep
    // their arity; absent ⇒ `finalizePromptTemplateTest` persists unmetered (best-effort, never
    // blocks the write) and `startPromptTemplateTest`'s quota precheck is skipped.
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedgerService?: IUsageLedgerService,
  ) {
    super(eventEmitter, clsService, ResourceType.PromptTemplate);
    this.textServiceUrl = this.configService?.get<string>('TEXT_URL') ?? 'http://localhost:8862';
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
      variables: (dto.variables as unknown as Record<string, unknown>) ?? null,
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
      variables: (dto.variables as unknown as Record<string, unknown>) ?? null,
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

  /**
   * TASK-890 §3.4 (OD-H / OD-M) — the REFERENCE-SET copy of ONE SYSTEM template into a tenant.
   *
   * Deliberately NOT `createPromptTemplate`: that method answers an authoring REQUEST, so it
   * checks the caller's ability and the tenant's template quota. Provisioning has neither — it
   * runs inside `TenantService.create`, where there is no caller ability in the new tenant, and
   * a plan quota must never be able to leave a tenant without the platform defaults its runtime
   * fails closed without. What it does share is the shape of the write: template row + version
   * 1, through the same factories and repositories.
   *
   * What travels: name, description, category, tags, scope and the APPROVED content (the
   * pinned `PromptVersion` snapshot, not the mutable `content` column, unless the source never
   * carried a pin). What is stamped: `sourceTemplateId` (the provenance the runtime resolves a
   * `SYSTEM_DEFAULTS.*` pointer through) and `templateLocked`.
   *
   * The clone's version lineage restarts at 1 — a tenant's history is its own — so an APPROVED
   * source pins the clone at 1, and every caller re-reads the pin rather than assuming it.
   *
   * MISSING-ONLY, by provenance first and by NAME second: a tenant that already carries a
   * template of that name keeps it (the `(tenantId, name)` uniqueness the authoring path
   * enforces would refuse the insert anyway, and silently renaming a platform default is worse
   * than not copying it).
   */
  async cloneFromSystem(
    systemTemplateId: string,
    targetTenantId: string,
  ): Promise<{ templateId: string; created: boolean; approvedVersionNumber: number | null }> {
    const source = await this.promptTemplateRepository.findSystemReferenceById(systemTemplateId, this.databaseService.baseClient);
    if (!source) {
      throw new NotFoundException(`No SYSTEM prompt template ${systemTemplateId} to clone from.`);
    }

    // The source's APPROVED snapshot, read standing in SYSTEM's own context: `PromptVersion`
    // leaves the shared-read set with its template, so the caller's tenant cannot see it.
    const snapshot = await runInTenantContext(this.clsService, SYSTEM_TENANT_ID, async () => {
      const pinned = source.approvedVersionNumber ?? null;
      if (pinned !== null) {
        const version = await this.promptVersionRepository.findByVersionNumber(source.id, pinned).catch(() => null);
        if (version?.content !== null && version?.content !== undefined) {
          return { content: version.content, variables: (version.variables as Record<string, unknown> | null) ?? null };
        }
      }
      return { content: source.content ?? '', variables: (source.variables as Record<string, unknown> | null) ?? null };
    });

    return runInTenantContext(this.clsService, targetTenantId, async () => {
      const byProvenance = await this.promptTemplateRepository.findByTenantAndSourceTemplateId(targetTenantId, source.id);
      if (byProvenance) {
        return { templateId: byProvenance.id, created: false, approvedVersionNumber: byProvenance.approvedVersionNumber ?? null };
      }
      const byName = source.name ? await this.promptTemplateRepository.findByName(targetTenantId, source.name) : null;
      if (byName) {
        return { templateId: byName.id, created: false, approvedVersionNumber: byName.approvedVersionNumber ?? null };
      }

      const approvedVersionNumber = source.status === 'APPROVED' ? 1 : null;
      const template = PromptTemplateFactory.CreatePromptTemplate({
        tenantId: targetTenantId,
        name: source.name ?? null,
        description: source.description ?? null,
        content: snapshot.content,
        category: source.category ?? null,
        status: source.status ?? 'DRAFT',
        variables: snapshot.variables,
        currentVersionNumber: 1,
        approvedVersionNumber,
        sourceTemplateId: source.id,
        templateLocked: true,
        // A DEPARTMENT_DEFAULT binding cannot cross a tenant boundary (the department ids
        // differ), so the reference set carries TENANT_DEFAULT rows and the clone says so.
        departmentId: null,
        scope: 'TENANT_DEFAULT',
        ownerUserId: null,
        tags: source.tags ?? [],
        createdBy: this.requestUserId ?? null,
      });
      const saved = await this.promptTemplateRepository.create(template);

      const version = PromptVersionFactory.CreatePromptVersion({
        tenantId: targetTenantId,
        promptTemplateId: saved.id,
        versionNumber: 1,
        content: snapshot.content,
        variables: snapshot.variables,
        changeReason: 'Provisioned from the platform reference set',
        changedBy: this.requestUserId ?? null,
      });
      await this.promptVersionRepository.create(version);

      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        data: { action: 'reference-set-clone', name: saved.name, sourceTemplateId: source.id, targetTenantId },
      });
      return { templateId: saved.id, created: true, approvedVersionNumber };
    });
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
      variables: (dto.variables as unknown as Record<string, unknown>) ?? null,
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
      variables: (dto.variables as unknown as Record<string, unknown>) ?? null,
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

    // Capture the pre-edit publication status BEFORE any dto.status change below,
    // so we can flag a live content edit of an already-APPROVED template for
    // audit (F-33). The new PromptVersion this edit creates is NOT served until
    // re-approval (resolution serves `approvedVersionNumber`, not latest).
    const wasApprovedLiveEdit = template.status === 'APPROVED' && dto.content !== undefined;

    const hasContentChanges =
      dto.name !== undefined || dto.description !== undefined || dto.content !== undefined || dto.variables !== undefined || dto.tags !== undefined;

    if (hasContentChanges) {
      if (dto.name !== undefined) template.name = dto.name;
      if (dto.description !== undefined) template.description = dto.description;
      if (dto.content !== undefined) template.content = dto.content;
      if (dto.variables !== undefined) template.variables = dto.variables as unknown as Record<string, unknown>;
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
          variables: (dto.variables as unknown as Record<string, unknown> | undefined) ?? template.variables,
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
        // Live content edit of an APPROVED template — downstream audit consumers
        // can distinguish this from routine DRAFT edits. The edit is NOT served
        // until re-approval (the eval gate re-runs then).
        ...(wasApprovedLiveEdit ? { wasApprovedLiveEdit: true, status: updated.status } : {}),
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
   * Authorization is split by ownership :
   * - **SYSTEM/library** template (tenantId = SYSTEM) — the shared library is
   *   globally visible, so approval is a SUPER_ADMIN-only PRIVILEGE (403, not
   *   404: existence is not hidden for the shared library).
   * - **Tenant-owned** template (tenantId ≠ SYSTEM) — a caller holding
   *   `manage:PromptTemplate` for that tenant (or a super admin) may approve.
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

    // OD-3 eval promotion gate: if a department agent bound to this template
    // references a golden set, run the eval BEFORE promoting. In block-mode a
    // failing eval rejects the approval (409 + score payload); the template stays
    // in its current status. The EvalRun is persisted (triggerType=PROMOTION)
    // either way. No golden set ⇒ approve proceeds with a recorded warning.
    if (this.promotionGate) {
      const verdict = await this.promotionGate.evaluatePromotion({
        tenantId: template.tenantId,
        promptTemplateId: id,
        trigger: 'approve',
      });
      if (verdict.blocked) {
        throw new ConflictException({
          message: 'Eval gate failed — template promotion blocked.',
          reason: 'EVAL_GATE_FAILED',
          failures: verdict.failures,
          runIds: verdict.runIds,
          aggregates: verdict.aggregates,
        });
      }
    }

    template.status = 'APPROVED';
    const previousVersion = template.version;
    const userId = this.requestUserId;

    // Approval BLESSES an existing snapshot; it does not author a new one.
    // `updatePromptTemplate` already persisted a PromptVersion for the edit that
    // is being approved, so minting another here produced a duplicate-content
    // version on every approve (edit -> v2, approve -> v3 pinned). Only when the
    // template has no history at all — or its live content has drifted from the
    // latest snapshot — is a new version authored, so the approved content is
    // always represented by exactly one row.
    const latestVersion = await this.promptVersionRepository.findLatestVersion(id);
    const latestMatchesLiveContent =
      latestVersion != null &&
      (latestVersion.content ?? '') === (template.content ?? '') &&
      JSON.stringify(latestVersion.variables ?? null) === JSON.stringify(template.variables ?? null);

    const updated = await this.databaseService.baseClient.$transaction(async (tx) => {
      let approvedVersionNumber: number;
      if (latestMatchesLiveContent) {
        approvedVersionNumber = latestVersion!.versionNumber;
      } else {
        const maxVersionNumber = await this.promptVersionRepository.findMaxVersionNumber(id, tx);
        approvedVersionNumber = maxVersionNumber + 1;
        const version = PromptVersionFactory.CreatePromptVersion({
          tenantId: template.tenantId,
          promptTemplateId: id,
          versionNumber: approvedVersionNumber,
          content: template.content,
          variables: template.variables,
          changeReason: dto.reason ?? 'Approved for clinical use',
          changedBy: userId ?? null,
        });
        await this.promptVersionRepository.create(version, tx);
      }
      // Eval-gate integrity (F-02): pin the version snapshot THIS approval
      // blesses. Resolution serves `approvedVersionNumber` for unpinned agents
      // and the preferred/legacy/default tiers, so a later plain content edit
      // (updatePromptTemplate) accumulates un-served versions until the next
      // (eval-gated) re-approval — the eval gate can no longer be bypassed by
      // editing content on an already-APPROVED template. Set inside the tx so it
      // commits or rolls back atomically with the version-pin + OCC CAS.
      template.approvedVersionNumber = approvedVersionNumber;
      return this.promptTemplateRepository.updateWithVersion(id, template, dto.expectedVersion, tx);
    });

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: {
        action: 'approve',
        status: 'APPROVED',
        previousVersion,
        newVersion: updated.version,
        approvedVersionNumber: updated.approvedVersionNumber ?? null,
        reason: dto.reason ?? null,
      },
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
    if (template.scope === SCOPE_USER_PERSONAL && template.ownerUserId !== this.requestUserId && !this.callerCanManageTemplates()) {
      return null;
    }
    return PromptManagementDtoMapper.toTemplateResponse(template);
  }

  /**
   * THE EXPLICIT `tenantId` PIN ON EVERY LIST/COUNT READ IN THIS
   * SERVICE IS LOAD-BEARING, NOT REDUNDANT.
   *
   * `PromptTemplate` / `PromptVersion` joined `SYSTEM_SHARED_READ_MODELS`
   * (packages/database/src/extensions/tenant-scope.ts) so the SYSTEM-owned
   * platform defaults — the pre-summary tier-2 fallback and the live default —
   * are resolvable from a tenant's own CLS. That widening injects
   * `tenantId IN [caller, SYSTEM]` into a read that supplies NO tenantId, which
   * would make the 13 SYSTEM golden templates and the platform defaults appear
   * inside tenant template pickers.
   *
   * `mergeSharedReadTenantIntoWhere` leaves an explicitly-supplied caller
   * `tenantId` untouched, so pinning it keeps these list surfaces byte-identical
   * to their pre-widening contents. Any NEW list/count read added here must pin
   * it too; only BY-ID reads (resolution, assertTemplateBindable, version
   * fetches) are meant to see SYSTEM rows.
   */
  async listPromptTemplates(filters?: ListPromptTemplatesFilters): Promise<PromptTemplateResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');

    const qb = this.promptTemplateRepository.$();
    // B-12: explicit caller-tenant pin — see the note above. Do not remove.
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
    // Tag narrowing — `hasEvery`, so several tags intersect (see the filter type).
    if (filters?.tags?.length) qb.Where({ tags: { hasEvery: filters.tags } });
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

    // B-12: explicit caller-tenant pin — see the note on `listPromptTemplates`.
    const where: Record<string, unknown> = { tenantId };
    if (!filters?.includeDisabled) where.resourceStatus = ResourceStatusType.ENABLED;
    if (filters?.category) where.category = filters.category;
    if (filters?.status) where.status = filters.status;
    if (filters?.departmentId) where.departmentId = filters.departmentId;
    // Admin scope/owner narrowing folded into the paginated where.
    if (filters?.scope) where.scope = filters.scope;
    if (filters?.ownerUserId) where.ownerUserId = filters.ownerUserId;
    // Tag narrowing — `hasEvery`, so several tags intersect (see the filter type).
    if (filters?.tags?.length) where.tags = { hasEvery: filters.tags };
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
   *   AND ( ( scope = TENANT_DEFAULT AND status != DRAFT)
   *         OR ( scope = DEPARTMENT_DEFAULT AND status != DRAFT)
   *         OR ( scope = USER_PERSONAL AND ownerUserId = caller))
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

  /**
   * F-07: assert the template exists (and, for a non-super-admin, is owned
   * by the caller's tenant) before returning its version history — mirrors
   * {@link diffVersions}. Without this a bogus or cross-tenant template id
   * was indistinguishable from a real template with zero versions.
   */
  async getVersions(templateId: string): Promise<PromptVersionResponse[]> {
    const template = await this.promptTemplateRepository.findById(templateId);
    if (!template) throw new NotFoundException(`Prompt template ${templateId} not found`);
    this.assertOwnedByTenant(template, templateId);

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
   *   - `fields[]` — per-field (`content`, `variables`) line diffs, each
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

    const [from, to] = await Promise.all([this.getVersion(templateId, fromVersion), this.getVersion(templateId, toVersion)]);
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

  /**
   * F-07: assert the template exists (and, for a non-super-admin, is owned
   * by the caller's tenant) before returning its usage stats — same
   * no-existence-leak rationale as {@link getVersions}.
   */
  async getUsageStats(templateId: string): Promise<{ totalUsages: number; lastUsedAt: string | null }> {
    const template = await this.promptTemplateRepository.findById(templateId);
    if (!template) throw new NotFoundException(`Prompt template ${templateId} not found`);
    this.assertOwnedByTenant(template, templateId);

    const records = await this.promptUsageRecordRepository.findByTemplate(templateId);
    const totalUsages = records.length;
    const lastUsedAt = totalUsages > 0 ? (records[0].createdAt?.toISOString() ?? null) : null;
    return { totalUsages, lastUsedAt };
  }

  /**
   * BUG-018 — SUBMIT a prompt-template test run. Returns an ACK in well under a
   * second; it never awaits the generation.
   *
   * Everything up to (and including) prompt assembly is unchanged: the
   * `sampleInput`/`goldenCaseId` mutual exclusion, the 404-over-403 template
   * guards, and the optional pinned `PromptVersion` snapshot. Prompt assembly
   * itself now renders through the ONE `{{ path | default() }}` grammar
   * (`renderTemplate`, `@arcaai/workflow-contract` — TASK-890 §3.2), not the
   * old `{{var}}`-flat-key brace-trap pass.
   *
   * What changed:
   *  - `dto.dryRun` short-circuits BEFORE any TEXT call — a dry run used to burn
   *    a real 2-minute generation just to discard the write.
   *  - Otherwise the tenant's `monthlyLlmTokens` quota is asserted (OD-E — every
   *    inference activity counts, including a prompt-bench run) and a STREAMING
   *    job is submitted (`stream: true`); the caller opens the returned
   *    `streamUrl` over SSE and then calls {@link finalizePromptTemplateTest} to
   *    score, meter and persist.
   *  - The outgoing body carries the tenant's BYO credentials + runtime profile
   *    via the shared `TextRequestEnrichmentService`, and the request carries
   *    `X-Tenant-Id`, so the run is tenant-funded and attributable.
   *  - Model selection is the tenant's ASSIGNED TEXT_GENERATION agent, the same
   *    resolution every real generation makes; the harness policy service is gone
   *    from this path entirely.
   *
   * @throws ArgumentInvalidException — both `sampleInput` and `goldenCaseId`
   *   supplied, a caller-supplied provider/model pair is partial/unknown, a
   *   required declared variable was not supplied (and declares no default),
   *   or the template has a grammar syntax error.
   * @throws NotFoundException — unknown/cross-tenant template, missing
   *   `versionNumber`, or unknown/cross-tenant `goldenCaseId` (404-over-403).
   * @throws BadRequestException — no TEXT_GENERATION agent is assigned (fail-closed).
   */
  async startPromptTemplateTest(id: string, dto: TestPromptTemplateRequest): Promise<PromptTestAckResponse> {
    if (dto.sampleInput !== undefined && dto.goldenCaseId !== undefined) {
      throw new ArgumentInvalidException('Provide either sampleInput or goldenCaseId, not both.');
    }

    const template = await this.promptTemplateRepository.findById(id);
    if (!template) throw new NotFoundException(`Prompt template ${id} not found`);

    this.assertOwnedByTenant(template, id);
    this.assertCanMutate(template);

    // B2 — an immutable PromptVersion snapshot instead of the mutable draft
    // when `versionNumber` is supplied. Variable declarations follow the
    // version's own `variables` when present, else the template's.
    let content = template.content ?? '';
    let declaredVariables = template.variables as Record<string, unknown> | null;
    if (dto.versionNumber !== undefined) {
      const version = await this.promptVersionRepository.findByVersionNumber(id, dto.versionNumber);
      if (!version) {
        throw new NotFoundException(`Prompt version ${dto.versionNumber} not found for template ${id}`);
      }
      content = version.content ?? '';
      declaredVariables = (version.variables as Record<string, unknown> | null) ?? declaredVariables;
    }

    // B3 — a golden case's decrypted transcript stands in for free-text
    // sampleInput. Decrypted plaintext lives only for this request's
    // lifetime — never persisted or logged.
    const sampleInput = dto.goldenCaseId ? await this.loadGoldenCaseSampleInput(dto.goldenCaseId) : dto.sampleInput;

    const prompt = this.renderTestPrompt(content, dto.variables, sampleInput, declaredVariables, id);
    const { provider, model } = await this.resolveTestTextTarget({ provider: dto.provider, model: dto.model, modelId: dto.modelId });

    // Defect 4 — a dry run generates NOTHING. The author gets the exact prompt
    // that would have been sent; no job, no tokens, no cost.
    if (dto.dryRun) {
      return { mode: 'dry-run', provider, model, assembledPrompt: prompt };
    }

    // TASK-890 §3.13 (OD-E) — a prompt-bench run is a production inference
    // activity like any other; it must count against the tenant's quota
    // BEFORE the upstream call, not just get recorded afterward.
    const tenantId = this.tenantId;
    if (tenantId) {
      await this.entitlements?.assertMeterQuota(tenantId, 'monthlyLlmTokens');
    }

    const { taskId, streamUrl } = await this.submitTextGenerationJob(prompt, provider, model);
    return { mode: 'stream', provider, model, assembledPrompt: prompt, taskId, streamUrl };
  }

  /**
   * BUG-018 — FINALIZE a test run started by {@link startPromptTemplateTest}.
   *
   * The finished text is read from TEXT SERVER-SIDE (`GET /api/v1/tasks/:id`,
   * whose `content` field holds the accumulated stream). It is deliberately NOT
   * accepted from the request body: the browser saw the same tokens over SSE,
   * but trusting it would let any caller forge `lastTestOutput` on the row.
   *
   * Scoring (`scoreOutput`) and persistence (encrypt → `updateWithVersion` →
   * `ResourceUpdated`) are unchanged from the old blocking implementation.
   *
   * @throws NotFoundException — unknown/cross-tenant template, or an unknown
   *   `taskId` (404 from TEXT).
   * @throws BadRequestException — the task has not reached a terminal completed
   *   state (the offending state is named).
   * @throws OptimisticConcurrencyException — version drift; HTTP 412.
   */
  async finalizePromptTemplateTest(id: string, dto: FinalizePromptTestRequest): Promise<PromptTestResultResponse> {
    const template = await this.promptTemplateRepository.findById(id);
    if (!template) throw new NotFoundException(`Prompt template ${id} not found`);

    this.assertOwnedByTenant(template, id);
    this.assertCanMutate(template);

    // Score against the SNAPSHOT THAT WAS TESTED. A run started with
    // `versionNumber` ran the immutable PromptVersion's content, and the score
    // dimensions (`jsonExpected` from the content, `variableCoverage` from the
    // declared variables) are properties of what ran — not of whatever the
    // mutable draft happens to say by the time the stream finishes.
    let scoredContent = template.content;
    let scoredVariables = template.variables as Record<string, unknown> | null;
    if (dto.versionNumber !== undefined) {
      const version = await this.promptVersionRepository.findByVersionNumber(id, dto.versionNumber);
      if (!version) {
        throw new NotFoundException(`Prompt version ${dto.versionNumber} not found for template ${id}`);
      }
      scoredContent = version.content ?? '';
      scoredVariables = (version.variables as Record<string, unknown> | null) ?? scoredVariables;
    }

    const taskOutput = await this.fetchTextTaskOutput(dto.taskId);
    const output = taskOutput.content;
    const { score, metrics } = this.scoreOutput(output, {
      category: template.category,
      content: scoredContent,
      variables: scoredVariables,
    });
    const testedAt = new Date();

    template.lastTestScore = score;
    template.lastTestOutput = output;
    template.lastTestAt = testedAt;

    // Encrypt the free-text test output into the ciphertext
    // column before the CAS persist (dual-write; plaintext retained for soak).
    await this.encryptBestEffort('PromptTemplate', () => this.promptTemplateRepository.encryptFieldsIntoEntity(template, this.secretsService!));

    // Compare-And-Set against the row `_version` (mirrors updatePromptTemplate).
    const updated = await this.promptTemplateRepository.updateWithVersion(id, template, dto.expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'test', score },
    });

    // TASK-890 §3.13 (OD-E) — record what this run actually cost, AFTER the
    // write it never blocks (see `recordPromptTestUsage`'s degradation note).
    await this.recordPromptTestUsage(taskOutput, dto.taskId);

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
  async listUsageRecords(filters?: { page?: number; limit?: number; promptTemplateId?: string }): Promise<Paginated<PromptUsageRecordResponse>> {
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
   * Render a template's content against the ONE `{{ path | default() }}`
   * grammar (`renderTemplate`, `@arcaai/workflow-contract` — TASK-890 §3.2),
   * then append any free-text `sampleInput` VERBATIM (never re-interpreted —
   * "values are data", the same rule the deleted single-brace substituter
   * enforced). Replaces the retired `{{var}}`-flat-key brace-trap pass
   * (flavour 3, §2.4) and its single-brace v1 fallback outright: a template
   * still carrying `{single_brace}` tokens renders them LITERALLY now (§3.2
   * rule "a single brace is literal") rather than silently substituting them.
   *
   * `declaredVariables` — the template's/version's typed declarations — are
   * validated FIRST (required-with-no-default is a 400 before any TEXT call
   * ever happens) and become the render SCOPE's bare-name roots, overlaid by
   * the caller-supplied `variables` (caller wins — §3.3 "bare name" row).
   *
   * @throws ArgumentInvalidException — a required declared variable was not
   *   supplied and declares no default, an undeclared `{{path}}` reference in
   *   the content did not resolve (no `default(...)`), or the content has a
   *   grammar syntax error.
   */
  private renderTestPrompt(
    content: string,
    variables: Record<string, unknown> | undefined,
    sampleInput: string | undefined,
    declaredVariables: Record<string, unknown> | null | undefined,
    templateRef: string,
  ): string {
    const scope = this.resolveTestVariableScope(parsePromptVariableDeclarations(declaredVariables), variables);

    let prompt: string;
    try {
      prompt = renderTemplate(content, scope, { templateRef });
    } catch (renderProblem) {
      // Build OUR OWN message from the named error's structured fields (a
      // dotted path, a numeric offset) — never the renderer's own `.message`
      // text verbatim; the same discipline the downstream-error boundary
      // applies to a caught network error, applied here to a caught local one.
      if (renderProblem instanceof PromptVariableUnresolvedError) {
        const unresolvedPath = renderProblem.path;
        throw new ArgumentInvalidException(
          `Prompt variable \`${unresolvedPath}\` did not resolve for this test run and declares no default(...). Supply it in \`variables\` or add a \`default(...)\` in the template.`,
        );
      }
      if (renderProblem instanceof PromptTemplateSyntaxError) {
        const syntaxOffset = renderProblem.offset;
        throw new ArgumentInvalidException(`Prompt template has a syntax error at offset ${syntaxOffset}.`);
      }
      throw renderProblem;
    }

    if (sampleInput) {
      prompt = `${prompt}\n\n${sampleInput}`;
    }
    return prompt;
  }

  /**
   * Build the `renderTemplate` scope from the declared variables + the
   * caller's sample values: required-with-no-default-and-not-supplied fails
   * closed HERE (before any TEXT call), everything else is coerced to its
   * declared `type` (declared default applied when the caller supplied
   * nothing). Undeclared caller-supplied keys pass through unchanged — the
   * template may reference them ad hoc.
   */
  private resolveTestVariableScope(declarations: PromptVariableDeclarationDto[], variables?: Record<string, unknown>): Record<string, unknown> {
    const scope: Record<string, unknown> = { ...(variables ?? {}) };
    for (const decl of declarations) {
      const supplied = scope[decl.name];
      if (supplied !== undefined && supplied !== null) {
        scope[decl.name] = coercePromptVariableValue(decl.type, supplied);
        continue;
      }
      if (decl.default !== undefined) {
        scope[decl.name] = coercePromptVariableValue(decl.type, decl.default);
        continue;
      }
      if (decl.required) {
        throw new ArgumentInvalidException(`Missing required variable \`${decl.name}\` for this test run.`);
      }
      // Optional, no default, not supplied: leave it unset so a reference to
      // it in the content fails observably at render time (a named
      // PromptVariableUnresolvedError) rather than silently as "undefined".
    }
    return scope;
  }

  /**
   * Resolve the `{provider, model}` a test run sends to TEXT.
   *
   * Precedence:
   *  1. TASK-890 §3.7 — `override.modelId` (a tenant-catalogue `AiModel` row
   *     id, the console picker). The row's `provider` + `wireModelId` (falling
   *     back to `sourceUri` for a not-yet-backfilled row) are resolved
   *     SERVER-SIDE and forwarded to TEXT — the browser never sees the wire
   *     identifier the catalogue DTO deliberately omits.
   *  2. Caller-supplied pair (`override.provider` + `override.model`, both
   *     required together) — forwarded VERBATIM (mirrors
   *     `applyTextModelSelection`'s "caller-pinned model wins" semantics),
   *     after validating it against the ENABLED AiModel registry.
   *  3. TASK-876 — the tenant's ASSIGNED TEXT_GENERATION agent
   *     (`department → tenant → SYSTEM`), through the SAME
   *     `TextAgentResolverService` every real generation uses. It used to be the
   *     `text.test` `AiTaskDefault` key, which is a RETIRED selection surface:
   *     testing a template against a model no consultation would ever run is a
   *     test of nothing, and `AgentAssignment` carries no role dimension for a
   *     task key to select on in the first place.
   *
   * Fail-closed and MISS-vs-ERROR split (the old bare `catch {}` conflated
   * them): nothing assigned ⇒ a `BadRequestException` saying so, never a
   * substituted platform model; a thrown lookup ⇒ logged and RETHROWN, never
   * disguised as "unconfigured".
   *
   * @throws ArgumentInvalidException — `modelId` combined with `provider`/`model`,
   *   only one of provider/model supplied, the supplied pair does not match an
   *   ENABLED registry row, or `modelId` names an unknown/disabled/cross-tenant row
   *   (404-over-403 — a foreign id reads as "unknown", never leaking existence).
   * @throws BadRequestException — no TEXT_GENERATION agent is assigned at any tier.
   */
  private async resolveTestTextTarget(override: {
    provider?: string;
    model?: string;
    modelId?: string;
  }): Promise<{ provider: string; model: string }> {
    if (override.modelId !== undefined) {
      if (override.provider !== undefined || override.model !== undefined) {
        throw new ArgumentInvalidException('modelId is mutually exclusive with provider/model.');
      }
      return this.resolveTextTargetFromModelId(override.modelId);
    }

    if (override.provider !== undefined || override.model !== undefined) {
      if (!override.provider || !override.model) {
        throw new ArgumentInvalidException('provider and model must be supplied together.');
      }
      await this.assertKnownTextModel(override.provider, override.model);
      return { provider: override.provider, model: override.model };
    }

    if (!this.textAgents) {
      throw new BadRequestException('A prompt test cannot resolve its model: the TEXT_GENERATION agent resolver is not wired in this composition.');
    }
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');

    try {
      // The SAME resolution every real generation makes. The candidate already carries the
      // provider as apps/text registers it (`azure` → `azure-openai`) and the provider-native
      // model id, so no mapping is re-done here.
      const spec = await this.textAgents.resolve({ tenantId });
      return { provider: spec.primary.provider, model: spec.primary.model };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new BadRequestException(
          'No TEXT_GENERATION agent is assigned for this tenant, so a prompt test has nothing to run on. ' +
            'Assign a published TEXT_GENERATION agent at TENANT or DEPARTMENT scope, or restore the SYSTEM platform default assignment.',
        );
      }
      // An ERROR is not a MISS. Surface it: silently falling through would
      // reintroduce exactly the "silently ran on the platform model" defect.
      this.logger.warn({
        message: 'Failed to resolve the assigned TEXT_GENERATION agent for a prompt-template test run',
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * TASK-890 §3.7 — resolve the wire `{provider, model}` from a tenant
   * catalogue `AiModel` row id. `AiModel` is shared-read (tenant row OR the
   * SYSTEM "Hope provider" row resolve transparently through `findById`), so
   * this serves both a tenant's BYO row and a platform-served one identically.
   * `wireModelId` is the ROUTED id (§3.1); `sourceUri` is the fallback for a
   * row the backfill migration has not reached.
   *
   * @throws NotFoundException — unknown id (404-over-403: a cross-tenant BYO
   *   row's id is indistinguishable from an unknown one at this read).
   * @throws ArgumentInvalidException — the row is disabled, or carries neither
   *   a `wireModelId` nor a `sourceUri` to route on.
   */
  private async resolveTextTargetFromModelId(modelId: string): Promise<{ provider: string; model: string }> {
    if (!this.aiModelRepository) {
      throw new BadRequestException('The model catalogue is not configured; supply provider/model explicitly.');
    }
    const row = await this.aiModelRepository.findById(modelId);
    if (!row || row.resourceStatus !== ResourceStatusType.ENABLED) {
      throw new NotFoundException(`Model ${modelId} not found`);
    }
    const wireModel = row.wireModelId || row.sourceUri;
    if (!row.provider || !wireModel) {
      throw new ArgumentInvalidException(`Model ${modelId} has no routable provider/model — it cannot serve a test run.`);
    }
    return { provider: row.provider, model: wireModel };
  }

  /**
   * Validate a caller-supplied `{provider, model}` pair against the ENABLED
   * `AiModel` registry (TEXT_GENERATION/SUMMARIZATION rows — the same source
   * `GET /text/providers` reads). Best-effort: without a wired
   * `AiModelRepository` the pair passes through unchecked rather than
   * blocking the test run.
   */
  private async assertKnownTextModel(provider: string, model: string): Promise<void> {
    if (!this.aiModelRepository) return;
    const [textGeneration, summarization] = await Promise.all([
      this.aiModelRepository.findByTaskTypeSharedRead(ModelTaskType.TEXT_GENERATION),
      this.aiModelRepository.findByTaskTypeSharedRead(ModelTaskType.SUMMARIZATION),
    ]);
    const known = [...textGeneration, ...summarization].some((row) => row.provider === provider && row.sourceUri === model);
    if (!known) {
      throw new ArgumentInvalidException(`Unknown or disabled provider/model pair: ${provider}/${model}`);
    }
  }

  /**
   * Load a golden case's decrypted transcript as
   * predefined test-run sample input. Tenant-scoped: a missing OR
   * cross-tenant id is 404 (404-over-403 — "not yours" is indistinguishable
   * from "missing"). The decrypted plaintext is returned to the caller for
   * this request only; it is never persisted or logged.
   */
  private async loadGoldenCaseSampleInput(goldenCaseId: string): Promise<string> {
    if (!this.goldenCaseRepository) {
      throw new BadRequestException('Golden-case lookup is not configured');
    }
    const goldenCase = await this.goldenCaseRepository.findById(goldenCaseId);
    if (!goldenCase || (this.tenantId && goldenCase.tenantId !== this.tenantId)) {
      throw new NotFoundException(`Golden case ${goldenCaseId} not found`);
    }
    const plaintext = this.secretsService
      ? await this.goldenCaseRepository.decryptFieldsFromEntity(goldenCase, this.secretsService)
      : { transcript: null, referenceNote: null };
    return plaintext.transcript ?? '';
  }

  /**
   * BUG-018 — SUBMIT a STREAMING generation job to TEXT and return its ack.
   *
   * Replaces the old blocking `stream: false` POST (2–3½ minutes, CDN 524) and
   * the direct-to-TEXT bypass that lost tenant credentials and metering:
   *  - the body goes through the SHARED `TextRequestEnrichmentService` — the same
   *    code path `TextProxyController` uses — so the tenant's BYO credential
   *    (`provider_overrides`, carrying its `funding` label) and the resolved
   *    hyperparameter profile ride along;
   *  - `X-Tenant-Id` is sent alongside `X-Service-Token`, so TEXT no longer logs
   *    `tenant_id: null` and the usage ledger can attribute the run.
   *
   * The generation itself is consumed by the caller over SSE
   * (`GET text/tasks/:taskId/stream`, which is where the ledger row is emitted)
   * and then finalized through {@link finalizePromptTemplateTest}.
   *
   * the SINGLE-CALL contract. TEXT no longer answers a
   * streaming `POST /generate` with `202 {task_id, stream_url}`; it answers
   * **200 + `text/event-stream`**, with the id in the first frame's `data`.
   * There is therefore no ack body to read: we open the stream, take the id off
   * the meta frame, and drop our subscription.
   *
   * Dropping it is NOT a cancel — the producer is owned by TEXT's hub,
   * not by this response — so nothing is lost between here and the browser's own
   * subscription: it replays from seq 0 out of the replay buffer. This service
   * still holds no stream state, which is what keeps the id round-trip honest.
   */
  private async submitTextGenerationJob(prompt: string, provider: string, model: string): Promise<{ taskId: string; streamUrl: string }> {
    if (!this.httpService) {
      throw new BadRequestException('TEXT/text-generation client is not configured');
    }
    const body: Record<string, unknown> = { prompt, stream: true, provider, model };
    if (this.textRequestEnrichment) {
      await this.textRequestEnrichment.applyTextRuntimeProfile(body as { provider?: string; model?: string });
      await this.textRequestEnrichment.applyTenantProviderOverrides(body as { provider?: string });
      // TASK-890 §3.14 — a prompt bench run is ALWAYS screened. There is no node and no agent
      // here, so there is no opinion to inherit: `resolveGuardrailDecision` would answer its
      // `default` (ON) for every input, and stating it explicitly is what lets TEXT tell
      // "screened by a decision" from "no opinion" and lets the ledger record `screened`.
      // A tenant cannot opt a bench run out; the only thing that can turn this off is the
      // PLATFORM kill switch, which stays the floor inside `apps/text`.
      this.textRequestEnrichment.applyGuardrailDecision(body, { enabled: true });
    }

    let taskId: string;
    try {
      const response = await this.httpService.axiosRef.post(`${this.textServiceUrl}/api/v1/generate`, body, {
        headers: { ...(await this.textHeaders()), Accept: 'text/event-stream' },
        responseType: 'stream',
      });
      taskId = await readGenerationId(response.data as Readable);
    } catch (error) {
      // was `BadRequestException(\`Failed to call TEXT service: ${error}\`)`.
      // That is the exact body the evidence captured — a 400 naming
      // `connect ECONNREFUSED 127.0.0.1:8862`. Rethrow the cause; the gateway
      // boundary (`downstream-error.ts` via `ExceptionInterceptor`) owns the
      // status and the client-facing message.
      this.logger.error({
        message: 'TEXT generation-job submission failed; rethrowing the cause for the gateway boundary to classify',
        causeMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // Gateway-relative SSE path (`TextProxyController` mounts `text/*`), never a
    // service-relative one — the browser talks to the gateway, with a
    // `text_task:<taskId>`-scoped single-use ticket. TEXT used to report its own
    // `stream_url` in the 202 ack; under there is no ack, so
    // this path is composed here from the id and nowhere else.
    return { taskId, streamUrl: `text/tasks/${taskId}/stream` };
  }

  /**
   * BUG-018 — read the FINISHED generation for `taskId` from TEXT
   * (`GET /api/v1/tasks/:id`; `content` holds the accumulated stream text).
   *
   * Server-side on purpose: the client must never be the source of the text
   * that gets persisted as `lastTestOutput`.
   *
   * Also carries `provider`/`model`/token counts (TASK-890 §3.13, OD-E) —
   * `TaskResponse` (`apps/text/src/text/models/responses.py`) has no full
   * `TextUsageDetail` block on this REST read (no `endpoint_kind`, no `byok`),
   * only `{provider, model, usage: {prompt_tokens, completion_tokens}}`. That
   * is exactly the "bare token counts, no real usage detail" shape
   * `buildLlmUsageInputFromTokenCounts` (`text-usage.ts`) exists for — the
   * honest builder that never fabricates an `endpointKind` it did not see.
   */
  private async fetchTextTaskOutput(taskId: string): Promise<{
    content: string;
    provider: string | null;
    model: string | null;
    promptTokens: number;
    completionTokens: number;
    usageDetail: unknown;
  }> {
    if (!this.httpService) {
      throw new BadRequestException('TEXT/text-generation client is not configured');
    }

    let data: {
      status?: string;
      content?: string | null;
      error?: string | null;
      provider?: string | null;
      model?: string | null;
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      // J3-4 — TEXT persists its own meterable block with the task now, so the bench can bill
      // the same dimensions a real generation does instead of bare counts.
      usage_detail?: unknown;
    };
    try {
      const response = await this.httpService.axiosRef.get(`${this.textServiceUrl}/api/v1/tasks/${taskId}`, {
        headers: await this.textHeaders(),
      });
      data = response.data ?? {};
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        throw new NotFoundException(`Generation task ${taskId} not found`);
      }
      // as above. The 404 branch stays: that is a considered mapping
      // of an upstream status, not a composed cause string.
      this.logger.error({
        message: 'TEXT task-output read failed; rethrowing the cause for the gateway boundary to classify',
        causeMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const state = data.status ?? 'unknown';
    if (state !== TEXT_TASK_COMPLETED) {
      throw new BadRequestException(`Generation task ${taskId} is not complete (state: ${state}). Wait for the stream to finish before finalizing.`);
    }
    return {
      content: data.content ?? '',
      provider: data.provider ?? null,
      model: data.model ?? null,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      usageDetail: data.usage_detail ?? null,
    };
  }

  /**
   * Best-effort ledger record for a finalized prompt-bench run (TASK-890
   * §3.13, OD-E). Mirrors `ContextService#persistSummaryMetaWithUsage`'s
   * degradation: a metering failure is logged and swallowed, never allowed to
   * fail the (already-committed) test-result write. `null` when the ledger is
   * not wired, the tenant is unknown, or the task reported zero tokens (no
   * counters to bill — no row is more honest than a zero-value one).
   */
  private async recordPromptTestUsage(
    taskOutput: { provider: string | null; model: string | null; promptTokens: number; completionTokens: number; usageDetail: unknown },
    taskId: string,
  ): Promise<void> {
    if (!this.usageLedgerService) return;
    const tenantId = this.tenantId;
    if (!tenantId) return;

    try {
      // J3-4 — PREFER TEXT's own block. It is the only source that carries a real
      // `endpoint_kind`, `byok` and `cost_basis`, so it is the only one that produces a
      // fully-dimensioned row; `apps/text` persists it with the task since this lane.
      const detail = parseTextUsageDetail(taskOutput.usageDetail);
      const provider = taskOutput.provider ? toLedgerProvider(taskOutput.provider) : 'none';
      const raw =
        (detail ? buildLlmUsageInput({ usage: detail, tenantId, operation: 'generate.stream' }) : null) ??
        buildLlmUsageInputFromTokenCounts({
          tenantId,
          operation: 'generate.stream',
          requestId: taskId,
          provider,
          model: taskOutput.model,
          // DERIVED, not stamped. This used to be a constant `CLOUD`, which put every local
          // `lm-studio` bench run in the cloud rollup bucket and under-reported self-hosted.
          deployment: resolveDeployment(provider, false),
          occurredAt: new Date(),
          inputTokens: taskOutput.promptTokens,
          outputTokens: taskOutput.completionTokens,
        });
      if (!raw) {
        // Never a row saying "an unknown amount happened" — but never silent either: an
        // unexplained absence is how the draft-agent bench stayed unmetered to the release phase.
        this.logger.warn({
          message: 'A prompt-template test-run finalize was persisted unmetered: the TEXT task read-back carried no billable usage',
          taskId,
        });
        return;
      }
      await this.usageLedgerService.recordUsage(withUsageTrigger(raw, 'PROMPT_TEST'));
    } catch (error) {
      this.logger.warn({
        message: 'Usage metering failed for a prompt-template test-run finalize; the test result was persisted unmetered',
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * D-D: the ONE shared `INTERNAL_ACCESS_TOKEN` (the per-service `TEXT_SERVICE_TOKEN`
   * fallback was retired with its descriptor, TASK-888). `X-Tenant-Id` is no longer CONDITIONAL.
   *
   * The old `if (tenantId) headers['X-Tenant-Id'] = tenantId` was the narrower
   * half of the audit's Class-B finding: this bench has a legitimate no-tenant
   * caller (a SUPER_ADMIN driving it with no working tenant selected), and the
   * conditional made that case indistinguishable from a header dropped in
   * transit. It now DECLARES itself instead — `tenantless:platform-operator` —
   * which is what lets `apps/text` treat an ABSENT header as an unambiguous
   * caller defect and refuse it with 428.
   */
  private async textHeaders(): Promise<Record<string, string>> {
    const serviceToken = await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN');
    return internalServiceHeaders({
      serviceToken,
      tenantId: this.tenantId,
      tenantlessReason: TENANTLESS.PLATFORM_OPERATOR,
    });
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
   * globally visible and stay SUPER_ADMIN-only (privilege → 403, existence not
   * hidden). Tenant-owned templates hide cross-tenant existence (404) and then
   * require `manage:PromptTemplate` for that tenant (or a super admin).
   */
  private assertCanApprove(template: PromptTemplateEntity, id: string): void {
    if (template.tenantId === SYSTEM_TENANT_ID) {
      if (!isSuperAdmin(this.requestUser)) {
        throw new ForbiddenException('Approval of SYSTEM/library prompt templates is restricted to super administrators.');
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
