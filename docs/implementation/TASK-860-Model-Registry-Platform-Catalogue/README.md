# TASK-860 — Model Registry: platform-admin-only catalogue of the shared model bucket, organised by Hugging Face task

| | |
|---|---|
| **Status** | Review |
| **Type** | feature + refactor + seed rewrite |
| **Program** | [TASK-859 — AI Platform Consolidation](../TASK-859-Ai-Platform-Consolidation-Program/README.md) |
| **Packages** | `packages/database` (`stt.prisma` → `ai-model.prisma`, `enums.prisma`, seeds `ai-models/*`, `06-stt.ts`), `packages/domains` (`AiModel*`), `packages/applications` (`stt/model/**` → `ai-model/**`), `apps/api` (`ai-model`), `apps/admin-console` (`ai-models`, `ai-platform` catalogue/store tabs), `apps/{stt,nlp,tts,text}` loaders, `packages/vox-node` (generated) |
| **Depends on** | — (first ticket in the program) |
| **Blocks** | TASK-861, TASK-862, TASK-863 (availability + task taxonomy) |
| **Rules** | `02`, `03`, `04`, `05`, `06`, `09` §Cluster Deploys, `13` |
| **Created** | 2026-09-04 |

## 1. Requirement Analysis

Owner directive (2026-09-04):

> Review the Model Registry; it must manage the models available in the shared bucket by platform admin ONLY. Model Registry is where platform admin register and manage models by Task, categorized following the Huggingface catalog. Review, cleanup & update the seed data following the model catalog. Make sure we have proper library and logic code to call/load the model for serving/inferencing when there is request.

Restated:

| # | Requirement |
|---|---|
| R-1 | **One catalogue, SYSTEM-owned.** Only a platform (super) admin can create, edit, publish or retire a registry row. Tenants read the catalogue (to bind agents and classify nodes) and never hold their own copies. |
| R-2 | **Bucket-aware.** A row states where its weights live in `s3://hope-models` (mounted read-only at `/mnt/models-bucket` in every serving pod) and whether they are actually there. Availability is measured, not declared. Cloud rows have no weights and are "available" when a provider connection exists (TASK-862). |
| R-3 | **Hugging Face taxonomy.** Rows are organised by HF `pipeline_tag` (task) → `library_name` (serving library) → model, and carry the model-card metadata worth mirroring (`license`, `gated`, `base_model`, `language`, `revision`). |
| R-4 | **Seed = the owner's catalogue, exactly.** 35 rows (§3.6); everything else is retired. |
| R-5 | **Serving readiness.** For every row, the owning service has the declared dependency and a loader that reads from a local directory/file; gaps are closed or the row fails closed with a named error. |

## 2. Current State Evaluation

Verified 2026-09-04.

### 2.1 Schema and taxonomy (good bones)

`AiModel` (`packages/database/src/prisma/db_main/stt.prisma:128-228`) already carries `category: ModelCategory`, `taskType: ModelTaskType` (46 members mirroring HF tasks, plus HOPE's `GUARDRAIL`, `SPEAKER_DIARIZATION`, `SPEAKER_EMBEDDING`), `modelType`, `source: AiModelSource {HUGGINGFACE, GITHUB, MLFLOW, LOCAL, S3}`, `sourceUri` (scheme grammar `hf:` / `file://` / `s3://`), `sourceRevision`, `format: AiModelFormat` (16 members incl. cloud pseudo-formats `AZURE_SPEECH`, `AZURE_FOUNDRY`, `CLOUD_API`, `SARVAM`, `OPENAI`), `provider`, `architecture`, `memorySizeMb`, `computeType`, `downloadStatus` (manual bookkeeping), `localPath` (operator override, highest precedence in every Python resolver), `checksum`, `metaData` (voices, label taxonomies, calibration). The only FK is `AiRoutingPolicy.modelId`. Every enum except `AiCapability`/`AiTaskKind`/`AiDeploymentKind` is single-consumer, so the taxonomy can be reshaped without blast radius.

### 2.2 Ownership is right at the controller, wrong below it

| Fact | Evidence |
|---|---|
| `admin/ai-models/**` is class-gated `@Authorize(['manage','all'])` (super admin) | `apps/api/src/modules/ai-model/ai-model-admin.controller.ts:22-47` |
| `AiModelService.create/update` write to `this.tenantId` unconditionally — the service has no SYSTEM pin | `packages/applications/src/services/stt/model/aiModel.service.ts:33-72` |
| The seed **clones the SYSTEM catalogue into the Global and ArcaAI tenants** (`backfillCustomerTenantAiModels`), so three copies of every row exist | `seed/06-stt.ts:1873-1913` |
| `01-policy.ts:181` still grants `manage:AiModel` to tenant-full-access ("self-serve their own clone") — a dead grant that contradicts the controller | `seed/01-policy.ts:181` |
| `AiModelRepository.findByTaskTypeSharedRead` already implements `[tenant, SYSTEM]` widening — the read side is ready for a single SYSTEM catalogue | `packages/domains/src/repositories/generated/core/AiModelRepository.ts` |
| `/ai-platform` has **Catalogue** and **Model store** tabs that also register models (`catalogue-client.ts:71` → `POST admin/ai-models`) — two writers for one resource | `apps/admin-console/src/features/ai-platform/**` |
| Discovery-register hardcodes `category: NLP, taskType: TEXT_GENERATION` for every engine-discovered model | `apps/api/src/modules/ai-model/ai-model-discovery.service.ts:225-234` |
| `AiModelEntityMapper` lacks `FIELDS_NOT_WRITABLE = ['version']` (rule 03 deviation) | `packages/domains/src/mappers/generated/core/AiModelEntityMapper.ts:1-26` |
| `AI_MODEL_PROVIDERS` duplicated in seed and DTO (test-pinned parity) | `seed/ai-models/shared.ts:83-108`, `create-model.request.ts:15-33` |

### 2.3 Two publishers for one bucket

| Publisher | Where | Behaviour |
|---|---|---|
| In-product download job (`POST admin/ai-models/:id/download` → BullMQ `DownloadAiModel`) | `packages/applications/src/services/stt/model/download/**` | fetches HF/S3, writes `<slug>/<version>/{manifest.json, SHA256SUMS, weights}` with a content-addressed version, writes `localPath`/`downloadStatus` back |
| Out-of-band k8s Job `hope-models-publish.yaml` | `arca/hope-v2-deployment/deployment/k8s/out-of-band/` | same layout for GGUF, plus a verbatim HF cache under `hf/hub/`; operator-run; reads `HF_TOKEN` for the private `taphuynh/*` repos |

Both are correct in isolation; together they are two sources of truth for what is in the bucket, and neither writes **availability** back into the registry rows in a way the other can see.

### 2.4 Serving-readiness audit (Python)

The resolver contract is mirrored file-for-file in `stt`, `nlp`, `tts`, `harness` (`models/source_resolver.py`: `local_path` first → scheme dispatch → `ModelSourceError`); `guardrail` and `text` deliberately have none (`text` has a regression fence forbidding any inference runtime). `/mnt/models-bucket` never appears in Python — rows reach services as resolved `AiModelConfig`/strings, so the bucket is transparent once `localPath` is set. Per-model verdicts:

| Model (slug) | Library | Verdict | Gap / note |
|---|---|---|---|
| `faster-whisper-large-v3-turbo-int8`, the five `taphuynh/*` ASR rows (whisper.cpp f16/q8_0, transformers, CT2) | faster-whisper 1.2.1 / pywhispercpp ≥1.5 (CUDA-built) / transformers 5.5.4 | READY | `_select_gguf_file` picks the quant by filename; publish the q8_0 file too or the q8_0 row silently loads f16 (deployment doc §2a) |
| `nemotron-3.5-asr-streaming-0.6b` | parakeet.cpp | **MISSING runtime** | no binding, no `libparakeet` in `apps/stt/docker/Dockerfile`; loader raises. Options: `mudler/parakeet.cpp` (ggml, supports this exact model), NVIDIA `NeMo-Speech.cpp` (official), or `transformers ≥ 5.13` `AutoModelForRNNT` (native, no C++) |
| `silero-vad` | onnxruntime | READY | canonical distribution is PyPI `silero-vad`/GitHub; the HF id is the `onnx-community/silero-vad` mirror (already what the seed and deployment use) |
| `rnnoise` | pyrnnoise | READY | **no HF repo exists** (`nickolay/rnnoise` is invalid); coefficients are compiled into the library — nothing to publish |
| `deepfilternet3` | DeepFilterNet | **MISSING dependency** | deliberately excluded (`numpy<2` pin, `apps/stt/pyproject.toml:153-161`); code degrades to a **silent no-op** (`deepfilternet_denoiser.py:71-74`) |
| `ecapa-tdnn-voxceleb`, `wespeaker-voxceleb-resnet34` | speechbrain / pyannote | READY | SpeechBrain 1.0.2 offline-fetch bug (issue #2817): pin a version and pre-copy to `savedir` |
| `kokoro` | kokoro 0.9.4 | PARTIAL | provider calls `KPipeline(lang_code)` with no paths → depends on `HF_HOME=/mnt/models-bucket/hf` + `HF_HUB_OFFLINE=1`; `KModel(config=…, model=…)` + voice `.pt` paths bypass the Hub entirely (verified in `kokoro/model.py`) |
| `indic-parler-tts` | parler-tts (git) | **MISSING deployable** | package not in `uv.lock`, no image variant builds it; weights gated (click-through) |
| `medical-ner`, `symps-disease-bert-v3-c41` | transformers | READY | — |
| `cadence-punctuation` | cadence-punctuation ≥1.1 | READY, **miscategorised** | served by `apps/stt` as ASR post-processing (`stt/punctuation/**`), not by `apps/nlp`; HF task stays `token-classification`, `servedBy` = stt; gated (click-through) |
| `gliner2-privacy-filter-pii-multi`, `gliner2-guardrails-pii-multi`, `gliguard-llm-guardrails-300m` | gliner2 | READY | `gliner2` unpinned in `apps/nlp/pyproject.toml:38` — pin |
| `minicheck-flan-t5-large` | llama-cpp-python | READY, **verify scoring** | MiniCheck scores by a single decoder step reading two token logits after `"predict: "` — confirm `entailment_scorer.py` does this rather than free-text generation |
| `granite-guardian-4.1-8b`, `lms-gemma-4-e2b-it-qat`, `lms-gemma-4-e4b-it-qat`, `lms-gemma-4-medical-icd10`, `lms-gemma-4-e4b` | LM Studio (llama.cpp) | READY (this repo) | GGUF loading happens in the `hope-lmstudio` workload; IBM ships no first-party GGUF for granite-guardian — the artifact is `mradermacher/granite-guardian-4.1-8b-GGUF` (Q4_K_M published; seed says `q4_k_s`); Gemma 4 GGUFs carry a separate `-mmproj.gguf`; `Gemma-4-Medical-ICD10` is an unvalidated community fine-tune (5 downloads) |
| cloud rows | Azure Speech / Foundry / OpenAI / Sarvam / Azure OpenAI | READY | adapters live in `apps/stt`, `apps/tts`, `apps/text` with gateway-resolved credentials (TASK-862); OpenAI is retiring `gpt-4o-transcribe` in favour of `gpt-transcribe` / `gpt-4o-transcribe-diarize`; Foundry lineup is `MAI-Transcribe-1.5` and `-2` |

### 2.5 Seed vs catalogue

45 seeded rows vs 35 in the owner's catalogue. Not in the catalogue (retire): `whisper-small`, `whisper-large-v3-turbo`, `whisper-large-v3-turbo-gguf`, `lms-gemma-4-12b-qat`, `lms-medgemma-1.5-4b-it`, `lms-medgemma-1.5-4b-it-vision`, `vllm-medgemma-1.5-27b-it`, `llama-cpp-medgemma-1.5-4b-it`, `bedrock-claude-3.5-haiku`, `nlp-doc-type-classifier` (placeholder), `indic-f5` (NO-GO licence). The 53-slug `RETIRED_AI_MODEL_SLUGS` ledger (`ai-models/retired.ts`) soft-deletes across every tenant copy and is guarded by `AsrPipeline.configYaml` references — that guard goes with TASK-861.

## 3. Target Design

### 3.1 Ownership

- Registry rows live **only** in the SYSTEM tenant. `AiModelService` pins `tenantId = SYSTEM_TENANT_ID` on every write and refuses a non-super-admin caller (403 — a privilege boundary, not the 404-over-403 cross-tenant posture). Tenant reads go through `findByTaskTypeSharedRead` (already `[tenant, SYSTEM]`; effectively SYSTEM-only once clones are gone).
- The dead `manage:AiModel` tenant grant is removed from `01-policy.ts`; `AiModel` leaves `TENANT_SCOPED_MODELS` semantics for writes (stays in `SYSTEM_SHARED_READ_MODELS`).
- One writer screen: `/ai-models` (tier 10-19). The `/ai-platform` Catalogue/Model-store tabs are removed (TASK-862 retires that hub).

### 3.2 Schema changes (`ai-model.prisma`, moved out of `stt.prisma`)

| Change | Why |
|---|---|
| `pipelineTag ModelTaskType` (rename of `taskType`; enum members re-synced to the 47 HF `pipeline_tag` values, kebab-case in `@map`, plus HOPE extensions `SPEAKER_DIARIZATION`, `SPEAKER_EMBEDDING`, `GUARDRAIL` kept as sub-tags under `audio-classification` / `text-classification` via `taskSubtype String?`) | R-3; the Hub's first facet |
| `libraryName String` (`faster-whisper`, `whisper.cpp`, `transformers`, `ctranslate2`, `onnxruntime`, `pyrnnoise`, `deepfilternet`, `speechbrain`, `pyannote-audio`, `kokoro`, `parler-tts`, `gliner2`, `cadence-punctuation`, `llama.cpp`, `lm-studio`, `azure-speech`, `azure-foundry`, `azure-openai`, `openai`, `sarvam`) — validated vocabulary in `constants.ts`, replaces the overloaded `format`+`provider` pair for loader selection | R-3; the Hub's second facet; `AiModelFormat` stays as the artifact format only |
| `servedBy String` (`stt`, `stt-worker`, `nlp`, `tts`, `lmstudio`, `gateway-proxy`) | R-5; documents the owning workload per the owner's catalogue column |
| `license String?`, `gated Boolean`, `baseModel String?`, `languages String[]`, `hfRevision String?` (the Hub `sha`) | R-3 card metadata |
| `deploymentKind AiDeploymentKind` (`SELF_HOSTED` \| `CLOUD`) | replaces the `format = CLOUD_API`-style pseudo-formats; cloud rows carry `wireModelId` (`saaras:v4`, `gpt-transcribe`, `MAI-Transcribe-1.5`) |
| `bucketPrefix String?` (`<slug>/<version>/` or `hf/hub/models--org--repo/snapshots/<sha>`), `primaryObject String?`, `manifestDigest String?` | R-2 bucket identity; `localPath` becomes **derived** (`/mnt/models-bucket/` + `bucketPrefix` [+ `primaryObject` for single-file loaders]) and is no longer an operator free-text field |
| `availability AiModelAvailability` (`UNKNOWN`, `AVAILABLE`, `MISSING`, `PARTIAL`, `NOT_APPLICABLE`), `availabilityCheckedAt`, `availabilityDetail Json?` | R-2 measured availability, written by the inventory job (§3.4) |
| `isPlatformDefaultFor AiTaskKind[]` | super-admin "platform default per task" without a separate screen; seeds the SYSTEM `AiRoutingPolicy` election (TASK-862) |
| `downloadStatus`, `downloadedAt`, `fileSizeMb` → **deprecated** (replaced by `availability`) | — |
| Mapper gains `FIELDS_NOT_WRITABLE = ['version']` | rule 03 |

### 3.3 Bucket layout (one contract, documented in this repo)

```
s3://hope-models/
  <slug>/<version>/manifest.json, SHA256SUMS, <weights…>, tokenizer*      # GGUF/CT2/ONNX/pth — flat
  hf/hub/models--<org>--<repo>/{blobs,refs,snapshots/<sha>/…}              # transformers-family (verbatim HF cache)
```

Rules (kept from the deployment repo's `model-bucket-and-serving.md`, restated as the registry's contract): the slug carries the format; every GGUF prefix carries its tokenizer flat; the version is content-derived and never overwritten; the HF cache is populated with `HF_HUB_DISABLE_SYMLINKS=1` (s3fs and symlinks do not mix); single-file loaders (`llama.cpp` MiniCheck, whisper.cpp) point `primaryObject` at the file. `infrastructure/docker/minio/README.md` §5.2's circular version definition is corrected to `sha256(SHA256SUMS)`.

### 3.4 One publisher, one inventory

- **Publisher**: the in-product download job (`DownloadAiModel`) is the **only** writer of new prefixes; it gains the HF-cache layout for `transformers`-family rows, `HF_TOKEN` from the SYSTEM `model-registry:huggingface` connection (gated/private repos), the mmproj sidecar for Gemma 4, and writes `bucketPrefix`/`manifestDigest`/`availability` back. The deployment repo's `hope-models-publish.yaml` is reduced to a **bootstrap** that calls the same publisher code path (a CLI entry in `packages/tools`) — one implementation, two invocations. Recorded as a cross-repo change for the deployment repo.
- **Inventory job** (`ModelInventoryCron`, hourly + on demand `POST admin/ai-models/inventory`): lists the bucket, verifies each row's `bucketPrefix` + `manifestDigest`, sets `availability`, and lists **unregistered prefixes** (surfaced in the registry screen as "In bucket, not registered → Register"). Cloud rows resolve `NOT_APPLICABLE`; LM Studio rows additionally probe `hope-lmstudio` (`/api/v0/models`) for "loaded" status (the existing discovery service, made read-only).
- `AiRoutingPolicy`/Agent publish reads `availability` and **fails closed** on `MISSING`.

### 3.5 Loader work (per service)

| Service | Change |
|---|---|
| `apps/stt` | `deepfilternet`: install a numpy-2-compatible build (or vendor the `df` runtime) and **remove the silent no-op** — selection of an unavailable denoiser raises `ModelLoadError`; `parakeet.cpp`: adopt **`transformers ≥ 5.13` `AutoModelForRNNT`** as the day-1 path for `nemotron-3.5-asr-streaming-0.6b` (no C++ build, GPU via torch), keep `ParakeetCppLoader` as an optional GGUF path behind `NeMo-Speech.cpp`/`mudler/parakeet.cpp` (owner decision OD-3); publish the q8_0 whisper file; pin SpeechBrain; keep the ASR engine registry, add `libraryName` → engine mapping |
| `apps/nlp` | pin `gliner2`; keep `guard_model_reference.py` fail-closed posture; confirm MiniCheck single-step logit scoring (test against the `minicheck` reference package on three fixtures) |
| `apps/tts` | Kokoro: `KModel(config, model)` + voice paths from `bucketPrefix` (no `HF_HOME` dependence); Indic Parler: add `parler-tts` (pinned git ref) to the `[indic-parler]` extra **and** a TTS image variant that installs it; gated-weights acceptance recorded |
| `apps/text` | none (routes to LM Studio / cloud; the no-serving invariant stays) |
| all | `tests/contracts/source-resolver-parity.contract.test.ts` extended to the new row fields (`bucketPrefix`, `primaryObject`); `HF_HUB_OFFLINE` guard reads the cache before raising (the message already promises it) |

### 3.6 The seed (35 rows, SYSTEM tenant only)

| pipeline_tag | slug | identity (`sourceUri`) | libraryName | servedBy | notes |
|---|---|---|---|---|---|
| automatic-speech-recognition | `faster-whisper-large-v3-turbo-int8` | `hf:deepdml/faster-whisper-large-v3-turbo-ct2` | faster-whisper | stt / stt-worker | int8_float16 |
| automatic-speech-recognition | `nemotron-3.5-asr-streaming-0.6b` | `hf:nvidia/nemotron-3.5-asr-streaming-0.6b` | transformers (RNNT) — GGUF variant `parakeet.cpp` optional | stt / stt-worker | licence OpenMDW-1.1; no Malayalam |
| automatic-speech-recognition | `arcaai-whisper-large-ml-en-gguf` | `hf:taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF` (private) | whisper.cpp | stt / stt-worker | f16; `isPlatformDefaultFor: [SPEECH_TO_TEXT]` |
| automatic-speech-recognition | `arcaai-whisper-large-ml-en-gguf-q8_0` | same repo | whisper.cpp | stt / stt-worker | q8_0, `primaryObject` = the q8_0 file |
| automatic-speech-recognition | `arcaai-whisper-large-ml-en` | `hf:taphuynh/…-fp16` (private) | transformers | stt / stt-worker | |
| automatic-speech-recognition | `arcaai-whisper-large-ml-en-ct2` | `hf:taphuynh/…-ct2` (private) | faster-whisper | stt / stt-worker | |
| automatic-speech-recognition | `whisper-large-en-medical-260726-merged-gguf` | `hf:taphuynh/whisper-large-en-medical-2607.26-merged-gguf` (private) | whisper.cpp | stt / stt-worker | f16 |
| automatic-speech-recognition | `whisper-large-en-medical-260726-merged-gguf-q8_0` | same repo | whisper.cpp | stt / stt-worker | q8_0 |
| automatic-speech-recognition | `whisper-large-en-medical-260726-merged-ct2` | `hf:taphuynh/whisper-large-en-medical-2607.26-merged-ct2` (private) | faster-whisper | stt / stt-worker | |
| automatic-speech-recognition | `azure-speech-stt` | `azure-speech://speech-to-text` | azure-speech | gateway-governed, executed by stt | `ml-IN` supported |
| automatic-speech-recognition | `mai-transcribe-1.5` | `azure-foundry://MAI-Transcribe-1.5` | azure-foundry | gateway-governed, executed by stt | batch; `-1` deprecated 2026-08-20 |
| automatic-speech-recognition | `sarvam-saaras-v4` | `sarvam://saaras:v4` | sarvam | gateway-governed, executed by stt | WS streaming; `ml-IN` |
| automatic-speech-recognition | `openai-gpt4o-transcribe` | `openai://gpt-4o-transcribe` | openai | gateway-governed, executed by stt | wire id to be confirmed: OpenAI lists `gpt-transcribe` (default) and `gpt-4o-transcribe-diarize` as successors |
| voice-activity-detection | `silero-vad` | `hf:onnx-community/silero-vad` (mirror of `snakers4/silero-vad`) | onnxruntime | stt / stt-worker | `baseModel: snakers4/silero-vad` |
| audio-to-audio | `rnnoise` | `pypi:pyrnnoise` | pyrnnoise | stt / stt-worker | no weights; `availability: NOT_APPLICABLE` |
| audio-to-audio | `deepfilternet3` | `github:Rikorose/DeepFilterNet#DeepFilterNet3` | deepfilternet | stt / stt-worker | package-resolved checkpoint |
| audio-classification (speaker-embedding) | `ecapa-tdnn-voxceleb` | `hf:speechbrain/spkrec-ecapa-voxceleb` | speechbrain | stt / stt-worker | |
| audio-classification (speaker-embedding) | `wespeaker-voxceleb-resnet34` | `hf:pyannote/wespeaker-voxceleb-resnet34-LM` | pyannote-audio | stt / stt-worker | default embedding |
| text-to-speech | `kokoro` | `hf:hexgrad/Kokoro-82M` | kokoro | tts / tts-worker | 54 voices; `isPlatformDefaultFor: [TEXT_TO_SPEECH]` |
| text-to-speech | `indic-parler-tts` | `hf:ai4bharat/indic-parler-tts` | parler-tts | tts / tts-worker | gated; Malayalam |
| text-to-speech | `azure-neural-voices` | `azure-speech://neural-voices` | azure-speech | gateway-governed, executed by tts | |
| text-to-speech | `sarvam-bulbul` | `sarvam://bulbul:v3` | sarvam | gateway-governed, executed by tts | |
| token-classification | `medical-ner` | `hf:blaze999/Medical-NER` | transformers | nlp | `isPlatformDefaultFor: [NAMED_ENTITY_RECOGNITION]` |
| token-classification | `cadence-punctuation` | `hf:ai4bharat/Cadence` | cadence-punctuation | **stt** (ASR post-processing) | gated |
| token-classification | `gliner2-privacy-filter-pii-multi` | `hf:fastino/gliner2-privacy-filter-PII-multi` | gliner2 | nlp | `isPlatformDefaultFor: [PII_DETECTION]` |
| token-classification | `gliner2-guardrails-pii-multi` | `hf:fastino/GLiNER2-Guardrails-PII-Multi` | gliner2 | nlp | |
| text-classification | `symps-disease-bert-v3-c41` | `hf:shanover/symps_disease_bert_v3_c41` | transformers | nlp | low-traffic, not clinically validated — note on the row |
| text-classification | `gliguard-llm-guardrails-300m` | `hf:fastino/gliguard-LLMGuardrails-300M` | gliner2 | nlp | `isPlatformDefaultFor: [CONTENT_SAFETY]` |
| text-classification | `minicheck-flan-t5-large` | `hf:nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF` | llama.cpp | nlp | `isPlatformDefaultFor: [GROUNDEDNESS]` |
| text-generation | `granite-guardian-4.1-8b` | `hf:mradermacher/granite-guardian-4.1-8b-GGUF` (`baseModel: ibm-granite/granite-guardian-4.1-8b`) | llama.cpp (LM Studio) | lmstudio | Q4_K_M (seed said q4_k_s) |
| text-generation | `lms-gemma-4-e2b-it-qat` | `hf:google/gemma-4-E2B-it-qat-q4_0-gguf` | llama.cpp (LM Studio) | lmstudio | + mmproj; `isPlatformDefaultFor: [TEXT_GENERATION]` |
| text-generation | `lms-gemma-4-e4b-it-qat` | `hf:google/gemma-4-E4B-it-qat-q4_0-gguf` | llama.cpp (LM Studio) | lmstudio | + mmproj |
| text-generation | `lms-gemma-4-medical-icd10` | `hf:nikhil061307/Gemma-4-Medical-ICD10` | llama.cpp (LM Studio) — needs a GGUF conversion step | lmstudio | unvalidated community fine-tune; row `DISABLED` until evaluated (owner) |
| text-generation | `lms-gemma-4-e4b` | `hf:google/gemma-4-E4B` | llama.cpp (LM Studio) — needs a GGUF conversion step | lmstudio | bf16 safetensors upstream |
| text-generation | `azure-gpt-5.4-mini` | `azure-openai://gpt-5.4-mini` | azure-openai | gateway-governed, executed by text | deployment name on the connection |

Retired (soft-deleted via the ledger, no tenant clones remain): the 10 rows in §2.5 plus every slug already in `RETIRED_AI_MODEL_SLUGS`. `metaData` payloads worth keeping (`medical-ner.clinicalTaxonomy`, GLiNER `labelTaxonomy`, MiniCheck `entailment` calibration, Kokoro/Azure/Sarvam voice lists, Granite `policy.medicalValidationCriteria`) are carried over verbatim.

### 3.7 Console (`/ai-models`, tier 10-19)

Grid grouped by `pipelineTag` (HF order) with facets `libraryName`, `servedBy`, `deploymentKind`, `availability`; columns Model · Task · Library · Served by · Availability (badge + checked-at) · Platform default for · Licence/gated · Updated. Header actions: **Register** (drawer: identity → HF card metadata auto-filled from the Hub API when reachable → task/library/servedBy → publish to bucket), **Run inventory**, **In bucket, not registered** panel. Row actions: edit, set platform default per task, retire. LM Studio/vLLM live discovery stays read-only inside the drawer ("loaded on engine"). The download panel becomes "Publish to bucket" with job progress.

### 3.8 Deprecations (mark now, remove in release +2)

`AiModel.downloadStatus/downloadedAt/fileSizeMb`, free-text `localPath` (derived instead), `format` pseudo-values `CLOUD_API/AZURE_SPEECH/AZURE_FOUNDRY/SARVAM/OPENAI` (→ `deploymentKind` + `libraryName`), `AiModelSource.MLFLOW/GITHUB` (unused), tenant clones + `backfillCustomerTenantAiModels`, `POST admin/ai-models/discovery/register` (registration is from the catalogue/inventory, discovery is read-only), the `/ai-platform` catalogue/store tabs, seed file `06-stt.ts` (split: models → `ai-models/*` under a new `06-ai-models.ts`; pipelines deleted by TASK-861).

## 4. Implementation Plan

| # | Step | RED test | Files |
|---|---|---|---|
| 1 | Enum/schema migration (`ai-model.prisma`; new columns + `AiModelAvailability`; `@map` HF kebab tags; deprecated columns kept nullable); shadow-DB proof | migration diff empty; `pnpm --filter @arcaai/database test` | `packages/database/src/prisma/db_main/{ai-model,enums}.prisma`, `migrations/<ts>_task_860_…` |
| 2 | `gen:model`; entity/factory/mapper (`FIELDS_NOT_WRITABLE`)/repository updated by hand; `gen:entity`/`gen:factory` coverage green | domain tests | `packages/domains/src/**/AiModel*` |
| 3 | `AiModelService` → `services/ai-model/**`: SYSTEM pin + super-admin assert; DTOs (`libraryName`, `servedBy`, `pipelineTag`, metadata, `wireModelId`); `AI_MODEL_LIBRARIES` vocabulary in one place; provider list de-duplicated (DTO imports the seed constant) | service tests: tenant caller 403, row lands in SYSTEM, `localPath` derived | `packages/applications/src/services/ai-model/**` |
| 4 | Inventory job + `availability` write-back + unregistered-prefix listing; download job writes `bucketPrefix`/`manifestDigest`; HF-cache layout + `HF_HUB_DISABLE_SYMLINKS`; mmproj sidecar; `HF_TOKEN` from the SYSTEM connection | processor tests with a MinIO stub | `services/ai-model/{inventory,publish}/**` |
| 5 | API: `POST admin/ai-models/inventory`, `PATCH …/platform-default`, discovery read-only; tags/summaries; artifacts regenerated (`api:route-manifest`, `openapi`, `portal`, `gen:admin`) | controller tests; e2e `task-860-registry-super-admin-only.spec.ts` (tenant admin 403, API key 403, service account with scope OK) | `apps/api/src/modules/ai-model/**` |
| 6 | Seeds: `06-ai-models.ts` with the 35 rows; clones removed; `retired.ts` ledger extended; `01-policy.ts` grant removed; seed tests (`ai-model-consolidation-seed.test.ts` rewritten to the catalogue: every row has `libraryName`/`servedBy`; platform defaults resolve; no non-SYSTEM rows) | seed tests | `packages/database/src/prisma/db_main/seed/**` |
| 7 | Python loaders (§3.5): DeepFilterNet fail-closed + dependency, Nemotron via `AutoModelForRNNT` (transformers bump in `apps/stt` — verify the pin against pywhispercpp/torch), Kokoro explicit paths, Parler extra + image variant, gliner2 pin, MiniCheck scoring test, SpeechBrain pin, resolver parity extended | `pnpm stt:test`, `nlp:test`, `tts:test` + the new tests | `apps/{stt,nlp,tts}/**`, root `uv.lock` |
| 8 | Console `/ai-models` v2 (§3.7); `/ai-platform` catalogue/store tabs removed | screen tests, axe 0, both themes | `apps/admin-console/src/features/ai-models/**` |
| 9 | Docs: `docs/architecture/model-and-config-plane.md` §6 rewritten; `infrastructure/docker/minio/README.md` §5 corrected; cross-repo note for `hope-v2-deployment` (`model-bucket-and-serving.md` publisher paragraph, `hope-models-publish.yaml` → bootstrap wrapper); deprecation register rows | — | docs |

### Verification criteria

- Layer gates green (database, domains, applications, api unit + e2e, the three Python suites, console).
- Local proof: `pnpm db:all` seeds exactly 35 ENABLED SYSTEM rows and zero rows in any other tenant; the inventory job against local MinIO marks the published rows `AVAILABLE` and the private/unpublished ones `MISSING`.
- A tenant-admin JWT gets `403` on every `admin/ai-models` write; a super-admin registers a row and the publish job lands `<slug>/<version>/manifest.json` in MinIO.
- `pnpm stt:test` proves DeepFilterNet3 selection without the dependency raises, and Nemotron loads from a local snapshot directory.

## 5. Decisions taken (owner may override)

| # | Decision | Alternative rejected |
|---|---|---|
| D-1 | The in-product download job is the single publisher; the k8s Job becomes a bootstrap wrapper. | Two publishers — divergent layouts and no availability write-back. |
| D-2 | `localPath` is derived from `bucketPrefix`; no free-text operator path. | Keep free text — the deployment doc shows it is exactly how rows drift. |
| D-3 | Nemotron via transformers `AutoModelForRNNT` first; parakeet.cpp optional. | C++ runtime first — a new build chain for one model. |
| D-4 | Cadence stays `token-classification` (HF truth) with `servedBy: stt`. | Move punctuation into `apps/nlp` — a network hop inside the realtime transcript path. |
| D-5 | `Gemma-4-Medical-ICD10` seeded `DISABLED` pending evaluation. | Enabled — an unevaluated community fine-tune in a clinical product. |
| D-6 | Cloud rows are "governed by the gateway, executed by the owning service" (current architecture); the owner's "api gateway service as proxy" is interpreted as credential governance, not as moving vendor HTTP calls into NestJS. | Move Azure/Sarvam/OpenAI calls into the gateway — duplicates the streaming/session machinery in `apps/stt` and the multi-provider adapter set in `apps/text` (see TASK-862 OD-1). |

## 6. Open questions for the owner

1. **OD-1 — vLLM**: the catalogue has no vLLM rows; `hope-vllm` ships at `replicas: 0`. Retire the vLLM provider/screen, or keep it dormant?
2. **OD-2 — OpenAI STT wire id**: keep `gpt-4o-transcribe` (retiring per OpenAI's lifecycle page) or move to `gpt-transcribe` / `gpt-4o-transcribe-diarize` now?
3. **OD-3 — Nemotron runtime**: transformers RNNT (recommended) vs `NeMo-Speech.cpp` vs `mudler/parakeet.cpp`.
4. **OD-4 — Embeddings/reranker**: the catalogue omits `text-embedding-embeddinggemma-300m-qat` and the TEI reranker used by the harness RAG. Register them (as `feature-extraction` / `text-ranking` rows) or keep them as infrastructure connections?
5. Licence acceptance for the three gated repos (`ai4bharat/Cadence`, `ai4bharat/indic-parler-tts`, and the private `taphuynh/*`) — the publisher needs the SYSTEM `model-registry:huggingface` token filled.

## 7. Implementation Summary

Implemented on branch `task-860-model-registry` (worktree, based on `dev-2.2` @ `1896ebc03`), one commit per green step. Package-scoped gates only; artifacts (`route-manifest`, `openapi`, `portal`, `vox-node gen:admin`), `uv lock`, the shadow-DB migration proof and the runtime browser pass are the orchestrator's after merge.

| Step | Delivered | Evidence |
|---|---|---|
| 1–2 Schema, migration, domain | `ai-model.prisma` (moved out of `stt.prisma`) with `libraryName` / `servedBy` / `deploymentKind` / `wireModelId`, card metadata, bucket identity, `availability` (+ `AiModelAvailability` enum), `isPlatformDefaultFor`; deprecation doc comments on the download bookkeeping, the cloud `AiModelFormat` pseudo-values and `MLFLOW`/`GITHUB`. Migration `20260904090000_task_860_model_registry` = Prisma diff + hand-written backfill of the three NOT NULL columns, wire ids, NOT_APPLICABLE for cloud rows, and the soft-delete of every non-SYSTEM row. Entity gains `isCloud`, `markAvailability`, `recordPublish`, `setPlatformDefaultFor`; mapper strips `_version`; repository gains `findPlatformDefaultsFor`. | `gen:model:check` / `gen:entity:check` / `gen:factory:check`: no drift, schema coverage OK · domains 1893 tests · database 1840 tests |
| 3 Service | `services/stt/model/**` → `services/ai-model/**` (`download/` → `publish/`). Every write asserts a platform admin (403) and lands in SYSTEM through the unscoped base-client lane; reads are the SYSTEM catalogue; `localPath` derived; `setPlatformDefaultFor` clears the previous holder. `constants.ts` holds the three vocabularies + `MODEL_TASK_TYPE_TO_PIPELINE_TAG`; DTOs reject `localPath`; response carries `pipelineTag`. | applications 11028 tests · `tests/contracts/ai-model-providers.contract.test.ts` pins seed ↔ DTO parity of providers, libraries and served-by |
| 4 Publisher + inventory | Processor writes `bucketPrefix` / `primaryObject` / `manifestDigest` / `hfRevision` + derived `localPath` + AVAILABLE back; transformers-family rows publish as a verbatim HF cache (`hf/hub/models--org--repo/{refs/main,snapshots/<sha>/}`) with a flat fallback; `sourceUri` keeps the Hub identity. `HuggingFaceModelSourceClient.getRepoInfo`. `ModelInventoryService` (one bucket listing; NOT_APPLICABLE / MISSING / PARTIAL / AVAILABLE with detail; digest adoption; unregistered-prefix listing) + settings-gated hourly cron (fail-safe OFF). | applications ai-model suites 128 tests |
| 5 API | `POST admin/ai-models/inventory`, `PATCH admin/ai-models/:id/platform-default`; `POST discovery/register` → 410 Gone (deprecated, removed R3); download routes documented as the single publisher. | `pnpm api:build` · api 4174 tests · api module lint clean |
| 6 Seeds | `06-ai-models.ts` owns the 35-row catalogue (metaData carried verbatim, 11 retirements in the ledger, non-SYSTEM sweep, no clones); `06-stt.ts` keeps pipelines/settings; dead tenant `manage:AiModel` grant removed; `ai-model-registry-seed.test.ts`. | database 80 files / 1840 tests |
| 7 Python loaders | stt: DeepFilterNet3 `initialize()` fails closed (`ModelLoadError`) and the session propagates it; Nemotron via transformers `AutoModelForRNNT` behind `RNNT_MIN_TRANSFORMERS = "5.13"` (fails closed naming the floor + the parakeet.cpp alternative); whisper.cpp uses a FILE `localPath` directly (the published primary object); SpeechBrain local source = its own `savedir`. nlp: `gliner2>=1.3.2,<2`; MiniCheck single-step logit scoring pinned on three fixtures (+ a skip-by-default reference cross-check). tts: Kokoro `KModel(config, model)` + voice `.pt` paths from `TTS_KOKORO_MODEL_PATH` (fails at boot if the prefix lacks the files); `[indic-parler]` extra gains `parler-tts @ git+…@v0.2.2`; Dockerfile `TTS_EXTRAS` build-arg (kokoro always installed, Parler additive variant). Resolver-parity contract extended (`local_path` honoured first, `exists()` not `is_dir()`). | stt unit 3060 passed (1 env failure: `.env.dev` supplies a real MinIO key) · nlp 583 passed (2 env failures: `/metrics` gate) · tts: see §8 |
| 8 Console | `/ai-models` v2: HF-organised grid (task · library · served by · deployment · measured availability · platform default · licence), facets, Register / Run inventory / "In bucket, not registered" (register from prefix) / Loaded on engines (read-only), row actions edit · platform default · retire; form carries the registry fields and shows the derived local path read-only; publish panel relabelled. | feature suites 78 tests · feature lint clean · build: see §8 |
| 9 Docs | `docs/architecture/model-and-config-plane.md` §6 rewritten; `infrastructure/docker/minio/README.md` §5 (HF-cache layout; `<version>` = `sha256(SHA256SUMS)`); register rows marked. | — |

Not delivered (reported to the orchestrator): the LM Studio "loaded on engine" probe inside the inventory (discovery stays the read-only source of that fact); the `hope-models-publish.yaml` bootstrap wrapper (cross-repo); the `modelRegistry.inventory.*` settings descriptors (outside file scope, so the cron is opt-in until they exist); the HF-card auto-fill in the register drawer; the e2e spec `task-860-registry-super-admin-only.spec.ts` (no live gateway in a worktree).

## 8. Change History

| Date | Change |
|---|---|
| 2026-09-04 | Ticket created from the TASK-859 review. |
| 2026-09-04 | Implemented in worktree `task-860-model-registry` (steps 1–9). **Deviations imposed for parallel safety with TASK-862/863/864/865:** (1) the Prisma/TS identifier stays `taskType`; the kebab-case HF tag is the derived DTO field `pipelineTag` (`MODEL_TASK_TYPE_TO_PIPELINE_TAG`); no enum members were renamed or `@map`ped, and `taskSubtype` was not added — `GUARDRAIL` maps to `text-generation` (granite-guardian is an LLM), `SPEAKER_*` to `audio-classification`. (2) `AiModelFormat` members kept (cloud pseudo-values `@deprecated`); the §3.2 columns added; `downloadStatus`/`downloadedAt`/`fileSizeMb`/`localPath` kept and deprecated, `localPath` derived by the service. (3) Registry writes are SYSTEM-pinned + super-admin-only in `AiModelService`. (4) `isPlatformDefaultFor` only; no `AiRoutingPolicyService` call. (5) Migration authored against a `git archive` snapshot with `prisma migrate diff`; not applied here. (6) `uv lock` not run. **Other deviations:** cloud and LM Studio rows keep `sourceUri` = the vendor / engine-host wire id (the STT cloud loaders and the TEXT router read `source_uri` verbatim — re-pointing them is TASK-862's), `wireModelId` mirrors it and the Hub artifact for LM Studio rows is `metaData.hubArtifact`; §2.5's "10 rows" is 11 slugs (46 − 11 = 35); the three retired whisper rows are still referenced by seeded pipeline YAML, so the reference guard skips them on an existing DB until TASK-861 (a fresh seed never creates them); provider-list de-dup was replaced by a parity contract test (`packages/database` is a dependency leaf); `deepfilternet` was NOT added to `apps/stt/pyproject.toml` (0.5.6 pins numpy<2 — unresolvable; the engine now fails closed instead of no-op); LM Studio inventory probe not folded into the inventory job; the register drawer has no Hub-card auto-fill. |
| 2026-09-09 | **Merged into `dev-2.2` — recorded at close-out (TASK-932 branch review).** The branch `task-860-model-registry` (tip `d4e0af31b`) was merged earlier and its exact tip tree is present in `dev-2.2`'s history (`208f8c946` after the 2026-09-09 history rewrite; `git cherry` reports no unmerged patch). Remote `dev-2.2` carries it since the push of `04708b489`. The local branch was deleted after that verification. |

| 2026-09-04 | Orchestrator (e2e baseline on the merged tree): `ai-model-discovery.spec.ts` rewritten for the 410 contract of `POST …/discovery/register`; the four registration-dependent cases and the cross-tenant read-back were dropped with the surface. Follow-up owed by this ticket: an e2e for `POST admin/ai-models` (create from the catalogue / an inventory prefix) plus the 404-over-403 read-back of `GET admin/ai-models/:id`. |
