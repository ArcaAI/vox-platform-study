import { SYSTEM_TENANT_ID } from '../00-constants';
import { AiModelFormat, AiModelSource, ModelCategory, ModelTaskType, ModelType, type AiModelSeed } from './shared';

/**
 * LLM (text generation / summarization) + guardrail model catalog
 * (the owner-approved 10-model matrix).
 *
 * Replaces the previous 31 LLM/guardrail rows. `sourceUri` carries the
 * provider-native identifier actually sent to the runtime (LM Studio model
 * name, Azure model id, Bedrock model id); `slug` stays the stable registry
 * key. New rows use the fresh `80000000-…-0007-…` id block (0001–0006 are
 * occupied by the legacy audio/LLM/browser blocks). Every `ollama-*` row was
 * deleted and its slug moved to `retired.ts` — the platform standardises on one
 * LM Studio model and ships no Ollama model opinion. The `ollama` PROVIDER is
 * still selectable (owner decision 2026-08-17); a tenant that runs its own
 * Ollama registers its own `AiModel` row against it.
 *
 * ## LM Studio identifiers — the invariant, and the two states a row may be in
 *
 * For an `lm-studio` row, `sourceUri` IS the LM Studio model id the services
 * put on the wire as `model`. A wrong identifier is not cosmetic drift; it is
 * a guaranteed 404 at request time, and it stays invisible until the model is
 * actually called.
 *
 * Two states are legitimate, and a reader must be able to tell them apart:
 *
 *   1. **Loaded** — the identifier resolves on the dev LM Studio instance
 *      today.
 *   2. **Catalogued, not loaded** — the identifier is provider-correct but the
 *      weights are not installed on this host. A catalogue legitimately lists
 *      installable models, so these rows are KEPT (not retired): retirement is
 *      a permanent cross-tenant soft-delete, which is the wrong verb for "an
 *      operator has not pulled this one yet". Each such row says "Not loaded"
 *      in its description, and NO `AiTaskDefault` may select one.
 *
 * A prior revision of this file claimed the dev instance serves
 * `google/gemma-4-e4b-qat` and that `google/gemma-4-e4b` was a typo for it —
 * this is how `harness.judge` broke (404 on every call). Re-verified against
 * the LIVE instance on 2026-08-16: BOTH halves were wrong. `google/gemma-4-e4b`
 * IS served; `google/gemma-4-e4b-qat` is NOT. A prose claim about a runtime
 * catalog is only as trustworthy as its last verification, so this file no
 * longer asserts one inline — `ai-model-consolidation-seed.test.ts` pins the
 * served set as a hard-coded, dated fixture instead (catalog ⊆ instance).
 *
 * `ai-model-consolidation-seed.test.ts` pins every LM Studio `sourceUri`,
 * enforces the "not loaded" wording, and fails if an `AiTaskDefault` ever
 * points at an unloaded row.
 */
export const LLM_AI_MODELS: AiModelSeed[] = [
  // =========================================================================
  // Guardrail / Safety (slug continuity with the `guardrail.safety` AiTaskDefault, which is
  // what apps/guardrail resolves its engine + model from since TASK-735/736)
  // =========================================================================
  {
    id: '80000000-0000-0000-0005-000000000060',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Granite Guardian 4.1 8B',
    slug: 'granite-guardian-4.1-8b',
    description:
      'IBM Granite Guardian 4.1 8B — safety/guardrail model. `format` is descriptive metadata (GGUF / llama.cpp); serving is provider-based (LM Studio). Platform default for guardrail.validate (AiTaskDefault).',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.GUARDRAIL,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'granite-guardian-4.1-8b',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    provider: 'lm-studio',
    architecture: 'granite',
    memorySizeMb: 4900,
    // Precision refresh (owner-specified exact quant scheme).
    computeType: 'q4_k_s',
    tags: ['guardrail', 'safety', 'granite'],
    // `metaData.policy` (TASK-777) — the governed key set declared in
    // `apps/guardrail/src/guardrail/core/policy.py::_SPECS`, resolved through
    // the SAME tenant → SYSTEM cascade as this row's selection. This SYSTEM
    // row is the platform default; `POST /medical/validate` fails closed
    // (503) without it (`GuardrailPolicy.require_criteria`).
    //
    // `medicalValidationCriteria` is `failMode: closed` — recovered VERBATIM
    // from the deleted `MEDICAL_VALIDATION_CRITERIA` Python literal
    // (`apps/guardrail/src/guardrail/services/external_text_client.py`,
    // present at commit 567d4baf5^, deleted by 567d4baf5). Not paraphrased —
    // a fabricated clinical-validator prompt would be worse than none.
    //
    // `injectionScreeningCriteria` (also `failMode: closed`) is declared in
    // `core/policy.py` but UNUSED by any call site today (reserved for a
    // future LLM-judge second opinion on the inbound path — TASK-777 README
    // §5.6.2). Deliberately NOT seeded here: authoring criteria text for a
    // check nothing resolves yet would be unreviewed policy masquerading as
    // shipped configuration.
    metaData: {
      policy: {
        medicalValidationCriteria:
          'You are a medical context validator. Your task is to determine if the provided text is related to medical documentation, clinical notes, patient care, or healthcare services. Analyze the text and respond ONLY with a JSON object in this exact format:\n{"is_medical": true/false, "confidence": 0.0-1.0, "context_type": "clinical/administrative/general", "reasoning": "brief explanation"}\n\nMedical context includes: patient records, clinical notes, diagnoses, treatments, medications, symptoms, medical procedures, healthcare consultations, referrals, prescriptions, vital signs, medical history, physical examinations, lab results, imaging reports, care plans, discharge summaries.\n\nNon-medical context includes: general conversation, business documents, technical documentation, entertainment content, personal communications unrelated to healthcare.',
      },
    },
  },

  // =========================================================================
  // LM Studio provider
  // =========================================================================
  {
    id: '80000000-0000-0000-0007-000000000004',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Gemma 4 E2B IT QAT (LM Studio)',
    slug: 'lms-gemma-4-e2b-it-qat',
    description:
      'Google Gemma 4 E2B instruction-tuned QAT via LM Studio — the platform default text/summarization model (HarnessPolicy SYSTEM textModel).',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'gemma-4-e2b-it-qat',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    provider: 'lm-studio',
    architecture: 'gemma4',
    memorySizeMb: 2048,
    // Precision refresh (owner-specified exact quant scheme).
    computeType: 'q4_0',
    tags: ['llm', 'lm-studio', 'default', 'summarization'],
  },
  {
    id: '80000000-0000-0000-0007-000000000005',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Gemma 4 E4B IT QAT (LM Studio)',
    slug: 'lms-gemma-4-e4b-it-qat',
    description:
      'Google Gemma 4 E4B instruction-tuned QAT via LM Studio — balanced local text-generation model. Served by the dev LM Studio instance (verified 2026-08-16).',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'gemma-4-e4b-it-qat',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    provider: 'lm-studio',
    architecture: 'gemma4',
    memorySizeMb: 3072,
    // Precision refresh (owner-specified exact quant scheme).
    computeType: 'q4_0',
    tags: ['llm', 'lm-studio'],
  },
  {
    id: '80000000-0000-0000-0007-000000000006',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Gemma 4 Medical ICD-10 (LM Studio)',
    slug: 'lms-gemma-4-medical-icd10',
    description:
      'Gemma 4 medical ICD-10 fine-tune via LM Studio — medical-coding-aware text generation. Not loaded on the dev LM Studio instance (verified 2026-08-10); the identifier is provider-correct, the weights are simply not installed there.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'gemma-4-medical-icd10',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    provider: 'lm-studio',
    architecture: 'gemma4',
    memorySizeMb: 3072,
    // Precision refresh (owner-specified exact quant scheme).
    computeType: 'q5_k_m',
    tags: ['llm', 'lm-studio', 'medical'],
  },
  {
    id: '80000000-0000-0000-0007-000000000007',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Gemma 4 12B QAT (LM Studio)',
    slug: 'lms-gemma-4-12b-qat',
    description:
      'Google Gemma 4 12B QAT via LM Studio — large local text-generation model. Not loaded on the dev LM Studio instance (verified 2026-08-10); the identifier is provider-correct, the weights are simply not installed there.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'google/gemma-4-12b-qat',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    provider: 'lm-studio',
    architecture: 'gemma4',
    memorySizeMb: 8192,
    // Precision refresh (owner-specified exact quant scheme).
    computeType: 'q4_0',
    tags: ['llm', 'lm-studio'],
  },
  {
    id: '80000000-0000-0000-0007-000000000008',
    tenantId: SYSTEM_TENANT_ID,
    name: 'MedGemma 1.5 4B IT (LM Studio)',
    slug: 'lms-medgemma-1.5-4b-it',
    description:
      'MedGemma 1.5 4B instruction-tuned via LM Studio — medical-domain text generation. Not loaded on the dev LM Studio instance (verified 2026-08-10); the identifier is provider-correct, the weights are simply not installed there.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'medgemma-1.5-4b-it',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    provider: 'lm-studio',
    architecture: 'gemma3',
    memorySizeMb: 3072,
    // Precision refresh (owner-specified exact quant scheme).
    computeType: 'q5_k_xl',
    tags: ['llm', 'lm-studio', 'medical'],
  },

  // =========================================================================
  // Azure OpenAI provider (cloud — endpoint/key/deployment configured by
  // admins later; metaData.azureDeployment is the non-secret placeholder)
  // =========================================================================
  {
    id: '80000000-0000-0000-0007-000000000009',
    tenantId: SYSTEM_TENANT_ID,
    name: 'GPT-5.4 Mini (Azure OpenAI)',
    slug: 'azure-gpt-5.4-mini',
    description:
      'OpenAI GPT-5.4 Mini via Azure OpenAI — cloud text generation. Endpoint/API key stay in env/Vault; admins set the deployment name (metaData.azureDeployment).',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'gpt-5.4-mini',
    sourceRevision: 'main',
    format: AiModelFormat.CLOUD_API,
    provider: 'azure',
    architecture: null,
    memorySizeMb: 0,
    computeType: 'cloud',
    tags: ['llm', 'cloud', 'azure'],
    metaData: { azureDeployment: '' },
  },

  // =========================================================================
  // vLLM provider ( / production self-host GPU
  // tier, AD-4). OpenAI-compatible `/v1` wire; prefix-cache + structured
  // `json_schema` output. Additive-only seed rows.
  // =========================================================================
  {
    id: '80000000-0000-0000-0007-000000000020',
    tenantId: SYSTEM_TENANT_ID,
    name: 'MedGemma 1.5 27B IT (vLLM)',
    slug: 'vllm-medgemma-1.5-27b-it',
    description:
      'MedGemma 1.5 27B instruction-tuned served by vLLM — production self-host GPU tier (AD-4). OpenAI-compatible `/v1` wire with prefix caching + structured json_schema output.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'google/medgemma-1.5-27b-it',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    provider: 'vllm',
    architecture: 'gemma3',
    memorySizeMb: 55296,
    computeType: 'bf16',
    tags: ['llm', 'vllm', 'medical', 'self-host'],
  },

  // =========================================================================
  // llama.cpp provider ( / production self-host
  // GGUF tier, AD-4). OpenAI-compatible `/v1` wire (`cache_prompt`). Additive.
  // =========================================================================
  {
    id: '80000000-0000-0000-0007-000000000021',
    tenantId: SYSTEM_TENANT_ID,
    name: 'MedGemma 1.5 4B IT (llama.cpp)',
    slug: 'llama-cpp-medgemma-1.5-4b-it',
    description:
      'MedGemma 1.5 4B instruction-tuned served by the llama.cpp server — production self-host GGUF tier (AD-4). OpenAI-compatible `/v1` wire with `cache_prompt` prefix caching + structured json_schema output.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'medgemma-1.5-4b-it-Q5_K_M.gguf',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    provider: 'llama-cpp',
    architecture: 'gemma3',
    memorySizeMb: 3584,
    computeType: 'q5_k_m',
    tags: ['llm', 'llama-cpp', 'medical', 'self-host'],
  },

  // =========================================================================
  // AWS Bedrock provider (TEXT supports the `bedrock` provider but
  // the catalog had no row. Region/credentials stay in env/Vault; sourceUri is
  // the Bedrock model id sent to the converse API.)
  // =========================================================================
  {
    id: '80000000-0000-0000-0007-000000000022',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Claude 3.5 Haiku (Bedrock)',
    slug: 'bedrock-claude-3.5-haiku',
    description:
      'Anthropic Claude 3.5 Haiku via AWS Bedrock — cloud text generation. Matches the TEXT Bedrock provider default (TEXT_BEDROCK_DEFAULT_MODEL). Region/keys stay in env/Vault.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'anthropic.claude-3-5-haiku-20241022-v1:0',
    sourceRevision: 'main',
    format: AiModelFormat.CLOUD_API,
    provider: 'bedrock',
    architecture: 'claude',
    memorySizeMb: 0,
    computeType: 'cloud',
    tags: ['llm', 'cloud', 'bedrock'],
  },

  // =========================================================================
  // Harness LLM-as-judge model (catalogued alternate; the `harness.judge`
  // AiTaskDefault currently targets `lms-gemma-4-e2b-it-qat` — see
  // 16-ai-task-default.ts — not this row).
  // =========================================================================
  {
    id: '80000000-0000-0000-0007-000000000023',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Gemma 4 E4B (LM Studio judge)',
    slug: 'lms-gemma-4-e4b',
    description:
      'Google Gemma 4 E4B served via LM Studio (OpenAI-compatible) — an alternate harness LLM-as-judge model. The sourceUri previously read `google/gemma-4-e4b-qat`, an identifier the live instance has never served (every prior judge call against it 404d); corrected to `google/gemma-4-e4b`, which the instance does serve (verified 2026-08-16).',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'google/gemma-4-e4b',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    provider: 'lm-studio',
    architecture: 'gemma4',
    memorySizeMb: 3072,
    computeType: 'q4_0',
    tags: ['llm', 'lm-studio', 'judge'],
  },

  // =========================================================================
  // Vision — first ModelCategory.VISION / IMAGE_TEXT_TO_TEXT row.
  // Same LM Studio weights as `lms-medgemma-1.5-4b-it` above (a 4B MedGemma
  // checkpoint is natively multimodal — one set of weights, two catalog rows
  // for two task types; `AiModel`'s only uniqueness constraint is
  // (tenantId, slug), not sourceUri). In-boundary (self-hosted) default —
  // no PHI ever leaves the tenant's infrastructure — chosen over a BYOK cloud
  // VLM (see docs/implementation/TASK-657-Vision-Capability/README.md for
  // the full tradeoff). Not loaded on the dev LM Studio instance (verified
  // 2026-08-10, same as `lms-medgemma-1.5-4b-it`); catalogued-but-not-loaded
  // rows are never selected by an AiTaskDefault, so `vlm.extract` has
  // deliberately NO SYSTEM default and fails closed until an operator either
  // loads these weights or a BYOK cloud vision credential is configured.
  // =========================================================================
  {
    id: '80000000-0000-0000-0007-000000000024',
    tenantId: SYSTEM_TENANT_ID,
    name: 'MedGemma 1.5 4B IT — Vision (LM Studio)',
    slug: 'lms-medgemma-1.5-4b-it-vision',
    description:
      'MedGemma 1.5 4B instruction-tuned via LM Studio — medical image+text vision-language extraction (TASK-657 vlm.extract). Not loaded on the dev LM Studio instance (verified 2026-08-10); the identifier is provider-correct, the weights are simply not installed there.',
    category: ModelCategory.VISION,
    taskType: ModelTaskType.IMAGE_TEXT_TO_TEXT,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'medgemma-1.5-4b-it',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    provider: 'lm-studio',
    architecture: 'gemma3',
    memorySizeMb: 3072,
    computeType: 'q5_k_xl',
    tags: ['vision', 'lm-studio', 'medical'],
  },
];
