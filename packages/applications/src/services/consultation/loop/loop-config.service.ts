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
  DepartmentAgentEntity,
  DepartmentAgentRepository,
  DepartmentAgentRole,
  DepartmentAgentVersionRepository,
  ResourceType,
} from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { ContextPrimitive, findKind } from '../../consultation-context-schema/context-schema-definition';
import { AgentActionKey, subscribedKindsProblems, writeScopeProblems } from '../../departmentAgent/constants';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { CONSULTATION_ENDPOINT_ACTIONS_DEFAULT, CONSULTATION_ENDPOINT_ACTIONS_KEY, resolveEndpointSequence } from './endpoint-sequence';
import { ILoopConfigService } from './ILoopConfigService';
import { HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_DEFAULT, HARNESS_LOOP_IDLE_TIMEOUT_SECONDS_KEY } from './loop-lifecycle.constants';
import { LoopAgentDto, LoopConfigResponse, LoopSubscriptionDto } from './dto';

/** The bounded execution envelope, until per-agent overrides exist. */
export const LOOP_CONFIG_MAX_DEPTH = 3;
export const LOOP_CONFIG_MAX_ACTIONS = 200;

/**
 * Per-primitive default action list a subscribed kind resolves to, before the
 * agent's `alwaysActions`/`neverActions` compliance-envelope adjustments
 * `STREAM_AUDIO` deliberately resolves to no per-kind
 * actions — the audio-session lifecycle is driven by `startActions` (see
 * `deriveStartAndEndingActions`), not by a per-context-arrival action.
 */
const PRIMITIVE_DEFAULT_ACTIONS: Record<ContextPrimitive, AgentActionKey[]> = {
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

/**
 * The agent's goal OBJECTIVE as a plain sentence, or null.
 *
 * `DepartmentAgent.goal` is a constrained JSONB object
 * (`{ version, objective, successCriteria[] }`). The loop's planner
 * prompt wants the objective sentence, not the envelope, and a malformed blob
 * degrades to "no goal" rather than leaking `[object Object]` into a prompt.
 */
function parseGoalObjective(goal: Record<string, unknown> | null | undefined): string | null {
  if (!goal) return null;
  const objective = goal.objective;
  return typeof objective === 'string' && objective.trim().length > 0 ? objective.trim() : null;
}

/**
 * Every write-scope output key, or `[]` when `writeScope` is absent or
 * structurally malformed. Same posture as `parseSubscribedKindKeys`: a bad JSONB
 * blob is treated as "nothing granted", never as a throw and never — critically
 * — as "everything granted".
 */
function parseWriteScopeKeys(writeScope: Record<string, unknown> | null | undefined): string[] {
  if (!writeScope) return [];
  const { problems, outputKeys } = writeScopeProblems(writeScope);
  return problems.length > 0 ? [] : outputKeys;
}

/**
 * Every subscribed kind key, or `[]` when `subscribedKinds` is absent or
 * structurally malformed — this resolution path never throws on a bad JSONB
 * blob, it simply treats it as "nothing subscribed".
 */
function parseSubscribedKindKeys(subscribedKinds: Record<string, unknown> | null | undefined): string[] {
  if (!subscribedKinds) return [];
  const { problems, kindKeys } = subscribedKindsProblems(subscribedKinds);
  return problems.length > 0 ? [] : kindKeys;
}

/** Append every entry of `toAppend` not already present, preserving order. */
function appendMissing(actions: string[], toAppend: readonly string[]): string[] {
  const result = [...actions];
  for (const action of toAppend) {
    if (!result.includes(action)) result.push(action);
  }
  return result;
}

/**
 * Resolves the deterministic, read-only loop configuration for one
 * consultation: which `DepartmentAgent`/config-version/context-schema-version
 * govern it, and the per-kind action subscriptions + start/ending action
 * lists the (future) `ConsultationLoopWorkflow` dispatches.
 *
 * Every resolution failure (missing/cross-tenant consultation, no
 * department, no default agent, no servable context schema) degrades to the
 * disabled config — this is a service-token internal read with no user to
 * surface an error to, so it must never throw (see `resolveForConsultation`).
 */
@Injectable()
export class LoopConfigService extends BaseService implements ILoopConfigService {
  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly departmentAgentRepository: DepartmentAgentRepository,
    private readonly departmentAgentVersionRepository: DepartmentAgentVersionRepository,
    private readonly contextSchemaRepository: ConsultationContextSchemaRepository,
    private readonly contextSchemaVersionRepository: ConsultationContextSchemaVersionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // `@Optional()` mirrors `LoopContextSignalService`: absent ⇒ the code
    // default applies, which is a BOUNDED loop. That is the safe direction — an
    // unwired resolver must not silently restore the unbounded wait.
    @Optional() @Inject(TenantSettingsService) private readonly tenantSettings?: TenantSettingsService,
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

    const agent = await this.departmentAgentRepository.findDefaultForDepartment(tenantId, departmentId);
    if (!agent) {
      return disabledResponse(consultationId, departmentId);
    }

    const latestVersion = await this.departmentAgentVersionRepository.findLatestForAgent(agent.id);
    const agentConfigVersionId = latestVersion?.id ?? null;

    const servableVersion = await this.resolveServableContextSchemaVersion(tenantId, departmentId);
    const contextSchemaVersionId = servableVersion?.id ?? null;

    const enabled = agentConfigVersionId !== null || contextSchemaVersionId !== null;

    const kindKeys = parseSubscribedKindKeys(agent.subscribedKinds);
    const subscriptions = this.buildSubscriptions(kindKeys, servableVersion, agent);
    const { startActions, endingActions } = this.deriveStartAndEndingActions(tenantId, kindKeys, servableVersion, agent);
    const agents = await this.buildAgentRoster(tenantId, departmentId, agent);

    return {
      enabled,
      consultationId,
      departmentId,
      agentId: agent.id,
      agentConfigVersionId,
      contextSchemaVersionId,
      subscriptions,
      budget: { maxDepth: LOOP_CONFIG_MAX_DEPTH, maxActions: LOOP_CONFIG_MAX_ACTIONS },
      startActions,
      endingActions,
      // The deliberative lane is ON only when there is actually
      // something to deliberate: a PRIMARY plus at least one SPECIALIST. A
      // department with one agent gets exactly the original behaviour, which is
      // also what keeps every existing consultation unchanged.
      reasoningEnabled: agents.some((a) => a.role === DepartmentAgentRole.PRIMARY) && agents.some((a) => a.role === DepartmentAgentRole.SPECIALIST),
      agents,
      // Pinned here, frozen for the whole consultation.
      idleTimeoutSeconds: this.resolveIdleTimeoutSeconds(),
      // D-12. Always true from this gateway: a timed-out consultation that never finalizes
      // silently loses the encounter. The harness-side default is FALSE, which is what keeps the
      // frozen replay fixtures green — see the field's doc on `LoopConfigResponse`.
      endpointOnTimeout: true,
    };
  }

  /**
   * The department's pinned agent roster.
   *
   * The PRIMARY is resolved by ROLE, falling back to the department default
   * agent when no agent carries the PRIMARY role — a department configured
   * previously has a default but no roles, and the loop must still have
   * exactly one note owner rather than none.
   *
   * Read and write scopes are resolved here and frozen into the pinned config.
   * That placement is the point: the harness enforces `writeScope` at its
   * orchestrator, but the SCOPE ITSELF is a tenant configuration decision, and
   * pinning it means a mid-consultation edit cannot widen what a running
   * specialist may write.
   */
  private async buildAgentRoster(tenantId: string, departmentId: string, defaultAgent: DepartmentAgentEntity): Promise<LoopAgentDto[]> {
    const all = await this.departmentAgentRepository.findAllByDepartment(tenantId, departmentId);
    if (all.length === 0) return [];

    const explicitPrimary = all.find((a) => a.role === DepartmentAgentRole.PRIMARY);
    const primaryId = explicitPrimary?.id ?? defaultAgent.id;

    const roster = await Promise.all(
      all.map(async (entity) => {
        const latest = await this.departmentAgentVersionRepository.findLatestForAgent(entity.id);
        return {
          agentId: entity.id,
          role: entity.id === primaryId ? DepartmentAgentRole.PRIMARY : DepartmentAgentRole.SPECIALIST,
          slug: entity.slug ?? null,
          goal: parseGoalObjective(entity.goal),
          subscribedKinds: parseSubscribedKindKeys(entity.subscribedKinds),
          writeScope: parseWriteScopeKeys(entity.writeScope),
          agentConfigVersionId: latest?.id ?? null,
        };
      }),
    );

    return roster;
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
   * (DEPARTMENT-scoped default → TENANT-scoped default → none) — an
   * independent local copy of `DepartmentAgentService.resolveServableContextDefinition`'s
   * cascade (deliberately not imported; see that method's own precedent
   * relative to `ConsultationContextSchemaService`).
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

  /** The declared primitive for `kindKey` in the servable schema version, or undefined when unresolvable. */
  private resolveKindPrimitive(servableVersion: ConsultationContextSchemaVersionEntity | null, kindKey: string): ContextPrimitive | undefined {
    if (!servableVersion) return undefined;
    return findKind(servableVersion.definition, kindKey)?.primitive;
  }

  private buildSubscriptions(
    kindKeys: string[],
    servableVersion: ConsultationContextSchemaVersionEntity | null,
    agent: DepartmentAgentEntity,
  ): LoopSubscriptionDto[] {
    const alwaysActions = agent.alwaysActions ?? [];
    const neverActions = new Set(agent.neverActions ?? []);

    return kindKeys.map((kindKey) => {
      const primitive = this.resolveKindPrimitive(servableVersion, kindKey);
      let actions: string[] = primitive ? [...PRIMITIVE_DEFAULT_ACTIONS[primitive]] : [];
      actions = appendMissing(actions, alwaysActions);
      actions = actions.filter((action) => !neverActions.has(action));
      return { kindKey, actions };
    });
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
   * The ending half used to be a literal here:
   *
   * ```ts
   * const endingActionsBase = hasStreamAudio ? ['livedoc.stop', 'harness.finalize'] : ['harness.finalize'];
   * ```
   *
   * with `neverActions` as its only control — a lever that could SUBTRACT and nothing else
   * (D-10). It now comes from the persisted, admin-ordered `consultation.endpoint.actions` list,
   * which an agent may EXTEND through `alwaysActions` and still veto through `neverActions`. The
   * ordering rules live in `endpoint-sequence.ts` as a pure function, so they are testable
   * without a settings backend; what stays here is the two impure reads.
   *
   * `startActions` is untouched: there is exactly one start action, it is audio-scoped, and
   * nothing about it was defective.
   */
  private deriveStartAndEndingActions(
    tenantId: string,
    kindKeys: string[],
    servableVersion: ConsultationContextSchemaVersionEntity | null,
    agent: DepartmentAgentEntity,
  ): { startActions: string[]; endingActions: string[] } {
    const neverActions = new Set(agent.neverActions ?? []);
    const hasStreamAudio = kindKeys.some((kindKey) => this.resolveKindPrimitive(servableVersion, kindKey) === 'STREAM_AUDIO');

    const startActions = (hasStreamAudio ? ['livedoc.start'] : []).filter((action) => !neverActions.has(action));
    const endingActions = resolveEndpointSequence({
      configured: this.resolveConfiguredEndpointActions(tenantId),
      hasStreamAudio,
      alwaysActions: agent.alwaysActions ?? [],
      neverActions: agent.neverActions ?? [],
    });

    return { startActions, endingActions };
  }
}
