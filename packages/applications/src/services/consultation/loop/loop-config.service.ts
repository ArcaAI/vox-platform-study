import { Inject, Injectable, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataNotFoundException } from '@arcaai/exceptions';
import {
  ConsultationContextSchemaRepository,
  ConsultationContextSchemaScope,
  ConsultationContextSchemaStatus,
  ConsultationContextSchemaVersionEntity,
  ConsultationContextSchemaVersionRepository,
  ConsultationEntity,
  ConsultationRepository,
  ResourceType,
  WorkflowDefinitionEntity,
  WorkflowDefinitionRepository,
} from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { ContextPrimitive, type ContextKindDeclaration } from '../../consultation-context-schema/context-schema-definition';
import { IWorkflowAssignmentService } from '../../workflow-assignment/IWorkflowAssignmentService';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { CONSULTATION_ENDPOINT_ACTIONS_DEFAULT, CONSULTATION_ENDPOINT_ACTIONS_KEY, resolveEndpointSequence } from './endpoint-sequence';
import { ILoopConfigService } from './ILoopConfigService';
import { HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_DEFAULT, HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_KEY } from './loop-lifecycle.constants';
import { LoopConfigResponse, LoopSubscriptionDto } from './dto';

/** The bounded execution envelope. */
export const LOOP_CONFIG_MAX_DEPTH = 3;
export const LOOP_CONFIG_MAX_ACTIONS = 200;

/** The palette whose assigned definition governs a consultation. */
const CONSULTATION_PALETTE_KEY = 'consultation';

/**
 * Per-primitive default action list a subscribed kind resolves to.
 *
 * `STREAM_AUDIO` is absent from the SUBSCRIPTION set entirely (see
 * `buildSubscriptions`), so it has no entry here — an audio session is a
 * lifecycle, not a context arrival.
 */
const PRIMITIVE_DEFAULT_ACTIONS: Record<ContextPrimitive, string[]> = {
  STREAM_AUDIO: [],
  TEXT: ['client.emit'],
  DOCUMENT: ['document.extract_text', 'client.emit'],
  IMAGE: ['vision.extract_text', 'client.emit'],
  STRUCTURED: ['client.emit'],
};

/**
 * A fully disabled config, used for every degradation branch.
 *
 * `idleTimeoutSeconds` is null here rather than the resolved bound, and that is
 * not an oversight: a disabled loop takes `ConsultationLoopWorkflow`'s DISABLED
 * branch, which completes IMMEDIATELY and never reaches the wait at all. Giving
 * it a bound would imply a wait that does not exist.
 */
function disabledResponse(consultationId: string | null, departmentId: string | null): LoopConfigResponse {
  return {
    enabled: false,
    consultationId,
    departmentId,
    agentId: null,
    agentConfigVersionId: null,
    contextSchemaVersionId: null,
    subscriptions: [],
    budget: { maxDepth: LOOP_CONFIG_MAX_DEPTH, maxActions: LOOP_CONFIG_MAX_ACTIONS },
    startActions: [],
    endingActions: [],
    reasoningEnabled: false,
    agents: [],
    idleTimeoutSeconds: null,
    // A disabled loop takes the workflow's DISABLED branch and completes immediately, so it never
    // reaches the wait, never expires, and never runs an endpoint stage. `false` is the honest
    // value; `true` would advertise a behaviour that cannot occur.
    endpointOnTimeout: false,
  };
}

/** Every kind the servable schema version declares, in authored order. */
function declaredKinds(version: ConsultationContextSchemaVersionEntity | null): ContextKindDeclaration[] {
  const definition = version?.definition as { kinds?: unknown } | null | undefined;
  const kinds = definition?.kinds;
  if (!Array.isArray(kinds)) return [];
  return kinds.filter(
    (kind): kind is ContextKindDeclaration => typeof kind === 'object' && kind !== null && typeof (kind as { key?: unknown }).key === 'string',
  );
}

/**
 * Resolves the deterministic, read-only loop configuration for one
 * consultation: which workflow definition / definition-version / context-schema
 * version govern it, and the per-kind action subscriptions + start/ending action
 * lists `ConsultationLoopWorkflow` dispatches.
 *
 * ## What changed
 *
 * Every field this service used to read off a `DepartmentAgent` now comes from
 * the tenant's own configuration:
 *
 * | Field | Source |
 * |---|---|
 * | `agentId` | the governing `WorkflowDefinition`'s SLUG — its identity across versions |
 * | `agentConfigVersionId` | that definition's ROW id; rows ARE versions, so the row IS the pin |
 * | `subscriptions` | the kinds the servable context schema DECLARES, crossed with their primitives |
 * | `startActions` / `endingActions` | the tenant's ordered `consultation.endpoint.actions` list |
 * | `agents[]` / `reasoningEnabled` | retired with `DepartmentAgentRole` — `[]` / `false` |
 *
 * The two identifier FIELD NAMES are deliberately unchanged. `agent_id` and
 * `agent_config_version_id` on the Python `ConsultationLoopConfig` thread
 * through Temporal workflow history and are replay-sensitive, so this replaces
 * the identifier SOURCE and keeps the wire names — the replay-safe option.
 *
 * ## Two levers that left, and why nothing replaced them
 *
 * The agent carried `alwaysActions` (EXTEND) and `neverActions` (VETO) over the
 * endpoint stage. Both are subsumed by the ordered
 * `consultation.endpoint.actions` list introduced, which can add,
 * ORDER and omit — strictly more than the two levers could express between
 * them. `resolveEndpointSequence` still accepts them as optional inputs (they
 * are its own tested contract); this service simply no longer supplies any.
 *
 * The PRIMARY/SPECIALIST roster was expressed entirely in `DepartmentAgentRole`,
 * an enum this ticket drops, and the graph substrate has no equivalent concept.
 * The deliberative lane therefore retires with it. Both fields stay on the
 * response because the contract is a deliverable — and because the Python
 * model's defaults for them are exactly `[]` / `false`, which is what keeps the
 * frozen loop replay fixture green.
 *
 * Every resolution failure (missing/cross-tenant consultation, no department, no
 * governing definition, no servable context schema) degrades to the disabled
 * config — this is a service-token internal read with no user to surface an
 * error to, so it must never throw.
 */
@Injectable()
export class LoopConfigService extends BaseService implements ILoopConfigService {
  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly contextSchemaRepository: ConsultationContextSchemaRepository,
    private readonly contextSchemaVersionRepository: ConsultationContextSchemaVersionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // `@Optional()` mirrors `LoopContextSignalService`: absent ⇒ the code
    // default applies, which is a BOUNDED loop. That is the safe direction — an
    // unwired resolver must not silently restore the unbounded wait.
    @Optional() @Inject(TenantSettingsService) private readonly tenantSettings?: TenantSettingsService,
    // The governing definition. Optional + trailing for the same reason the
    // realtime executor's copies are: an unwired resolver degrades to "no
    // definition", which is the same shape as a department that never had a
    // default agent — never to a throw on an internal read.
    @Optional() @Inject(IWorkflowAssignmentService) private readonly workflowAssignments?: IWorkflowAssignmentService,
    @Optional() @Inject(WorkflowDefinitionRepository) private readonly workflowDefinitionRepository?: WorkflowDefinitionRepository,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  /**
   * The loop's IDLE bound, in seconds.
   *
   * Read HERE, once per consultation, because this is the resolution the
   * workflow PINS at start — not per signal, the way the
   * `harness.loop.emergencyStop` veto is. `resolvePlatform` is the platform
   * lane (`maxScope: 'system'`) and is synchronous: it reads the in-memory
   * settings cache and does no I/O.
   *
   * A non-positive stored value is treated as "no bound". Someone typing `0`
   * into an admin field almost certainly means "turn this off", and the
   * alternative — a zero-second idle bound — would abandon every consultation
   * the instant it went quiet.
   */
  private resolveIdleTimeoutSeconds(): number | null {
    const resolved = this.tenantSettings
      ? this.tenantSettings.resolvePlatform<number>(HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_KEY).value
      : HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_DEFAULT;
    return typeof resolved === 'number' && Number.isFinite(resolved) && resolved > 0 ? resolved : null;
  }

  async resolveForConsultation(tenantId: string, consultationId: string): Promise<LoopConfigResponse> {
    const consultation = await this.findConsultationTolerant(consultationId);
    if (!consultation || consultation.tenantId !== tenantId) {
      return disabledResponse(null, null);
    }

    const departmentId = consultation.departmentId ?? null;
    if (!departmentId) {
      return disabledResponse(consultationId, null);
    }

    const definition = await this.resolveGoverningDefinition(tenantId, departmentId);
    const servableVersion = await this.resolveServableContextSchemaVersion(tenantId, departmentId);
    const contextSchemaVersionId = servableVersion?.id ?? null;

    // Same shape as before: the loop is on when EITHER source of governance
    // exists. A tenant with a published graph but no context schema still has a
    // loop; so does one with a schema and no graph. Neither ⇒ the DISABLED
    // response, early — a disabled loop completes immediately and never reaches
    // the idle wait, so it must not be handed a bound that implies one.
    if (definition === null && contextSchemaVersionId === null) {
      return disabledResponse(consultationId, departmentId);
    }

    const kinds = declaredKinds(servableVersion);
    const subscriptions = this.buildSubscriptions(kinds);
    const { startActions, endingActions } = this.deriveStartAndEndingActions(tenantId);

    return {
      enabled: true,
      consultationId,
      departmentId,
      agentId: definition?.slug ?? null,
      agentConfigVersionId: definition?.id ?? null,
      contextSchemaVersionId,
      subscriptions,
      budget: { maxDepth: LOOP_CONFIG_MAX_DEPTH, maxActions: LOOP_CONFIG_MAX_ACTIONS },
      startActions,
      endingActions,
      // The deliberative lane retired with `DepartmentAgentRole` — see the class
      // docstring. Reported honestly rather than dropped from the contract.
      reasoningEnabled: false,
      agents: [],
      // Pinned here, frozen for the whole consultation.
      idleTimeoutSeconds: this.resolveIdleTimeoutSeconds(),
      // D-12. Always true from this gateway: a timed-out consultation that never finalizes
      // silently loses the encounter. The harness-side default is FALSE, which is what keeps the
      // frozen replay fixtures green — see the field's doc on `LoopConfigResponse`.
      endpointOnTimeout: true,
    };
  }

  /**
   * The ACTIVE PUBLISHED `consultation` definition governing this department,
   * resolved through the shared `department -> tenant -> platform default`
   * assignment cascade — the same walk the realtime executor and the tier-1a
   * prompt chain make, so all three agree on which graph governs.
   *
   * Total: an unwired resolver, an unassigned palette, a slug whose definition
   * was deprecated, or a failed read all yield null.
   */
  private async resolveGoverningDefinition(tenantId: string, departmentId: string): Promise<WorkflowDefinitionEntity | null> {
    if (!this.workflowAssignments || !this.workflowDefinitionRepository) return null;
    try {
      const assignment = await this.workflowAssignments.resolve(tenantId, CONSULTATION_PALETTE_KEY, departmentId);
      if (!assignment.workflowDefinitionSlug) return null;
      return await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, assignment.workflowDefinitionSlug);
    } catch {
      return null;
    }
  }

  /** `findById` throws `DataNotFoundException` on a miss (incl. a cross-tenant id, hidden by the tenant-scope extension) — never surfaced as a throw here. */
  private async findConsultationTolerant(consultationId: string): Promise<ConsultationEntity | null> {
    try {
      return await this.consultationRepository.findById(consultationId);
    } catch (err) {
      if (err instanceof DataNotFoundException) return null;
      throw err;
    }
  }

  /**
   * The department's servable context-schema vocabulary version
   * (DEPARTMENT-scoped default → TENANT-scoped default → none).
   */
  private async resolveServableContextSchemaVersion(tenantId: string, departmentId: string): Promise<ConsultationContextSchemaVersionEntity | null> {
    const candidates = [
      await this.contextSchemaRepository.findDefaultForScope(tenantId, ConsultationContextSchemaScope.DEPARTMENT, departmentId),
      await this.contextSchemaRepository.findDefaultForScope(tenantId, ConsultationContextSchemaScope.TENANT, null),
    ];

    for (const schema of candidates) {
      if (!schema) continue;
      const servable =
        schema.pinnedVersionNumber != null &&
        (schema.status === ConsultationContextSchemaStatus.PUBLISHED || schema.status === ConsultationContextSchemaStatus.APPROVED);
      if (!servable) continue;
      const version = await this.contextSchemaVersionRepository.findBySchemaAndVersionNumber(schema.id, schema.pinnedVersionNumber as number);
      if (version) return version;
    }
    return null;
  }

  /**
   * One subscription per DECLARED kind, carrying that primitive's default
   * action list — EXCEPT `STREAM_AUDIO` kinds, which are not subscribed at all.
   *
   * The set used to be the intersection of the agent's `subscribedKinds` and
   * the schema's declarations. With the agent gone the schema declares the
   * whole vocabulary on its own, which is what a context schema IS, and there
   * is no second place for a tenant to narrow it.
   *
   * The audio exclusion is not a convenience — it reproduces a deliberate
   * decision the seeded day-1 agent encoded by omission. An audio stream is a
   * SESSION, whose lifecycle `consultation.controller.ts` already owns
   * (`recording/start` -> `LiveDocumentationService.start`, `recording/stop` ->
   * `.stop`). Subscribing it here would put `livedoc.start`/`livedoc.stop` into
   * the loop's action lists ON TOP of that — a second start and a second stop
   * per consultation. Encoding it as a rule rather than leaving it to whoever
   * authors the schema removes a foot-gun that used to be one checkbox away.
   *
   * A kind whose primitive is unrecognised resolves to no actions rather than
   * being dropped, so it stays visible in the pinned config.
   */
  private buildSubscriptions(kinds: ContextKindDeclaration[]): LoopSubscriptionDto[] {
    return kinds
      .filter((kind) => kind.primitive !== 'STREAM_AUDIO')
      .map((kind) => ({
        kindKey: kind.key,
        actions: [...(PRIMITIVE_DEFAULT_ACTIONS[kind.primitive as ContextPrimitive] ?? [])],
      }));
  }

  /**
   * The tenant's ORDERED endpoint sequence (D-10).
   *
   * Read here, once per consultation, for the same reason the idle bound is: this is the
   * resolution the workflow PINS at start, so a mid-consultation edit cannot reorder the stage of
   * a run already underway. `resolve` (not `resolvePlatform`) because the key is
   * `maxScope: 'tenant'` — the endpoint stage is where a tenant's own compliance posture shows
   * up, and the read path enforces the same clamp the write path does.
   *
   * Anything other than an array of strings degrades to the platform default rather than to an
   * empty stage. A malformed `GlobalSetting` row must never mean "close consultations without
   * finalizing them"; `resolveEndpointSequence` applies the same rule to the entries themselves.
   */
  private resolveConfiguredEndpointActions(tenantId: string): readonly string[] {
    if (!this.tenantSettings) return CONSULTATION_ENDPOINT_ACTIONS_DEFAULT;
    const resolved = this.tenantSettings.resolve<unknown>(CONSULTATION_ENDPOINT_ACTIONS_KEY, tenantId).value;
    return Array.isArray(resolved) ? (resolved as readonly string[]) : CONSULTATION_ENDPOINT_ACTIONS_DEFAULT;
  }

  /**
   * The consultation's start actions and its ENDPOINT SEQUENCE.
   *
   * `hasStreamAudio` is FALSE, unconditionally, and that is a decision rather than a stub. The
   * live-documentation lifecycle is not this loop's to drive: `consultation.controller.ts` owns
   * it on the legacy path, and the realtime lane owns it for a tenant-authored graph. When it
   * was agent-derived, a tenant one checkbox away from subscribing an agent to an audio kind got
   * a SECOND `livedoc.start` and a SECOND `livedoc.stop` per consultation — which is why the
   * seeded day-1 agent pointedly did not subscribe to `audio_stream` even though the schema
   * declares it. Removing the lever removes the hazard, and reproduces the seeded behaviour
   * exactly. `resolveEndpointSequence` still drops `livedoc.stop` on this input, which is the
   * stage every consultation runs today.
   *
   * `alwaysActions` / `neverActions` are no longer supplied — see the class docstring.
   */
  private deriveStartAndEndingActions(tenantId: string): { startActions: string[]; endingActions: string[] } {
    return {
      startActions: [],
      endingActions: resolveEndpointSequence({
        configured: this.resolveConfiguredEndpointActions(tenantId),
        hasStreamAudio: false,
      }),
    };
  }
}
