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
 * LLM (text generation / summarization) + guardrail model catalog
 * (the owner-approved 10-model matrix).
 *
 * Replaces the previous 31 LLM/guardrail rows. `sourceUri` carries the
 * provider-native identifier actually sent to the runtime (Ollama tag,
 * LM Studio model name, Azure model id); `slug` stays the stable registry
 * key. New rows use the fresh `80000000-…-0007-…` id block (0001–0006 are
 * occupied by the legacy audio/LLM/browser blocks).
 */
export const LLM_AI_MODELS: AiModelSeed[] = [
    // =========================================================================
    // Guardrail / Safety (kept — slug continuity with HarnessPolicy.safetyModel)
    // =========================================================================
    {
        id: '80000000-0000-0000-0005-000000000060',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Granite Guardian 4.1 8B',
        slug: 'granite-guardian-4.1-8b',
        description: 'IBM Granite Guardian 4.1 8B — safety/guardrail model. `format` is descriptive metadata (GGUF / llama.cpp); serving is provider-based (LM Studio). Platform default for guardrail.validate (AiTaskDefault).',
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
    },

    // =========================================================================
    // Ollama provider
    // =========================================================================
    {
        id: '80000000-0000-0000-0007-000000000001',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Gemma 4 12B MLX (Ollama)',
        slug: 'ollama-gemma4-12b-mlx',
        description: 'Google Gemma 4 12B (MLX build) via Ollama — large local text-generation model for Apple-silicon hosts.',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'gemma4:12b-mlx',
        sourceRevision: 'main',
        format: AiModelFormat.MLX,
        provider: 'ollama',
        architecture: 'gemma4',
        memorySizeMb: 8192,
        // Precision refresh (owner-specified exact quant scheme).
        computeType: 'nvfp4',
        tags: ['llm', 'ollama'],
    },
    {
        id: '80000000-0000-0000-0007-000000000002',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Gemma 4 E2B IT QAT (Ollama)',
        slug: 'ollama-gemma4-e2b-it-qat',
        description: 'Google Gemma 4 E2B instruction-tuned QAT via Ollama — compact edge-class text-generation model.',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'gemma4:e2b-it-qat',
        sourceRevision: 'main',
        format: AiModelFormat.GGUF,
        provider: 'ollama',
        architecture: 'gemma4',
        memorySizeMb: 2048,
        // Precision refresh (owner-specified exact quant scheme).
        computeType: 'Q4_0',
        tags: ['llm', 'ollama'],
    },
    {
        id: '80000000-0000-0000-0007-000000000003',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Qwen 3.5 2B (Ollama)',
        slug: 'ollama-qwen3.5-2b',
        description: 'Qwen 3.5 2B via Ollama — smallest local text-generation model, ideal for testing.',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'qwen3.5:2b',
        sourceRevision: 'main',
        format: AiModelFormat.GGUF,
        provider: 'ollama',
        architecture: 'qwen3.5',
        memorySizeMb: 1536,
        // Precision refresh (owner-specified exact quant scheme).
        computeType: 'Q8_0',
        tags: ['llm', 'ollama'],
    },

    // =========================================================================
    // LM Studio provider
    // =========================================================================
    {
        id: '80000000-0000-0000-0007-000000000004',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Gemma 4 E2B IT QAT (LM Studio)',
        slug: 'lms-gemma-4-e2b-it-qat',
        description: 'Google Gemma 4 E2B instruction-tuned QAT via LM Studio — the platform default text/summarization model (HarnessPolicy SYSTEM smrModel).',
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
        description: 'Google Gemma 4 E4B instruction-tuned QAT via LM Studio — balanced local text-generation model.',
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
        description: 'Gemma 4 medical ICD-10 fine-tune via LM Studio — medical-coding-aware text generation.',
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
        description: 'Google Gemma 4 12B QAT via LM Studio — large local text-generation model.',
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
        description: 'MedGemma 1.5 4B instruction-tuned via LM Studio — medical-domain text generation.',
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
        description: 'OpenAI GPT-5.4 Mini via Azure OpenAI — cloud text generation. Endpoint/API key stay in env/Vault; admins set the deployment name (metaData.azureDeployment).',
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
        description: 'MedGemma 1.5 27B instruction-tuned served by vLLM — production self-host GPU tier (AD-4). OpenAI-compatible `/v1` wire with prefix caching + structured json_schema output.',
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
        description: 'MedGemma 1.5 4B instruction-tuned served by the llama.cpp server — production self-host GGUF tier (AD-4). OpenAI-compatible `/v1` wire with `cache_prompt` prefix caching + structured json_schema output.',
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
    // AWS Bedrock provider (SMR supports the `bedrock` provider but
    // the catalog had no row. Region/credentials stay in env/Vault; sourceUri is
    // the Bedrock model id sent to the converse API.)
    // =========================================================================
    {
        id: '80000000-0000-0000-0007-000000000022',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Claude 3.5 Haiku (Bedrock)',
        slug: 'bedrock-claude-3.5-haiku',
        description: 'Anthropic Claude 3.5 Haiku via AWS Bedrock — cloud text generation. Matches the SMR Bedrock provider default (SMR_V2_BEDROCK_DEFAULT_MODEL). Region/keys stay in env/Vault.',
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
    // Harness LLM-as-judge model (the judge is served on an
    // OpenAI-compatible LM Studio endpoint; sourceUri is the model id sent to
    // the judge client. Default target for the `harness.judge` AiTaskDefault.)
    // =========================================================================
    {
        id: '80000000-0000-0000-0007-000000000023',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Gemma 4 E4B (LM Studio judge)',
        slug: 'lms-gemma-4-e4b',
        description: 'Google Gemma 4 E4B served via LM Studio (OpenAI-compatible) — the harness LLM-as-judge default (harness.judge AiTaskDefault; matches HARNESS_JUDGE model google/gemma-4-e4b).',
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
];
