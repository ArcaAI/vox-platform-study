/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AiRoutingPolicyEntity, IAiRoutingPolicyEntity } from '../../../entities';
import { AiExplicitProviderMode, AiRoutingPolicyStatus, AiRoutingStrategy } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateAiRoutingPolicyProps extends BaseEntityFactoryCreateProps {
  tenantId: IAiRoutingPolicyEntity['tenantId'];
  taskKey: IAiRoutingPolicyEntity['taskKey'];
  candidatesJson: IAiRoutingPolicyEntity['candidatesJson'];

  policyVersion?: IAiRoutingPolicyEntity['policyVersion'];
  status?: IAiRoutingPolicyEntity['status'];
  strategy?: IAiRoutingPolicyEntity['strategy'];
  explicitProviderMode?: IAiRoutingPolicyEntity['explicitProviderMode'];
  priority?: IAiRoutingPolicyEntity['priority'];
  killSwitch?: IAiRoutingPolicyEntity['killSwitch'];
  matchJson?: IAiRoutingPolicyEntity['matchJson'];
  fallbackJson?: IAiRoutingPolicyEntity['fallbackJson'];
  healthJson?: IAiRoutingPolicyEntity['healthJson'];
  maxConcurrentStreams?: IAiRoutingPolicyEntity['maxConcurrentStreams'];
  requestsPerMinute?: IAiRoutingPolicyEntity['requestsPerMinute'];
  tokensPerMinute?: IAiRoutingPolicyEntity['tokensPerMinute'];
  affinityJson?: IAiRoutingPolicyEntity['affinityJson'];
  supersedesVersion?: IAiRoutingPolicyEntity['supersedesVersion'];
  activatedAt?: IAiRoutingPolicyEntity['activatedAt'];

  createdAt?: IAiRoutingPolicyEntity['createdAt'];
  updatedAt?: IAiRoutingPolicyEntity['updatedAt'];
  createdBy?: IAiRoutingPolicyEntity['createdBy'];
  updatedBy?: IAiRoutingPolicyEntity['updatedBy'];
}

export class AiRoutingPolicyFactory {
  static CreateAiRoutingPolicy(props: CreateAiRoutingPolicyProps): AiRoutingPolicyEntity {
    const id = generateId();
    const now = new Date();

    return new AiRoutingPolicyEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      taskKey: props.taskKey,
      candidatesJson: props.candidatesJson,

      // Defaults MIRROR the Prisma column defaults so an entity built here and
      // a row read back from the database agree. A policy is authored before it
      // is served (DRAFT), served in strict candidate order (PRIORITY), and
      // §3A.4's STRICT explicit-provider mode is the platform posture: a named
      // provider that is down returns an error, never a silent substitution.
      policyVersion: props.policyVersion ?? 1,
      status: props.status ?? AiRoutingPolicyStatus.DRAFT,
      strategy: props.strategy ?? AiRoutingStrategy.PRIORITY,
      explicitProviderMode: props.explicitProviderMode ?? AiExplicitProviderMode.STRICT,
      priority: props.priority ?? 0,
      // Kill-switches default OFF.
      killSwitch: props.killSwitch ?? false,

      matchJson: props.matchJson ?? null,
      fallbackJson: props.fallbackJson ?? null,
      healthJson: props.healthJson ?? null,
      maxConcurrentStreams: props.maxConcurrentStreams ?? null,
      requestsPerMinute: props.requestsPerMinute ?? null,
      tokensPerMinute: props.tokensPerMinute ?? null,
      affinityJson: props.affinityJson ?? null,

      // A first DRAFT supersedes nothing and has never been activated.
      supersedesVersion: props.supersedesVersion ?? null,
      activatedAt: props.activatedAt ?? null,
    });
  }
}
