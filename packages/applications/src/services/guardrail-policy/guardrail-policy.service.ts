import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
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
  ModelTaskType,
  ResourceStatusType,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import type { AiModelEntity, GuardrailPolicyRevisionEntity } from '@arcaai/domains';
import {
  GUARDRAIL_JUDGE_LANES,
  GUARDRAIL_JUDGE_TASK_KEYS,
  guardrailJudgeLaneTaskKey,
  isAiModelJudgeMetadata,
  judgeMetadataProblems,
  type GuardrailJudgeCheckId,
  type GuardrailJudgeLane,
  type GuardrailPolicyKeySpec,
} from '@arcaai/types';
import { BaseService } from '../../common/base.service';
import type { IActiveUserContext } from '../../interfaces';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';
import { IAiRoutingPolicyService } from '../ai-routing-policy/IAiRoutingPolicyService';
import { assertRoutingModelServesJudgeLane } from '../ai-routing-policy/judge-lane-capability';
import { IModelResidencyService } from '../model-residency/IModelResidencyService';
import type { ModelResidencyStateSnapshot } from '../model-residency/model-residency.service';
import {
  GuardrailDryRunVerdict,
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
import { GuardrailDryRunRejectedError, GuardrailDryRunUnavailableError, GuardrailJudgeDryRunClient } from './guardrail-judge-dry-run.client';
import { assertGuardrailPlatformAdmin } from './guardrail-platform-gate';
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

/** The `_metadata` blobs of the catalogue keys. */
const POLICY_SLOT = { current: 'policy', defaults: 'policyDefaults' } as const;

/**
 * TASK-1050 (round 2) — the rows whose classifier thresholds inside `_metadata.labelTaxonomy` are editable here:
 * the top-level `threshold` and each task's `cls_threshold`. Labels, the task set, `benignLabels` / `benign_labels`
 * and `multi_label` are NOT: a label-set change is a model-version change, made through the registry (§11.3 D).
 */
export const GUARDRAIL_LABEL_THRESHOLD_TASK_KEYS = ['guardrail.safety', 'guardrail.injection', 'guardrail.pii', 'guardrail.pii.spans'] as const;
export const GUARDRAIL_LABEL_TAXONOMY_KEY_PREFIX = 'labelTaxonomy.';
/** A classifier threshold is a probability. */
const LABEL_THRESHOLD_MIN = 0;
const LABEL_THRESHOLD_MAX = 1;
const CLS_THRESHOLD_KEY = /^tasks\.([^.]+)\.cls_threshold$/;

/** `labelTaxonomy.threshold` → `['threshold']`; `labelTaxonomy.tasks.<t>.cls_threshold` → its path; another `labelTaxonomy.*` → `'not-editable'`; else `null`. */
export function guardrailLabelThresholdPath(key: string): string[] | 'not-editable' | null {
  if (!key.startsWith(GUARDRAIL_LABEL_TAXONOMY_KEY_PREFIX)) return null;
  const rest = key.slice(GUARDRAIL_LABEL_TAXONOMY_KEY_PREFIX.length);
  if (rest === 'threshold') return ['threshold'];
  const match = CLS_THRESHOLD_KEY.exec(rest);
  return match ? ['tasks', match[1] as string, 'cls_threshold'] : 'not-editable';
}

function getPath(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const segment of path) {
    if (!isRec(node) || !Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/** Copy-on-write set; every ancestor on `path` must already be an object (a threshold is only edited where it exists). */
function setPath(root: Rec, path: readonly string[], value: unknown): Rec {
  const [head, ...rest] = path as [string, ...string[]];
  return { ...root, [head]: rest.length === 0 ? value : setPath(isRec(root[head]) ? (root[head] as Rec) : {}, rest, value) };
}

function labelThresholdKeysOf(model: AiModelEntity): string[] {
  const taxonomy = (model.metaData as Rec | undefined)?.labelTaxonomy;
  if (!isRec(taxonomy)) return [];
  const keys = typeof taxonomy.threshold === 'number' ? [`${GUARDRAIL_LABEL_TAXONOMY_KEY_PREFIX}threshold`] : [];
  if (isRec(taxonomy.tasks)) {
    for (const [task, entry] of Object.entries(taxonomy.tasks)) {
      if (isRec(entry) && typeof entry.cls_threshold === 'number') keys.push(`${GUARDRAIL_LABEL_TAXONOMY_KEY_PREFIX}tasks.${task}.cls_threshold`);
    }
  }
  return keys;
}

/** The entry spec of a label threshold. Not in `policy-keys.json` (that is `_metadata.policy` only); bounds are a probability's. */
function labelThresholdSpec(key: string, taskKey: string): GuardrailPolicyKeySpec {
  return {
    key,
    kind: 'threshold',
    type: 'number',
    min: LABEL_THRESHOLD_MIN,
    max: LABEL_THRESHOLD_MAX,
    failMode: 'open-to-default',
    taskKey,
    // `labelTaxonomy` is hashed into guardrail's policy version (`core/policy_version.py`): a change re-screens.
    inPolicyVersion: true,
    editable: true,
  };
}

/** A resolved key: a catalogue key (`path` null → `_metadata.policy[key]`) or a label threshold (`path` inside `labelTaxonomy`). */
interface KeyRef {
  readonly spec: GuardrailPolicyKeySpec;
  readonly path: readonly string[] | null;
}

/** One key change inside a single model-row write. */
interface KeyChange {
  readonly key: string;
  readonly value: unknown;
  /** Label-threshold path inside `labelTaxonomy`; absent for a catalogue key. */
  readonly path?: readonly string[] | null;
  /** The default the change was made against (`null` = none), stored as the revision's `_metadata.defaultAtEdit`. */
  readonly defaultAtEdit?: unknown;
}

/** How many newest revisions are scanned for the last edit / restore (the "default changed since your edit" read). */
const HISTORY_SCAN = 50;
const NO_HISTORY: KeyHistory = { latest: null, lastEdit: null };
/** Revisions that record an administrator's own value (a reset puts the default back, so it is not one). */
const EDIT_REASONS: ReadonlySet<string> = new Set(['edit', 'restore']);

interface KeyHistory {
  readonly latest: GuardrailPolicyRevisionEntity | null;
  readonly lastEdit: GuardrailPolicyRevisionEntity | null;
}

/**
 * README §11.3 C — "default changed since your edit": the current value differs from the default AND the default
 * differs from the one captured (`_metadata.defaultAtEdit`) by the last edit / restore. A revision written before
 * the capture existed carries no `defaultAtEdit` and reports false.
 */
function defaultChangedSinceEdit(currentValue: unknown, defaultValue: unknown, lastEdit: GuardrailPolicyRevisionEntity | null): boolean {
  if (sameValue(currentValue, defaultValue)) return false;
  const meta = lastEdit?.metaData as Rec | null | undefined;
  if (!isRec(meta) || !Object.prototype.hasOwnProperty.call(meta, 'defaultAtEdit')) return false;
  return !sameValue(meta.defaultAtEdit, defaultValue);
}

/** Apply key changes to a `_metadata` copy. */
function applyChanges(meta: Rec, changes: readonly KeyChange[]): Rec {
  let next = { ...meta };
  for (const change of changes) {
    if (change.path) next = { ...next, labelTaxonomy: setPath(isRec(next.labelTaxonomy) ? next.labelTaxonomy : {}, change.path, change.value) };
    else next = { ...next, policy: { ...(isRec(next.policy) ? next.policy : {}), [change.key]: change.value } };
  }
  return next;
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
    const byTask = new Map<string, GuardrailPolicyKeySpec[]>();
    if (this.catalogue.available) for (const spec of this.catalogue.specs) byTask.set(spec.taskKey, [...(byTask.get(spec.taskKey) ?? []), spec]);
    for (const taskKey of GUARDRAIL_LABEL_THRESHOLD_TASK_KEYS) if (!byTask.has(taskKey)) byTask.set(taskKey, []);

    const groups: GuardrailPolicyKeyGroupResponse[] = [];
    for (const [taskKey, specs] of byTask) {
      const model = await this.resolveModel(taskKey);
      const refs: KeyRef[] = specs.map((spec) => ({ spec, path: null }));
      if (model && (GUARDRAIL_LABEL_THRESHOLD_TASK_KEYS as readonly string[]).includes(taskKey)) {
        for (const key of labelThresholdKeysOf(model)) refs.push({ spec: labelThresholdSpec(key, taskKey), path: guardrailLabelThresholdPath(key) as string[] });
      }
      if (refs.length === 0) continue;
      const keys = await Promise.all(refs.map(async (ref) => this.toEntry(ref, model, model ? await this.history(model.id, ref.spec.key) : NO_HISTORY)));
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
    return { catalogueAvailable: this.catalogue.available, groups };
  }

  async getPolicyKey(key: string, taskKey?: string): Promise<GuardrailPolicyKeyResponse> {
    this.assertPlatformAdmin('read a guardrail policy key');
    const { ref, model } = await this.resolveRef(key, taskKey, 'read');
    if (!model) throw this.modelUnresolved(ref.spec);
    return { ...this.toEntry(ref, model, await this.history(model.id, ref.spec.key)), version: model.version };
  }

  async listRevisions(key: string, limit?: number, taskKey?: string): Promise<GuardrailPolicyRevisionsResponse> {
    this.assertPlatformAdmin('read guardrail policy history');
    const { ref, model } = await this.resolveRef(key, taskKey, 'read');
    if (!model) return { key: ref.spec.key, modelId: null, revisions: [] };
    const take = Math.min(Math.max(1, Math.trunc(limit ?? REVISIONS_DEFAULT_LIMIT)), REVISIONS_MAX_LIMIT);
    const rows = await this.revisions.listByKey(model.id, ref.spec.key, take);
    return {
      key: ref.spec.key,
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

  async updatePolicyKey(key: string, request: UpdateGuardrailPolicyKeyRequest, taskKey?: string): Promise<GuardrailPolicyKeyResponse> {
    this.assertPlatformAdmin('change a guardrail policy key');
    const { ref, model } = await this.resolveRef(key, taskKey, 'write', { value: request.value });
    if (request.expectedVersion === undefined || request.expectedVersion !== model.version) {
      // RFC 7232: the precondition is evaluated before the payload. `@RequiresIfMatch()` 428s an absent header
      // at the HTTP layer, so `undefined` here is a non-HTTP caller skipping the precondition.
      throw new OptimisticConcurrencyException(String(ResourceType.AiModel), model.id, { expectedVersion: request.expectedVersion, currentVersion: model.version });
    }
    return this.writeKey(ref, model, request.value, 'edit');
  }

  async resetPolicyKey(key: string, taskKey?: string): Promise<GuardrailPolicyKeyResponse> {
    this.assertPlatformAdmin('reset a guardrail policy key');
    const { ref, model } = await this.resolveRef(key, taskKey, 'write');
    const fallback = this.defaultOf(ref, model);
    if (!fallback.has) {
      throw new ConflictException({
        code: 'GUARDRAIL_POLICY_DEFAULT_MISSING',
        message: `The seed ships no default for '${ref.spec.key}' on model '${model.slug}', so there is nothing to reset to.`,
      });
    }
    return this.writeKey(ref, model, fallback.value, 'reset');
  }

  async resetLane(lane: string): Promise<GuardrailPolicyLaneResetResponse> {
    this.assertPlatformAdmin('reset a guardrail lane');
    const taskKey = (GUARDRAIL_JUDGE_LANES as readonly string[]).includes(lane) ? guardrailJudgeLaneTaskKey(lane as GuardrailJudgeLane) : lane;
    const hasLabelThresholds = (GUARDRAIL_LABEL_THRESHOLD_TASK_KEYS as readonly string[]).includes(taskKey);
    if (!hasLabelThresholds) this.requireCatalogue();
    const specs = this.catalogue.available ? this.catalogue.specs.filter((spec) => spec.taskKey === taskKey) : [];
    if (specs.length === 0 && !hasLabelThresholds) throw new NotFoundException(`No guardrail policy keys live on '${lane}'.`);

    const model = await this.resolveModel(taskKey);
    if (!model) throw this.modelUnresolved(specs[0] ?? labelThresholdSpec(`${GUARDRAIL_LABEL_TAXONOMY_KEY_PREFIX}threshold`, taskKey));
    const refs: KeyRef[] = specs.map((spec) => ({ spec, path: null }));
    if (hasLabelThresholds) for (const key of labelThresholdKeysOf(model)) refs.push({ spec: labelThresholdSpec(key, taskKey), path: guardrailLabelThresholdPath(key) as string[] });
    if (refs.length === 0) throw new NotFoundException(`No guardrail policy keys live on '${lane}'.`);

    const changes: KeyChange[] = [];
    const skippedKeys: string[] = [];
    for (const ref of refs) {
      const fallback = this.defaultOf(ref, model);
      if (!ref.spec.editable || !fallback.has || sameValue(this.currentOf(ref, model).value, fallback.value) || this.criteriaNotApplicable(ref.spec, model)) {
        skippedKeys.push(ref.spec.key);
        continue;
      }
      changes.push({ key: ref.spec.key, value: fallback.value, path: ref.path, defaultAtEdit: fallback.value });
    }
    if (changes.length === 0) return { taskKey, version: model.version, resetKeys: [], skippedKeys };

    const { saved } = await this.commit(model, (meta) => applyChanges(meta, changes), changes, 'reset', null, taskKey);
    return { taskKey, version: saved.version, resetKeys: changes.map((change) => change.key), skippedKeys };
  }

  async restoreRevision(key: string, revisionId: string, taskKey?: string): Promise<GuardrailPolicyKeyResponse> {
    this.assertPlatformAdmin('restore a guardrail policy revision');
    if (guardrailLabelThresholdPath(key) === null) this.requireEditableSpec(key);
    const revision = await this.revisions.findById(revisionId).catch(() => null);
    if (!revision || revision.policyKey !== key) throw new NotFoundException(`Revision '${revisionId}' of '${key}' not found.`);
    const { ref, model } = await this.resolveRef(key, taskKey, 'write');
    if (revision.aiModelId !== model.id) {
      throw new ConflictException({
        code: 'GUARDRAIL_POLICY_REVISION_MODEL_MISMATCH',
        message: `Revision '${revisionId}' was written on another model row; '${ref.spec.taskKey}' now elects '${model.slug}'. A value is model-coupled and is not carried across a model switch.`,
      });
    }
    this.assertValidValue(ref.spec, revision.value);
    return this.writeKey(ref, model, revision.value, 'restore', revision.id);
  }

  // ── _metadata.judge ──────────────────────────────────────────────────────

  async getJudgeMeta(modelId: string): Promise<GuardrailJudgeMetaResponse> {
    this.assertPlatformAdmin("read a judge model's category mapping");
    return this.judgeMetaResponse(await this.requireJudgeModel(modelId));
  }

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
    const plan: Array<{ lane: GuardrailJudgeLane; taskKey: string; model: AiModelEntity }> = [];
    for (const selection of request.selections) {
      const lane = selection.lane as GuardrailJudgeLane;
      if (!(GUARDRAIL_JUDGE_LANES as readonly string[]).includes(lane)) throw new BadRequestException(`Unknown judge lane '${selection.lane}'.`);
      const model = await this.aiModels.findByIdOrNull(selection.modelId);
      if (!model || model.tenantId !== SYSTEM_TENANT_ID || model.resourceStatus === ResourceStatusType.DELETED) {
        throw new NotFoundException(`AiModel '${selection.modelId}' was not found in the platform catalogue.`);
      }
      const taskKey = guardrailJudgeLaneTaskKey(lane);
      // The same rule the routing write path applies (`guardrail.validate`: a declared judge must name
      // `medical_validation`; an undeclared legacy guardian row is allowed).
      assertRoutingModelServesJudgeLane(taskKey, model);
      plan.push({ lane, taskKey, model });
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
    const overrides = request.policy ?? {};
    if (Object.keys(overrides).length > 0) this.requireCatalogue();
    const problems: Array<{ key: string; code: string; message: string }> = [];
    for (const [key, value] of Object.entries(overrides)) {
      const spec = this.catalogue.specs.find((candidate) => candidate.key === key);
      if (!spec) {
        problems.push({ key, code: 'POLICY_KEY_UNKNOWN', message: `'${key}' is not a governed guardrail policy key.` });
        continue;
      }
      if (spec.kind !== 'criteria' && !DRAFTABLE_HYPERPARAMETERS.has(spec.key)) {
        problems.push({ key, code: 'POLICY_KEY_NOT_DRAFTABLE', message: `'${key}' cannot be drafted: a dry run takes criteria and judgeTemperature / judgeMaxTokens only.` });
        continue;
      }
      for (const problem of validateGuardrailPolicyValue(spec, value)) problems.push({ key, code: problem.code, message: problem.message });
    }
    if (problems.length > 0) throw new BadRequestException({ code: 'GUARDRAIL_POLICY_VALUE_INVALID', message: 'A draft value is invalid.', problems });

    const lanes = request.lanes as GuardrailJudgeLane[];
    const laneModels = await Promise.all(lanes.map(async (lane) => ({ lane, model: await this.resolveModel(guardrailJudgeLaneTaskKey(lane)) })));

    // A draft mapping is checked over each NATIVE lane model's stored declaration (guardrail re-checks: 422).
    const draftJudgeMeta = request.judgeMeta ? (JSON.parse(JSON.stringify(request.judgeMeta)) as Rec) : undefined;
    if (draftJudgeMeta && Object.keys(draftJudgeMeta).length > 0) {
      const metaProblems = laneModels.flatMap(({ lane, model }) => {
        const stored = (model?.metaData as Rec | undefined)?.judge;
        return isRec(stored) && stored.protocol === 'qwen3guard_native' ? judgeMetadataProblems({ ...stored, ...draftJudgeMeta }).map((p) => `${lane}: ${p}`) : [];
      });
      if (metaProblems.length > 0) throw new BadRequestException({ code: 'GUARDRAIL_JUDGE_META_INVALID', message: 'The draft judge mapping is invalid.', problems: metaProblems });
    }

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
        direction: request.direction,
        ...(request.mode !== undefined ? { mode: request.mode } : {}),
        ...(request.promptContext !== undefined ? { promptContext: request.promptContext } : {}),
        ...(Object.keys(overrides).length > 0 ? { draftPolicy: overrides } : {}),
        ...(draftJudgeMeta && Object.keys(draftJudgeMeta).length > 0 ? { draftJudgeMeta } : {}),
        samples: request.samples,
      });
    } catch (error) {
      if (error instanceof GuardrailDryRunRejectedError) {
        const detail = isRec(error.detail) ? error.detail : {};
        if (detail.code === 'JUDGE_META_INVALID') {
          throw new BadRequestException({ code: 'GUARDRAIL_JUDGE_META_INVALID', message: 'The draft judge mapping is invalid.', problems: detail.problems ?? [] });
        }
        throw new BadRequestException({ code: 'GUARDRAIL_DRY_RUN_REJECTED', message: 'Guardrail refused the dry-run request.', detail: error.detail });
      }
      if (error instanceof GuardrailDryRunUnavailableError) {
        throw new ServiceUnavailableException({ code: 'GUARDRAIL_DRY_RUN_UNAVAILABLE', message: error.message });
      }
      throw error;
    }
    const results = Array.isArray(body.results) ? body.results.filter(isRec) : [];
    return {
      persisted: false,
      latencyMs: finiteOrNull(body.latencyMs),
      models: laneModels.map(({ lane, model }) => ({ lane, modelId: model?.id ?? null, modelSlug: model?.slug ?? null })),
      results: results.map((result, index) => {
        const verdicts = isRec(result.verdicts) ? result.verdicts : {};
        return {
          sampleIndex: typeof result.sampleIndex === 'number' ? result.sampleIndex : index,
          latencyMs: finiteOrNull(result.latencyMs),
          verdicts: lanes.map((lane) => toDryRunVerdict(lane, isRec(verdicts[lane]) ? (verdicts[lane] as Rec) : undefined)),
        };
      }),
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * ROW-INDEPENDENT, so it runs first (rule 05): a SUPER_ADMIN, in a tenant-less context or the SYSTEM tenant.
   * A customer working tenant is refused because the writes target SYSTEM rows and the activity reads span
   * every tenant — the same posture as model residency and promote-to-system.
   */
  private assertPlatformAdmin(action: string): void {
    assertGuardrailPlatformAdmin(this.requestUser, this.tenantId, action);
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
    ref: KeyRef,
    model: AiModelEntity,
    value: unknown,
    reason: 'edit' | 'reset' | 'restore',
    restoredFromRevisionId: string | null = null,
  ): Promise<GuardrailPolicyKeyResponse> {
    if (sameValue(this.currentOf(ref, model).value, value)) {
      return { ...this.toEntry(ref, model, await this.history(model.id, ref.spec.key)), version: model.version, changed: false, revisionId: null };
    }
    const changes: KeyChange[] = [{ key: ref.spec.key, value, path: ref.path, defaultAtEdit: this.defaultOf(ref, model).value }];
    const { saved, revisions } = await this.commit(model, (meta) => applyChanges(meta, changes), changes, reason, restoredFromRevisionId, ref.spec.taskKey);
    const revision = revisions[0] ?? null;
    return { ...this.toEntry(ref, saved, await this.history(saved.id, ref.spec.key)), version: saved.version, changed: true, revisionId: revision?.id ?? null };
  }

  private async writeJudge(model: AiModelEntity, next: Rec, reason: 'edit' | 'reset'): Promise<GuardrailJudgeMetaResponse> {
    const problems = judgeMetadataProblems(next);
    if (problems.length > 0) {
      throw new BadRequestException({ code: 'GUARDRAIL_JUDGE_META_INVALID', message: 'The judge declaration is invalid.', problems });
    }
    const meta = (model.metaData ?? {}) as Rec;
    if (sameValue(meta.judge, next)) return this.judgeMetaResponse(model, false);
    const taskKeys = laneTaskKeysOf(next);
    const changes: KeyChange[] = [{ key: GUARDRAIL_JUDGE_META_REVISION_KEY, value: next, defaultAtEdit: isRec(meta.judgeDefaults) ? meta.judgeDefaults : null }];
    const { saved } = await this.commit(model, (current) => ({ ...current, judge: next }), changes, reason, null, taskKeys);
    return this.judgeMetaResponse(saved, true);
  }

  /** `{ modelId, slug, version, judge, judgeDefaults, isDefault, defaultChangedSinceEdit, changed? }`. */
  private async judgeMetaResponse(model: AiModelEntity, changed?: boolean): Promise<GuardrailJudgeMetaResponse> {
    const meta = (model.metaData ?? {}) as Rec;
    const judge = isRec(meta.judge) ? meta.judge : {};
    const defaults = isRec(meta.judgeDefaults) ? meta.judgeDefaults : null;
    const { lastEdit } = await this.history(model.id, GUARDRAIL_JUDGE_META_REVISION_KEY);
    return {
      modelId: model.id,
      slug: model.slug,
      version: model.version,
      judge,
      judgeDefaults: defaults,
      isDefault: defaults !== null && sameValue(judge, defaults),
      defaultChangedSinceEdit: defaults !== null && defaultChangedSinceEdit(judge, defaults, lastEdit),
      ...(changed !== undefined ? { changed } : {}),
    };
  }

  /** The newest revision and the newest edit / restore of one key on one row. */
  private async history(aiModelId: string, key: string): Promise<KeyHistory> {
    const rows = await this.revisions.listByKey(aiModelId, key, HISTORY_SCAN);
    return { latest: rows[0] ?? null, lastEdit: rows.find((row) => EDIT_REASONS.has(row.reason)) ?? null };
  }

  /**
   * ONE compare-and-set on the model row plus one revision per change, in one transaction; then the
   * invalidation publish and the sys-event (after commit, never inside it).
   */
  private async commit(
    model: AiModelEntity,
    mutate: (meta: Rec) => Rec,
    changes: readonly KeyChange[],
    reason: 'edit' | 'reset' | 'restore',
    restoredFromRevisionId: string | null,
    taskKeys: string | readonly string[],
  ): Promise<{ saved: AiModelEntity; revisions: GuardrailPolicyRevisionEntity[] }> {
    const meta = mutate({ ...((model.metaData ?? {}) as Rec) });
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
          // README §11.3 C — the default this value was set against, for "default changed since your edit".
          ...(Object.prototype.hasOwnProperty.call(change, 'defaultAtEdit') ? { metaData: { defaultAtEdit: (change.defaultAtEdit ?? null) as never } } : {}),
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
    for (const lane of GUARDRAIL_JUDGE_LANES) {
      const taskKey = guardrailJudgeLaneTaskKey(lane);
      const resolved = await this.routing.resolveDefault(SYSTEM_TENANT_ID, taskKey, { systemOnly: true }).catch(() => null);
      const declared = judges.filter((model) => ((model.metaData as Rec).judge as { lanes: readonly string[] }).lanes.includes(lane));
      // The medical judge also accepts the legacy guardian rows that declare no judge capability at all.
      const legacy =
        lane === 'medical_validation'
          ? catalogue.filter((model) => model.tenantId === SYSTEM_TENANT_ID && model.taskType === ModelTaskType.GUARDRAIL && !isRec((model.metaData as Rec | undefined)?.judge))
          : [];
      const candidates = [...declared, ...legacy].map((model) => toCandidate(model, states));
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

  /** The key's current value on the row. */
  private currentOf(ref: KeyRef, model: AiModelEntity): { has: boolean; value: unknown } {
    if (ref.path) {
      const value = getPath((model.metaData as Rec | undefined)?.labelTaxonomy, ref.path);
      return { has: value !== undefined, value: value ?? null };
    }
    const current = slotOf(model, POLICY_SLOT.current);
    const has = Object.prototype.hasOwnProperty.call(current, ref.spec.key);
    return { has, value: has ? current[ref.spec.key] : null };
  }

  /**
   * The key's default: `_metadata.policyDefaults[key]` for a catalogue key; for a label threshold
   * `_metadata.labelTaxonomyDefaults` at the same path when the seed ships one, otherwise the CURRENT value
   * (`source: 'current'` — reported, so the editor can say "no seeded default yet").
   */
  private defaultOf(ref: KeyRef, model: AiModelEntity): { has: boolean; value: unknown; source: 'seed' | 'current' | null } {
    if (ref.path) {
      const seeded = getPath((model.metaData as Rec | undefined)?.labelTaxonomyDefaults, ref.path);
      if (seeded !== undefined) return { has: true, value: seeded, source: 'seed' };
      const current = this.currentOf(ref, model);
      return current.has ? { has: true, value: current.value, source: 'current' } : { has: false, value: null, source: null };
    }
    const defaults = slotOf(model, POLICY_SLOT.defaults);
    const has = Object.prototype.hasOwnProperty.call(defaults, ref.spec.key);
    return { has, value: has ? defaults[ref.spec.key] : null, source: has ? 'seed' : null };
  }

  /**
   * A catalogue key, or a label threshold (`labelTaxonomy.threshold` / `labelTaxonomy.tasks.<task>.cls_threshold`
   * on one of {@link GUARDRAIL_LABEL_THRESHOLD_TASK_KEYS}, named by `taskKey`). A write also validates `value`
   * BEFORE the model row is read, so a bad value is a 400 whatever the row says.
   */
  private async resolveRef(key: string, taskKey: string | undefined, mode: 'read'): Promise<{ ref: KeyRef; model: AiModelEntity | null }>;
  private async resolveRef(key: string, taskKey: string | undefined, mode: 'write', check?: { value: unknown }): Promise<{ ref: KeyRef; model: AiModelEntity }>;
  private async resolveRef(key: string, taskKey: string | undefined, mode: 'read' | 'write', check?: { value: unknown }): Promise<{ ref: KeyRef; model: AiModelEntity | null }> {
    const path = guardrailLabelThresholdPath(key);
    if (path === null) {
      const spec = mode === 'write' ? this.requireEditableSpec(key) : this.requireSpec(key);
      if (check) this.assertValidValue(spec, check.value);
      const model = mode === 'write' ? await this.requireWritableModel(spec) : await this.resolveModel(spec.taskKey);
      return { ref: { spec, path: null }, model };
    }
    if (path === 'not-editable') {
      throw new BadRequestException({
        code: 'GUARDRAIL_POLICY_KEY_NOT_EDITABLE',
        message: `'${key}' is not editable: only labelTaxonomy.threshold and labelTaxonomy.tasks.<task>.cls_threshold are. Labels, the task set and benign labels are a model-version change (the model registry).`,
      });
    }
    if (!taskKey || !(GUARDRAIL_LABEL_THRESHOLD_TASK_KEYS as readonly string[]).includes(taskKey)) {
      throw new BadRequestException({
        code: 'GUARDRAIL_LABEL_THRESHOLD_TASK_KEY_REQUIRED',
        message: `'${key}' lives on several model rows: name one with ?taskKey= (${GUARDRAIL_LABEL_THRESHOLD_TASK_KEYS.join(', ')}).`,
      });
    }
    const spec = labelThresholdSpec(key, taskKey);
    if (check) this.assertValidValue(spec, check.value);
    const model = await this.resolveModel(taskKey);
    if (!model) throw this.modelUnresolved(spec);
    if (typeof getPath((model.metaData as Rec | undefined)?.labelTaxonomy, path) !== 'number') {
      throw new NotFoundException(`'${key}' is not a threshold of '${model.slug}'s label taxonomy.`);
    }
    return { ref: { spec, path }, model };
  }

  private toEntry(ref: KeyRef, model: AiModelEntity | null, { latest, lastEdit }: KeyHistory): GuardrailPolicyKeyEntryResponse {
    const { spec } = ref;
    const currentValue = model ? this.currentOf(ref, model).value : null;
    const fallback = model ? this.defaultOf(ref, model) : { has: false, value: null, source: null };
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
      defaultValue: fallback.value,
      defaultSource: fallback.source,
      isDefault: sameValue(currentValue, fallback.value),
      defaultChangedSinceEdit: fallback.has ? defaultChangedSinceEdit(currentValue, fallback.value, lastEdit) : false,
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
    // `undeclared`: a legacy guardian row with no `_metadata.judge` (served as criteria_json on the medical lane).
    protocol: typeof judge?.protocol === 'string' ? judge.protocol : 'undeclared',
    servedBy: typeof servedBy === 'string' ? servedBy : null,
    residency: residencyOf(states, model.id),
  };
}

const DRY_RUN_VERDICTS = ['pass', 'flag', 'undetermined'];

/** The two non-criteria keys guardrail's dry run accepts as drafts (`judge_dry_run._DRAFTABLE_KEYS`). */
const DRAFTABLE_HYPERPARAMETERS: ReadonlySet<string> = new Set(['judgeTemperature', 'judgeMaxTokens']);

const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function toDryRunVerdict(lane: string, reported: Rec | undefined): GuardrailDryRunVerdict {
  return {
    lane,
    verdict: typeof reported?.verdict === 'string' && DRY_RUN_VERDICTS.includes(reported.verdict) ? reported.verdict : 'undetermined',
    category: stringOrNull(reported?.category),
    confidence: finiteOrNull(reported?.confidence),
    model: stringOrNull(reported?.model),
    latencyMs: finiteOrNull(reported?.latencyMs),
    tier: stringOrNull(reported?.tier),
  };
}
