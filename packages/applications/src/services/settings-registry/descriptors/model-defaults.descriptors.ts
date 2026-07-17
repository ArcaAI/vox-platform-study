// TASK-506 — AI task-model default descriptors.
//
// One `models.<taskKey>` descriptor per `AiTaskDefault` task key. The value is
// a registry model slug (dataType `string`) living in the dedicated
// `AiTaskDefault` table (tier `db-config`, tenant → SYSTEM cascade resolved by
// `AiTaskDefaultService.getEffective`).
//
// Governance (owner directive 2026-07-17): `guardrail.*` keys are
// GLOBAL-ADMIN-ONLY — `editableBy` points at the global-admin resource
// (`'all'`, the CASL manage-everything subject) and the descriptor is flagged
// `globalOnly`. `nlp.*` keys stay tenant-editable via `manage:AiTaskDefault`.

import { AI_TASK_KEYS, AiTaskKey, GLOBAL_ADMIN_ONLY_TASK_PREFIX } from '../../ai-task-default/constants';
import { SettingDescriptor } from '../registry.types';

const META: Record<AiTaskKey, { label: string; description: string }> = {
  'guardrail.validate': {
    label: 'Guardrail validation model',
    description: 'Default guardian LLM used by the safety engine for medical validation (global admins only).',
  },
  'nlp.ner': {
    label: 'Medical NER model',
    description: 'Default token-classification model used for medical entity extraction.',
  },
  'nlp.classification': {
    label: 'Medical classification model',
    description: 'Default text-classification model used for diagnosis suggestions.',
  },
};

export const MODEL_DEFAULT_SETTINGS: SettingDescriptor[] = AI_TASK_KEYS.map<SettingDescriptor>((taskKey) => {
  const globalAdminOnly = taskKey.startsWith(GLOBAL_ADMIN_ONLY_TASK_PREFIX);
  return {
    key: `models.${taskKey}`,
    tier: 'db-config',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: globalAdminOnly ? 'all' : 'AiTaskDefault',
    ...(globalAdminOnly ? { globalOnly: true } : {}),
    category: 'Models',
    label: META[taskKey].label,
    description: META[taskKey].description,
  };
});
