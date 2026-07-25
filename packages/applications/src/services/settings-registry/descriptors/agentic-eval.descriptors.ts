// agentic eval-gate descriptors.
//
// `agentic.eval.promotionGate` governs the mandatory (OD-3) eval gate that runs
// when a template version is APPROVED — or a DepartmentAgent's pinned version is
// re-pointed — and the agent references a golden set:
//
//   'block' (default) — a failing eval BLOCKS the promotion (409 + score payload).
//   'warn'            — the eval runs + is recorded, but a failure does NOT block.
//   'off'             — the gate is skipped entirely (no eval run).
//
// It is GLOBAL-ADMIN-ONLY (the `agentic.*` privilege boundary — a privilege rule
// → 403, enforced at the service layer, not a cross-tenant probe), tier
// `global-kv`, and carries its code default here as the single source of truth.
// Resolved through `EffectiveSettingsService.resolveEffective` (global-kv lane),
// so a write via `PUT /admin/settings/registry/:key` governs the gate with no
// redeploy.

import { SettingDescriptor } from '../registry.types';

/** The operational escape-hatch modes for the eval promotion gate. */
export type EvalPromotionGateMode = 'block' | 'warn' | 'off';

export const AGENTIC_EVAL_PROMOTION_GATE_KEY = 'agentic.eval.promotionGate';

/** Code default — mandatory blocking per OD-3. */
export const AGENTIC_EVAL_PROMOTION_GATE_DEFAULT: EvalPromotionGateMode = 'block';

export const AGENTIC_EVAL_SETTINGS: SettingDescriptor[] = [
  {
    key: AGENTIC_EVAL_PROMOTION_GATE_KEY,
    tier: 'global-kv',
    dataType: 'enum',
    sensitivity: 'internal',
    // agentic.* is GLOBAL-ADMIN-only — platform-owned, not tenant-set.
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    // Mode knob — an unset gate degrades to the code default (`block`), which is
    // the SAFE end of this knob, so open-to-default does not weaken the gate.
    failMode: 'open-to-default',
    category: 'Agentic Eval',
    label: 'Eval promotion gate',
    description: 'Governs the eval gate on template approval / agent pin re-point: block (fail → 409), warn (record only), or off.',
    default: AGENTIC_EVAL_PROMOTION_GATE_DEFAULT,
  },
];
