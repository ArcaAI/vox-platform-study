import {
  GuardrailDryRunRequest,
  GuardrailDryRunResponse,
  GuardrailJudgeLanesResponse,
  GuardrailJudgeMetaResponse,
  GuardrailPolicyKeyResponse,
  GuardrailPolicyKeysResponse,
  GuardrailPolicyLaneResetResponse,
  GuardrailPolicyRevisionsResponse,
  IGuardrailPolicyService,
  UpdateGuardrailJudgeLanesRequest,
  UpdateGuardrailJudgeMetaRequest,
  UpdateGuardrailPolicyKeyRequest,
} from '@arcaai/applications';
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  CanManage,
  CanRead,
  CanUpdate,
  ExpectedVersion,
  ForbidApiKey,
  NoOptimisticConcurrency,
  RequiredSvcScopes,
  RequiresIfMatch,
} from '../../decorators';

const SCOPE = 'svc:admin:guardrail:manage';
const FORBIDDEN = 'Not a platform administrator, or a customer working tenant is selected (guardrail control is platform-wide and tenant-less).';
const TASK_KEY_QUERY = {
  name: 'taskKey',
  required: false,
  description:
    'Required for a label threshold (`labelTaxonomy.threshold`, `labelTaxonomy.tasks.<task>.cls_threshold`): the model row it lives on — `guardrail.safety`, `guardrail.injection`, `guardrail.pii` or `guardrail.pii.spans`. Ignored for a catalogue key.',
  example: 'guardrail.safety',
};
const LABEL_400 =
  '`GUARDRAIL_LABEL_THRESHOLD_TASK_KEY_REQUIRED` (a label threshold without `?taskKey=`), or `GUARDRAIL_POLICY_KEY_NOT_EDITABLE` (labels, the task set, benign labels).';
const IF_MATCH = {
  name: 'If-Match',
  description: 'RFC 7232 strong validator: the model row `_version` from the prior read (the key entry `modelVersion`, or the `ETag`).',
  required: true,
  example: '"7"',
};

/**
 * TASK-1050 W2h (README §11.3 B/C, §12.2) — the platform guardrail policy plane: the governed policy keys on the
 * SYSTEM guardrail model rows (current, default, revisions, reset, restore), a native guard's category mapping,
 * the judge model per lane, and the dry run.
 *
 * AUTH-NOTE: the class-level `@CanManage('AiModel')` UNDERSTATES the real gate on every route here. There is no
 * "super admin" CASL subject; the actual control — SUPER_ADMIN in a tenant-less (or SYSTEM) context — is enforced
 * imperatively in `assertGuardrailPlatformAdmin` (`GuardrailPolicyService`), because tenant admins legitimately
 * hold `manage:AiModel` for their own BYO rows while only the platform admin manages guardrail detail (owner
 * re-scope, README §11.1). The gate is ROW-INDEPENDENT, so it runs FIRST (the promote-to-system ordering): 403 for
 * every non-platform-admin; an unknown key, model or revision is still a 404 after it. Never widen a decorator
 * here without reading the service first.
 *
 * `@ForbidApiKey()` keeps the business plane out; a service account needs `svc:admin:guardrail:manage` on every
 * route (one scope: every route is a platform-administration act).
 */
@ApiBearerAuth()
@ApiTags('admin-guardrail-availability')
@ForbidApiKey()
@Controller('admin/guardrail')
@CanManage('AiModel')
export class GuardrailPolicyController {
  constructor(@Inject(IGuardrailPolicyService) private readonly service: IGuardrailPolicyService) {}

  // AUTH-NOTE: platform-admin only, imperatively, row-independent — see the class note.
  @Get('policy-keys')
  @CanRead('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'List every governed guardrail policy key, grouped by its model row',
    description:
      'Every key of the guardrail policy-key catalogue (`policy-keys.json`, generated from guardrail `_SPECS`), grouped by the routing task key whose ' +
      'SYSTEM model row it lives on: current value (`_metadata.policy`), default (`_metadata.policyDefaults`, seed-owned), bounds, editability, ' +
      'the model row and its `_version`, and the last revision. `catalogueAvailable: false` when the artifact cannot be read (then no key is writable).',
  })
  @ApiResponse({ status: 200, type: GuardrailPolicyKeysResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  async list(): Promise<GuardrailPolicyKeysResponse> {
    return this.service.listPolicyKeys();
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Get('policy-keys/:key')
  @CanRead('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({ summary: 'Read one guardrail policy key', description: 'The key entry plus `version` (the model row `_version`, also the ETag).' })
  @ApiParam({ name: 'key', example: 'judgeTemperature' })
  @ApiQuery(TASK_KEY_QUERY)
  @ApiResponse({ status: 200, type: GuardrailPolicyKeyResponse })
  @ApiResponse({ status: 400, description: LABEL_400 })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'Not a governed guardrail policy key (or not a threshold of that row`s label taxonomy).' })
  @ApiResponse({ status: 409, description: '`GUARDRAIL_POLICY_MODEL_UNRESOLVED` — the key`s task key elects no SYSTEM model.' })
  @ApiResponse({ status: 503, description: '`GUARDRAIL_POLICY_CATALOGUE_UNAVAILABLE`.' })
  async get(@Param('key') key: string, @Query('taskKey') taskKey?: string): Promise<GuardrailPolicyKeyResponse> {
    return this.service.getPolicyKey(key, taskKey);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Put('policy-keys/:key')
  @RequiresIfMatch()
  @CanUpdate('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'Change one guardrail policy key on its SYSTEM model row',
    description:
      'Validates the value against the catalogue (type, bounds; `judgeBands` per check `low <= high` inside the bounds) and, for a safety-judge ' +
      'criteria key, against the judge template (five sections, the two locked sections verbatim, exactly the lane`s verdict categories — OD-34). ' +
      'Writes `_metadata.policy[key]` under a compare-and-set on the model row `_version`, appends a `GuardrailPolicyRevision` (reason `edit`) in the ' +
      'same transaction, broadcasts a sys-event and publishes `guardrail:config:invalidate`. A key in the policy version re-screens (busts the ' +
      'window-verdict cache). A value equal to the current one is an idempotent no-op (`changed: false`). A classifier threshold inside ' +
      '`_metadata.labelTaxonomy` (`labelTaxonomy.threshold`, `labelTaxonomy.tasks.<task>.cls_threshold`, in [0, 1]) is written the same way, ' +
      'named with `?taskKey=`; labels, the task set and benign labels are not editable.',
  })
  @ApiHeader(IF_MATCH)
  @ApiParam({ name: 'key', example: 'judgeTemperature' })
  @ApiQuery(TASK_KEY_QUERY)
  @ApiResponse({ status: 200, type: GuardrailPolicyKeyResponse })
  @ApiResponse({ status: 400, description: `\`GUARDRAIL_POLICY_VALUE_INVALID\` (with \`problems\`), ${LABEL_400}` })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'Not a governed guardrail policy key (or not a threshold of that row`s label taxonomy).' })
  @ApiResponse({
    status: 409,
    description: '`GUARDRAIL_POLICY_MODEL_UNRESOLVED`, or `GUARDRAIL_CRITERIA_NOT_APPLICABLE` (the lane elects a native-template guard).',
  })
  @ApiResponse({ status: 412, description: 'The model row changed since it was read.' })
  @ApiResponse({ status: 428, description: 'If-Match is required.' })
  async update(
    @Param('key') key: string,
    @Body() request: UpdateGuardrailPolicyKeyRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('taskKey') taskKey?: string,
  ): Promise<GuardrailPolicyKeyResponse> {
    return this.service.updatePolicyKey(key, { ...request, expectedVersion: expectedFromHeader ?? request.expectedVersion }, taskKey);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Post('policy-keys/reset')
  @HttpCode(HttpStatus.OK)
  @NoOptimisticConcurrency('reset-to-default: "put the seed default back whatever it says now"; the service CASes on the version it just read')
  @CanUpdate('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'Reset every editable key of one lane (model row) to its default',
    description:
      'Copies `_metadata.policyDefaults[key]` into `_metadata.policy[key]` for every editable key of the row that ships a default and differs from ' +
      'it, in ONE compare-and-set, one `reset` revision per key. `lane` is a routing task key (`guardrail.safety`) or a judge lane id (`injection_judge`).',
  })
  @ApiQuery({ name: 'lane', required: true, example: 'guardrail.safety' })
  @ApiResponse({ status: 200, type: GuardrailPolicyLaneResetResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'No policy key lives on that lane.' })
  @ApiResponse({ status: 409, description: '`GUARDRAIL_POLICY_MODEL_UNRESOLVED`.' })
  async resetLane(@Query('lane') lane: string): Promise<GuardrailPolicyLaneResetResponse> {
    return this.service.resetLane(lane ?? '');
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Post('policy-keys/:key/reset')
  @HttpCode(HttpStatus.OK)
  @NoOptimisticConcurrency('reset-to-default: "put the seed default back whatever it says now"; the service CASes on the version it just read')
  @CanUpdate('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'Reset one guardrail policy key to its default',
    description:
      'Copies `_metadata.policyDefaults[key]` into current as a `reset` revision (OD-33); a label threshold copies `_metadata.labelTaxonomyDefaults` ' +
      'at the same path (no seeded default yet: the current value is the default, so this is a no-op). Already at default: idempotent no-op.',
  })
  @ApiParam({ name: 'key', example: 'injectionJudgeCriteria' })
  @ApiQuery(TASK_KEY_QUERY)
  @ApiResponse({ status: 200, type: GuardrailPolicyKeyResponse })
  @ApiResponse({ status: 400, description: LABEL_400 })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'Not a governed guardrail policy key.' })
  @ApiResponse({
    status: 409,
    description: '`GUARDRAIL_POLICY_DEFAULT_MISSING`, `GUARDRAIL_POLICY_MODEL_UNRESOLVED`, or `GUARDRAIL_CRITERIA_NOT_APPLICABLE`.',
  })
  async reset(@Param('key') key: string, @Query('taskKey') taskKey?: string): Promise<GuardrailPolicyKeyResponse> {
    return this.service.resetPolicyKey(key, taskKey);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Get('policy-keys/:key/revisions')
  @CanRead('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'A guardrail policy key`s revision history',
    description: 'Newest first, with values, on the CURRENT model row of the key.',
  })
  @ApiParam({ name: 'key', example: 'injectionJudgeCriteria' })
  @ApiQuery({ name: 'limit', required: false, description: '1–200, default 50.' })
  @ApiQuery(TASK_KEY_QUERY)
  @ApiResponse({ status: 200, type: GuardrailPolicyRevisionsResponse })
  @ApiResponse({ status: 400, description: LABEL_400 })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'Not a governed guardrail policy key.' })
  async revisions(
    @Param('key') key: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('taskKey') taskKey?: string,
  ): Promise<GuardrailPolicyRevisionsResponse> {
    return this.service.listRevisions(key, limit, taskKey);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Post('policy-keys/:key/revisions/:revisionId/restore')
  @HttpCode(HttpStatus.OK)
  @NoOptimisticConcurrency('restore: the named revision IS the target value; the service CASes on the version it just read')
  @CanUpdate('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'Restore a guardrail policy key to an earlier revision',
    description: 'Re-validates the revision value against TODAY`s catalogue, then writes it as a `restore` revision naming its source.',
  })
  @ApiParam({ name: 'key', example: 'judgeTemperature' })
  @ApiParam({ name: 'revisionId' })
  @ApiQuery(TASK_KEY_QUERY)
  @ApiResponse({ status: 200, type: GuardrailPolicyKeyResponse })
  @ApiResponse({
    status: 400,
    description: '`GUARDRAIL_POLICY_VALUE_INVALID` (the old value breaks today`s bounds), or `GUARDRAIL_POLICY_KEY_NOT_EDITABLE`.',
  })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'Unknown key, or no such revision of it.' })
  @ApiResponse({ status: 409, description: '`GUARDRAIL_POLICY_REVISION_MODEL_MISMATCH` — the revision was written on another model row.' })
  async restore(
    @Param('key') key: string,
    @Param('revisionId') revisionId: string,
    @Query('taskKey') taskKey?: string,
  ): Promise<GuardrailPolicyKeyResponse> {
    return this.service.restoreRevision(key, revisionId, taskKey);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Get('judge-models/:modelId/judge-meta')
  @CanRead('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'Read a judge model`s declaration and its default',
    description:
      '`_metadata.judge` and `_metadata.judgeDefaults` of a SYSTEM judge model, `version` (the model row `_version`, also the ETag to send as ' +
      '`If-Match` on the PUT), `isDefault`, and `defaultChangedSinceEdit` (the seed moved the default since the last edit).',
  })
  @ApiParam({ name: 'modelId' })
  @ApiResponse({ status: 200, type: GuardrailJudgeMetaResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'No SYSTEM model with a judge declaration.' })
  async getJudgeMeta(@Param('modelId') modelId: string): Promise<GuardrailJudgeMetaResponse> {
    return this.service.getJudgeMeta(modelId);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Put('judge-models/:modelId/judge-meta')
  @RequiresIfMatch()
  @CanUpdate('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'Change a native guard`s category map and tier mapping',
    description:
      'The editable half of `_metadata.judge` on a SYSTEM judge model (README §12.2): `categoryMap` and/or `tiers`. `protocol` and `lanes` are its ' +
      'capability declaration and are not editable. The merged declaration is validated with `judgeMetadataProblems`; written under a compare-and-set ' +
      'on the model row with a `judge` revision, a sys-event and the invalidation publish for the lanes it declares.',
  })
  @ApiHeader(IF_MATCH)
  @ApiParam({ name: 'modelId' })
  @ApiResponse({ status: 200, type: GuardrailJudgeMetaResponse })
  @ApiResponse({ status: 400, description: '`GUARDRAIL_JUDGE_META_INVALID` (with `problems`).' })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'No SYSTEM model with a judge declaration.' })
  @ApiResponse({ status: 412, description: 'The model row changed since it was read.' })
  @ApiResponse({ status: 428, description: 'If-Match is required.' })
  async updateJudgeMeta(
    @Param('modelId') modelId: string,
    @Body() request: UpdateGuardrailJudgeMetaRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<GuardrailJudgeMetaResponse> {
    return this.service.updateJudgeMeta(modelId, { ...request, expectedVersion: expectedFromHeader ?? request.expectedVersion });
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Post('judge-models/:modelId/judge-meta/reset')
  @HttpCode(HttpStatus.OK)
  @NoOptimisticConcurrency('reset-to-default: "put the seed default back whatever it says now"; the service CASes on the version it just read')
  @CanUpdate('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'Reset a native guard`s mapping to its default',
    description: 'Copies `_metadata.judgeDefaults` (seed-owned) into `_metadata.judge`.',
  })
  @ApiParam({ name: 'modelId' })
  @ApiResponse({ status: 200, type: GuardrailJudgeMetaResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'No SYSTEM model with a judge declaration.' })
  @ApiResponse({ status: 409, description: '`GUARDRAIL_JUDGE_DEFAULT_MISSING`.' })
  async resetJudgeMeta(@Param('modelId') modelId: string): Promise<GuardrailJudgeMetaResponse> {
    return this.service.resetJudgeMeta(modelId);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Get('judge-lanes')
  @CanRead('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'The judge model per safety-judge lane, with the selectable candidates',
    description:
      'Per lane: its routing task key (`guardrail.judge.*`), the elected SYSTEM row and model, and every SYSTEM model whose `_metadata.judge` ' +
      'declares the lane, with protocol, `servedBy` and read-only residency (load / unload live on `/model-residency`).',
  })
  @ApiResponse({ status: 200, type: GuardrailJudgeLanesResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  async lanes(): Promise<GuardrailJudgeLanesResponse> {
    return this.service.getJudgeLanes();
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Put('judge-lanes')
  @NoOptimisticConcurrency(
    'election: each lane is a new routing revision elected atomically by AiRoutingPolicyService.setDefault (partial unique index)',
  )
  @CanUpdate('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'Select the judge model for one or more lanes',
    description:
      'Every selection is validated before any is written: the model must be a SYSTEM model whose `_metadata.judge` declares the lane, else 400 ' +
      '`JUDGE_LANE_UNSUPPORTED` (`medical_validation` also accepts a legacy guardian row with no declaration, and refuses one that declares ' +
      'other lanes only). A changed lane gets a new SYSTEM `AiRoutingPolicy` revision (create → activate → elect) and the invalidation publish; ' +
      'an unchanged one writes nothing. Lanes not named are untouched.',
  })
  @ApiResponse({ status: 200, type: GuardrailJudgeLanesResponse })
  @ApiResponse({ status: 400, description: '`JUDGE_LANE_UNSUPPORTED`, or an invalid body.' })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 404, description: 'Unknown or non-platform model.' })
  async selectLanes(@Body() request: UpdateGuardrailJudgeLanesRequest): Promise<GuardrailJudgeLanesResponse> {
    return this.service.updateJudgeLanes(request);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Post('dry-run')
  @HttpCode(HttpStatus.OK)
  @NoOptimisticConcurrency('read-only evaluation: a dry run writes no row and no cache entry anywhere')
  @CanRead('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'Dry-run draft judge configuration on samples against the live judge',
    description:
      'Validates the draft values exactly as a save would, checks that each lane`s model is RESIDENT (never loads one — OD-35), then runs guardrail`s ' +
      '`POST /api/v1/guardrail/judge/dry-run` as SYSTEM. Answers per sample, per lane, with latency. Persists nothing.',
  })
  @ApiResponse({ status: 200, type: GuardrailDryRunResponse })
  @ApiResponse({
    status: 400,
    description: '`GUARDRAIL_POLICY_VALUE_INVALID`, `GUARDRAIL_JUDGE_META_INVALID`, `GUARDRAIL_DRY_RUN_REJECTED`, or an invalid body.',
  })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  @ApiResponse({ status: 409, description: '`MODEL_NOT_RESIDENT` — `{ link: "/model-residency", models: [{ lane, modelId, slug, state }] }`.' })
  @ApiResponse({ status: 503, description: '`GUARDRAIL_DRY_RUN_UNAVAILABLE`.' })
  async dryRun(@Body() request: GuardrailDryRunRequest): Promise<GuardrailDryRunResponse> {
    return this.service.dryRun(request);
  }
}
