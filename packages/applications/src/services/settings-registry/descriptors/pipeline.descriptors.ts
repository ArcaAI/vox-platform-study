// TASK-504 Phase 3 — pipeline-toggle descriptors.
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

const META: Record<PipelineToggleKey, { label: string; description: string }> = {
  autoSummaryEnabled: { label: 'Auto-summary', description: 'Automatically generate a summary after each consultation.' },
  autoNerEnabled: { label: 'Auto medical NER', description: 'Automatically extract medical entities during transcription.' },
  harnessEnabled: {
    label: 'Documentation harness',
    description: 'Route consultations through the clinical documentation harness (rollout knob — capped at department).',
  },
  dnaStyleEnabled: { label: 'DNA writing style', description: "Apply and learn the doctor's DNA writing style." },
};

export const PIPELINE_SETTINGS: SettingDescriptor[] = (Object.keys(PIPELINE_SETTING_DESCRIPTORS) as PipelineToggleKey[]).map((key) => ({
  key: `pipeline.${key}`,
  tier: 'db-config',
  dataType: 'boolean',
  sensitivity: 'internal',
  maxScope: mapScope(PIPELINE_SETTING_DESCRIPTORS[key].maxScope),
  editableBy: 'PipelinePolicy',
  category: 'Pipeline',
  label: META[key].label,
  description: META[key].description,
  default: PIPELINE_SETTING_DESCRIPTORS[key].codeDefault,
}));
