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
  // derived from `taskKey` via `AI_TASK_KIND_BY_TASK_KEY` in the
  // applications layer, never independently chosen. Optional at this boundary
  // because the column is nullable: an un-migrated writer must land
  // "unclassified" rather than plausible-but-wrong.
  taskKind?: IAiRoutingPolicyEntity['taskKind'];

  // ─────────── — the provider-configuration binding ───────────
  // `modelId`/`modelRef` are optional HERE and yet one of them is required by
  // `validate()`. That is deliberate: the factory does not decide which form of
  // model reference a caller has (a catalogue FK, or a provider-side id for a
  // connection whose model is not catalogued), so the invariant is expressed
  // once, on the entity, rather than duplicated as a signature the type system
  // could not enforce anyway.
  displayName?: IAiRoutingPolicyEntity['displayName'];
  providerConnectionId?: IAiRoutingPolicyEntity['providerConnectionId'];
  modelId?: IAiRoutingPolicyEntity['modelId'];
  modelRef?: IAiRoutingPolicyEntity['modelRef'];
  isDefault?: IAiRoutingPolicyEntity['isDefault'];
  enabled?: IAiRoutingPolicyEntity['enabled'];
  residency?: IAiRoutingPolicyEntity['residency'];
  baaCovered?: IAiRoutingPolicyEntity['baaCovered'];
  configJson?: IAiRoutingPolicyEntity['configJson'];

  /** @deprecated — the chain is now the set of rows. Never write it. */
  candidatesJson?: IAiRoutingPolicyEntity['candidatesJson'];

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
      taskKind: props.taskKind ?? null,

      // binding. `isDefault` defaults FALSE — electing a default is an
      // explicit administrative act that must go through
      // `AiRoutingPolicyService.setDefault`, which unsets the incumbent in the
      // same transaction. A factory that defaulted it TRUE would make every
      // create race the partial unique index.
      displayName: props.displayName ?? null,
      providerConnectionId: props.providerConnectionId ?? null,
      modelId: props.modelId ?? null,
      modelRef: props.modelRef ?? null,
      isDefault: props.isDefault ?? false,
      // A new candidate is servable unless someone parks it.
      enabled: props.enabled ?? true,
      // No invented residency class and no assumed BAA coverage — the
      // gates read these, and guessing `baaCovered: true` for a candidate whose
      // author did not say so is the silent PHI redirection they exist to stop.
      residency: props.residency ?? null,
      baaCovered: props.baaCovered ?? null,
      configJson: props.configJson ?? null,

      candidatesJson: props.candidatesJson ?? null,

      // Defaults MIRROR the Prisma column defaults so an entity built here and
      // a row read back from the database agree. A policy is authored before it
      // is served (DRAFT), served in strict candidate order (PRIORITY), and
      // STRICT explicit-provider mode is the platform posture: a named
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
