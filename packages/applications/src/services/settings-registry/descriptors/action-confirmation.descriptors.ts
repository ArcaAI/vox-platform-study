// Action confirmations (TASK-1057) — one platform-only setting per confirmable admin action.
//
// The catalogue (`ACTION_CONFIRMATION_CATALOGUE` in `@arcaai/types`) is the single source of
// truth: every UNLOCKED row becomes exactly one `confirmation.<actionId>` enum key here, holding
// one of the row's `modes`. Locked rows (break-glass, impersonation, password step-up, the billing
// reason code) get NO key — there is nothing to switch, by owner decision.
//
// `maxScope: 'system'` + `globalOnly: true`: the switch is PLATFORM-ONLY (owner decision
// 2026-10-09). A tenant can neither loosen nor tighten it, so no tenant row may ever exist.
// `failMode: 'open-to-default'` and every default is TODAY's behaviour, so an absent SYSTEM row
// changes nothing.

import { ACTION_CONFIRMATION_CATALOGUE, actionConfirmationSettingKey } from '@arcaai/types';
import { SettingDescriptor } from '../registry.types';

export const ACTION_CONFIRMATIONS_CATEGORY = 'Action Confirmations';

export const ACTION_CONFIRMATION_SETTINGS: SettingDescriptor[] = ACTION_CONFIRMATION_CATALOGUE.filter((spec) => !spec.locked).map<SettingDescriptor>(
  (spec) => ({
    key: actionConfirmationSettingKey(spec.actionId),
    tier: 'global-kv',
    dataType: 'enum',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: ACTION_CONFIRMATIONS_CATEGORY,
    label: spec.label,
    description:
      `${spec.domain} — whether the ${spec.kind === 'typeToConfirm' ? 'typed-name confirmation (console only)' : spec.kind} is demanded before this action. ` +
      `Allowed: ${spec.modes.join(' | ')}. Platform-only; the audit event records the policy either way.`,
    default: spec.default,
    validate: (value: unknown) =>
      typeof value === 'string' && (spec.modes as readonly string[]).includes(value) ? undefined : `Must be one of: ${spec.modes.join(', ')}.`,
  }),
);

export const ACTION_CONFIRMATION_KEYS: readonly string[] = ACTION_CONFIRMATION_SETTINGS.map((d) => d.key);
