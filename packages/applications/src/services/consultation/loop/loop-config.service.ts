import { Injectable } from '@nestjs/common';
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
  DepartmentAgentVersionRepository,
  ResourceType,
} from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { ContextPrimitive, findKind } from '../../consultation-context-schema/context-schema-definition';
import { AgentActionKey, subscribedKindsProblems } from '../../departmentAgent/constants';
import { ILoopConfigService } from './ILoopConfigService';
import { LoopConfigResponse, LoopSubscriptionDto } from './dto';

/** TASK-662 — the bounded execution envelope, until per-agent overrides exist. */
export const LOOP_CONFIG_MAX_DEPTH = 3;
export const LOOP_CONFIG_MAX_ACTIONS = 200;

/**
 * Per-primitive default action list a subscribed kind resolves to, before the
 * agent's `alwaysActions`/`neverActions` compliance-envelope adjustments
 * (TASK-654 §4.4 / D11). `STREAM_AUDIO` deliberately resolves to no per-kind
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

/** A fully disabled config, used for every degradation branch. */
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
  };
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
 * TASK-662 — resolves the deterministic, read-only loop configuration for one
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
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
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
    const { startActions, endingActions } = this.deriveStartAndEndingActions(kindKeys, servableVersion, agent);

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
    };
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
  private async resolveServableContextSchemaVersion(
    tenantId: string,
    departmentId: string,
  ): Promise<ConsultationContextSchemaVersionEntity | null> {
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

  private deriveStartAndEndingActions(
    kindKeys: string[],
    servableVersion: ConsultationContextSchemaVersionEntity | null,
    agent: DepartmentAgentEntity,
  ): { startActions: string[]; endingActions: string[] } {
    const neverActions = new Set(agent.neverActions ?? []);
    const hasStreamAudio = kindKeys.some((kindKey) => this.resolveKindPrimitive(servableVersion, kindKey) === 'STREAM_AUDIO');

    const startActions = (hasStreamAudio ? ['livedoc.start'] : []).filter((action) => !neverActions.has(action));
    const endingActionsBase = hasStreamAudio ? ['livedoc.stop', 'harness.finalize'] : ['harness.finalize'];
    const endingActions = endingActionsBase.filter((action) => !neverActions.has(action));

    return { startActions, endingActions };
  }
}
