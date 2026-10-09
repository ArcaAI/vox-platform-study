// Action confirmations (TASK-1057) — resolve and enforce the platform policy that decides whether
// an admin action demands a reason / evidence / acknowledgement before it runs, and produce the
// audit stamp every such action records — including "reason not required".
//
// Consumers (one per confirmable action):
//
//   const stamp = this.confirmations.assert('promptTemplate.update', { value: dto.changeReason });
//   …mutate…
//   this.broadcastSysEvent(SysEventType.ResourceUpdated, { …, metaData: { …, confirmation: stamp } });
//
// An action with its OWN refusal shape (model residency's 409 `LIVE_PATH_REASON_REQUIRED`, the
// restore's `RESTORE_REASON_INVALID`, the schema's `SCHEMA_IMPACT_UNACKNOWLEDGED`) calls `decide`
// — never throws — and raises its own error when `stamp.required && !stamp.provided`.
//
// The mode is resolved on the PLATFORM lane only (`resolve(key, null)`): the switch is SYSTEM-tier,
// owner decision 2026-10-09. Locked catalogue rows have no setting and are always `required`.

import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ACTION_CONFIRMATION_CATALOGUE,
  type ActionConfirmationAuditStamp,
  type ActionConfirmationSpec,
  CONFIRMATION_REQUIRED_CODE,
  type ConfirmationMode,
  type EffectiveActionConfirmation,
  actionConfirmationSettingKey,
  findActionConfirmation,
} from '@arcaai/types';
import { TenantSettingsService } from './tenant-settings.service';

export interface ConfirmationInput {
  /** The caller-supplied value: a reason / evidence string, or `true` for an acknowledgement. */
  value?: unknown;
  /** For `when-risky` rows: whether the action's own risk rule fired for this request. */
  risky?: boolean;
}

const KIND_NOUN: Record<ActionConfirmationSpec['kind'], string> = {
  reason: 'reason',
  evidence: 'evidence reference',
  acknowledgement: 'acknowledgement',
  typeToConfirm: 'typed confirmation',
  reasonCode: 'reason code',
  breakGlass: 'break-glass confirmation',
  stepUp: 'password confirmation',
};

@Injectable()
export class ActionConfirmationService {
  constructor(private readonly tenantSettings: TenantSettingsService) {}

  /** The catalogue row for `actionId`; an unknown id is a programming error. */
  spec(actionId: string): ActionConfirmationSpec {
    const spec = findActionConfirmation(actionId);
    if (!spec) throw new Error(`Unknown action confirmation '${actionId}'.`);
    return spec;
  }

  /** The effective mode on the SYSTEM tier (locked rows are always `required`). */
  mode(actionId: string): ConfirmationMode {
    const spec = this.spec(actionId);
    if (spec.locked) return 'required';
    const resolved = this.tenantSettings.resolve<string>(actionConfirmationSettingKey(actionId), null);
    const value = resolved.value;
    return typeof value === 'string' && (spec.modes as readonly string[]).includes(value) ? (value as ConfirmationMode) : spec.default;
  }

  /** Every catalogue row with its effective mode — what the console dialogs read. */
  effective(): EffectiveActionConfirmation[] {
    return ACTION_CONFIRMATION_CATALOGUE.map((spec) => ({
      actionId: spec.actionId,
      kind: spec.kind,
      mode: this.mode(spec.actionId),
      locked: spec.locked === true,
      ...(spec.minLength === undefined ? {} : { minLength: spec.minLength }),
      ...(spec.maxLength === undefined ? {} : { maxLength: spec.maxLength }),
    }));
  }

  /** Evaluate the policy for one request. Never throws on a missing value. */
  decide(actionId: string, input: ConfirmationInput = {}): ActionConfirmationAuditStamp {
    const spec = this.spec(actionId);
    const mode = this.mode(actionId);
    const required = mode === 'required' || (mode === 'when-risky' && input.risky === true);
    const provided = isProvided(input.value);
    const noun = KIND_NOUN[spec.kind];
    return {
      actionId,
      kind: spec.kind,
      mode,
      locked: spec.locked === true,
      required,
      provided,
      note: required ? `${noun} required` : `${noun} not required`,
    };
  }

  /**
   * `decide`, then refuse with 400 `CONFIRMATION_REQUIRED` when the policy demands a value the
   * caller did not supply (or a free-text value shorter than the row's `minLength`).
   */
  assert(actionId: string, input: ConfirmationInput = {}): ActionConfirmationAuditStamp {
    const stamp = this.decide(actionId, input);
    if (!stamp.required) return stamp;
    const spec = this.spec(actionId);
    const tooShort = typeof input.value === 'string' && spec.minLength !== undefined && input.value.trim().length < spec.minLength;
    if (!stamp.provided || tooShort) {
      const noun = KIND_NOUN[spec.kind];
      throw new BadRequestException({
        code: CONFIRMATION_REQUIRED_CODE,
        actionId,
        kind: spec.kind,
        ...(spec.minLength === undefined ? {} : { minLength: spec.minLength }),
        message:
          spec.minLength === undefined
            ? `A ${noun} is required for this action.`
            : `A ${noun} of at least ${spec.minLength} characters is required for this action.`,
      });
    }
    return stamp;
  }
}

function isProvided(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'boolean') return value;
  return value !== undefined && value !== null;
}
