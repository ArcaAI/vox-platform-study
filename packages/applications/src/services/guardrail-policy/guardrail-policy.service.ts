import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AiModelRepository,
  CoreUnitOfWorkService,
  GuardrailPolicyRevisionFactory,
  GuardrailPolicyRevisionRepository,
  ResourceStatusType,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import type { AiModelEntity, GuardrailPolicyRevisionEntity } from '@arcaai/domains';
import {
  GUARDRAIL_JUDGE_CHECK_IDS,
  GUARDRAIL_JUDGE_LANES,
  GUARDRAIL_JUDGE_TASK_KEYS,
  JUDGE_LANE_UNSUPPORTED,
  JudgeLaneUnsupportedError,
  assertModelSupportsLane,
  guardrailJudgeLaneTaskKey,
  isAiModelJudgeMetadata,
  judgeMetadataProblems,
  type GuardrailJudgeCheckId,
  type GuardrailJudgeLane,
  type GuardrailPolicyKeySpec,
} from '@arcaai/types';
import { BaseService } from '../../common/base.service';
import { isSuperAdmin } from '../../common/tenant-guards';
import type { IActiveUserContext } from '../../interfaces';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';
import { IAiRoutingPolicyService } from '../ai-routing-policy/IAiRoutingPolicyService';
import { IModelResidencyService } from '../model-residency/IModelResidencyService';
import type { ModelResidencyStateSnapshot } from '../model-residency/model-residency.service';
import {
  GuardrailDryRunLaneResult,
  GuardrailDryRunRequest,
  GuardrailDryRunResponse,
  GuardrailJudgeLaneCandidateResponse,
  GuardrailJudgeLanesResponse,
  GuardrailJudgeMetaResponse,
  GuardrailPolicyKeyEntryResponse,
  GuardrailPolicyKeyGroupResponse,
  GuardrailPolicyKeyResponse,
  GuardrailPolicyKeysResponse,
  GuardrailPolicyLaneResetResponse,
  GuardrailPolicyRevisionsResponse,
  GuardrailPolicyRevisionSummaryResponse,
  UpdateGuardrailJudgeLanesRequest,
  UpdateGuardrailJudgeMetaRequest,
  UpdateGuardrailPolicyKeyRequest,
} from './dto';
import { GuardrailDryRunUnavailableError, GuardrailJudgeDryRunClient } from './guardrail-judge-dry-run.client';
import type { IGuardrailPolicyService } from './IGuardrailPolicyService';
import { guardrailCriteriaLane, validateGuardrailPolicyValue, type LoadedGuardrailPolicyKeyCatalogue } from './policy-key-catalogue';

/** Guardrail subscribes here (lane W2a1) and drops its cached SYSTEM config for the named task keys. */
export const GUARDRAIL_CONFIG_INVALIDATE_CHANNEL = 'guardrail:config:invalidate';

/** DI token for the loaded `policy-keys.json`. */
export const GUARDRAIL_POLICY_KEY_CATALOGUE = Symbol('GUARDRAIL_POLICY_KEY_CATALOGUE');

/** The revision `policyKey` an `_metadata.judge` edit is recorded under (it is not a catalogue key). */
export const GUARDRAIL_JUDGE_META_REVISION_KEY = 'judge';

/** Revision history page size (an API paging bound, not a policy knob). */
const REVISIONS_DEFAULT_LIMIT = 50;
const REVISIONS_MAX_LIMIT = 200;

const MODEL_RESIDENCY_LINK = '/model-residency';

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Canonical JSON: object keys sorted, so a hash or an equality check does not depend on key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRec(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const guardrailPolicyValueHash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const sameValue = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

const JUDGE_LANE_BY_TASK_KEY: Readonly<Record<string, GuardrailJudgeCheckId>> = Object.freeze(
  Object.fromEntries(Object.entries(GUARDRAIL_JUDGE_TASK_KEYS).map(([lane, taskKey]) => [taskKey, lane as GuardrailJudgeCheckId])),
);

/** Which `_metadata` blob a write targets. */
interface MetaSlot {
  readonly current: 'policy' | 'judge';
  readonly defaults: 'policyDefaults' | 'judgeDefaults';
}

const POLICY_SLOT: MetaSlot = { current: 'policy', defaults: 'policyDefaults' };

/** One key change inside a single model-row write. */
interface KeyChange {
  readonly key: string;
  readonly value: unknown;
}

/**
 * TASK-1050 W2h — see {@link IGuardrailPolicyService}.
 *
 * Writes go to `_metadata.policy[key]` (or `_metadata.judge`) on the SYSTEM model row the key's task key elects,
 * through `AiModelRepository.updateWithVersion` — a compare-and-set on the row `_version`, which is what makes a
 * whole-`_metadata` replacement safe against a concurrent writer of any other `_metadata` key. The revision is
 * appended in the SAME transaction, on the base (unscoped) client the unit of work opens, with `tenantId` SYSTEM
 * set explicitly — never stamped from the caller's CLS tenant. `_metadata.policyDefaults` / `judgeDefaults` are
 * seed-owned and never written here.
 */
@Injectable()
export class GuardrailPolicyService extends BaseService implements IGuardrailPolicyService {
  private readonly logger = new Logger(GuardrailPolicyService.name);

  constructor(
    private readonly aiModels: AiModelRepository,
    private readonly revisions: GuardrailPolicyRevisionRepository,
    @Inject(IAiRoutingPolicyService) private readonly routing: IAiRoutingPolicyService,
    private readonly unitOfWork: CoreUnitOfWorkService,
    @Inject(GUARDRAIL_POLICY_KEY_CATALOGUE) private readonly catalogue: LoadedGuardrailPolicyKeyCatalogue,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(IRedisCacheService) private readonly redis?: IRedisCacheService,
    @Optional() @Inject(IModelResidencyService) private readonly residency?: IModelResidencyService,
    @Optional() private readonly dryRunClient?: GuardrailJudgeDryRunClient,
  ) {
    super(eventEmitter, clsService, ResourceType.GuardrailPolicyRevision);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async listPolicyKeys(): Promise<GuardrailPolicyKeysResponse> {
    this.assertPlatformAdmin('read the guardrail policy keys');
    if (!this.catalogue.available) return { catalogueAvailable: false, groups: [] };

    const byTask = new Map<string, GuardrailPolicyKeySpec[]>();
    for (const spec of this.catalogue.specs) byTask.set(spec.taskKey, [...(byTask.get(spec.taskKey) ?? []), spec]);

    const groups: GuardrailPolicyKeyGroupResponse[] = [];
    for (const [taskKey, specs] of byTask) {
      const model = await this.resolveModel(taskKey);
      const keys = await Promise.all(specs.map(async (spec) => this.toEntry(spec, model, model ? await this.revisions.findLatestByKey(model.id, spec.key) : null)));
      groups.push({
        taskKey,
        lane: JUDGE_LANE_BY_TASK_KEY[taskKey] ?? (taskKey === guardrailJudgeLaneTaskKey('medical_validation') ? 'medical_validation' : null),
        modelId: model?.id ?? null,
        modelSlug: model?.slug ?? null,
        modelVersion: model?.version ?? null,
        protocol: protocolOf(model),
        keys,
      });
    }
    return { catalogueAvailable: true, groups };
  }

  async getPolicyKey(key: string): Promise<GuardrailPolicyKeyResponse> {
    this.assertPlatformAdmin('read a guardrail policy key');
    const spec = this.requireSpec(key);
    const model = await this.resolveModel(spec.taskKey);
    if (!model) throw this.modelUnresolved(spec);
    const latest = await this.revisions.findLatestByKey(model.id, spec.key);
    return { ...this.toEntry(spec, model, latest), version: model.version };
  }

  async listRevisions(key: string, limit?: number): Promise<GuardrailPolicyRevisionsResponse> {
    this.assertPlatformAdmin('read guardrail policy history');
    const spec = this.requireSpec(key);
    const model = await this.resolveModel(spec.taskKey);
    if (!model) return { key: spec.key, modelId: null, revisions: [] };
    const take = Math.min(Math.max(1, Math.trunc(limit ?? REVISIONS_DEFAULT_LIMIT)), REVISIONS_MAX_LIMIT);
    const rows = await this.revisions.listByKey(model.id, spec.key, take);
    return {
      key: spec.key,
      modelId: model.id,
      revisions: rows.map((row) => ({
        ...toRevisionSummary(row),
        aiModelId: row.aiModelId,
        policyKey: row.policyKey,
        value: row.value,
        restoredFromRevisionId: row.restoredFromRevisionId ?? null,
      })),
    };
  }

  // ── policy-key writes ────────────────────────────────────────────────────

  async updatePolicyKey(key: string, request: UpdateGuardrailPolicyKeyRequest): Promise<GuardrailPolicyKeyResponse> {
    this.assertPlatformAdmin('change a guardrail policy key');
    const spec = this.requireEditableSpec(key);
    this.assertValidValue(spec, request.value);
    const model = await this.requireWritableModel(spec);
    if (request.expectedVersion === undefined || request.expectedVersion !== model.version) {
      // RFC 7232: the precondition is evaluated before the payload. `@RequiresIfMatch()` 428s an absent header
      // at the HTTP layer, so `undefined` here is a non-HTTP caller skipping the precondition.
      throw new OptimisticConcurrencyException(String(ResourceType.AiModel), model.id, { expectedVersion: request.expectedVersion, currentVersion: model.version });
    }
    return this.writeKey(spec, model, request.value, 'edit');
  }

  async resetPolicyKey(key: string): Promise<GuardrailPolicyKeyResponse> {
    this.assertPlatformAdmin('reset a guardrail policy key');
    const spec = this.requireEditableSpec(key);
    const model = await this.requireWritableModel(spec);
    const defaults = slotOf(model, POLICY_SLOT.defaults);
    if (!Object.prototype.hasOwnProperty.call(defaults, spec.key)) {
      throw new ConflictException({
        code: 'GUARDRAIL_POLICY_DEFAULT_MISSING',
        message: `The seed ships no default for '${spec.key}' on model '${model.slug}', so there is nothing to reset to.`,
      });
    }
    return this.writeKey(spec, model, defaults[spec.key], 'reset');
  }

  async resetLane(lane: string): Promise<GuardrailPolicyLaneResetResponse> {
    this.assertPlatformAdmin('reset a guardrail lane');
    this.requireCatalogue();
    const taskKey = (GUARDRAIL_JUDGE_LANES as readonly string[]).includes(lane) ? guardrailJudgeLaneTaskKey(lane as GuardrailJudgeLane) : lane;
    const specs = this.catalogue.specs.filter((spec) => spec.taskKey === taskKey);
    if (specs.length === 0) throw new NotFoundException(`No guardrail policy keys live on '${lane}'.`);

    const model = await this.resolveModel(taskKey);
    if (!model) throw this.modelUnresolved(specs[0] as GuardrailPolicyKeySpec);
    const current = slotOf(model, POLICY_SLOT.current);
    const defaults = slotOf(model, POLICY_SLOT.defaults);
    const changes: KeyChange[] = [];
    const skippedKeys: string[] = [];
    for (const spec of specs) {
      const hasDefault = Object.prototype.hasOwnProperty.call(defaults, spec.key);
      if (!spec.editable || !hasDefault || sameValue(current[spec.key], defaults[spec.key]) || this.criteriaNotApplicable(spec, model)) {
        skippedKeys.push(spec.key);
        continue;
      }
      changes.push({ key: spec.key, value: defaults[spec.key] });
    }
    if (changes.length === 0) return { taskKey, version: model.version, resetKeys: [], skippedKeys };

    const { saved } = await this.commit(model, POLICY_SLOT, changes, 'reset', null, taskKey);
    return { taskKey, version: saved.version, resetKeys: changes.map((change) => change.key), skippedKeys };
  }

  async restoreRevision(key: string, revisionId: string): Promise<GuardrailPolicyKeyResponse> {
    this.assertPlatformAdmin('restore a guardrail policy revision');
    const spec = this.requireEditableSpec(key);
    const revision = await this.revisions.findById(revisionId).catch(() => null);
    if (!revision || revision.policyKey !== spec.key) throw new NotFoundException(`Revision '${revisionId}' of '${spec.key}' not found.`);
    const model = await this.requireWritableModel(spec);
    if (revision.aiModelId !== model.id) {
      throw new ConflictException({
        code: 'GUARDRAIL_POLICY_REVISION_MODEL_MISMATCH',
        message: `Revision '${revisionId}' was written on another model row; '${spec.taskKey}' now elects '${model.slug}'. A value is model-coupled and is not carried across a model switch.`,
      });
    }
    this.assertValidValue(spec, revision.value);
    return this.writeKey(spec, model, revision.value, 'restore', revision.id);
  }

  // ── _metadata.judge ──────────────────────────────────────────────────────

  async updateJudgeMeta(modelId: string, request: UpdateGuardrailJudgeMetaRequest): Promise<GuardrailJudgeMetaResponse> {
    this.assertPlatformAdmin("change a judge model's category mapping");
    const model = await this.requireJudgeModel(modelId);
    const current = (model.metaData as Rec).judge as Rec;
    if (request.expectedVersion === undefined || request.expectedVersion !== model.version) {
      throw new OptimisticConcurrencyException(String(ResourceType.AiModel), model.id, { expectedVersion: request.expectedVersion, currentVersion: model.version });
    }
    // `protocol` and `lanes` are the capability declaration: never taken from the request.
    const next: Rec = {
      ...current,
      ...(request.categoryMap !== undefined ? { categoryMap: request.categoryMap } : {}),
      ...(request.tiers !== undefined ? { tiers: request.tiers } : {}),
    };
    return this.writeJudge(model, next, 'edit');
  }

  async resetJudgeMeta(modelId: string): Promise<GuardrailJudgeMetaResponse> {
    this.assertPlatformAdmin("reset a judge model's category mapping");
    const model = await this.requireJudgeModel(modelId);
    const defaults = (model.metaData as Rec).judgeDefaults;
    if (!isRec(defaults)) {
      throw new ConflictException({ code: 'GUARDRAIL_JUDGE_DEFAULT_MISSING', message: `The seed ships no judge defaults for model '${model.slug}'.` });
    }
    return this.writeJudge(model, defaults, 'reset');
  }

  // ── lane → model ─────────────────────────────────────────────────────────

  async getJudgeLanes(): Promise<GuardrailJudgeLanesResponse> {
    this.assertPlatformAdmin('read the judge lane selection');
    return this.buildLanes();
  }

  async updateJudgeLanes(request: UpdateGuardrailJudgeLanesRequest): Promise<GuardrailJudgeLanesResponse> {
    this.assertPlatformAdmin('select a judge model per lane');
    // Validate EVERY selection before writing any, so one bad lane does not leave a half-applied change.
    const plan: Array<{ lane: GuardrailJudgeCheckId; taskKey: string; model: AiModelEntity }> = [];
    for (const selection of request.selections) {
      const lane = selection.lane as GuardrailJudgeCheckId;
      if (!(GUARDRAIL_JUDGE_CHECK_IDS as readonly string[]).includes(lane)) throw new BadRequestException(`Unknown judge lane '${selection.lane}'.`);
      const model = await this.aiModels.findByIdOrNull(selection.modelId);
      if (!model || model.tenantId !== SYSTEM_TENANT_ID || model.resourceStatus === ResourceStatusType.DELETED) {
        throw new NotFoundException(`AiModel '${selection.modelId}' was not found in the platform catalogue.`);
      }
      try {
        assertModelSupportsLane((model.metaData as Rec | undefined)?.judge, lane);
      } catch (error) {
        if (error instanceof JudgeLaneUnsupportedError) {
          throw new BadRequestException({ code: JUDGE_LANE_UNSUPPORTED, message: error.message, lane, modelId: model.id, problems: error.problems });
        }
        throw error;
      }
      plan.push({ lane, taskKey: GUARDRAIL_JUDGE_TASK_KEYS[lane], model });
    }

    const changed: string[] = [];
    for (const step of plan) {
      const current = await this.routing.resolveDefault(SYSTEM_TENANT_ID, step.taskKey, { systemOnly: true });
      if (current.policy?.modelId === step.model.id) continue;
      // The routing plane's own revision lifecycle: author a DRAFT, activate it (archives the ACTIVE it
      // supersedes), elect it. Its write path re-checks the lane capability (`assertModelServesTask`).
      const draft = await this.routing.create(SYSTEM_TENANT_ID, {
        taskKey: step.taskKey,
        modelId: step.model.id,
        displayName: `${step.lane} → ${step.model.slug}`,
      });
      await this.routing.activate(draft.id, SYSTEM_TENANT_ID);
      await this.routing.setDefault(draft.id, SYSTEM_TENANT_ID);
      changed.push(step.taskKey);
    }
    if (changed.length > 0) await this.publishInvalidation(changed);
    return this.buildLanes();
  }

  // ── dry run ──────────────────────────────────────────────────────────────

  async dryRun(request: GuardrailDryRunRequest): Promise<GuardrailDryRunResponse> {
    this.assertPlatformAdmin('dry-run a guardrail judge');
    if ((request.text === undefined) === (request.sampleId === undefined)) {
      throw new BadRequestException({ code: 'GUARDRAIL_DRY_RUN_SAMPLE_REQUIRED', message: 'Send exactly one of `text` or `sampleId`.' });
    }
    const overrides = request.policy ?? {};
    if (Object.keys(overrides).length > 0) this.requireCatalogue();
    const problems: Array<{ key: string; code: string; message: string }> = [];
    for (const [key, value] of Object.entries(overrides)) {
      const spec = this.catalogue.specs.find((candidate) => candidate.key === key);
      if (!spec) {
        problems.push({ key, code: 'POLICY_KEY_UNKNOWN', message: `'${key}' is not a governed guardrail policy key.` });
        continue;
      }
      for (const problem of validateGuardrailPolicyValue(spec, value)) problems.push({ key, code: problem.code, message: problem.message });
    }
    if (problems.length > 0) throw new BadRequestException({ code: 'GUARDRAIL_POLICY_VALUE_INVALID', message: 'A draft value is invalid.', problems });

    const lanes = request.lanes as GuardrailJudgeLane[];
    const laneModels = await Promise.all(lanes.map(async (lane) => ({ lane, model: await this.resolveModel(guardrailJudgeLaneTaskKey(lane)) })));
    const states = await this.readResidency();
    const blocked = laneModels
      .map(({ lane, model }) => ({ lane, modelId: model?.id ?? null, slug: model?.slug ?? null, state: model ? residencyOf(states, model.id) : 'unselected' }))
      .filter((entry) => entry.state !== 'loaded');
    if (blocked.length > 0) {
      // OD-35: never load implicitly. The operator loads on /model-residency, then retries.
      throw new ConflictException({
        code: 'MODEL_NOT_RESIDENT',
        message: 'The judge model for a requested lane is not resident. Load it on Model residency, then retry.',
        link: MODEL_RESIDENCY_LINK,
        models: blocked,
      });
    }
    if (!this.dryRunClient) throw new ServiceUnavailableException({ code: 'GUARDRAIL_DRY_RUN_UNAVAILABLE', message: 'The guardrail dry-run client is not wired.' });

    let body: Rec;
    try {
      body = await this.dryRunClient.run({
        lanes,
        ...(request.text !== undefined ? { text: request.text } : {}),
        ...(request.sampleId !== undefined ? { sampleId: request.sampleId } : {}),
        policyOverrides: overrides,
      });
    } catch (error) {
      if (error instanceof GuardrailDryRunUnavailableError) {
        throw new ServiceUnavailableException({ code: 'GUARDRAIL_DRY_RUN_UNAVAILABLE', message: error.message });
      }
      throw error;
    }
    const reported = Array.isArray(body.lanes) ? body.lanes.filter(isRec) : [];
    return {
      persisted: false,
      lanes: laneModels.map(({ lane, model }) => toDryRunLane(lane, model, reported.find((entry) => entry.lane === lane))),
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * ROW-INDEPENDENT, so it runs first (rule 05): a SUPER_ADMIN, in a tenant-less context or the SYSTEM tenant.
   * A customer working tenant is refused because the writes target SYSTEM rows and the activity reads span
   * every tenant — the same posture as model residency and promote-to-system.
   */
  private assertPlatformAdmin(action: string): void {
    if (!isSuperAdmin(this.requestUser)) throw new ForbiddenException(`Only platform administrators may ${action}.`);
    const tenant = this.tenantId;
    if (tenant && tenant !== SYSTEM_TENANT_ID) {
      throw new ForbiddenException(`Guardrail control is platform-wide; clear the working tenant to ${action}.`);
    }
  }

  private requireCatalogue(): void {
    if (!this.catalogue.available) {
      throw new ServiceUnavailableException({
        code: 'GUARDRAIL_POLICY_CATALOGUE_UNAVAILABLE',
        message: 'The guardrail policy-key catalogue (policy-keys.json) is unavailable, so no policy key can be validated or written.',
      });
    }
  }

  private requireSpec(key: string): GuardrailPolicyKeySpec {
    this.requireCatalogue();
    const spec = this.catalogue.specs.find((candidate) => candidate.key === key);
    if (!spec) throw new NotFoundException(`'${key}' is not a governed guardrail policy key.`);
    return spec;
  }

  private requireEditableSpec(key: string): GuardrailPolicyKeySpec {
    const spec = this.requireSpec(key);
    if (!spec.editable) {
      throw new BadRequestException({ code: 'GUARDRAIL_POLICY_KEY_NOT_EDITABLE', message: `'${key}' is declared read-only in the policy-key catalogue.` });
    }
    return spec;
  }

  private assertValidValue(spec: GuardrailPolicyKeySpec, value: unknown): void {
    const problems = validateGuardrailPolicyValue(spec, value);
    if (problems.length > 0) {
      throw new BadRequestException({ code: 'GUARDRAIL_POLICY_VALUE_INVALID', message: `The value for '${spec.key}' is invalid.`, key: spec.key, problems });
    }
  }

  /** The ENABLED SYSTEM model the task key elects, re-read for a fresh `_version`; `null` when none. */
  private async resolveModel(taskKey: string): Promise<AiModelEntity | null> {
    const resolved = await this.routing.resolveDefault(SYSTEM_TENANT_ID, taskKey, { systemOnly: true }).catch((error: unknown) => {
      this.logger.warn({ message: 'guardrail.policy.model_unresolved', taskKey, error: error instanceof Error ? error.name : 'unknown' });
      return null;
    });
    const id = resolved?.model?.id;
    if (!id) return null;
    const model = await this.aiModels.findByIdOrNull(id);
    return model && model.tenantId === SYSTEM_TENANT_ID ? model : null;
  }

  private async requireWritableModel(spec: GuardrailPolicyKeySpec): Promise<AiModelEntity> {
    const model = await this.resolveModel(spec.taskKey);
    if (!model) throw this.modelUnresolved(spec);
    if (this.criteriaNotApplicable(spec, model)) {
      throw new ConflictException({
        code: 'GUARDRAIL_CRITERIA_NOT_APPLICABLE',
        message: `'${spec.key}' is a criteria prompt, but '${spec.taskKey}' elects '${model.slug}', which speaks its own native template (qwen3guard_native). Edit its category mapping instead.`,
      });
    }
    return model;
  }

  private criteriaNotApplicable(spec: GuardrailPolicyKeySpec, model: AiModelEntity): boolean {
    return spec.kind === 'criteria' && protocolOf(model) === 'qwen3guard_native';
  }

  private modelUnresolved(spec: GuardrailPolicyKeySpec): ConflictException {
    return new ConflictException({
      code: 'GUARDRAIL_POLICY_MODEL_UNRESOLVED',
      message: `'${spec.taskKey}' elects no enabled SYSTEM model, so '${spec.key}' has no row to live on.`,
    });
  }

  private async requireJudgeModel(modelId: string): Promise<AiModelEntity> {
    const model = await this.aiModels.findByIdOrNull(modelId);
    if (!model || model.tenantId !== SYSTEM_TENANT_ID || !isRec((model.metaData as Rec | undefined)?.judge)) {
      throw new NotFoundException(`No SYSTEM judge model '${modelId}' (a model with a _metadata.judge declaration).`);
    }
    return model;
  }

  private async writeKey(
    spec: GuardrailPolicyKeySpec,
    model: AiModelEntity,
    value: unknown,
    reason: 'edit' | 'reset' | 'restore',
    restoredFromRevisionId: string | null = null,
  ): Promise<GuardrailPolicyKeyResponse> {
    if (sameValue(slotOf(model, POLICY_SLOT.current)[spec.key], value)) {
      const latest = await this.revisions.findLatestByKey(model.id, spec.key);
      return { ...this.toEntry(spec, model, latest), version: model.version, changed: false, revisionId: null };
    }
    const { saved, revisions } = await this.commit(model, POLICY_SLOT, [{ key: spec.key, value }], reason, restoredFromRevisionId, spec.taskKey);
    const revision = revisions[0] ?? null;
    return { ...this.toEntry(spec, saved, revision), version: saved.version, changed: true, revisionId: revision?.id ?? null };
  }

  private async writeJudge(model: AiModelEntity, next: Rec, reason: 'edit' | 'reset'): Promise<GuardrailJudgeMetaResponse> {
    const problems = judgeMetadataProblems(next);
    if (problems.length > 0) {
      throw new BadRequestException({ code: 'GUARDRAIL_JUDGE_META_INVALID', message: 'The judge declaration is invalid.', problems });
    }
    const meta = (model.metaData ?? {}) as Rec;
    if (sameValue(meta.judge, next)) return toJudgeMeta(model, false);
    const taskKeys = laneTaskKeysOf(next);
    const { saved } = await this.commit(model, { current: 'judge', defaults: 'judgeDefaults' }, [{ key: GUARDRAIL_JUDGE_META_REVISION_KEY, value: next }], reason, null, taskKeys);
    return toJudgeMeta(saved, true);
  }

  /**
   * ONE compare-and-set on the model row plus one revision per change, in one transaction; then the
   * invalidation publish and the sys-event (after commit, never inside it).
   */
  private async commit(
    model: AiModelEntity,
    slot: MetaSlot,
    changes: readonly KeyChange[],
    reason: 'edit' | 'reset' | 'restore',
    restoredFromRevisionId: string | null,
    taskKeys: string | readonly string[],
  ): Promise<{ saved: AiModelEntity; revisions: GuardrailPolicyRevisionEntity[] }> {
    const meta = { ...((model.metaData ?? {}) as Rec) };
    if (slot.current === 'judge') {
      meta.judge = changes[0]?.value;
    } else {
      const policy = { ...slotOf(model, 'policy') };
      for (const change of changes) policy[change.key] = change.value;
      meta.policy = policy;
    }
    const previousVersion = model.version;
    const actorId = this.requestUserId ?? 'unknown';
    model.metaData = meta as AiModelEntity['metaData'];

    const result = await this.unitOfWork.runInTransaction(async (tx) => {
      const saved = await this.aiModels.updateWithVersion(model.id, model, previousVersion, tx);
      const revisions: GuardrailPolicyRevisionEntity[] = [];
      for (const change of changes) {
        const entity = GuardrailPolicyRevisionFactory.CreateGuardrailPolicyRevision({
          // Explicit: the revision table lives in SYSTEM, whatever the caller's CLS tenant (none, here).
          tenantId: SYSTEM_TENANT_ID,
          aiModelId: model.id,
          policyKey: change.key,
          value: change.value as never,
          valueHash: guardrailPolicyValueHash(change.value),
          actorId,
          reason,
          restoredFromRevisionId: restoredFromRevisionId ?? undefined,
        });
        revisions.push(await this.revisions.create(entity, tx));
      }
      return { saved, revisions };
    });

    const keys = typeof taskKeys === 'string' ? [taskKeys] : [...taskKeys];
    await this.publishInvalidation(keys);
    for (const revision of result.revisions) {
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: model.id,
        data: {
          surface: 'guardrail.policy',
          key: revision.policyKey,
          taskKey: keys[0] ?? null,
          taskKeys: keys,
          modelSlug: model.slug,
          reason,
          revisionId: revision.id,
          valueHash: revision.valueHash,
          restoredFromRevisionId,
          previousVersion,
          newVersion: result.saved.version,
        },
      });
    }
    return result;
  }

  private async publishInvalidation(taskKeys: readonly string[]): Promise<void> {
    if (!this.redis || taskKeys.length === 0) return;
    try {
      await this.redis.publish(GUARDRAIL_CONFIG_INVALIDATE_CHANNEL, JSON.stringify({ taskKeys }));
    } catch (error) {
      // The write is committed; guardrail's 60 s SQL TTL is the bounded-staleness backstop (rule 09).
      this.logger.warn({ message: 'guardrail.policy.invalidate_failed', taskKeys, error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  private async readResidency(): Promise<ModelResidencyStateSnapshot | null> {
    const reader = this.residency as (IModelResidencyService & { getLifecycleStates?: () => Promise<ModelResidencyStateSnapshot> }) | undefined;
    if (!reader?.getLifecycleStates) return null;
    try {
      return await reader.getLifecycleStates();
    } catch (error) {
      this.logger.warn({ message: 'guardrail.policy.residency_unavailable', error: error instanceof Error ? error.name : 'unknown' });
      return null;
    }
  }

  private async buildLanes(): Promise<GuardrailJudgeLanesResponse> {
    const [catalogue, states] = await Promise.all([
      this.aiModels.findAll({ filters: { tenantId: SYSTEM_TENANT_ID, resourceStatus: ResourceStatusType.ENABLED } as never }),
      this.readResidency(),
    ]);
    const judges = catalogue.filter((model) => model.tenantId === SYSTEM_TENANT_ID && isAiModelJudgeMetadata((model.metaData as Rec | undefined)?.judge));
    const lanes = [];
    for (const lane of GUARDRAIL_JUDGE_CHECK_IDS) {
      const taskKey = GUARDRAIL_JUDGE_TASK_KEYS[lane];
      const resolved = await this.routing.resolveDefault(SYSTEM_TENANT_ID, taskKey, { systemOnly: true }).catch(() => null);
      const candidates = judges
        .filter((model) => ((model.metaData as Rec).judge as { lanes: readonly string[] }).lanes.includes(lane))
        .map((model) => toCandidate(model, states));
      const selectedId = resolved?.model?.id ?? resolved?.policy?.modelId ?? null;
      const selectedModel = selectedId ? (catalogue.find((model) => model.id === selectedId) ?? null) : null;
      lanes.push({
        lane,
        taskKey,
        policyId: resolved?.policy?.id ?? null,
        selected: selectedModel ? toCandidate(selectedModel, states) : null,
        candidates,
      });
    }
    return { lanes };
  }

  private toEntry(spec: GuardrailPolicyKeySpec, model: AiModelEntity | null, latest: GuardrailPolicyRevisionEntity | null): GuardrailPolicyKeyEntryResponse {
    const current = model ? slotOf(model, POLICY_SLOT.current) : {};
    const defaults = model ? slotOf(model, POLICY_SLOT.defaults) : {};
    const currentValue = Object.prototype.hasOwnProperty.call(current, spec.key) ? current[spec.key] : null;
    const defaultValue = Object.prototype.hasOwnProperty.call(defaults, spec.key) ? defaults[spec.key] : null;
    return {
      key: spec.key,
      kind: spec.kind,
      type: spec.type,
      min: spec.min,
      max: spec.max,
      failMode: spec.failMode,
      taskKey: spec.taskKey,
      inPolicyVersion: spec.inPolicyVersion,
      editable: spec.editable,
      lane: spec.kind === 'criteria' ? guardrailCriteriaLane(spec.key) : null,
      modelId: model?.id ?? null,
      modelSlug: model?.slug ?? null,
      modelVersion: model?.version ?? null,
      currentValue,
      defaultValue,
      isDefault: sameValue(currentValue, defaultValue),
      lastRevision: latest ? toRevisionSummary(latest) : null,
    };
  }
}

function slotOf(model: AiModelEntity, slot: string): Rec {
  const meta = model.metaData as Rec | undefined;
  const value = meta?.[slot];
  return isRec(value) ? value : {};
}

function protocolOf(model: AiModelEntity | null): string | null {
  const judge = (model?.metaData as Rec | undefined)?.judge;
  return isRec(judge) && typeof judge.protocol === 'string' ? judge.protocol : null;
}

/** The routing task keys a judge declaration's lanes select through (what an `_metadata.judge` change invalidates). */
function laneTaskKeysOf(judge: Rec): string[] {
  const lanes = Array.isArray(judge.lanes) ? (judge.lanes as string[]) : [];
  return lanes.filter((lane) => (GUARDRAIL_JUDGE_LANES as readonly string[]).includes(lane)).map((lane) => guardrailJudgeLaneTaskKey(lane as GuardrailJudgeLane));
}

function toRevisionSummary(row: GuardrailPolicyRevisionEntity): GuardrailPolicyRevisionSummaryResponse {
  const at = row.at instanceof Date ? row.at : new Date(row.at as unknown as string);
  return { id: row.id, reason: row.reason, actorId: row.actorId, at: at.toISOString(), valueHash: row.valueHash };
}

function toJudgeMeta(model: AiModelEntity, changed: boolean): GuardrailJudgeMetaResponse {
  const meta = (model.metaData ?? {}) as Rec;
  const judge = isRec(meta.judge) ? meta.judge : {};
  const defaults = isRec(meta.judgeDefaults) ? meta.judgeDefaults : null;
  return { modelId: model.id, slug: model.slug, version: model.version, judge, judgeDefaults: defaults, isDefault: defaults !== null && sameValue(judge, defaults), changed };
}

function residencyOf(states: ModelResidencyStateSnapshot | null, modelId: string): string {
  if (!states) return 'unknown';
  const found = states.services.flatMap((service) => service.models).filter((entry) => entry.aiModelId === modelId);
  if (found.some((entry) => entry.state === 'loaded')) return 'loaded';
  return found[0]?.state ?? 'not_loaded';
}

function toCandidate(model: AiModelEntity, states: ModelResidencyStateSnapshot | null): GuardrailJudgeLaneCandidateResponse {
  const judge = (model.metaData as Rec | undefined)?.judge as Rec | undefined;
  const servedBy = (model as unknown as { servedBy?: unknown }).servedBy;
  return {
    modelId: model.id,
    slug: model.slug,
    name: (model as unknown as { name?: string | null }).name ?? null,
    protocol: typeof judge?.protocol === 'string' ? judge.protocol : 'unknown',
    servedBy: typeof servedBy === 'string' ? servedBy : null,
    residency: residencyOf(states, model.id),
  };
}

const DRY_RUN_VERDICTS = ['pass', 'flag', 'undetermined'];

function toDryRunLane(lane: string, model: AiModelEntity | null, reported: Rec | undefined): GuardrailDryRunLaneResult {
  const verdict = typeof reported?.verdict === 'string' && DRY_RUN_VERDICTS.includes(reported.verdict) ? reported.verdict : 'undetermined';
  const latency = reported?.latencyMs ?? reported?.latency_ms;
  return {
    lane,
    modelId: model?.id ?? null,
    modelSlug: model?.slug ?? null,
    verdict,
    category: typeof reported?.category === 'string' ? reported.category : null,
    confidence: typeof reported?.confidence === 'number' && Number.isFinite(reported.confidence) ? reported.confidence : null,
    latencyMs: typeof latency === 'number' && Number.isFinite(latency) ? latency : null,
  };
}
