// Pipeline-toggle descriptors.
//
// Sourced FROM the existing `PIPELINE_SETTING_DESCRIPTORS` (config-resolver) so
// maxScope + code default stay single-sourced — the registry adds only the
// classification metadata (tier / sensitivity / editor / category). No behaviour
// change: the resolver keeps using its own descriptor map; this mirrors it.

import { PipelinePolicyScope } from '@arcaai/domains';
import { PIPELINE_SETTING_DESCRIPTORS, PipelineToggleKey } from '../../config-resolver/config-resolver.service';
import { SettingDescriptor, SettingScope } from '../registry.types';

function mapScope(scope: PipelinePolicyScope): SettingScope {
  switch (scope) {
    case PipelinePolicyScope.DOCTOR:
      return 'doctor';
    case PipelinePolicyScope.DEPARTMENT:
      return 'department';
    case PipelinePolicyScope.TENANT:
    default:
      return 'tenant';
  }
}

/**
 * `globalOnly` marks the toggles a tenant admin may no
 * longer write. `harnessEnabled` gates guardrail's primary caller and
 * `autoNerEnabled` gates NLP auto-extraction; per the owner directive both AI
 * services are controlled by super admins only. `PipelinePolicyService`
 * enforces FROM this metadata — do not mirror it into a key list there.
 *
 * `autoSummaryEnabled` / `dnaStyleEnabled` stay tenant-writable: they select
 * clinical convenience behaviour, not whether a governed AI service runs.
 */
const META: Record<PipelineToggleKey, { label: string; description: string; globalOnly?: boolean }> = {
  autoSummaryEnabled: { label: 'Auto-summary', description: 'Automatically generate a summary after each consultation.' },
  autoNerEnabled: {
    label: 'Auto medical NER',
    description: 'Automatically extract medical entities during transcription (super administrators only).',
    globalOnly: true,
  },
  harnessEnabled: {
    label: 'Documentation harness',
    description: 'Route consultations through the clinical documentation harness (rollout knob — capped at department; super administrators only).',
    globalOnly: true,
  },
  dnaStyleEnabled: { label: 'DNA writing style', description: "Apply and learn the doctor's DNA writing style." },
  dnaRedactionEnabled: {
    label: 'DNA redaction',
    description:
      "Apply the doctor's DNA redaction/rewrite rules to generated notes as a separate, auditable post-generation transform (tenant-level gate; the doctor's DNA opt-in still applies).",
  },
};

/**
 * `failMode` for `pipeline.*` keys is DESCRIPTIVE metadata only — it is never
 * actually applied. `EffectiveSettingsService.resolveEffective` special-cases
 * every `pipeline.` key to delegate straight to
 * `ConfigResolver.resolvePipelineToggles`, which has its OWN hard-coded
 * fail-closed policy (`codeDefaultResult()` on a lookup error) and never
 * calls `applyDeclaredFailMode`/`applyFailMode`. So changing this field
 * cannot change runtime behaviour for these keys — it only documents intent.
 *
 * `dnaStyleEnabled` is declared `'closed'` (not the blanket `'open-to-default'`
 * every other toggle gets) to say what is actually true of it: it is a
 * PHI-relevant opt-out gate (TASK-700), and `ConfigResolver.
 * resolveEffectiveDnaStyleEnabled` already fails CLOSED (DNA off) on any
 * lookup error — never a silently-substituted default. `codeDefault: false`
 * happens to make `'open-to-default' `and `'closed'` observably identical
 * for this one key (the substituted default and the fail-closed outcome are
 * both "off"), which is exactly why the mismatch was easy to miss; declaring
 * it `'closed'` removes the discrepancy between what the descriptor SAYS and
 * what the resolver DOES, for the next engineer who reads only this file.
 */
function failModeFor(key: PipelineToggleKey): 'closed' | 'open-to-default' {
  return key === 'dnaStyleEnabled' ? 'closed' : 'open-to-default';
}

export const PIPELINE_SETTINGS: SettingDescriptor[] = (Object.keys(PIPELINE_SETTING_DESCRIPTORS) as PipelineToggleKey[]).map((key) => ({
  key: `pipeline.${key}`,
  tier: 'db-config',
  dataType: 'boolean',
  sensitivity: 'internal',
  maxScope: mapScope(PIPELINE_SETTING_DESCRIPTORS[key].maxScope),
  editableBy: 'PipelinePolicy',
  failMode: failModeFor(key),
  category: 'Pipeline',
  label: META[key].label,
  description: META[key].description,
  default: PIPELINE_SETTING_DESCRIPTORS[key].codeDefault,
  ...(META[key].globalOnly ? { globalOnly: true } : {}),
}));
