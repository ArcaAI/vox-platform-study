// AI task-model default descriptors.
//
// One `models.<taskKey>` descriptor per `AiTaskDefault` task key. The value is
// a registry model slug (dataType `string`) living in the dedicated
// `AiTaskDefault` table (tier `db-config`, tenant → SYSTEM cascade resolved by
// `AiTaskDefaultService.getEffective`).
//
// Governance: `guardrail.*`, `smr.*`, and `nlp.*` keys are
// GLOBAL-ADMIN-ONLY — `editableBy` points at the global-admin resource
// (`'all'`, the CASL manage-everything subject) and the descriptor is flagged
// `globalOnly`.

import { AI_TASK_KEYS, AiTaskKey, GLOBAL_ADMIN_ONLY_TASK_PREFIXES } from '../../ai-task-default/constants';
import { SettingDescriptor } from '../registry.types';

const META: Record<AiTaskKey, { label: string; description: string }> = {
  'guardrail.validate': {
    label: 'Guardrail validation model',
    description: 'Default guardian LLM used by the safety engine for medical validation (global admins only).',
  },
  // guardrail content-safety + groundedness selection (global admins only).
  'guardrail.safety': {
    label: 'Guardrail safety detector',
    description: 'Default GLiNER token-classification detector used by the safety engine for content-safety / PII labelling (global admins only).',
  },
  'guardrail.groundedness': {
    label: 'Guardrail groundedness model',
    description: 'Default MiniCheck NLI/entailment fact-checker used by the safety engine for groundedness verification (global admins only).',
  },
  'nlp.ner': {
    label: 'Medical NER model',
    description: 'Default token-classification model used for medical entity extraction.',
  },
  'nlp.classification': {
    label: 'Document-type classification model',
    description: 'Default text-classification model used by the /classify/text document-type classifier (global admins only).',
  },
  // diagnosis suggester, split out of the doc-type classifier key.
  'nlp.diagnosis': {
    label: 'Diagnosis suggestion model',
    description: 'Default text-classification model used for symptom→disease diagnosis suggestions (global admins only).',
  },
  // SMR generation routing (global admins only).
  'smr.live': {
    label: 'SMR live-summary model',
    description: 'Default text-generation model for the live-documentation delta summariser (global admins only).',
  },
  'smr.finalize': {
    label: 'SMR final-summary model',
    description: 'Default text-generation model for the final/comprehensive summary generator (global admins only).',
  },
  // harness LLM-as-judge model (global admins only).
  'harness.judge': {
    label: 'Harness judge model',
    description: 'Default text-generation model used as the LLM-as-judge by the clinical documentation harness (global admins only).',
  },
};

export const MODEL_DEFAULT_SETTINGS: SettingDescriptor[] = AI_TASK_KEYS.map<SettingDescriptor>((taskKey) => {
  const globalAdminOnly = GLOBAL_ADMIN_ONLY_TASK_PREFIXES.some((p) => taskKey.startsWith(p));
  return {
    key: `models.${taskKey}`,
    tier: 'db-config',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: globalAdminOnly ? 'all' : 'AiTaskDefault',
    ...(globalAdminOnly ? { globalOnly: true } : {}),
    // Provider/model SELECTION — the canonical fail-closed class (plan §9.3 M5).
    // An unselected task must surface as unresolved, never as a null the caller
    // cannot tell apart from a deliberate value, and never as a neighbouring
    // tenant's or a global model. This mirrors guardrail's own posture
    // (`tenant_config.py`: "Selection is DB-only … fail-closed").
    failMode: 'closed',
    category: 'Models',
    label: META[taskKey].label,
    description: META[taskKey].description,
  };
});
