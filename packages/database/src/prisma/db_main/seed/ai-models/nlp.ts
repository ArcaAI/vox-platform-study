import { SYSTEM_TENANT_ID } from '../00-constants';
import {
    AiModelFormat,
    AiModelSource,
    ModelCategory,
    ModelTaskType,
    ModelType,
    type AiModelSeed,
} from './shared';

/**
 * NLP task-model catalog (TASK-506 §4.3) — the two `built-in`
 * (transformers-library) models the NLP service serves. Registry-backed
 * defaults for the `nlp.ner` / `nlp.classification` AiTaskDefault keys.
 */
export const NLP_AI_MODELS: AiModelSeed[] = [
    {
        id: '80000000-0000-0000-0007-000000000010',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Medical NER',
        slug: 'medical-ner',
        description: 'blaze999/Medical-NER — medical named-entity recognition (token classification). Platform default for nlp.ner (AiTaskDefault).',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TOKEN_CLASSIFICATION,
        modelType: ModelType.FINETUNED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'blaze999/Medical-NER',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        provider: 'built-in',
        architecture: null,
        memorySizeMb: 1024,
        computeType: 'float32',
        tags: ['medical', 'ner', 'default'],
    },
    {
        id: '80000000-0000-0000-0007-000000000011',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Symptom-Disease BERT v3 C41',
        slug: 'symps-disease-bert-v3-c41',
        description: 'shanover/symps_disease_bert_v3_c41 — symptom→disease text classification (diagnosis suggestion). Platform default for nlp.classification (AiTaskDefault).',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_CLASSIFICATION,
        modelType: ModelType.FINETUNED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'shanover/symps_disease_bert_v3_c41',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        provider: 'built-in',
        architecture: 'bert',
        memorySizeMb: 512,
        computeType: 'float32',
        tags: ['medical', 'classification', 'default'],
    },
];
