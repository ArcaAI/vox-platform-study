import { ResourceStatusType } from '../../../../generated/core-prisma-client/client.js';
import { SYSTEM_TENANT_ID } from '../00-constants';
import { AiModelFormat, AiModelSource, ModelCategory, ModelTaskType, ModelType, type AiModelSeed } from './shared';

/**
 * NLP task-model catalog — the two `built-in`
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
    description:
      'shanover/symps_disease_bert_v3_c41 — symptom→disease text classification (diagnosis suggestion). Platform default for nlp.classification (AiTaskDefault).',
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
  // Catalog the guardrail GLiNER detector (was env-only).
  // Connection/weights path may still use GUARDRAIL_GLINER_* infra env;
  // this row documents the selected model identity in the DB control plane.
  {
    id: '80000000-0000-0000-0007-000000000017',
    tenantId: SYSTEM_TENANT_ID,
    name: 'GLiNER Guard Uniencoder ONNX',
    slug: 'gliner-guard-uniencoder-onnx',
    description: 'hivetrace/gliner-guard-uniencoder-onnx — GLiNER ONNX detector used by Guardrail for content-safety / PII / adversarial labels.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TOKEN_CLASSIFICATION,
    modelType: ModelType.FINETUNED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'hivetrace/gliner-guard-uniencoder-onnx',
    sourceRevision: 'main',
    format: AiModelFormat.ONNX,
    provider: 'built-in',
    architecture: 'gliner',
    memorySizeMb: 512,
    computeType: 'float32',
    tags: ['guardrail', 'gliner', 'pii', 'catalog'],
  },
  // MiniCheck groundedness model (was env-only:
  // GUARDRAIL_V2_GROUNDEDNESS_*). NLI/entailment fact-checker used by the
  // guardrail groundedness sensor; modelled as TEXT_CLASSIFICATION (the
  // closest existing ModelTaskType for a sequence-pair entailment head — there
  // is no dedicated NLI task type). Default for the `guardrail.groundedness`
  // AiTaskDefault. GGUF served in-process by the MiniCheck entailer.
  {
    id: '80000000-0000-0000-0007-000000000018',
    tenantId: SYSTEM_TENANT_ID,
    name: 'MiniCheck Flan-T5 Large (GGUF)',
    slug: 'minicheck-flan-t5-large',
    description:
      'nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF — MiniCheck (Flan-T5 Large) groundedness/entailment fact-checker used by the guardrail groundedness sensor. Modelled as TEXT_CLASSIFICATION (closest fit for NLI/entailment).',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_CLASSIFICATION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    provider: 'built-in',
    architecture: 'flan-t5',
    memorySizeMb: 1200,
    computeType: 'q6_k',
    tags: ['guardrail', 'groundedness', 'minicheck', 'nli'],
  },
  // explicit DISABLED placeholder for the `/classify/text`
  // document-type classifier. `nlp.classification` historically pointed at the
  // diagnosis suggester (symps-disease-bert), which is the WRONG model for the
  // doc-type endpoint. No real doc-type classifier is deployed yet, so
  // `nlp.classification` is repointed here and the capability is fail-closed
  // (a DISABLED row never resolves to an ENABLED model → 503) until a real
  // model is seeded. The diagnosis suggester moves to the new `nlp.diagnosis`
  // task key.
  {
    id: '80000000-0000-0000-0007-000000000019',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Document-Type Classifier (placeholder)',
    slug: 'nlp-doc-type-classifier',
    description:
      'Placeholder for the /classify/text document-type classifier. Seeded DISABLED: no doc-type model is deployed, so nlp.classification fails closed until a real classifier replaces this row.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_CLASSIFICATION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'placeholder://nlp-doc-type-classifier',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    provider: 'built-in',
    architecture: null,
    memorySizeMb: 0,
    computeType: 'float32',
    tags: ['nlp', 'classification', 'placeholder', 'disabled'],
    resourceStatus: ResourceStatusType.DISABLED,
  },
];
