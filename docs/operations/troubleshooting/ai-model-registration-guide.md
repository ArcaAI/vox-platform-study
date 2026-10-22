# AI Model Registration Guide (Ollama, vLLM, LM Studio)

This guide covers how to register external, wire-served AI models in the HOPE Admin Console without triggering **"Missing on server"** badges or **`400 Bad Request: invalid model name`** errors.

---

## 1. Field-by-Field Reference

| Field in UI | Required Setting | Purpose & Rule |
| :--- | :--- | :--- |
| **Name** | Display Name (e.g., `Qwen 2.5 14B (Ollama)`) | Human-readable label shown in the UI. |
| **Slug** | Kebab-case string (e.g., `ollama-qwen2-5-14b`) | Unique slug used in internal APIs and pipelines. Must not contain slashes (`/`) or colons (`:`). |
| **Deployment** | **`Cloud`** | **CRITICAL:** Unlocks the `Wire model id` field. Tells HOPE that model weights are managed by an external engine and not pulled from MinIO. |
| **Wire model ID** | Exact engine tag (e.g., `qwen2.5:14b` or `openai/whisper-large-v3-turbo`) | Sent in request bodies (`{"model": "..."}`) to the backend engine API (`/api/generate` or `/v1/chat/completions`). |
| **Source** | **`Hugging Face`** | **CRITICAL:** Do not choose `Local`. `Local` locks the Source URI to an `s3://hope-models/...` prefix. |
| **Source URI** | **Exact same string as Wire model ID** | Used by HOPE's Discovery service (`/admin/ai-models/discovery`) to match live probed engine models against registered catalog rows. |
| **Runtime provider**| `ollama`, `vllm`, or `lm-studio` | Connects the model to the corresponding provider connection. |
| **Served by** | `text` (for LLMs / vLLM) | Specifies the internal routing service. |

---

## 2. Step-by-Step UI Instructions

1. Navigate to **Admin Console &rarr; AI Models** (`/admin/ai-models`).
2. Click **Register model** (or click an existing model row to edit it).
3. Set the metadata:
   * **Name**: `Qwen 2.5 14B (Ollama)`
   * **Slug**: `ollama-qwen2-5-14b`
   * **Category**: `NLP` (or `AUDIO` for speech models)
   * **Task**: `TEXT_GENERATION` (or `AUTOMATIC_SPEECH_RECOGNITION` for ASR)
4. Set the deployment and provider:
   * **Deployment**: Select **`Cloud`**.
   * **Wire model id**: Set to the exact engine tag (e.g. `qwen2.5:14b`).
   * **Runtime provider**: Select `ollama` or `vllm`.
   * **Served by**: Select `text`.
5. Set the source:
   * **Source**: Select **`Hugging Face`**.
   * **Source URI**: Paste the exact same tag as Wire model id (e.g. `qwen2.5:14b`).
6. Click **Register model** (or **Save changes**).

---

## 3. Reference Configurations

### Ollama Model (`qwen2.5:14b`)
* **Name:** `Qwen 2.5 14B (Ollama)`
* **Slug:** `ollama-qwen2-5-14b`
* **Task:** `TEXT_GENERATION`
* **Deployment:** `Cloud`
* **Wire model ID:** `qwen2.5:14b`
* **Source:** `Hugging Face`
* **Source URI:** `qwen2.5:14b`
* **Runtime provider:** `ollama`
* **Served by:** `text`

### vLLM Whisper Model (`openai/whisper-large-v3-turbo`)
* **Name:** `Whisper Large v3 Turbo`
* **Slug:** `whisper-large-v3-turbo`
* **Task:** `AUTOMATIC_SPEECH_RECOGNITION`
* **Deployment:** `Cloud`
* **Wire model ID:** `openai/whisper-large-v3-turbo`
* **Source:** `Hugging Face`
* **Source URI:** `openai/whisper-large-v3-turbo`
* **Runtime provider:** `vllm`
* **Served by:** `text`

---

## 4. Common Pitfalls & Symptoms

| Mistake | What Happens in HOPE | How to Fix |
| :--- | :--- | :--- |
| **Leaving `Source: Local`** | HOPE derives `Source URI` as `s3://hope-models/...`. LLM queries fail with **`400 Bad Request: invalid model name`**. | Change `Source` to `Hugging Face` and set `Source URI` to the engine tag. |
| **`Source URI` does not match the live engine tag** | In `/ai-services/*`, the model shows a red **`Missing on server`** badge and a separate grey **`Discovered`** badge. | Update `Source URI` to match the exact string returned by the live probe. |
| **Leaving `Deployment: Self-hosted`** | The **Wire model ID** field stays disabled, preventing you from specifying custom engine tags. | Select **`Deployment: Cloud`**. |
