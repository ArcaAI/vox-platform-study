import { Injectable, Inject, Optional, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
  TestPromptTemplateRequest,
  PromptTestResultResponse,
  PromptUsageAnalyticsResponse,
} from './dto';
import { PromptManagementDtoMapper } from './prompt-management.dto.mapper';
import { mapSmrGenerateResponse } from '../consultation/summary/smr-v2-generate';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IDepartmentService } from '../department/IDepartmentService';
import { DepartmentResponse } from '../department/dto';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';

const SCOPE_TENANT_DEFAULT = 'TENANT_DEFAULT';
const SCOPE_USER_PERSONAL = 'USER_PERSONAL';

// TASK-328 A4 — word count at which a generated test output earns the full
// quality score. The score is a deterministic, testable proxy for "did the
// template produce a substantive response", not a semantic judgement.
const FULL_SCORE_WORD_COUNT = 50;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// TASK-331 doc-02 F8 — deterministic output-quality rubric helpers. Kept as
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
    // TASK-328 A4 — SMR/text-generation client (mirrors SummaryService). These
    // are @Optional() so existing unit-test fixtures that construct the service
    // directly without the SMR deps keep compiling; the live API always wires
    // HttpModule + ConfigModule via PromptManagementServiceModule.
    @Optional() private readonly httpService?: HttpService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.PromptTemplate);
    this.smrServiceUrl = this.configService?.get<string>('SMR_URL') ?? 'http://localhost:8862';
  }

  async createPromptTemplate(dto: CreatePromptTemplateRequest): Promise<PromptTemplateResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');
    if (!this.callerCanManageTemplates()) {
      throw new ForbiddenException('Caller cannot create tenant-default prompt templates');
    }

    const existing = await this.promptTemplateRepository.findByName(tenantId, dto.name);
    if (existing) throw new BadRequestException(`Prompt template with name '${dto.name}' already exists`);

    const template = PromptTemplateFactory.CreatePromptTemplate({
      tenantId,
      name: dto.name,
      description: dto.description ?? null,
      content: dto.content,
      category: dto.category,
      // TASK-331 doc-02 F5 — persist the publication status (defaults DRAFT).
      status: dto.status ?? 'DRAFT',
      variables: dto.variables ?? null,
      departmentId: dto.departmentId ?? null,
      scope: SCOPE_TENANT_DEFAULT,
      ownerUserId: null,
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
   * TASK-302 Stream D Phase E.3 — write path is now Compare-And-Set
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
      const version = PromptVersionFactory.CreatePromptVersion({
        tenantId: template.tenantId,
        promptTemplateId: id,
        versionNumber: (template.currentVersionNumber ?? 0) + 1,
        content: dto.content ?? template.content,
        variables: dto.variables ?? template.variables,
        changeReason: dto.changeReason ?? null,
        changedBy: userId ?? null,
      });
      await this.promptVersionRepository.create(version);

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

    // TASK-331 doc-02 F5 — a publication-status change is a mutating edit (it does
    // NOT spawn a new PromptVersion snapshot, but it marks the row dirty so the
    // OCC write proceeds). Set it before the `hasChanges` gate below.
    if (dto.status !== undefined) {
      template.status = dto.status;
    }

    if (!template.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    // Snapshot pre-write `_version` BEFORE the CAS bumps it (audit
    // correlation mirrors C.8 / E.1 / E.2).
    const previousVersion = template.version;

    // TASK-302 Stream D Phase E.3 — Compare-And-Set against `_version`.
    // `expectedVersion` is the CAS predicate input only; it never
    // reaches the entity (the `_version` getter is read-only per B.5).
    const updated = await this.promptTemplateRepository.updateWithVersion(id, template, dto.expectedVersion);

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

  async getPromptTemplate(id: string): Promise<PromptTemplateResponse | null> {
    const template = await this.promptTemplateRepository.findById(id);
    if (!template) return null;
    if (this.tenantId && template.tenantId !== this.tenantId) return null;
    if (template.scope === SCOPE_USER_PERSONAL && template.ownerUserId !== this.requestUserId) {
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
    if (filters?.search) qb.Where({ name: { contains: filters.search, mode: 'insensitive' } });
    const models = await qb.ToList();
    const mapper = PromptTemplateEntityMapper.getInstance();
    const templates = models.map((m) => mapper.toDomainEntity(m));
    return templates.map(PromptManagementDtoMapper.toTemplateResponse);
  }

  /**
   * TASK-328 A4 — repository-level pagination for the admin list.
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
   * TASK-331 doc-09 — end-user readable templates for the calling clinician.
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
   *   AND ( scope = TENANT_DEFAULT
   *         OR scope = DEPARTMENT_DEFAULT
   *         OR ( scope = USER_PERSONAL AND ownerUserId = caller ) )
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
    qb.WhereOr({ scope: SCOPE_TENANT_DEFAULT });
    qb.WhereOr({ scope: 'DEPARTMENT_DEFAULT' });
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

  async getUsageStats(templateId: string): Promise<{ totalUsages: number; lastUsedAt: string | null }> {
    const records = await this.promptUsageRecordRepository.findByTemplate(templateId);
    const totalUsages = records.length;
    const lastUsedAt = totalUsages > 0 ? (records[0].createdAt?.toISOString() ?? null) : null;
    return { totalUsages, lastUsedAt };
  }

  /**
   * TASK-328 A4 — run a prompt template against the SMR/text-generation
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
   * TASK-328 A4 — tenant-scoped usage analytics for `PromptUsageRecord`,
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

  async assignToDepartment(dto: AssignDepartmentPromptRequest): Promise<DepartmentResponse> {
    // TASK-302 Stream D Phase E.2 — `updatePromptConfig` now enforces OCC,
    // so the caller MUST carry the Department row's `expectedVersion`.
    // Cross-service callers (e.g. the prompt-management UI) read the
    // Department first and echo back its version on this DTO.
    return this.departmentService.updatePromptConfig(dto.departmentId, {
      newPatientPromptId: dto.newPatientPromptId,
      revisitPromptId: dto.revisitPromptId,
      expectedVersion: dto.expectedVersion,
    });
  }

  // ─── TASK-328 A4 — prompt-test internals ─────────────────────────────

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
      const response = await this.httpService.axiosRef.post(
        `${this.smrServiceUrl}/api/v1/generate`,
        { prompt, stream: false },
        { headers: { 'Content-Type': 'application/json', 'X-Service-Token': token } },
      );
      return mapSmrGenerateResponse(response.data).summary;
    } catch (error) {
      throw new BadRequestException(`Failed to call SMR service: ${error}`);
    }
  }

  /**
   * TASK-331 doc-02 F8 — deterministic, testable output-quality proxy in
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

  // ─── Internal authorization helpers (TASK-294 DEF-C2) ────────────────

  private assertOwnedByTenant(template: PromptTemplateEntity, id: string): void {
    const callerTenant = this.tenantId;
    if (callerTenant && template.tenantId !== callerTenant) {
      throw new NotFoundException(`Prompt template ${id} not found`);
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
}
