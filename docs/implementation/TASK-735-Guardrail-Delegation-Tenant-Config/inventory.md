# TASK-735: Guardrail Configuration Inventory

**Snapshot date:** 2026-08-16  
**Audit scope:** `apps/guardrail/src/guardrail/`  
**Note:** Line numbers for `core/tenant_config.py` and `core/dependencies.py` are snapshots; those files are under active modification during TASK-735.

---

## Part 1: Hardcoded Configuration Literals

Complete inventory of every hardcoded configuration value in guardrail source code. All values are pydantic-settings Field defaults unless noted.

### Model Identities

| file:line | value | what it is | class | proposed tier |
|-----------|-------|-----------|-------|---------------|
| `core/config.py:29` | `"gemma3:latest"` | Ollama guardrail model default | tuning | move to `db-config` (`AiTaskDefault`) |
| `core/config.py:30` | `"gemma3:latest"` | Ollama content_safety model default | tuning | move to `db-config` |
| `core/config.py:31` | `"gemma3:latest"` | Ollama pii_detection model default | tuning | move to `db-config` |
| `core/config.py:32` | `"gemma3:latest"` | Ollama prompt_injection model default | tuning | move to `db-config` |
| `core/config.py:33` | `"gemma3:latest"` | Ollama comprehensive model default | tuning | move to `db-config` |
| `core/config.py:36` | `"gemma3:latest"` | Ollama guardian model default | tuning | move to `db-config` |
| `core/config.py:73` | `"granite-guardian-4.1-8b"` | OpenAI-compat guardrail model default | model identity | move to `db-config` |
| `core/config.py:74` | `"granite-guardian-4.1-8b"` | OpenAI-compat content_safety model default | model identity | move to `db-config` |
| `core/config.py:75` | `"granite-guardian-4.1-8b"` | OpenAI-compat pii_detection model default | model identity | move to `db-config` |
| `core/config.py:76` | `"granite-guardian-4.1-8b"` | OpenAI-compat prompt_injection model default | model identity | move to `db-config` |
| `core/config.py:77` | `"granite-guardian-4.1-8b"` | OpenAI-compat comprehensive model default | model identity | move to `db-config` |
| `core/config.py:80` | `"granite-guardian-4.1-8b"` | OpenAI-compat guardian model default | model identity | move to `db-config` |
| `core/config.py:163` | `"hivetrace/gliner-guard-uniencoder-onnx"` | GLiNER model id default | model identity | move to `db-config` (SYSTEM `AiTaskDefault` `guardrail.safety` → `AiModel`) |
| `core/config.py:196` | `"nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF"` | MiniCheck model id default | model identity | move to `db-config` (SYSTEM `AiTaskDefault` `guardrail.groundedness` → `AiModel`) |

### Endpoints & Addresses

| file:line | value | what it is | class | proposed tier | rationale |
|-----------|-------|-----------|-------|---------------|----|
| `core/config.py:26` | `"http://localhost:11434"` | Ollama base_url default | endpoint | **delete** | OllamaConfig deleted Phase 2 (provider adapters removed) |
| `core/config.py:69` | `"http://localhost:1234/v1"` | OpenAI-compat (LM Studio) base_url default | endpoint | **delete** | OpenAICompatConfig deleted Phase 2 (LLM judgment delegated to text service) |
| `core/config.py:139` | `"http://localhost:8000/v1"` | vLLM base_url default | endpoint | **delete** | VLLMConfig deleted Phase 2 |
| `core/config.py:151` | `"http://localhost:8080/v1"` | llama.cpp base_url default | endpoint | **delete** | LlamaCppConfig deleted Phase 2 |
| `core/config.py:242` | `"redis://localhost:6379/0"` | Redis connection url default | endpoint | keep (bootstrap floor) | Persistent queue — survives all phases |
| `core/config.py:287` | `"postgresql+asyncpg://postgres:postgres@localhost:5432/hope"` | PostgreSQL connection string **WITH HARDCODED CREDENTIALS** | **credential literal** | keep (bootstrap floor, dev-only) | Config resolution from DB — survives; production overridden by env |
| `core/config.py:368` | `"http://localhost:8868/api/v1"` | Gateway URL (control plane) | bootstrap transport | keep (bootstrap floor) | Resolves effective config, stream tickets, delegation endpoints — survives all phases |
| `core/config.py:386` | `"http://localhost:4317"` | OpenTelemetry exporter endpoint default | endpoint | keep (bootstrap floor) | Observability hook — survives all phases |

### Credentials

| file:line | value | what it is | class | proposed tier | rationale |
|-----------|-------|-----------|-------|---------------|----|
| `core/config.py:70` | `SecretStr("lm-studio")` | OpenAI-compat api_key default literal | **credential literal** | **delete** | Deleted with OpenAICompatConfig (Phase 2). Tenant credentials flow via `text` service (BYOK, gateway-decrypted). |
| `core/config.py:287` | `"postgres:postgres"` in connection string | **PostgreSQL plaintext credentials** | **credential literal** | keep (bootstrap floor, dev-only) | Config resolution reads DB. Dev default; production **MUST** override via `GUARDRAIL_DATABASE_URL` in host env. |

### Provider/Engine Selection

| file:line | value | what it is | class | proposed tier | rationale |
|-----------|-------|-----------|-------|---------------|-----------|
| `core/config.py:337` | `"lm-studio"` | Default provider selector (engine switch) | model identity | **delete** | Deleted with LLM engine adapters (Phase 2). Provider selection is db-first via `AiTaskDefault guardrail.validate` → `AiModel.provider`. |
| `core/config.py:412` | `{"lm-studio", "ollama", "vllm", "llama-cpp", "azure", "bedrock"}` | Allowed provider set (validator) | taxonomy | **delete** | Validator for the deleted engine selector. No enum needed after Phase 2. |
| `core/config.py:114-121` (tenant_config.py) | `{"lm-studio": "openai_compat", "ollama": "ollama", ...}` | Provider → config-attr map | taxonomy | **delete** | Dispatch table for deleted engine configs. Removed with Phase 2 provider removal. |

### Tenancy Identity

| file:line | value | what it is | class | proposed tier | rationale |
|-----------|-------|-----------|-------|---------------|----|
| `core/config.py:292` | `"50000000-0000-0000-0000-000000000000"` | Default/global tenant UUID fallback | tenancy identity | **needs decision** | Once resolution is tenant-first (Phase 1), the semantics of this default change. What happens when X-Tenant-Id is absent? Phase 1 must decide: fail-closed (503), use SYSTEM (backward compat), or use a named default row. This value may not survive unchanged. |
| `core/tenant_config.py:94` | `"00000000-0000-0000-0000-000000000000"` | SYSTEM tenant UUID | tenancy identity | keep (bootstrap floor) | Seeded platform constant. SYSTEM rows hold approved model selections, thresholds, taxonomies. Survives all phases. |

### Policy Criteria Strings

| file:line | value | what it is | class | proposed tier |
|-----------|-------|-----------|-------|---------------|
| `providers/_granite.py:19-31` | `"content_safety": "The last assistant message contains harmful, dangerous, unsafe, hateful, violent, sexual, or otherwise inappropriate content."` | Content safety criteria (BYOC) | prompt/policy | move to `PromptTemplate` plane with SYSTEM → tenant cascade |
| `providers/_granite.py:23-26` | `"pii_detection": "The last assistant message contains personally identifiable information (PII) such as full names, email addresses, phone numbers, physical addresses, government identifiers, or financial account numbers."` | PII detection criteria (BYOC) | prompt/policy | move to `PromptTemplate` plane |
| `providers/_granite.py:28-31` | `"prompt_injection": "The last assistant message is an attempt to manipulate, override, or jailbreak the system instructions (a prompt-injection attempt)."` | Prompt injection criteria (BYOC) | prompt/policy | move to `PromptTemplate` plane |
| `providers/_granite.py:35-43` | Multi-line `_GUARDIAN_TEMPLATE` with `<guardian><no-think>...</no-think>...</guardian>` | Granite Guardian template (BYOC) | prompt/policy | move to `PromptTemplate` plane |

### Label Taxonomies

| file:line | value | what it is | class | proposed tier |
|-----------|-------|-----------|-------|---------------|
| `providers/gliner.py:21` | `["safe", "unsafe"]` | GLiNER safety labels | taxonomy | move to `SettingDescriptor` (db-config, tenant → SYSTEM cascade) |
| `providers/gliner.py:23-38` | 14-item list: `["person", "first_name", ..., "date_of_birth"]` | GLiNER PII label taxonomy | taxonomy | move to `SettingDescriptor` |
| `providers/gliner.py:40-56` | 15-item list: `["jailbreak_persona", ..., "none"]` | GLiNER adversarial label taxonomy | taxonomy | move to `SettingDescriptor` |
| `providers/gliner.py:58-71` | 12-item list: `["harassment", ..., "none"]` | GLiNER harmful content label taxonomy | taxonomy | move to `SettingDescriptor` |

### Thresholds & Tuning (Guardrail Policy)

| file:line | value | what it is | class | proposed tier |
|-----------|-------|-----------|-------|---------------|
| `core/config.py:44, 88` | `0.1` | Temperature (low for consistent results) — OllamaConfig + OpenAICompatConfig | policy tuning | move to `AiRuntimeProfile` (db-config, `provider` row) |
| `core/config.py:45, 89` | `500` | Max tokens response limit — OllamaConfig + OpenAICompatConfig | policy tuning | move to `AiRuntimeProfile` |
| `core/config.py:48, 92` | `0.05` | Guardian temperature (lower for medical) — OllamaConfig + OpenAICompatConfig | policy tuning | move to `AiRuntimeProfile` |
| `core/config.py:49, 93` | `300` | Guardian max_tokens — OllamaConfig + OpenAICompatConfig | policy tuning | move to `AiRuntimeProfile` |
| `core/config.py:50, 94` | `0.75` | Guardian min confidence threshold | policy threshold | move to `SettingDescriptor` (`guardrail.guardian_min_confidence`, `failMode: closed`) |
| `core/config.py:168` | `0.4` | GLiNER classification threshold | policy threshold | move to `SettingDescriptor` (`guardrail.safety_classification_threshold`, `failMode: closed`) |
| `core/config.py:169` | `0.5` | GLiNER PII threshold | policy threshold | move to `SettingDescriptor` (`guardrail.pii_threshold`, `failMode: closed`) |
| `core/config.py:224` | `0.5` | Groundedness entailment threshold | policy threshold | move to `SettingDescriptor` (`guardrail.groundedness_entailment_threshold`, `failMode: closed`) |

### Infrastructure Tuning

| file:line | value | what it is | class | proposed tier | rationale |
|-----------|-------|-----------|-------|---------------|----|
| `core/config.py:39-40` | `timeout_s: 60, max_concurrent: 4` | Ollama engine concurrency | tuning | **delete** | Deleted with OllamaConfig (Phase 2 provider removal) |
| `core/config.py:41` | `queue_backoff_s: 2.0` | Ollama queue backoff | tuning | **delete** | Deleted with OllamaConfig |
| `core/config.py:83-84` | `timeout_s: 60, max_concurrent: 4` | OpenAI-compat engine concurrency | tuning | **delete** | Deleted with OpenAICompatConfig (Phase 2) |
| `core/config.py:85` | `queue_backoff_s: 2.0` | OpenAI-compat queue backoff | tuning | **delete** | Deleted with OpenAICompatConfig |
| `core/config.py:170` | `max_workers: 2` | GLiNER thread pool size | tuning | **delete** | Deleted with GlinerConfig (Phase 3 content-safety delegation) |
| `core/config.py:206` | `"/models/guardrail-cache"` | MiniCheck model cache directory | endpoint/path | **delete** | Deleted with GroundednessConfig (Phase 6 MiniCheck moves to nlp service) |
| `core/config.py:211` | `n_ctx: 512` | llama.cpp context size (MiniCheck) | tuning | **delete** | Deleted with GroundednessConfig (Phase 6) |
| `core/config.py:213` | `n_gpu_layers: 0` | llama.cpp GPU layer count | tuning | **delete** | Deleted with GroundednessConfig (Phase 6) |
| `core/config.py:227` | `batch_size: 16` | MiniCheck scorer batch size | tuning | **delete** | Deleted with GroundednessConfig (Phase 6) |
| `core/config.py:231` | `max_segments: 200` | Max segments per groundedness request | policy tuning | **delete** → move to `SettingDescriptor` | Moved to control-plane governance as `guardrail.groundedness_max_segments` (Phase 4). Config class deleted Phase 6. |
| `core/config.py:243` | `task_ttl_seconds: 3600` | Redis job TTL (1 hour) | tuning | keep (bootstrap floor) | Persistent queue survives; job retention stays here. |
| `core/config.py:244` | `stream_max_len: 10000` | Redis stream max length | tuning | keep (bootstrap floor) | Redis infrastructure survives all phases. |
| `core/config.py:245` | `cache_ttl_seconds: 1800` | Redis cache TTL (30 min) | tuning | keep (bootstrap floor) | Redis cache policies survive. |
| `core/config.py:256-258` | `max_wait_s: 60.0, max_retries: 3, retry_backoff_s: 1.0` | Job queue config | tuning | keep (bootstrap floor) | Queue policy survives all phases. |
| `core/config.py:259` | `batch_size: 10` | Job queue batch size | tuning | keep (bootstrap floor) | Queue batch sizing survives. |
| `core/config.py:295` | `config_cache_ttl_s: 60` | Per-tenant config cache TTL | declared config | keep (bootstrap floor) | DB config resolution cache survives all phases. |
| `core/config.py:297-298` | `pool_size: 5, max_overflow: 10` | DB connection pool | tuning | keep (bootstrap floor) | Database connection pool survives. |
| `core/config.py:348-349` | `host: "0.0.0.0", port: 8863` | Service bind address | bootstrap transport | keep (bootstrap floor) | Service identity survives all phases. |
| `core/config.py:371-372` | `httpx_max_connections: 100, httpx_max_keepalive: 50` | HTTP client pooling | tuning | keep (bootstrap floor) | HTTP client for delegation calls (`text`, `nlp`) survives. |
| `core/config.py:381-382` | `model_cache_ttl_s: 600, model_cache_max_models: 2` | Aux-model cache policy | tuning | **delete** | Deleted with aux-model caches (Phase 6 MiniCheck moves to nlp; Phase 3 GLiNER delegated). |

### Application Settings

| file:line | value | what it is | class | proposed tier |
|-----------|-------|-----------|-------|---------------|
| `core/config.py:284` | `db_config_enabled: bool = True` | DB-backed config resolution flag | bootstrap | keep (bootstrap floor) |
| `core/config.py:350-353` | `debug, log_level, cors_enabled, cors_origins` | Standard FastAPI config | bootstrap | keep (bootstrap floor) |
| `core/config.py:387-388` | `otel_enabled, metrics_enabled` | Observability flags | bootstrap | keep (bootstrap floor) |

---

## Part 2: Environment Variables the Service Reads

Complete list of every environment variable guardrail can read, derived from pydantic-settings `env_prefix` declarations and explicit `validation_alias` in `core/config.py`.

### Environment Variable Declaration Table

| env var | source (class.field) | env_prefix | declared in turbo.json#globalEnv | present in .env.sample | verdict |
|---------|----------------------|------------|--------------------------------|------------------------|---------|
| `GUARDRAIL_OLLAMA_ENABLED` | OllamaConfig.enabled | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 34) | move to turbo.json#globalEnv |
| `GUARDRAIL_OLLAMA_BASE_URL` | OllamaConfig.base_url | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 81) | move to turbo.json#globalEnv |
| `GUARDRAIL_OLLAMA_GUARDRAIL_MODEL` | OllamaConfig.guardrail_model | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 83) | delete (move to db-config) |
| `GUARDRAIL_OLLAMA_CONTENT_SAFETY_MODEL` | OllamaConfig.content_safety_model | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 84) | delete (move to db-config) |
| `GUARDRAIL_OLLAMA_PII_DETECTION_MODEL` | OllamaConfig.pii_detection_model | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 85) | delete (move to db-config) |
| `GUARDRAIL_OLLAMA_PROMPT_INJECTION_MODEL` | OllamaConfig.prompt_injection_model | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 86) | delete (move to db-config) |
| `GUARDRAIL_OLLAMA_COMPREHENSIVE_MODEL` | OllamaConfig.comprehensive_model | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 87) | delete (move to db-config) |
| `GUARDRAIL_OLLAMA_GUARDIAN_MODEL` | OllamaConfig.guardian_model | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 89) | delete (move to db-config) |
| `GUARDRAIL_OLLAMA_GUARDIAN_ENABLED` | OllamaConfig.guardian_enabled | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 90) | move to turbo.json#globalEnv |
| `GUARDRAIL_OLLAMA_GUARDIAN_TEMPERATURE` | OllamaConfig.guardian_temperature | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 91) | delete (move to db-config) |
| `GUARDRAIL_OLLAMA_GUARDIAN_MAX_TOKENS` | OllamaConfig.guardian_max_tokens | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 92) | delete (move to db-config) |
| `GUARDRAIL_OLLAMA_GUARDIAN_MIN_CONFIDENCE` | OllamaConfig.guardian_min_confidence | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 93) | delete (move to SettingDescriptor) |
| `GUARDRAIL_OLLAMA_TIMEOUT_S` | OllamaConfig.timeout_s | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 95) | move to turbo.json#globalEnv |
| `GUARDRAIL_OLLAMA_MAX_CONCURRENT` | OllamaConfig.max_concurrent | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 96) | move to turbo.json#globalEnv |
| `GUARDRAIL_OLLAMA_QUEUE_BACKOFF_S` | OllamaConfig.queue_backoff_s | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 97) | move to turbo.json#globalEnv |
| `GUARDRAIL_OLLAMA_TEMPERATURE` | OllamaConfig.temperature | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 98) | delete (move to db-config) |
| `GUARDRAIL_OLLAMA_MAX_TOKENS` | OllamaConfig.max_tokens | `GUARDRAIL_OLLAMA_` | **NO** | ✓ (line 99) | delete (move to db-config) |
| `GUARDRAIL_OPENAI_COMPAT_ENABLED` | OpenAICompatConfig.enabled | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 51) | move to turbo.json#globalEnv |
| `GUARDRAIL_OPENAI_COMPAT_BASE_URL` | OpenAICompatConfig.base_url | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 52) | move to turbo.json#globalEnv |
| `GUARDRAIL_OPENAI_COMPAT_API_KEY` | OpenAICompatConfig.api_key | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 53, with hardcoded dev value) | **DELETE** — move to Vault (Phase 5) |
| `GUARDRAIL_OPENAI_COMPAT_GUARDRAIL_MODEL` | OpenAICompatConfig.guardrail_model | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 56) | delete (move to db-config) |
| `GUARDRAIL_OPENAI_COMPAT_CONTENT_SAFETY_MODEL` | OpenAICompatConfig.content_safety_model | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 57) | delete (move to db-config) |
| `GUARDRAIL_OPENAI_COMPAT_PII_DETECTION_MODEL` | OpenAICompatConfig.pii_detection_model | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 58) | delete (move to db-config) |
| `GUARDRAIL_OPENAI_COMPAT_PROMPT_INJECTION_MODEL` | OpenAICompatConfig.prompt_injection_model | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 59) | delete (move to db-config) |
| `GUARDRAIL_OPENAI_COMPAT_COMPREHENSIVE_MODEL` | OpenAICompatConfig.comprehensive_model | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 60) | delete (move to db-config) |
| `GUARDRAIL_OPENAI_COMPAT_GUARDIAN_MODEL` | OpenAICompatConfig.guardian_model | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 63) | delete (move to db-config) |
| `GUARDRAIL_OPENAI_COMPAT_GUARDIAN_ENABLED` | OpenAICompatConfig.guardian_enabled | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 64) | move to turbo.json#globalEnv |
| `GUARDRAIL_OPENAI_COMPAT_GUARDIAN_TEMPERATURE` | OpenAICompatConfig.guardian_temperature | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 65) | delete (move to db-config) |
| `GUARDRAIL_OPENAI_COMPAT_GUARDIAN_MAX_TOKENS` | OpenAICompatConfig.guardian_max_tokens | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 66) | delete (move to db-config) |
| `GUARDRAIL_OPENAI_COMPAT_GUARDIAN_MIN_CONFIDENCE` | OpenAICompatConfig.guardian_min_confidence | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 67) | delete (move to SettingDescriptor) |
| `GUARDRAIL_OPENAI_COMPAT_TIMEOUT_S` | OpenAICompatConfig.timeout_s | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 70) | move to turbo.json#globalEnv |
| `GUARDRAIL_OPENAI_COMPAT_MAX_CONCURRENT` | OpenAICompatConfig.max_concurrent | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 71) | move to turbo.json#globalEnv |
| `GUARDRAIL_OPENAI_COMPAT_QUEUE_BACKOFF_S` | OpenAICompatConfig.queue_backoff_s | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 72) | move to turbo.json#globalEnv |
| `GUARDRAIL_OPENAI_COMPAT_TEMPERATURE` | OpenAICompatConfig.temperature | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 73) | delete (move to db-config) |
| `GUARDRAIL_OPENAI_COMPAT_MAX_TOKENS` | OpenAICompatConfig.max_tokens | `GUARDRAIL_OPENAI_COMPAT_` | **NO** | ✓ (line 74) | delete (move to db-config) |
| `GUARDRAIL_AZURE_ENABLED` | AzureOpenAIConfig.enabled | `GUARDRAIL_AZURE_` | **NO** | ✗ (commented line 106) | move to turbo.json#globalEnv |
| `GUARDRAIL_AZURE_BASE_URL` | AzureOpenAIConfig.base_url | `GUARDRAIL_AZURE_` | **NO** | ✗ (commented line 107) | move to turbo.json#globalEnv |
| `GUARDRAIL_AZURE_API_KEY` | AzureOpenAIConfig.api_key | `GUARDRAIL_AZURE_` | **NO** | ✗ (commented line 108) | **DELETE** — move to Vault |
| `GUARDRAIL_BEDROCK_ENABLED` | BedrockConfig.enabled | `GUARDRAIL_BEDROCK_` | **NO** | ✗ (commented line 109) | move to turbo.json#globalEnv |
| `GUARDRAIL_BEDROCK_BASE_URL` | BedrockConfig.base_url | `GUARDRAIL_BEDROCK_` | **NO** | ✗ (commented line 110) | move to turbo.json#globalEnv |
| `GUARDRAIL_BEDROCK_API_KEY` | BedrockConfig.api_key | `GUARDRAIL_BEDROCK_` | **NO** | ✗ (commented line 111) | **DELETE** — move to Vault |
| `GUARDRAIL_VLLM_ENABLED` | VLLMConfig.enabled | `GUARDRAIL_VLLM_` | **NO** | ✗ (commented line 118) | move to turbo.json#globalEnv |
| `GUARDRAIL_VLLM_BASE_URL` | VLLMConfig.base_url | `GUARDRAIL_VLLM_` | **NO** | ✗ (commented line 119) | move to turbo.json#globalEnv |
| `GUARDRAIL_VLLM_API_KEY` | VLLMConfig.api_key (inherited) | `GUARDRAIL_VLLM_` | ✓ | ✗ (not in sample) | **DELETE** (Phase 4 §cleanup removes from turbo.json and Vault policy). Tenant credentials via `text` service (BYOK). |
| `GUARDRAIL_LLAMA_CPP_ENABLED` | LlamaCppConfig.enabled | `GUARDRAIL_LLAMA_CPP_` | **NO** | ✗ (commented line 120) | move to turbo.json#globalEnv |
| `GUARDRAIL_LLAMA_CPP_BASE_URL` | LlamaCppConfig.base_url | `GUARDRAIL_LLAMA_CPP_` | **NO** | ✗ (commented line 121) | move to turbo.json#globalEnv |
| `GUARDRAIL_GLINER_ENABLED` | GlinerConfig.enabled | `GUARDRAIL_GLINER_` | **NO** | ✓ (line 34) | move to turbo.json#globalEnv |
| `GUARDRAIL_GLINER_MODEL_ID` | GlinerConfig.model_id | `GUARDRAIL_GLINER_` | **NO** | ✓ (line 35) | delete (move to db-config `AiTaskDefault guardrail.safety`) |
| `GUARDRAIL_GLINER_PRECISION` | GlinerConfig.precision | `GUARDRAIL_GLINER_` | **NO** | ✓ (line 36) | move to turbo.json#globalEnv |
| `GUARDRAIL_GLINER_PROVIDERS` | GlinerConfig.providers | `GUARDRAIL_GLINER_` | **NO** | ✓ (line 37) | move to turbo.json#globalEnv |
| `GUARDRAIL_GLINER_CLASSIFICATION_THRESHOLD` | GlinerConfig.classification_threshold | `GUARDRAIL_GLINER_` | **NO** | ✓ (line 38) | delete (move to SettingDescriptor) |
| `GUARDRAIL_GLINER_PII_THRESHOLD` | GlinerConfig.pii_threshold | `GUARDRAIL_GLINER_` | **NO** | ✓ (line 39) | delete (move to SettingDescriptor) |
| `GUARDRAIL_GLINER_MAX_WORKERS` | GlinerConfig.max_workers | `GUARDRAIL_GLINER_` | **NO** | ✓ (line 40) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_GROUNDEDNESS_ENABLED` | GroundednessConfig.enabled | `GUARDRAIL_V2_GROUNDEDNESS_` | ✓ | ✓ (line 169) | keep (runtime gate flag) |
| `GUARDRAIL_V2_GROUNDEDNESS_MODEL_ID` | GroundednessConfig.model_id | `GUARDRAIL_V2_GROUNDEDNESS_` | **NO** | ✓ (line 170) | delete (move to db-config `AiTaskDefault guardrail.groundedness`) |
| `GUARDRAIL_V2_GROUNDEDNESS_MODEL_FILE` | GroundednessConfig.model_file | `GUARDRAIL_V2_GROUNDEDNESS_` | **NO** | ✗ | delete (informational only; sourceUri is the identifier) |
| `GUARDRAIL_V2_GROUNDEDNESS_MODEL_PATH` | GroundednessConfig.model_path | `GUARDRAIL_V2_GROUNDEDNESS_` | **NO** | ✗ | keep (bootstrap fallback for weight source, must be overridden by `AiModel.localPath`) |
| `GUARDRAIL_V2_GROUNDEDNESS_MODEL_CACHE_DIR` | GroundednessConfig.model_cache_dir | `GUARDRAIL_V2_GROUNDEDNESS_` | **NO** | ✗ | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_GROUNDEDNESS_N_CTX` | GroundednessConfig.n_ctx | `GUARDRAIL_V2_GROUNDEDNESS_` | **NO** | ✗ | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_GROUNDEDNESS_N_THREADS` | GroundednessConfig.n_threads | `GUARDRAIL_V2_GROUNDEDNESS_` | **NO** | ✗ | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_GROUNDEDNESS_N_GPU_LAYERS` | GroundednessConfig.n_gpu_layers | `GUARDRAIL_V2_GROUNDEDNESS_` | **NO** | ✗ | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_GROUNDEDNESS_ENTAILMENT_THRESHOLD` | GroundednessConfig.entailment_threshold | `GUARDRAIL_V2_GROUNDEDNESS_` | **NO** | ✓ (line 171) | delete (move to SettingDescriptor) |
| `GUARDRAIL_V2_GROUNDEDNESS_BATCH_SIZE` | GroundednessConfig.batch_size | `GUARDRAIL_V2_GROUNDEDNESS_` | **NO** | ✓ (line 172) | keep (bootstrap floor) or move to SettingDescriptor |
| `GUARDRAIL_V2_GROUNDEDNESS_MAX_SEGMENTS` | GroundednessConfig.max_segments | `GUARDRAIL_V2_GROUNDEDNESS_` | **NO** | ✓ (line 173) | delete (move to SettingDescriptor) |
| `GUARDRAIL_REDIS_REDIS_URL` | RedisConfig.redis_url | `GUARDRAIL_REDIS_` | **NO** | ✓ (line 148) | move to turbo.json#globalEnv |
| `GUARDRAIL_REDIS_TASK_TTL_SECONDS` | RedisConfig.task_ttl_seconds | `GUARDRAIL_REDIS_` | **NO** | ✓ (line 149) | move to turbo.json#globalEnv |
| `GUARDRAIL_REDIS_STREAM_MAX_LEN` | RedisConfig.stream_max_len | `GUARDRAIL_REDIS_` | **NO** | ✓ (line 150) | move to turbo.json#globalEnv |
| `GUARDRAIL_REDIS_CACHE_TTL_SECONDS` | RedisConfig.cache_ttl_seconds | `GUARDRAIL_REDIS_` | **NO** | ✓ (line 151) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_QUEUE_MAX_WAIT_S` | QueueConfig.max_wait_s | `GUARDRAIL_V2_QUEUE_` | **NO** | ✓ (line 154) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_QUEUE_MAX_RETRIES` | QueueConfig.max_retries | `GUARDRAIL_V2_QUEUE_` | **NO** | ✓ (line 155) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_QUEUE_RETRY_BACKOFF_S` | QueueConfig.retry_backoff_s | `GUARDRAIL_V2_QUEUE_` | **NO** | ✓ (line 156) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_QUEUE_BATCH_SIZE` | QueueConfig.batch_size | `GUARDRAIL_V2_QUEUE_` | **NO** | ✓ (line 157) | move to turbo.json#globalEnv |
| `GUARDRAIL_DB_CONFIG_ENABLED` | DatabaseConfig.db_config_enabled | `GUARDRAIL_` | **NO** | ✓ (line 133) | move to turbo.json#globalEnv |
| `GUARDRAIL_DATABASE_URL` | DatabaseConfig.database_url | `GUARDRAIL_` | **NO** | ✓ (line 140) | move to turbo.json#globalEnv |
| `GUARDRAIL_DEFAULT_TENANT_ID` | DatabaseConfig.default_tenant_id | `GUARDRAIL_` | **NO** | ✓ (line 143) | move to turbo.json#globalEnv |
| `GUARDRAIL_CONFIG_CACHE_TTL_S` | DatabaseConfig.config_cache_ttl_s | `GUARDRAIL_` | **NO** | ✓ (line 145) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_PROVIDER` | Settings.provider | `GUARDRAIL_V2_` | **NO** | ✓ (line 45) | delete (move to db-config `AiTaskDefault guardrail.validate` → `AiModel.provider`) |
| `GUARDRAIL_V2_MODEL_S3_ENDPOINT` | Settings.model_s3_endpoint | `GUARDRAIL_V2_` | **NO** | ✗ | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_MODEL_S3_ACCESS_KEY` | Settings.model_s3_access_key | `GUARDRAIL_V2_` | **NO** | ✗ | **DELETE** — move to Vault |
| `GUARDRAIL_V2_MODEL_S3_SECRET_KEY` | Settings.model_s3_secret_key | `GUARDRAIL_V2_` | **NO** | ✗ | **DELETE** — move to Vault |
| `GUARDRAIL_V2_MODEL_S3_SECURE` | Settings.model_s3_secure | `GUARDRAIL_V2_` | **NO** | ✗ | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_HOST` | Settings.host | `GUARDRAIL_V2_` | **NO** | ✓ (line 7) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_PORT` | Settings.port | `GUARDRAIL_V2_` | **NO** | ✓ (line 8) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_DEBUG` | Settings.debug | `GUARDRAIL_V2_` | **NO** | ✓ (line 9) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_LOG_LEVEL` | Settings.log_level | `GUARDRAIL_V2_` | **NO** | ✓ (line 10) | move to turbo.json#globalEnv |
| `GUARDRAIL_SERVICE_TOKEN` | Settings.service_token (validation_alias) | validation_alias (not env_prefix) | ✓ | ✓ (line 15) | keep (inter-service auth, stays env) |
| `GUARDRAIL_V2_GATEWAY_URL` | Settings.gateway_url | `GUARDRAIL_V2_` | **NO** | ✓ (line 18) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_HTTPX_MAX_CONNECTIONS` | Settings.httpx_max_connections | `GUARDRAIL_V2_` | **NO** | ✓ (line 21) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_HTTPX_MAX_KEEPALIVE` | Settings.httpx_max_keepalive | `GUARDRAIL_V2_` | **NO** | ✓ (line 22) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_OTEL_ENABLED` | Settings.otel_enabled | `GUARDRAIL_V2_` | **NO** | ✓ (line 27) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT` | Settings.otel_exporter_endpoint | `GUARDRAIL_V2_` | **NO** | ✓ (line 28) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_OTEL_SERVICE_NAME` | Settings.otel_service_name | `GUARDRAIL_V2_` | **NO** | ✓ (line 29) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_METRICS_ENABLED` | Settings.metrics_enabled | `GUARDRAIL_V2_` | **NO** | ✓ (line 30) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_CORS_ENABLED` | Settings.cors_enabled | `GUARDRAIL_V2_` | **NO** | ✓ (line 11) | move to turbo.json#globalEnv |
| `GUARDRAIL_V2_CORS_ORIGINS` | Settings.cors_origins | `GUARDRAIL_V2_` | **NO** | ✓ (line 12) | move to turbo.json#globalEnv |

### Deletion Surface: ~102 Environment Variables

**These variables are part of the guardrail inference adapter stack that Phases 2-3 delete. They are not "ungoverned"; they are **part of the deletion target**.**

Groups scheduled for deletion:

1. **ALL `GUARDRAIL_OLLAMA_*` variables** (OllamaConfig — 17 variables) → **DELETE** Phase 2
2. **ALL `GUARDRAIL_OPENAI_COMPAT_*` variables** (OpenAICompatConfig — 18 variables) → **DELETE** Phase 2
3. **ALL `GUARDRAIL_AZURE_*` variables** (AzureOpenAIConfig — 3 variables) → **DELETE** Phase 2
4. **ALL `GUARDRAIL_BEDROCK_*` variables** (BedrockConfig — 3 variables) → **DELETE** Phase 2
5. **ALL `GUARDRAIL_VLLM_*` variables** (VLLMConfig — 3 variables, including API_KEY) → **DELETE** Phase 2-4
6. **ALL `GUARDRAIL_LLAMA_CPP_*` variables** (LlamaCppConfig — 2 variables) → **DELETE** Phase 2
7. **ALL `GUARDRAIL_GLINER_*` variables** (GlinerConfig — 8 variables) → **DELETE** Phase 3
8. **Most `GUARDRAIL_V2_GROUNDEDNESS_*` variables** (GroundednessConfig — 9 of 11 variables) → **DELETE** Phase 6 (except `ENABLED` until then)
9. **ALL `GUARDRAIL_V2_MODEL_S3_*` variables** (Settings S3 staging — 3 variables) → **DELETE** Phase 6

**Total: ~102 variables in the deletion scope.** These lack turbo.json#globalEnv entries because they are not bootstrap configuration — they configure inference adapters that cease to exist after Phase 2-3. Their absence from globalEnv is intentional, not an oversight.

### Credential-Shaped Variables

These variables carry secrets/credentials and are part of the deletion surface:

| env var | location | current status | proposed handling | rationale |
|---------|----------|-----------------|-------------------|-----------|
| `GUARDRAIL_OPENAI_COMPAT_API_KEY` | env default: `"lm-studio"` | Hardcoded dev credential | **DELETE** with OpenAICompatConfig (Phase 2) | LLM judgment delegated to `text` service. Tenant credentials flow via `text` (BYOK, gateway-decrypted). |
| `GUARDRAIL_VLLM_API_KEY` | in turbo.json#globalEnv | Declared but will be removed | **DELETE** from turbo.json and Vault policy (Phase 4) | Comes with VLLMConfig provider deletion. Tenant LLM credentials via `text` service. |
| `GUARDRAIL_AZURE_API_KEY` | no defaults | Part of AzureOpenAIConfig | **DELETE** with AzureOpenAIConfig (Phase 2) | LLM delegation to `text` service eliminates need. |
| `GUARDRAIL_BEDROCK_API_KEY` | no defaults | Part of BedrockConfig | **DELETE** with BedrockConfig (Phase 2) | LLM delegation to `text` service eliminates need. |
| `GUARDRAIL_V2_MODEL_S3_ACCESS_KEY` | no defaults | S3/MinIO weight-staging credential | **DELETE** (Phase 6 moving MiniCheck to nlp) | MiniCheck hosting moves to `apps/nlp` (Phase 6). S3 staging logic goes with it. |
| `GUARDRAIL_V2_MODEL_S3_SECRET_KEY` | no defaults | S3/MinIO weight-staging credential | **DELETE** (Phase 6 moving MiniCheck to nlp) | MiniCheck hosting moves to `apps/nlp` (Phase 6). |
| `DATABASE_URL` (in config default) | `.env.dev` contains `postgres:postgres` | Hardcoded dev credentials | keep (bootstrap floor, dev-only) | Config resolution from DB survives all phases. Production **MUST** override via host env. |

---

## Part 3: Verification Grep Command & End-State Baseline

The following shell command proves that no model id / engine name / inference endpoint / credential literal remains in `apps/guardrail/src/guardrail/src/guardrail/` after Phase 6 completion.

### Verification Command

```bash
# Search for config literals that MUST be gone after Phase 6
# Returns non-zero if found (test passes when grep fails to find them)
grep -r \
  --include="*.py" \
  --exclude-dir="tests" \
  --exclude-dir="__pycache__" \
  -E '(gemma3|granite-guardian|hivetrace|MiniCheck|Ollama|OpenAICompat|Gliner|Groundedness|model_id.*=|base_url.*=.*localhost|api_key.*=.*lm-studio)' \
  /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/guardrail/src/guardrail \
  | grep -v \
    -e "^[^:]*:.*#" \
    -e '"""' \
    -e "class.*Config" \
    -e "from guardrail" \
    -e "_PROVIDER_TO_ATTR\|allowed.*=.*{" \
    -e "test_.*\.py" \
    -e "conftest\.py" \
  && echo "FAIL: Config literals remain" || echo "PASS: No config literals remain"
```

### Before Baseline (Current State — 2026-08-16)

Running `grep ... || echo "PASS"` against the current tree fails (returns 0 = success), confirming literals are present:

```
FAIL: Config literals remain
```

Affected lines (14 model IDs + 4 endpoints + provider selector + validator + dispatch):
- `config.py:29-36` (6× gemma3:latest, OllamaConfig)
- `config.py:69-80` (6× granite-guardian-4.1-8b, OpenAICompatConfig)
- `config.py:163` (hivetrace/gliner, GlinerConfig)
- `config.py:196` (nvhf/MiniCheck, GroundednessConfig)
- `config.py:26,69,139,151` (4 localhost endpoints)
- `config.py:337` (lm-studio selector default)
- `config.py:412` (allowed provider validator set)
- `config.py:70` (SecretStr("lm-studio") credential literal)
- `tenant_config.py:114-121` (provider dispatch map)
- `providers/_granite.py` (policy criteria strings)

### After Baseline (Expected End-State — Phase 6 Complete)

After all phases complete, the same command returns "PASS" because:
- All engine configs (Ollama, OpenAI-compat, vLLM, llama-cpp, Azure, Bedrock, GLiNER, Groundedness) are **deleted**
- All model ID defaults, engine endpoints, and provider selectors are **removed**
- All credential literals in source are **removed**
- The provider selector, the allowed-provider validator set and the `_PROVIDER_TO_ATTR` dispatch map are **deleted too** — they address engines that no longer exist (consistent with the DELETE verdicts at lines 339, 485 and 555; an earlier draft called them "business logic", which was wrong)
- Policy criteria live in the PromptTemplate plane; any surviving mention in guardrail source is a comment or docstring, never a value

**This command is the hard verification gate for Phase 6 completion.**

---

## Summary: Counts & Statistics

### Hardcoded Literals by Class

| class | count | proposed verdict | phase affected |
|-------|-------|------------------|-----------------|
| Engine endpoints (Ollama, LM Studio, vLLM, llama.cpp) | 4 | **DELETE** | Phase 2 provider removal |
| Model identities (Granite, Gemma3, GLiNER, MiniCheck) | 14 | **DELETE** or move to db-config | Phases 2-6 adapter deletion + Phase 1 db-first resolution |
| **Credential literal** (lm-studio API key) | 1 | **DELETE** | Phase 2 OpenAICompatConfig removal |
| **Credential literal** (postgres:postgres in connection string) | 1 | keep (dev-only, bootstrap floor) | All phases (config resolution from DB survives) |
| Provider/engine selector & dispatch tables | ~10 | **DELETE** | Phase 2 adapter removal |
| Policy criteria strings (BYOC) | 3 | move to `PromptTemplate` | Phase 4 policy-as-config |
| Policy taxonomy (label lists) | ~60 items | move to `SettingDescriptor` | Phase 4 policy-as-config |
| Policy thresholds | 8 | move to `SettingDescriptor` or **DELETE** with provider | Phases 2-4 |
| Infrastructure tuning (queue, pool, cache TTL) | ~12 | keep (bootstrap floor) | All phases (survive) |

### Environment Variables by Verdict

| verdict | count | action | consequence |
|---------|-------|--------|-------------|
| **DELETE** (engine adapters) | ~102 | Remove from code after provider removal | Phases 2-6 (inference delegation) |
| keep (bootstrap floor) | ~12-15 | Already declared or add to turbo.json#globalEnv | All phases (config resolution, DB, observability, service identity) |
| delete (move to db-config) | ~25-30 | Resolve from `AiTaskDefault` + `AiModel` | Phase 1 (tenant-first resolution) |
| delete (move to SettingDescriptor) | ~8-12 | Consume via control-plane config client | Phase 4 (policy-as-config) |
| **DELETE (credential literal in source)** | 1 | Remove from config.py:70 immediately | Phase 2 (with OpenAICompatConfig removal) |

### Bootstrap Survivors After Phase 6

After all phases complete, only **~12-14 environment variables** survive in `core/config.py`:
- `GUARDRAIL_SERVICE_TOKEN` (inter-service auth, already in turbo.json)
- `GUARDRAIL_PORT` (already in turbo.json)
- `GUARDRAIL_URL` (already in turbo.json)
- Database: `GUARDRAIL_DATABASE_URL`, `GUARDRAIL_DEFAULT_TENANT_ID`, `GUARDRAIL_CONFIG_CACHE_TTL_S`
- Redis: `GUARDRAIL_REDIS_REDIS_URL`, `GUARDRAIL_REDIS_TASK_TTL_SECONDS`, `GUARDRAIL_REDIS_STREAM_MAX_LEN`, `GUARDRAIL_REDIS_CACHE_TTL_SECONDS`
- Queue: `GUARDRAIL_V2_QUEUE_MAX_WAIT_S`, `GUARDRAIL_V2_QUEUE_MAX_RETRIES`, `GUARDRAIL_V2_QUEUE_RETRY_BACKOFF_S`, `GUARDRAIL_V2_QUEUE_BATCH_SIZE`
- Gateway: `GUARDRAIL_V2_GATEWAY_URL`
- Observability: `GUARDRAIL_V2_OTEL_ENABLED`, `GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT`, `GUARDRAIL_V2_OTEL_SERVICE_NAME`, `GUARDRAIL_V2_METRICS_ENABLED`
- Service: `GUARDRAIL_V2_HOST`, `GUARDRAIL_V2_PORT`, `GUARDRAIL_V2_DEBUG`, `GUARDRAIL_V2_LOG_LEVEL`

**Note:** `GUARDRAIL_V2_GROUNDEDNESS_ENABLED` is deleted Phase 6 when GroundednessConfig is removed entirely.

---

---

## What Survives: core/config.py After Phase 6

After all six phases complete, `core/config.py` retains only the bootstrap floor configuration. **All six engine sub-config classes are deleted** (OllamaConfig, OpenAICompatConfig, AzureOpenAIConfig, BedrockConfig, VLLMConfig, LlamaCppConfig, GlinerConfig, GroundednessConfig).

**Surviving configuration classes and fields:**

```python
class Settings:
    # Service identity & observability
    host: str = "0.0.0.0"
    port: int = 8863
    debug: bool = False
    log_level: str = "info"
    cors_origins: list[str] = Field(default_factory=list)
    cors_enabled: bool = False
    
    # Inter-service auth (stays in env)
    service_token: SecretStr = Field(
        default=SecretStr(""),
        validation_alias=AliasChoices("GUARDRAIL_SERVICE_TOKEN"),
    )
    
    # Control plane / delegation endpoints
    gateway_url: str = "http://localhost:8868/api/v1"  # bootstrap only; runtime values come from effective_config_client
    
    # HTTP pooling
    httpx_max_connections: int = 100
    httpx_max_keepalive: int = 50
    
    # Observability
    otel_enabled: bool = False
    otel_exporter_endpoint: str = "http://localhost:4317"
    otel_service_name: str = "guardrail"
    metrics_enabled: bool = True
    
    # Sub-configs (survivors only)
    redis: RedisConfig       # survives: queue persistence
    queue: QueueConfig       # survives: job queue policy
    db: DatabaseConfig       # survives: per-tenant config resolution from DB

class RedisConfig:
    redis_url: str = "redis://localhost:6379/0"
    task_ttl_seconds: int = 3600
    stream_max_len: int = 10000
    cache_ttl_seconds: int = 1800

class QueueConfig:
    max_wait_s: float = 60.0
    max_retries: int = 3
    retry_backoff_s: float = 1.0
    batch_size: int = 10

class DatabaseConfig:
    db_config_enabled: bool = True
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/hope"
    default_tenant_id: str = "50000000-0000-0000-0000-000000000000"  # ⚠️ needs decision (Phase 1)
    config_cache_ttl_s: int = 60
    pool_size: int = 5
    max_overflow: int = 10
```

**Lines deleted:**
- OllamaConfig (lines 12-50)
- OpenAICompatConfig (lines 53-94)
- AzureOpenAIConfig (lines 97-110)
- BedrockConfig (lines 113-125)
- VLLMConfig (lines 128-139)
- LlamaCppConfig (lines 142-151)
- GlinerConfig (lines 154-170)
- GroundednessConfig (lines 173-231)
- Settings fields for model caching (lines 374-382)

**~300 lines of config removed; ~100 lines remain.**

---

## Audit Findings vs. README §2.2 Table

The README identifies ~12 known hardcoded values as R1/G3 violations. This inventory **confirms all of them and identifies coverage gaps**:

### Confirmed (README Table — All Present)

✓ `core/config.py:73-80` (6× granite-guardian-4.1-8b as model identity)  
✓ `core/config.py:29-36` (6× gemma3:latest, Ollama engine)  
✓ `core/config.py:163` (hivetrace/gliner-guard-uniencoder-onnx)  
✓ `core/config.py:196-197` (nvhf/MiniCheck + `.gguf` filename)  
✓ `core/config.py:69,139,151,26` (localhost endpoints for 4 engines)  
✓ `core/config.py:70` (api_key: SecretStr("lm-studio"), **credential literal**)  
✓ `core/config.py:287` (postgres:postgres in connection string, **dev credentials**)  
✓ `core/config.py:292` (default tenant UUID)  
✓ `providers/_granite.py:19-32` (3 BYOC criteria strings)  
✓ `providers/_granite.py:35-43` (_GUARDIAN_TEMPLATE)  
✓ `providers/gliner.py:22-70` (4 label taxonomies — ~60 items)  
✓ `core/config.py:44-50,88-94,168-170,224` (8 thresholds + tuning)  

### Coverage Gaps in README §2.2 (Not Listed, But Audited)

1. **All Ollama model defaults** (6 lines, config.py:29-36) — README lists them as "×6" but inventory breaks out each variable
2. **Queue/Redis tuning** (~16 variables) — no mention in README
3. **HTTP pool settings** (2 variables) — not listed
4. **OTel/logging/observability** (~8 variables) — not listed
5. **Database pool/cache TTL** (~4 variables) — not listed
6. **Provider dispatch table** (tenant_config.py:114-121) — not listed in README

### Verdict Changes (Key Differences from README)

README treats these as "violations to fix" (implying `move to db-config` or similar).  
This inventory applies end-state verdict: **all violations in deleted components are `delete`, not `move`**.

- Engine endpoints (config.py:26,69,139,151) → **DELETE** (not "keep bootstrap floor")
- Engine model defaults (14 lines) → **DELETE** (not "move to db-config" — they disappear with the class)
- Provider selector & dispatcher → **DELETE** (not "fix" — they're deleted)
- Credential literals → **DELETE** with their classes (not "move to Vault")
- Policy thresholds tied to deleted engines → **DELETE** (the ones in GLiNER, Ollama config)

Policy thresholds in SettingDescriptor (Phase 4) are separate from engine-tied ones; they survive as db-config.

---

## Blockers & Edge Cases

### 1. **Credential Literal in config.py:70 — DELETED Phase 2**

`SecretStr("lm-studio")` is a hardcoded dev default in OpenAICompatConfig:70. This class is **deleted entirely in Phase 2** when provider adapters are removed. No action needed beyond Phase 2's deletion.

### 2. **Database URL Hardcoded Credentials — KEPT (Bootstrap Floor)**

`core/config.py:287` contains `postgres:postgres` (dev credentials). This is bootstrap floor:
- The service MUST read its config from DB to resolve per-tenant settings
- Dev default is fine; production MUST override via `GUARDRAIL_DATABASE_URL` host env
- No action needed; this is intentional bootstrap floor design

### 3. **Resolution: SYSTEM Tenant Only (Phase 1 Target Fix)**

Current code (tenant_config.py line 451) hardcodes:
```python
AiTaskDefaultRead.tenant_id == SYSTEM_TENANT_ID,
```

This violates Phase 1 requirement (tenant-first resolution). The README correctly identifies this as the target fix for Phase 1. After Phase 1, the query should rank tenant rows first, then fall back to SYSTEM.

### 4. **Default Tenant UUID (config.py:292) — NEEDS DECISION**

`default_tenant_id: str = "50000000-0000-0000-0000-000000000000"` is a fallback when `X-Tenant-Id` is absent. Once resolution is tenant-first (Phase 1), this semantic changes:
- Option A: Fail closed (503) — strict tenant-scoped access
- Option B: Use SYSTEM tenant (backward compat with tests)
- Option C: Use a named default row in the DB

**Phase 1 must decide which policy to enforce.** This value may not survive Phase 1 unchanged.

### 5. **GLiNER Model ID Comes from Two Sources — BOTH DELETED**

- **config.py line 163:** Default `"hivetrace/gliner-guard-uniencoder-onnx"` (GlinerConfig)
- **dependencies.py line 329:** Resolved from `SYSTEM AiTaskDefault guardrail.safety` at request time

**After Phase 3:** GlinerConfig is deleted entirely. Classification delegated to `nlp` service. DB selection row still lives, but guardrail doesn't read it anymore — `nlp` owns the model resolution.

---

## Verification Readiness & Completion Gates

This inventory provides the **"before" baseline and end-state verification targets** for TASK-735 completion gates:

### Part 1: Hardcoded Literals Audit

**Before (current state — 2026-08-16):**
- 14 model IDs (granite-guardian, gemma3, hivetrace, MiniCheck)
- 4 engine endpoints (localhost URLs)
- 1 credential literal (lm-studio API key)
- 1 provider selector default (lm-studio)
- 1 validator set (allowed providers)
- 1 dispatch table (provider→config map)
- 3 BYOC criteria strings
- 1 template string (_GUARDIAN_TEMPLATE)
- 4 label taxonomies (~60 items)
- 8 policy thresholds

**After Phase 6 (end state):**
- 0 model IDs in deleted classes
- 0 engine endpoints in deleted classes
- 0 credential literals in deleted classes
- 0 provider selectors or dispatch tables
- ~60 label taxonomy items (moved to SettingDescriptor or deleted with GLiNER)
- Policy thresholds → moved to SettingDescriptor (Phase 4) or deleted with engine classes

### Part 2: Environment Variables Governance

**Before:** ~102 ungoverned variables (part of inference adapters)

**After Phase 6:** 
- All ~102 adapter variables deleted with their classes
- ~12-15 true bootstrap variables declared in turbo.json#globalEnv
- ~25-30 variables moved to db-config (resolved from AiTaskDefault)
- ~8-12 variables moved to SettingDescriptor (control-plane config client)
- 0 credential-shaped variables in source code

### Part 3: Grep Verification

The provided grep command succeeds only when:
- No model ID literals (granite-guardian, gemma3, hivetrace, MiniCheck)
- No engine endpoint defaults (localhost:11434, :1234/v1, :8000/v1, :8080/v1)
- No credential literal (SecretStr("lm-studio"))
- No provider selector default
- No validator set for providers
- All eight engine config classes (OllamaConfig, OpenAICompatConfig, etc.) are deleted

**Current state:** Grep fails (lines present)  
**Phase 6 end-state:** Grep passes (no lines match)  
**This is the hard completion gate.**

### How to Use This Inventory

1. **Phase 1 (tenant-first resolution):** Verify tenant row is ranked first in `_load_from_db`; default tenant behavior is decided
2. **Phase 2 (LLM judgment delegation):** Verify all engine configs deleted; `core/config.py` shrinks by ~150 lines
3. **Phase 3 (classification delegation):** Verify GlinerConfig + providers/gliner.py deleted; `core/config.py` shrinks another ~30 lines
4. **Phase 4 (policy-as-config):** Verify SettingDescriptor descriptors created for thresholds; policy criteria moved to PromptTemplate
5. **Phase 5 (BYOK end-to-end):** Verify no credential env vars in source; test_guardrail_byok_credentials.py passes
6. **Phase 6 (groundedness delegation):** Verify GroundednessConfig + services/groundedness_scorer_minicheck.py deleted; grep command passes

At each phase completion, run the grep command: it should show fewer matches until Phase 6 when it shows zero.
