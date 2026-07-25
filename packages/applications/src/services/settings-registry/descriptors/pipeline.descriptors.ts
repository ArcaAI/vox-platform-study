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
 * services are controlled by global admins only. `PipelinePolicyService`
 * enforces FROM this metadata — do not mirror it into a key list there.
 *
 * `autoSummaryEnabled` / `dnaStyleEnabled` stay tenant-writable: they select
 * clinical convenience behaviour, not whether a governed AI service runs.
 */
const META: Record<PipelineToggleKey, { label: string; description: string; globalOnly?: boolean }> = {
  autoSummaryEnabled: { label: 'Auto-summary', description: 'Automatically generate a summary after each consultation.' },
  autoNerEnabled: {
    label: 'Auto medical NER',
    description: 'Automatically extract medical entities during transcription (global administrators only).',
    globalOnly: true,
  },
  harnessEnabled: {
    label: 'Documentation harness',
    description: 'Route consultations through the clinical documentation harness (rollout knob — capped at department; global administrators only).',
    globalOnly: true,
  },
  dnaStyleEnabled: { label: 'DNA writing style', description: "Apply and learn the doctor's DNA writing style." },
  dnaRedactionEnabled: {
    label: 'DNA redaction',
    description:
      "Apply the doctor's DNA redaction/rewrite rules to generated notes as a separate, auditable post-generation transform (tenant-level gate; the doctor's DNA opt-in still applies).",
  },
};

export const PIPELINE_SETTINGS: SettingDescriptor[] = (Object.keys(PIPELINE_SETTING_DESCRIPTORS) as PipelineToggleKey[]).map((key) => ({
  key: `pipeline.${key}`,
  tier: 'db-config',
  dataType: 'boolean',
  sensitivity: 'internal',
  maxScope: mapScope(PIPELINE_SETTING_DESCRIPTORS[key].maxScope),
  editableBy: 'PipelinePolicy',
  // Feature toggles, not selection: an unset toggle degrades to the code
  // default the resolver already applies today (plan §9.3 M5 "fail-open on tuning").
  failMode: 'open-to-default',
  category: 'Pipeline',
  label: META[key].label,
  description: META[key].description,
  default: PIPELINE_SETTING_DESCRIPTORS[key].codeDefault,
  ...(META[key].globalOnly ? { globalOnly: true } : {}),
}));
