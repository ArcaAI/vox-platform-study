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
 * The LM Studio tier declares one MORE parameter than the resolved set above: `reasoning`.
 *
 * It is not part of `defaults.py`'s `{temperature, max_tokens, top_p}` because it does not travel
 * that way at all. `parameters.generation.reasoning` (TASK-891 C1 / OD-4) travels as its own
 * `GenerateRequest.reasoning` posture since TASK-970, and each adapter renders it into that
 * engine's own parameter — `apps/text/src/text/core/reasoning.py`. LM Studio is classified
 * `effort-only` there: its documented vocabulary is low|medium|high with no off value, so an
 * authored `enabled: false` is approximated by the lowest rung rather than a true stop.
 *
 * And it is honoured, not merely accepted: measured on `gemma-4-e2b-it-qat` under LM Studio on
 * 2026-09-07, unset gave 5168 ms / 184 reasoning tokens against 1237 ms / 30 with `minimal`
 * (`agent-schemas.ts:126-131`).
 *
 * So on the LM Studio rows `reasoning` is honest capability. It is deliberately NOT added to the
 * Azure row: `AzureOpenAIProvider` is its own class and forwards no `extra`, so there the
 * parameter WOULD be dropped on the wire and the publish gate is right to refuse it.
 */
const LM_STUDIO_GENERATION_PARAMS: GenerationParamName[] = [...TEXT_PLANE_GENERATION_PARAMS, 'reasoning'];

/**
 * The context window the LM Studio rows are SERVED with (owner directive 2026-09-18).
 *
 * One constant, because the number has to agree with `LMS_CONTEXT` in the deployment repo's
 * `base/lmstudio.yaml`, which is what `lms load --context-length` loads the weights at. The
 * dev overlay no longer patches it: this is the DEFAULT for every environment, and an
 * environment that must differ overrides it there — and must lower this with it.
 *
 * It is a BUDGET, and the invariant is one-directional: it must never EXCEED what the engine
 * was loaded with. Under-claiming is safe (the lane leaves headroom unused); over-claiming is
 * the bug, because a pre-dispatch check would pass and the engine would still answer
 * `exceed_context_size_error`.
 *
 * 131072 IS the maximum the engine reports for this model, so the invariant now holds only at
 * equality and there is no slack left to absorb a mistake. That is why it is declared on the
 * PRELOADED row alone — see the E2B/E4B note at the rows themselves.
 *
 * Residency, which is the constraint that actually binds: LM Studio gives each of its
 * `LMS_PARALLEL` slots the FULL context rather than dividing it (measured — a single request
 * was served the whole configured window), so KV-cache memory scales with
 * `context x parallel`. At the 2026-09-18 settings (131072 x 10) that is more than one
 * RTX 2000 Ada holds; KV-cache quantization would fix it and is not reachable headless in
 * LM Studio 0.0.23-1. See the ticket README.
 */
const LM_STUDIO_CONTEXT_LENGTH = 131072;

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
    // `injectionScreeningCriteria` is GONE (TASK-886). It was declared in
    // `core/policy.py` with no reader anywhere — reserved for an inbound
    // LLM-judge second opinion that was never built — and was deliberately
    // never seeded here for that reason. The declaration itself has now been
    // removed too: a fail-closed key with no reader advertises a control an
    // admin cannot move, which is worse than an absent one. If that lane is
    // ever built, the key returns IN THE SAME CHANGE as its reader.
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
    metaData: {
      hubArtifact: 'google/gemma-4-E2B-it-qat-q4_0-gguf',
      supportedGenerationParams: LM_STUDIO_GENERATION_PARAMS,
      // The PRELOADED model (`LMS_LOAD`), so `LMS_CONTEXT` -> `lms load --context-length`
      // guarantees the window this declares. Keep the two equal.
      contextLength: LM_STUDIO_CONTEXT_LENGTH,
    },
  },
  {
    // The E4B tier of the catalogue, and the harness LLM-as-judge's alternate.
    // The id is the one the retired `lms-gemma-4-e4b` (un-quantised bf16) row
    // carried, because `seedAiModels` upserts on (tenantId, slug): keeping it
    // makes the rename an in-place update on an existing database and a cold
    // seed produce the same id. The old QAT slug is in the never-reuse ledger.
    id: '80000000-0000-0000-0007-000000000023',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Gemma 4 E4B IT QAT (LM Studio)',
    slug: 'lms-gemma-4-e4b',
    description:
      'Google Gemma 4 E4B instruction-tuned QAT (q4_0 GGUF + mmproj) via LM Studio — balanced local text-generation model, and the alternate harness LLM-as-judge. Served by the dev LM Studio instance (verified 2026-08-16).',
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
    tags: ['llm', 'lm-studio', 'mmproj', 'judge'],
    metaData: {
      hubArtifact: 'google/gemma-4-E4B-it-qat-q4_0-gguf',
      supportedGenerationParams: LM_STUDIO_GENERATION_PARAMS,
      // Deliberately NO `contextLength`. This row is not in `LMS_LOAD`, so LM Studio
      // JIT-loads it without `--context-length`, on a default this seed does not control —
      // the catalogue reports 131072 for the `@q4_0` variant but 4096 for the unqualified
      // one. While the declaration equalled a value BELOW the engine maximum it could be a
      // safe under-claim; at the maximum itself any JIT default lower than that turns it
      // into an over-claim, which is the one direction the invariant forbids. Undeclared is
      // honest, and the catalogue mapper omits the field rather than inventing a budget.
    },
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
