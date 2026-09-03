# Provider Capability Matrix — SARVAM / AZURE OPENAI / HUGGINGFACE

Research date: 2026-09-01. Scope: TEXT GENERATION, TRANSLATION, SPEECH-TO-TEXT, TEXT-TO-SPEECH.
Every claim below is cited. Where I could not verify something from an official source, it is
marked **UNVERIFIED** with what I tried.

---

## A. MASTER MATRIX (provider × task)

| Provider | Task | Supported? | Endpoint | OpenAI-compatible? | Streaming? | Required params | Usage/metering returned? | Malayalam? |
|---|---|---|---|---|---|---|---|---|
| **Sarvam** | Text generation | ✅ | `POST https://api.sarvam.ai/v1/chat/completions` | Schema-compatible (chat.completion shape); auth also accepts `Authorization: Bearer` for OpenAI-tooling interop [[1]](https://docs.sarvam.ai/api-reference-docs/authentication) | ✅ SSE (`stream: true`) [[2]](https://docs.sarvam.ai/api-reference/chat/chat-completions) | `messages`, `model` (`sarvam-105b` \| `sarvam-105b-conversations`) [[2]](https://docs.sarvam.ai/api-reference/chat/chat-completions) | ✅ `usage.prompt_tokens/completion_tokens/total_tokens` — but documented as *optional* in the response, i.e. not guaranteed on every call [[2]](https://docs.sarvam.ai/api-reference/chat/chat-completions) | Chat model is Indic-tuned (10 Indic langs + English), Malayalam not individually broken out on the chat-completion page — the model card is the source, not per-request; treat as supported via general Indic coverage, not separately confirmed on this page |
| **Sarvam** | Translation | ✅ | `POST https://api.sarvam.ai/translate` | Bespoke (not OpenAI-shaped) [[3]](https://docs.sarvam.ai/api-reference/text/translate-text) | ❌ not supported [[3]](https://docs.sarvam.ai/api-reference/text/translate-text) | `input`, `source_language_code`, `target_language_code` [[3]](https://docs.sarvam.ai/api-reference/text/translate-text) | ❌ none — response is only `request_id`, `translated_text`, `source_language_code` [[3]](https://docs.sarvam.ai/api-reference/text/translate-text) | ✅ **`ml-IN` explicitly listed** as source and target [[3]](https://docs.sarvam.ai/api-reference/text/translate-text) [[4]](https://docs.sarvam.ai/api-reference-docs/getting-started/models/mayura) |
| **Sarvam** | Speech-to-text | ✅ | `POST https://api.sarvam.ai/speech-to-text` (+ batch API for ≤2h files, + WebSocket streaming API) [[5]](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/overview) [[6]](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe) | Bespoke | ✅ separate WebSocket streaming endpoint exists in addition to REST [[5]](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/overview) | `file` (multipart); `model` and `language_code` optional (auto-detect default) [[6]](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe) | ❌ none — response is `request_id`, `transcript`, `language_code`, optional `timestamps`/`language_probability`; **no audio-duration field** [[6]](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe) | ✅ **`ml-IN: Malayalam` explicitly listed** [[6]](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe) |
| **Sarvam** | Text-to-speech | ✅ | `POST https://api.sarvam.ai/text-to-speech` (+ streaming variant via HTTP stream/WebSocket) [[7]](https://docs.sarvam.ai/api-reference-docs/text-to-speech/api/rest-api) [[8]](https://docs.sarvam.ai/api-reference/text-to-speech/convert) | Bespoke | ⚠️ the plain REST `convert` endpoint returns base64 audio, not streamed [[8]](https://docs.sarvam.ai/api-reference/text-to-speech/convert); a **separate streaming API exists** per the TTS overview [[9]](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/overview) | `text`, `language_code`; `speaker`/`model` optional [[8]](https://docs.sarvam.ai/api-reference/text-to-speech/convert) | ❌ none — response is just `request_id` + `audios[]`; no character count [[8]](https://docs.sarvam.ai/api-reference/text-to-speech/convert) | ✅ **`ml-IN` explicitly listed** as allowed `language_code`; which specific speaker voices support it is **UNVERIFIED** — the convert-endpoint page did not enumerate voice→language mapping [[8]](https://docs.sarvam.ai/api-reference/text-to-speech/convert) |
| **Azure OpenAI** | Text generation | ✅ | v1 GA: `POST {endpoint}/openai/v1/chat/completions` or `/responses` (deployment referenced via `model` = deployment name); legacy: `POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...` [[10]](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle) | ✅ Yes — v1 GA is explicitly the OpenAI-client-compatible surface [[10]](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle) | ✅ SSE, standard OpenAI streaming | `model` (= your **deployment name**, not the base model id), `messages` [[10]](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle) | ✅ rich: `usage.prompt_tokens/completion_tokens/total_tokens`, plus `completion_tokens_details.{audio_tokens,reasoning_tokens}`, `prompt_tokens_details.cached_tokens` [[11]](https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them)-pattern confirmed for Azure via changelog additions [[10]](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle) | Model-dependent; not a Malayalam-specialist provider — **UNVERIFIED** at task level (general GPT multilingual capability, no explicit Malayalam benchmark found) |
| **Azure OpenAI** | Translation | ⚠️ **NOT a first-class task** — see §C | `POST {endpoint}/openai/v1/audio/translations` — **audio-to-English-text ONLY**, via Whisper [[12]](https://learn.microsoft.com/th-th/azure/ai-services/speech-service/whisper-overview) | Bespoke (multipart form), preview surface (`api-version=preview`) [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest) | ❌ not documented for `/audio/translations` | `file`; `model` optional | ✅ `duration` field in response (`AzureAudioTranslationResponse`) when available [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest) | N/A — output is English text only regardless of input language, by design [[12]](https://learn.microsoft.com/th-th/azure/ai-services/speech-service/whisper-overview) |
| **Azure OpenAI** | Speech-to-text | ✅ | v1 preview: `POST {endpoint}/openai/v1/audio/transcriptions` [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest) | Bespoke (multipart), modeled on OpenAI's audio API | ✅ SSE `stream:true` supported for `gpt-4o-transcribe`/`gpt-4o-mini-transcribe` family — **NOT for `whisper-1`**, which ignores the flag [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest) | `file`; `model`, `language`, `response_format` optional [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest) | ✅ `duration` field (`AzureAudioTranscriptionResponse`, optional, populated with `verbose_json`) [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest) | Whisper: `ml` is one of Whisper's ~99 supported languages [[14]](https://voicci.com/whisper-languages.html); gpt-4o-transcribe: Malayalam supported but reported WER approaching 30% for Dravidian languages incl. Malayalam — quality caveat, not an availability gap — **UNVERIFIED against an official OpenAI/Microsoft language table**, this figure comes from third-party benchmarking discussion, not Microsoft/OpenAI docs |
| **Azure OpenAI** | Text-to-speech | ✅ | v1 preview: `POST {endpoint}/openai/v1/audio/speech`; legacy: `POST {endpoint}/openai/deployments/{deployment}/audio/speech?api-version=2025-04-01-preview` [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest) [[15]](https://learn.microsoft.com/en-us/azure/foundry/openai/whisper-quickstart) | Bespoke, modeled on OpenAI's TTS API | ✅ `stream_format: sse\|audio` — **not supported for `tts-1`/`tts-1-hd`** [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest) | `input` (≤4096 chars), `model`, `voice` [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest) | ❌ none — response is raw `application/octet-stream` audio, no usage JSON [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest) | ❌ **OpenAI TTS voices (alloy/echo/fable/onyx/nova/shimmer) are English-centric preset voices, not Malayalam voices** — Malayalam TTS on Azure requires the *separate* **Azure AI Speech** service, not Azure OpenAI TTS — see §E notes below |
| **HuggingFace** | Text generation | ✅ | `POST https://router.huggingface.co/v1/chat/completions` (or provider-native via `InferenceClient`) [[16]](https://huggingface.co/docs/inference-providers/index) | ✅ Yes — explicitly a "drop-in OpenAI replacement" [[16]](https://huggingface.co/docs/inference-providers/index) | ✅ | `model` (Hub model id, optionally suffixed `:provider`/`:fastest`/`:cheapest`/`:preferred`), `messages` [[16]](https://huggingface.co/docs/inference-providers/index) | ⚠️ Standard OpenAI-shaped `usage` object expected (chat-completions compatible) but **not explicitly shown in the fetched docs** — **UNVERIFIED**, only inferred from "drop-in OpenAI replacement" framing | Model-dependent (whichever open model is routed to); no Malayalam-specific guarantee — **UNVERIFIED** |
| **HuggingFace** | Translation | ⚠️ | `POST` via `InferenceClient`/router, task=`translation`; only **`hf-inference`** (HF's own legacy serverless tier) is shown as a provider for this task — no third-party router partner (Groq/Together/Fireworks/etc.) lists translation in the partner capability table [[17]](https://huggingface.co/docs/inference-providers/en/tasks/translation) [[16]](https://huggingface.co/docs/inference-providers/index) | Bespoke (`inputs`, `parameters.src_lang/tgt_lang`) [[17]](https://huggingface.co/docs/inference-providers/en/tasks/translation) | ❌ not documented | `inputs`; `src_lang`/`tgt_lang` "required for multi-lingual models" [[17]](https://huggingface.co/docs/inference-providers/en/tasks/translation) | ❌ response is just `translation_text` [[17]](https://huggingface.co/docs/inference-providers/en/tasks/translation) | Depends entirely on which model you pick — the **recommended model is `google-t5/t5-base` (English↔German/French/Romanian only, no Malayalam)** [[17]](https://huggingface.co/docs/inference-providers/en/tasks/translation); Malayalam would require you to explicitly select a different Hub model (e.g. an NLLB or IndicTrans2 checkpoint) that happens to be warm on a provider — **not guaranteed available** |
| **HuggingFace** | Speech-to-text | ✅ | Task=`automatic-speech-recognition` via router; providers shown: `deepinfra`, `fal-ai`, `hf-inference`, `replicate`, `together` (for `openai/whisper-large-v3`) [[18]](https://huggingface.co/docs/inference-providers/en/tasks/automatic-speech-recognition) | Bespoke | ❌ not documented on this task page | `inputs` (base64 or raw audio bytes) [[18]](https://huggingface.co/docs/inference-providers/en/tasks/automatic-speech-recognition) | ❌ response is `text` + optional `chunks[]` timestamps — no duration/usage field [[18]](https://huggingface.co/docs/inference-providers/en/tasks/automatic-speech-recognition) | Whisper-large-v3 supports Malayalam (Whisper's ~99-language set) [[14]](https://voicci.com/whisper-languages.html), but availability depends on which of the 5 listed providers is warm/routed |
| **HuggingFace** | Text-to-speech | ⚠️ **UNVERIFIED / weak** | The canonical Inference Providers **partner capability table does not list a "Text to Speech" column at all** (only Chat LLM/VLM, Feature Extraction, Text-to-Image, Text-to-video, Speech-to-text) [[16]](https://huggingface.co/docs/inference-providers/index); the task-reference index page also lists no `text-to-speech` entry under "Popular tasks" or "Other tasks" [[19]](https://huggingface.co/docs/inference-providers/en/tasks/index); a direct fetch of `.../tasks/text-to-speech` and `.../tasks/text_to_speech` both **404'd** during this research | — | — | — | — | — |

Sources for row-by-row detail are inline. Full source list is in §Sources at the end.

---

## B. CONFIGURATION FIELD SETS (per provider) — direct input to schema design

Legend: 🔒 SECRET (Vault) · ⚙️ CONFIG (DB)

### Sarvam
| Field | 🔒/⚙️ | Notes |
|---|---|---|
| `api_subscription_key` | 🔒 | The one credential. Sent as header `api-subscription-key`, OR as `Authorization: Bearer <key>` for OpenAI-tool interop [[1]](https://docs.sarvam.ai/api-reference-docs/authentication). Displayed once at creation, non-retrievable after [[1]](https://docs.sarvam.ai/api-reference-docs/authentication). |
| `base_url` | ⚙️ | Fixed: `https://api.sarvam.ai` [[1]](https://docs.sarvam.ai/api-reference-docs/authentication) — effectively a constant, not tenant-configurable, but still belongs in config for self-hosted-mirror/testing scenarios. |
| `model` (per task) | ⚙️ | e.g. chat: `sarvam-105b`/`sarvam-105b-conversations`; translate: `mayura:v1`/`sarvam-translate:v1`; STT: `saarika:v2.5`/`saaras:v3`; TTS: `bulbul:v2`/`bulbul:v3`. |
| task-tunables | ⚙️ | Optional per-task knobs (temperature, mode, output_script, speaker, pace, etc.) — belong on `AiTaskDefault`-style rows, not the connection itself. |

**One API key authenticates every Sarvam product** — chat, translate, STT, and TTS all read the *same* `api-subscription-key` header [[1]](https://docs.sarvam.ai/api-reference-docs/authentication); the docs never describe per-product keys. Rate limits, however, are enforced **per endpoint, per account** (not per key) — a Starter-tier account gets 60 req/min on chat but only 30 req/min on Bulbul v3 TTS [[20]](https://docs.sarvam.ai/api-reference-docs/ratelimits). So although credential-wise "one config = one key covers all tasks," the owner's stated model ("one configuration for one task") is still coherent — each task-scoped config would just reuse the same underlying secret value, which the schema should allow (don't force a technically-unique secret per task row).

### Azure OpenAI
| Field | 🔒/⚙️ | Notes |
|---|---|---|
| `resource_endpoint` | ⚙️ | `https://{resource-name}.openai.azure.com` (also accepts `.services.ai.azure.com`) [[10]](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle). |
| `api_key` | 🔒 | Key-based auth path. |
| `entra_id_credentials` (client id/secret, or managed identity ref) | 🔒 (client secret) / ⚙️ (client id, tenant id) | Alternative to `api_key`; Microsoft explicitly recommends this as "more secure" [[10]](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle). Token scope: `https://ai.azure.com/.default` [[10]](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle). |
| `deployment_name` | ⚙️ | The value your code sends as `model` — **it is an admin-chosen label, not the model id** [[21]](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/working-with-models). One deployment = one model = (practically) one task. |
| `underlying_model` + `model_version` | ⚙️ | Informational/capability-routing field — needed because the deployment name alone doesn't tell your platform which model/version backs it (e.g. `gpt-4.1`, `whisper-1`, `gpt-4o-transcribe`, `tts-1-hd`). |
| `api_version` | ⚙️ | Either a dated string (`2025-04-01-preview`, etc.) or omitted entirely on the v1 GA surface (`/openai/v1/...`, no `api-version` query param needed for GA chat) [[10]](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle). **Audio endpoints (`/audio/transcriptions`, `/audio/translations`, `/audio/speech`) are still on `api-version=preview`**, i.e. not yet GA, as of the fetched doc (updated 2026-06-24) [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest). |
| `region` | ⚙️ | Implied by the resource; matters because some audio models are region-restricted (e.g. `tts-1`/`tts-1-hd` require North Central US or Sweden Central) [[22]](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/text-to-speech-quickstart). |
| `subscription_id` / `resource_group` | ⚙️ | Needed only if you also want to call the ARM-based Usages/Model-Capacities quota APIs [[23]](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota) — not needed for plain inference calls. |

### HuggingFace
| Field | 🔒/⚙️ | Notes |
|---|---|---|
| `hf_token` | 🔒 | Fine-grained personal/org access token with **"Make calls to Inference Providers"** permission [[16]](https://huggingface.co/docs/inference-providers/index). Sent as `Authorization: Bearer hf_...`. |
| `router_base_url` | ⚙️ | Fixed: `https://router.huggingface.co/v1` for the OpenAI-compatible chat surface [[16]](https://huggingface.co/docs/inference-providers/index); non-chat tasks go through the `InferenceClient`/raw task endpoints instead. |
| `provider_selection_policy` | ⚙️ | `auto`/`:fastest` (default), `:cheapest`, `:preferred`, or an explicit provider name suffix on the model id (e.g. `openai/gpt-oss-120b:groq`) [[16]](https://huggingface.co/docs/inference-providers/index). |
| `bill_to` (org) | ⚙️ | Optional `X-HF-Bill-To` header / `bill_to` client param to attribute usage to a Team/Enterprise org instead of the individual token owner [[24]](https://huggingface.co/docs/inference-providers/en/pricing). |
| `model_id` (per task) | ⚙️ | Hub repo id, e.g. `openai/whisper-large-v3`. |
| **Separate concern — model download token** | 🔒 | For pulling weights into MinIO: same or a different `hf_token`, scoped `read`, used with `huggingface_hub`/`hf auth login`; for **gated models** the token's *owning user* must have an **accepted access request** on that specific repo — this is a per-user/per-repo grant, not something a service token can bulk-satisfy [[25]](https://huggingface.co/docs/hub/models-gated). |

---

## C. THE AZURE TRANSLATION PROBLEM

**The owner's "translation task on Azure OpenAI" is NOT achievable as a general text-to-text
translation endpoint.** Verified facts:

1. Azure OpenAI's only endpoint with "translation" in its name is `/audio/translations`, which is
   Whisper's speech-translation mode — it takes **audio in**, and always produces **English text
   out**. It cannot translate audio into Malayalam, and it cannot translate *text* input at all
   (there is no text-in/text-out translation endpoint in the Azure OpenAI data-plane API)
   [[12]](https://learn.microsoft.com/th-th/azure/ai-services/speech-service/whisper-overview) [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest).
2. General multi-language **text** translation on Azure OpenAI, if desired, would have to be done
   by prompting a chat model ("translate the following to Malayalam") — that's a text-generation
   call wearing a translation costume, not a distinct provider capability, and it inherits chat's
   content-filter behavior, token billing, and lack of translation-specific guarantees (no formal
   accuracy SLA, no glossary/terminology-consistency features).
3. **Azure AI Translator is a genuinely different Azure service** — different resource type,
   different API (`Ocp-Apim-Subscription-key` header, not an Azure OpenAI key), different base
   URL/domain, and (for its classic NMT tier) different billing model (character-based, not
   token-based) [[26]](https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/quickstart/rest-api) [[27]](https://learn.microsoft.com/en-us/fabric/data-science/ai-services/how-to-use-text-translator). Microsoft has also announced a newer Azure AI Translator API tier that adds
   generative-AI-backed translation, billed like Azure OpenAI tokens for that specific mode — but
   it is still a separate resource/credential from Azure OpenAI proper [[28]](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/announcing-a-new-azure-ai-translator-api-public-preview/4450660).

**Options for the owner, stated plainly:**
- **(a)** Model "Azure OpenAI" as NOT covering the translation task at all in the unified schema
  (its per-task config screen for Translation would show "not supported"), and require a tenant
  who wants Azure-backed translation to configure **Azure AI Translator** as a *distinct provider*
  with its own credential fields (subscription key, endpoint, region) — architecturally the
  cleanest option, consistent with how the providers actually separate.
- **(b)** Model chat-based translation as a thin wrapper task on top of the existing Azure OpenAI
  text-generation configuration (reuse the deployment, inject a translation system prompt) —
  works today, but is not a distinct "capability" the provider advertises, has no formal
  translation semantics, and every content-filter/rate-limit/error behavior is chat's, not
  translation's.
- **(c)** Add Azure AI Translator as a fourth Azure integration alongside Azure OpenAI under one
  logical "Azure" provider family with per-service credentials — a middle ground if the UI wants
  one "Azure" tile with sub-configs.

This needs an explicit owner decision — do not silently implement (b) and call it "Azure OpenAI
translation," since that overstates what the provider natively does.

---

## D. HUGGINGFACE OFFERING CHOICE

HuggingFace is not one product; it is (at least) three, and they do not compose the way a single
"provider configuration" implies:

| Offering | What it is | Fits "one config per tenant, live inference"? | Fits "download models to MinIO"? |
|---|---|---|---|
| **Inference Providers** (the router, `router.huggingface.co`) | A proxy in front of 15+ third-party inference backends (Groq, Together, Fireworks, Cerebras, Replicate, fal, etc.) plus HF's own legacy `hf-inference` tier, unified under one HF token and one OpenAI-compatible chat surface [[16]](https://huggingface.co/docs/inference-providers/index) | ✅ **Yes — this is the one to model as the "provider configuration."** One HF token per tenant genuinely does authenticate every task it supports (chat is solid; ASR is solid via 5 providers; translation and TTS are weak/unverified per §A) | ❌ No — it runs inference remotely, it does not hand you weight files |
| **Inference Endpoints (dedicated)** | Per-model, per-tenant dedicated GPU deployment you provision and pay for by the hour, with your own hardware/region/scaling choice [[29]](https://huggingface.co/learn/cookbook/en/enterprise_dedicated_endpoints) | ⚠️ Technically possible but architecturally a poor fit for "one configuration per tenant" — each endpoint is bound to ONE specific model, so a tenant wanting text-gen + ASR would need *two* dedicated endpoints, each with its own URL, defeating the single-config premise | ❌ No — same as above, it's a hosted inference service, not a download mechanism |
| **The Hub** (`huggingface_hub`, `hf auth login`, `snapshot_download`/`hf_hub_download`) | Git-LFS-backed model/dataset storage; you download files, you run them yourself | N/A — not an inference API at all | ✅ **Yes — this is the one to model as a model-store integration**, separate from "provider configuration." Auth is the same token type (`read` or `fine-grained`) but the *operation* is a bulk file transfer, not a request/response inference call [[30]](https://huggingface.co/docs/hub/security-tokens) |

**Recommendation:** model HuggingFace as **two independent capabilities** in the platform, not
one:
1. A **provider configuration** (task-scoped, like Sarvam/Azure) that talks to **Inference
   Providers**, honestly scoped to the tasks it actually covers today (text-generation strong,
   speech-to-text usable, translation and text-to-speech flagged UNVERIFIED/weak — see §A).
2. A **model-store integration** (unrelated to the four-task provider-config screen) that uses
   `huggingface_hub` to pull a chosen repo/revision down and land it in MinIO. This needs its own
   token field, its own gated-model-acceptance UX (a human must click "Agree" on huggingface.co
   for gated repos before any script can download them — this cannot be automated away
   [[25]](https://huggingface.co/docs/hub/models-gated)), and its own storage-path/bucket target — none of which belongs on
   the inference-provider config screen.

---

## E. SARVAM VERDICT

Sarvam genuinely covers all four tasks today, natively, for Indian languages including Malayalam:

| Task | Verdict | Malayalam |
|---|---|---|
| Text generation | ✅ Real product (`chat/completions`, Sarvam-105B family) | Chat model is described as covering "10 Indic languages + English" at the product level; Malayalam is one of Sarvam's core supported Indic languages per the model family, though the chat-completions API reference page itself doesn't enumerate a per-language list the way translate/STT/TTS pages do — treat as **supported but not independently re-verified on this specific page** [[2]](https://docs.sarvam.ai/api-reference/chat/chat-completions) |
| Translation (Mayura / Sarvam-Translate) | ✅ Real, dedicated product | ✅ **Explicitly listed**: `ml-IN` (Malayalam) is a named supported language for both `mayura:v1` and the newer `sarvam-translate:v1` [[3]](https://docs.sarvam.ai/api-reference/text/translate-text) [[4]](https://docs.sarvam.ai/api-reference-docs/getting-started/models/mayura) |
| Speech-to-text (Saarika / Saaras) | ✅ Real, dedicated product, REST + batch + streaming | ✅ **Explicitly listed**: `ml-IN: Malayalam` [[6]](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe) |
| Text-to-speech (Bulbul) | ✅ Real, dedicated product, REST + streaming | ✅ **Explicitly listed**: `ml-IN` is an allowed `language_code`; exact voice→language coverage (which of the 30+ speaker voices actually render Malayalam well) is **UNVERIFIED** from the API reference alone — would need the voices catalog/dashboard, which requires an authenticated session and wasn't reachable in this research |

This is very likely *why* Sarvam was chosen for this platform: it is the only one of the three
providers whose native, dedicated products (not a workaround) cover Malayalam across all four
tasks with the language explicitly named in the API docs, not inferred.

**Caveats that matter for schema design:**
- No task returns a usage/metering figure except chat (and even there it's marked *optional* in
  the schema) [[2]](https://docs.sarvam.ai/api-reference/chat/chat-completions). Translate/STT/TTS return **zero** cost signal — HOPE's metering layer must compute its own
  character-count (translate, TTS input) or audio-duration (STT — must be derived from the
  uploaded file, since Sarvam doesn't echo it back) [[3]](https://docs.sarvam.ai/api-reference/text/translate-text) [[6]](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe) [[8]](https://docs.sarvam.ai/api-reference/text-to-speech/convert).
- Auth failures are **403, not 401** — an adapter that only treats 401 as "bad credential" will
  misclassify Sarvam auth errors [[1]](https://docs.sarvam.ai/api-reference-docs/authentication).
- Rate limits are **per Sarvam account, not per API key**, and differ **per endpoint**, e.g.
  Starter tier: chat 60 req/min, STT REST 60 req/min, TTS standard 60 req/min but Bulbul v3
  specifically 30 req/min, translation 60 req/min [[20]](https://docs.sarvam.ai/api-reference-docs/ratelimits). A single "requests per minute" field in the
  config schema is insufficient; rate-limit awareness must be per-task.

---

## F. ERROR + RATE-LIMIT HANDLING TABLE

| Provider | Rate-limit model | 429 shape | Other errors an adapter must handle |
|---|---|---|---|
| **Sarvam** | Per-account (not per-key), per-endpoint req/min ceilings by plan tier (Starter/Pro/Business/Enterprise) [[20]](https://docs.sarvam.ai/api-reference-docs/ratelimits) | `{"error":{"message":"Rate limit exceeded","code":"rate_limit_exceeded_error"}}`. **No `retry-after` header documented** — must use exponential backoff blind [[20]](https://docs.sarvam.ai/api-reference-docs/ratelimits) | **403** (not 401) for any auth failure, with `code: invalid_api_key_error` distinguishing "bad key" from other `*_error` "authenticated but forbidden" cases [[1]](https://docs.sarvam.ai/api-reference-docs/authentication); **503** possible under load, same backoff guidance [[20]](https://docs.sarvam.ai/api-reference-docs/ratelimits) |
| **Azure OpenAI** | Quota-based: TPM (tokens-per-minute) assigned per deployment, RPM derived from TPM by a model-class-specific ratio (e.g. older chat models: 6 RPM per 1,000 TPM; o-series reasoning models: different ratios) [[23]](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota) | 429 **with `retry-after-ms` header** (milliseconds to wait) [[23]](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota); also exposes live budget via `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens` on **every** response, not just 429s [[23]](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota) | **400 content_filter**: prompt-side blocks return HTTP 400 with `{"error":{"message":"The response was filtered","code":"content_filter",...}}` and (on the classic completions shape) a nested `innererror.content_filter_result` per category (hate/self_harm/sexual/violence) with `filtered`+`severity` [[31]](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-filter). Output-side blocks return **200** with `finish_reason: content_filter` instead of an error — this is the healthcare-relevant trap: a clean 200 can still mean "we silently dropped/withheld content" [[31]](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-filter). Content filtering explicitly **does not apply** to Whisper/audio models [[31]](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-filter), so a 400 on an STT call is never a content-filter 400. |
| **HuggingFace (Inference Providers)** | Free/PRO/Team/Enterprise tiers by monthly credit ($0.10/$2.00/$2.00-per-seat) plus pass-as-you-go beyond that [[24]](https://huggingface.co/docs/inference-providers/en/pricing); separate Hub-level rate-limit buckets (5-minute rolling windows) are also enforced [[32]](https://huggingface.co/docs/hub/rate-limits) | 429 Too Many Requests; `huggingface_hub` ≥1.2.0 parses a `RateLimit` header to sleep the exact reset duration automatically [[33]](https://discuss.huggingface.co/t/hitting-rate-limits-with-inference-providers/168245) | **402 Payment Required** when monthly credits are exhausted and no pay-as-you-go is configured [[34]](https://discuss.huggingface.co/t/hugging-face-payment-error-402-youve-exceeded-monthly-quota/144968); **403** for denied/pending/revoked org-scoped fine-grained tokens, each with a distinct message [[30]](https://huggingface.co/docs/hub/security-tokens); provider-proxy errors can also surface the *third-party provider's own* error shape since HF is a pass-through proxy — the exact shape is provider-dependent and not unified [[16]](https://huggingface.co/docs/inference-providers/index) |

---

## G. TOP 5 MODELLING IMPLICATIONS

1. **"One configuration = one credential" is false for Sarvam and true-ish for Azure, false again
   for HuggingFace — the schema must decouple "credential" from "task scope."** Sarvam's single
   `api-subscription-key` legitimately authorizes all four tasks (the owner's "one config per
   task" is a UI/UX choice to scope *usage*, not a credential requirement) [[1]](https://docs.sarvam.ai/api-reference-docs/authentication). Azure's
   deployment-per-task IS a hard technical constraint (a deployment binds to exactly one model)
   [[21]](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/working-with-models). HuggingFace's Inference-Providers token also authorizes everything the router supports, but
   the router itself doesn't support all four tasks equally (§A) — so "coverage" must be modeled
   per (provider, task) pair, independent of whether the *credential* happens to be shared.

2. **A provider row needs a `deployment_id`/`model_binding` field that is DISTINCT from
   `provider_id` and `credential_id`.** For self-hosted OpenAI-compatible engines (LM Studio,
   vLLM — out of scope for this brief but must still fit the same schema) there is no separate
   "deployment" concept at all; the model IS the endpoint. Azure forces deployment_name; Sarvam
   and HF let you pick the model per-request. The schema should treat "which model backs this
   task" as an **optional, provider-specific field** (required for Azure, optional/defaultable
   for Sarvam/HF/self-hosted), not a universal required column.

3. **Usage/metering cannot be assumed to come from the provider.** Only Azure OpenAI chat and
   Azure audio (`duration` field) reliably return a cost signal in-band
   [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest). Sarvam returns **nothing** for translate/STT/TTS
   [[3]](https://docs.sarvam.ai/api-reference/text/translate-text) [[6]](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe) [[8]](https://docs.sarvam.ai/api-reference/text-to-speech/convert), Azure TTS returns **nothing** (raw audio bytes only) [[13]](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest), and HF's non-chat
   tasks show no usage field in their documented response shapes [[17]](https://huggingface.co/docs/inference-providers/en/tasks/translation) [[18]](https://huggingface.co/docs/inference-providers/en/tasks/automatic-speech-recognition). The metering
   layer must be able to **self-compute** a usage figure (character count for text/translate/TTS
   input, audio duration measured client-side for STT input) as the fallback path, with
   provider-returned usage as an *override when present*, not the only path — the BYOK/CLOUD
   metering split (`09-infrastructure-devops.md` "Funding is derived, never stamped") needs this
   self-computed fallback to work at all for two of the three providers on three of four tasks.

4. **"Translation" is not a real, provider-native capability everywhere it's demanded, and the
   schema must be able to say so honestly per (provider, task) cell rather than forcing every
   provider into all four task slots.** Azure OpenAI has no text translation endpoint at all
   (§C); HuggingFace's router has translation on paper but only via the legacy `hf-inference` tier
   with a stale demo model, no third-party partner listed for it [[17]](https://huggingface.co/docs/inference-providers/en/tasks/translation); only Sarvam
   has a real, dedicated, Malayalam-capable translation product. A schema that requires every
   provider to populate all four task rows will produce fake/misleading "supported" flags —
   support should be a first-class per-(provider,task) boolean the admin UI reads, not inferred
   from "the provider has *a* config."

5. **Error taxonomies are provider-specific enough that a unified adapter interface needs a
   normalization layer, not a shared status-code switch.** Auth failure is 403 on Sarvam
   [[1]](https://docs.sarvam.ai/api-reference-docs/authentication) but 401/403 conventionally elsewhere; quota exhaustion is 402 on HuggingFace
   [[34]](https://discuss.huggingface.co/t/hugging-face-payment-error-402-youve-exceeded-monthly-quota/144968) but 429 (with `retry-after-ms`) on Azure [[23]](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota); content-safety
   rejection is a 400 with a structured `content_filter` body on Azure chat but a clean **200**
   with `finish_reason: content_filter` when it's the *output* rather than the *prompt* that's
   blocked [[31]](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-filter) — a healthcare product's guardrail/audit layer must special-case this "200 that
   isn't really a success" per provider, because the string "200 OK" does not mean "content
   delivered" for at least one of the three providers in scope.

---

## Sources

1. Sarvam AI Authentication — https://docs.sarvam.ai/api-reference-docs/authentication
2. Sarvam Chat Completion API reference — https://docs.sarvam.ai/api-reference/chat/chat-completions
3. Sarvam Translation API reference — https://docs.sarvam.ai/api-reference/text/translate-text
4. Sarvam Mayura model page — https://docs.sarvam.ai/api-reference-docs/getting-started/models/mayura
5. Sarvam Speech-to-Text overview — https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/overview
6. Sarvam Speech-to-Text transcribe reference — https://docs.sarvam.ai/api-reference/speech-to-text/transcribe
7. Sarvam TTS REST API — https://docs.sarvam.ai/api-reference-docs/text-to-speech/api/rest-api
8. Sarvam TTS convert reference — https://docs.sarvam.ai/api-reference/text-to-speech/convert
9. Sarvam TTS overview (streaming) — https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/overview
10. Azure OpenAI v1 API / api-version lifecycle — https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle
11. OpenAI tokens explainer (pattern reference) — https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them
12. Azure "Whisper model from OpenAI" overview — https://learn.microsoft.com/th-th/azure/ai-services/speech-service/whisper-overview
13. Azure OpenAI image/audio/video REST reference (v1 preview) — https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest
14. Whisper supported languages (incl. Malayalam) — https://voicci.com/whisper-languages.html
15. Azure OpenAI Whisper quickstart — https://learn.microsoft.com/en-us/azure/foundry/openai/whisper-quickstart
16. HF Inference Providers index/overview — https://huggingface.co/docs/inference-providers/index
17. HF Inference Providers — Translation task — https://huggingface.co/docs/inference-providers/en/tasks/translation
18. HF Inference Providers — ASR task — https://huggingface.co/docs/inference-providers/en/tasks/automatic-speech-recognition
19. HF Inference Providers — task index — https://huggingface.co/docs/inference-providers/en/tasks/index
20. Sarvam rate limits — https://docs.sarvam.ai/api-reference-docs/ratelimits
21. Azure OpenAI "working with models" (deployment vs model name) — https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/working-with-models
22. Azure OpenAI TTS quickstart (region restriction) — https://learn.microsoft.com/en-us/azure/foundry-classic/openai/text-to-speech-quickstart
23. Azure OpenAI quota / rate limits — https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota
24. HF Inference Providers pricing & billing — https://huggingface.co/docs/inference-providers/en/pricing
25. HF gated models — https://huggingface.co/docs/hub/models-gated
26. Azure AI Translator REST quickstart — https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/quickstart/rest-api
27. Azure Translator via Fabric (auth confirmation) — https://learn.microsoft.com/en-us/fabric/data-science/ai-services/how-to-use-text-translator
28. Azure AI Translator generative-AI tier announcement — https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/announcing-a-new-azure-ai-translator-api-public-preview/4450660
29. HF Inference Endpoints (dedicated) cookbook — https://huggingface.co/learn/cookbook/en/enterprise_dedicated_endpoints
30. HF User access tokens — https://huggingface.co/docs/hub/security-tokens
31. Azure content filtering concepts — https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-filter (fetched via foundry-classic mirror, same content)
32. HF Hub rate limits — https://huggingface.co/docs/hub/rate-limits
33. HF forum — Inference Providers rate-limit retry behavior — https://discuss.huggingface.co/t/hitting-rate-limits-with-inference-providers/168245
34. HF forum — 402 payment/quota error — https://discuss.huggingface.co/t/hugging-face-payment-error-402-youve-exceeded-monthly-quota/144968

## Explicitly UNVERIFIED items (do not treat as fact without further checking)

- Exact Sarvam TTS **voice → language** coverage table (which of 30+ Bulbul speakers render
  Malayalam) — the API reference lists `ml-IN` as an allowed `language_code` but does not cross-
  reference it against specific `speaker` values; the voice catalog likely lives behind an
  authenticated dashboard (`dashboard.sarvam.ai`) I could not reach.
- Whether **HuggingFace Inference Providers supports text-to-speech at all** as a routed task in
  2026 — the authoritative partner table and the task-reference index both omit it entirely; two
  direct URL guesses (`tasks/text-to-speech`, `tasks/text_to_speech`) both 404'd. Treat HF as
  **not offering TTS via Inference Providers** until confirmed otherwise by someone with dashboard/
  model-page access (check a specific TTS model's page for a "Deploy > Inference Providers"
  widget).
- Whether **HuggingFace's chat-completions router response includes a `usage` object** — assumed
  yes by analogy to "drop-in OpenAI replacement" framing, but not shown verbatim in any fetched
  example response.
- **Azure gpt-4o-transcribe Malayalam/Dravidian-language WER (~30%)** — sourced from a third-party
  community discussion referenced in search results, not from an official OpenAI/Microsoft
  benchmark page; flagged as a quality signal worth independent confirmation before it drives a
  model-selection default.
- Azure OpenAI general chat models' **Malayalam quality/coverage** — no official per-language
  benchmark was located in this research pass.
