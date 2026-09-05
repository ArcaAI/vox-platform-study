import { ResourceStatusType } from '../../../../generated/core-prisma-client/client.js';
import { SYSTEM_TENANT_ID } from '../00-constants';
import {
  AiDeploymentKind,
  AiModelAvailability,
  AiModelFormat,
  AiModelSource,
  AiTaskKind,
  ModelCategory,
  ModelTaskType,
  ModelType,
  type AiModelSeed,
  type GenerationParamName,
} from './shared';

/**
 * finding F-32 — the generation hyper-parameters this platform can actually deliver to
 * a provider, declared once and shared by every generation row below.
 *
 * This is a MEASURED fact about `apps/text`, not a vendor capability matrix:
 *
 *   - `apps/text/src/text/core/defaults.py:41-43` defines the whole resolved parameter set as
 *     `{temperature, max_tokens, top_p}`, and `:69-71` is where a request's values enter it.
 *   - `AiRuntimeProfile` carries exactly `temperature`, `topP`, `maxTokens` and no other
 *     generation column (`ai-runtime-profile.prisma:28-30`).
 *   - No adapter in `apps/text/src/text/providers/` mentions a penalty parameter at all.
 *
 * So on THIS platform, a node that sets `presencePenalty`, `frequencyPenalty`, `seed` or
 * `stopSequences` is tuning a value that never reaches a provider. Declaring the honest set is
 * what lets the publish gate say so at authoring time instead of letting it be discovered in a
 * consultation.
 */
const TEXT_PLANE_GENERATION_PARAMS: GenerationParamName[] = ['temperature', 'maxTokens', 'topP'];

/**
 * text-generation catalogue (TASK-860 — the owner's catalogue, exactly): the
 * granite-guardian safety LLM, four Gemma 4 rows on LM Studio, and the Azure
 * OpenAI cloud row. Retired here (see `retired.ts`): `lms-gemma-4-12b-qat`,
 * `lms-medgemma-1.5-4b-it`, `lms-medgemma-1.5-4b-it-vision`,
 * `vllm-medgemma-1.5-27b-it`, `llama-cpp-medgemma-1.5-4b-it`,
 * `bedrock-claude-3.5-haiku`.
 *
 * ## LM Studio identifiers — the invariant
 *
 * For an `lm-studio` row, `sourceUri` IS the LM Studio model id the services
 * put on the wire as `model` (`findByProviderAndSourceUri`, the TEXT router).
 * A wrong identifier is a guaranteed 404 at request time. `wireModelId`
 * mirrors it; the Hub artifact the PUBLISHER fetches is `metaData.hubArtifact`
 * until TASK-862 re-points routing at `wireModelId`, after which `sourceUri`
 * can become the Hub repo the schema comment describes.
 *
 * GGUF loading happens in the `hope-lmstudio` workload (`servedBy: lmstudio`);
 * the Gemma 4 GGUF repos carry a separate `-mmproj.gguf` the publisher keeps.
 */
export const LLM_AI_MODELS: AiModelSeed[] = [
  // =========================================================================
  // Guardrail / Safety — the granite-guardian screen (guardrail.validate)
  // =========================================================================
  {
    // IBM ships no first-party GGUF for granite-guardian — the artifact is the
    // community quant `mradermacher/granite-guardian-4.1-8b-GGUF` (Q4_K_M
    // published; the previous seed said q4_k_s).
    id: '80000000-0000-0000-0005-000000000060',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Granite Guardian 4.1 8B',
    slug: 'granite-guardian-4.1-8b',
    description:
      'IBM Granite Guardian 4.1 8B — safety/guardrail LLM served by LM Studio (llama.cpp GGUF, community quant mradermacher/granite-guardian-4.1-8b-GGUF Q4_K_M). Platform default for guardrail.validate.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.GUARDRAIL,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'granite-guardian-4.1-8b',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    libraryName: 'llama.cpp',
    servedBy: 'lmstudio',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    wireModelId: 'granite-guardian-4.1-8b',
    license: 'apache-2.0',
    baseModel: 'ibm-granite/granite-guardian-4.1-8b',
    languages: ['en'],
    provider: 'lm-studio',
    architecture: 'granite',
    memorySizeMb: 4900,
    computeType: 'q4_k_m',
    tags: ['guardrail', 'safety', 'granite'],
    // `metaData.policy` — the governed key set declared in
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
    // future LLM-judge second opinion on the inbound path). Deliberately NOT
    // seeded here: authoring criteria text for a check nothing resolves yet
    // would be unreviewed policy masquerading as shipped configuration.
    //
    // `judgeTemperature` / `judgeMaxTokens` (TASK-878, both `failMode: closed`)
    // ARE seeded, because unlike the above they have a reader: they were
    // `JudgePolicy.temperature = 0.05` and `.max_tokens = 300` in
    // `apps/guardrail/src/guardrail/core/config.py`, and the values below are
    // those literals transcribed verbatim, so moving them changed no behaviour.
    // They belong on THIS row rather than on a platform setting because they are
    // model-coupled: a decoding temperature and an output-token budget calibrated
    // for this checkpoint's JSON verdict are meaningless against another, so they
    // must resolve through the same tenant → SYSTEM cascade that chose the model.
    // Fail-closed with no code default — an unseeded row makes
    // `POST /medical/validate` answer 503 rather than judge at a temperature
    // nobody chose (`GuardrailPolicy.require_number`).
    metaData: {
      hubArtifact: 'mradermacher/granite-guardian-4.1-8b-GGUF',
      policy: {
        judgeTemperature: 0.05,
        judgeMaxTokens: 300,
        medicalValidationCriteria:
          'You are a medical context validator. Your task is to determine if the provided text is related to medical documentation, clinical notes, patient care, or healthcare services. Analyze the text and respond ONLY with a JSON object in this exact format:\n{"is_medical": true/false, "confidence": 0.0-1.0, "context_type": "clinical/administrative/general", "reasoning": "brief explanation"}\n\nMedical context includes: patient records, clinical notes, diagnoses, treatments, medications, symptoms, medical procedures, healthcare consultations, referrals, prescriptions, vital signs, medical history, physical examinations, lab results, imaging reports, care plans, discharge summaries.\n\nNon-medical context includes: general conversation, business documents, technical documentation, entertainment content, personal communications unrelated to healthcare.',
      },
    },
  },

  // =========================================================================
  // LM Studio — Gemma 4
  // =========================================================================
  {
    id: '80000000-0000-0000-0007-000000000004',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Gemma 4 E2B IT QAT (LM Studio)',
    slug: 'lms-gemma-4-e2b-it-qat',
    description:
      'Google Gemma 4 E2B instruction-tuned QAT (q4_0 GGUF + mmproj) via LM Studio — the platform default text-generation model (HarnessPolicy SYSTEM textModel).',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'gemma-4-e2b-it-qat',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    libraryName: 'llama.cpp',
    servedBy: 'lmstudio',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    wireModelId: 'gemma-4-e2b-it-qat',
    license: 'gemma',
    gated: true,
    baseModel: 'google/gemma-4-E2B-it',
    languages: ['en'],
    isPlatformDefaultFor: [AiTaskKind.TEXT_GENERATION],
    provider: 'lm-studio',
    architecture: 'gemma4',
    memorySizeMb: 2048,
    computeType: 'q4_0',
    tags: ['llm', 'lm-studio', 'default', 'summarization', 'mmproj'],
    metaData: { hubArtifact: 'google/gemma-4-E2B-it-qat-q4_0-gguf', supportedGenerationParams: TEXT_PLANE_GENERATION_PARAMS },
  },
  {
    id: '80000000-0000-0000-0007-000000000005',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Gemma 4 E4B IT QAT (LM Studio)',
    slug: 'lms-gemma-4-e4b-it-qat',
    description:
      'Google Gemma 4 E4B instruction-tuned QAT (q4_0 GGUF + mmproj) via LM Studio — balanced local text-generation model. Served by the dev LM Studio instance (verified 2026-08-16).',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'gemma-4-e4b-it-qat',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    libraryName: 'llama.cpp',
    servedBy: 'lmstudio',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    wireModelId: 'gemma-4-e4b-it-qat',
    license: 'gemma',
    gated: true,
    baseModel: 'google/gemma-4-E4B-it',
    languages: ['en'],
    provider: 'lm-studio',
    architecture: 'gemma4',
    memorySizeMb: 3072,
    computeType: 'q4_0',
    tags: ['llm', 'lm-studio', 'mmproj'],
    metaData: { hubArtifact: 'google/gemma-4-E4B-it-qat-q4_0-gguf', supportedGenerationParams: TEXT_PLANE_GENERATION_PARAMS },
  },
  {
    // Unvalidated community fine-tune (5 downloads) — seeded DISABLED pending
    // evaluation (decision D-5). Upstream is safetensors; needs a GGUF
    // conversion step before LM Studio can serve it.
    id: '80000000-0000-0000-0007-000000000006',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Gemma 4 Medical ICD-10 (LM Studio)',
    slug: 'lms-gemma-4-medical-icd10',
    description:
      'Gemma 4 medical ICD-10 community fine-tune (nikhil061307/Gemma-4-Medical-ICD10) via LM Studio — medical-coding-aware text generation. UNVALIDATED; DISABLED until evaluated. Needs a GGUF conversion step.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.FINETUNED_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'gemma-4-medical-icd10',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    libraryName: 'llama.cpp',
    servedBy: 'lmstudio',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    wireModelId: 'gemma-4-medical-icd10',
    license: 'gemma',
    baseModel: 'google/gemma-4-E4B-it',
    languages: ['en'],
    provider: 'lm-studio',
    architecture: 'gemma4',
    memorySizeMb: 3072,
    computeType: 'q5_k_m',
    tags: ['llm', 'lm-studio', 'medical', 'unvalidated', 'requires-conversion'],
    metaData: { hubArtifact: 'nikhil061307/Gemma-4-Medical-ICD10', supportedGenerationParams: TEXT_PLANE_GENERATION_PARAMS },
    resourceStatus: ResourceStatusType.DISABLED,
  },
  {
    // The un-quantised E4B build — a catalogued ALTERNATE for the harness
    // LLM-as-judge. `harness.judge` targets the QAT row; this one is here so
    // a super admin can select the bf16 build deliberately. Upstream is bf16
    // safetensors; needs a GGUF conversion step.
    id: '80000000-0000-0000-0007-000000000023',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Gemma 4 E4B (LM Studio judge)',
    slug: 'lms-gemma-4-e4b',
    description:
      'Google Gemma 4 E4B served via LM Studio (OpenAI-compatible) — an alternate harness LLM-as-judge model. Identifier verified against the live instance 2026-08-16 (`google/gemma-4-e4b`). Upstream bf16 safetensors; needs a GGUF conversion step.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'google/gemma-4-e4b',
    sourceRevision: 'main',
    format: AiModelFormat.GGUF,
    libraryName: 'llama.cpp',
    servedBy: 'lmstudio',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    wireModelId: 'google/gemma-4-e4b',
    license: 'gemma',
    gated: true,
    baseModel: 'google/gemma-4-E4B',
    languages: ['en'],
    provider: 'lm-studio',
    architecture: 'gemma4',
    memorySizeMb: 3072,
    computeType: 'q4_0',
    tags: ['llm', 'lm-studio', 'judge', 'requires-conversion'],
    metaData: { hubArtifact: 'google/gemma-4-E4B', supportedGenerationParams: TEXT_PLANE_GENERATION_PARAMS },
  },

  // =========================================================================
  // Azure OpenAI (cloud — gateway-governed, executed by text)
  // =========================================================================
  {
    id: '80000000-0000-0000-0007-000000000009',
    tenantId: SYSTEM_TENANT_ID,
    name: 'GPT-5.4 Mini (Azure OpenAI)',
    slug: 'azure-gpt-5.4-mini',
    description:
      'OpenAI GPT-5.4 Mini via Azure OpenAI — cloud text generation. Endpoint/API key live on the `llm`/`azure` provider connection; the deployment name is set there (metaData.azureDeployment is the legacy placeholder).',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TEXT_GENERATION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'gpt-5.4-mini',
    sourceRevision: 'main',
    format: AiModelFormat.CLOUD_API,
    libraryName: 'azure-openai',
    servedBy: 'text',
    deploymentKind: AiDeploymentKind.CLOUD,
    wireModelId: 'gpt-5.4-mini',
    languages: ['en'],
    availability: AiModelAvailability.NOT_APPLICABLE,
    provider: 'azure',
    architecture: null,
    memorySizeMb: 0,
    computeType: 'cloud',
    tags: ['llm', 'cloud', 'azure'],
    metaData: { azureDeployment: '', supportedGenerationParams: TEXT_PLANE_GENERATION_PARAMS },
  },
];
