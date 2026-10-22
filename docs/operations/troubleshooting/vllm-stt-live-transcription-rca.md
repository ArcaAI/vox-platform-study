# Technical Root Cause Analysis: vLLM-Hosted Whisper STT on Vox Platform

## 1. Executive Summary

During the integration of self-hosted vLLM serving `openai/whisper-large-v3-turbo` with the Vox Platform for Live Transcription, two successive issues were identified and resolved:

1. **Issue 1 (502 Bad Gateway):** Live transcription session creation failed with `502 Bad Gateway` because the STT model was registered with `format = 'PYTORCH'`, forcing the STT worker to search for local `.pt` weights instead of dispatching via OpenAI REST to vLLM.
2. **Issue 2 (Silent Transcripts / No Output):** After fixing session creation, WebSocket connected and microphone audio streamed, but no transcript appeared. The provider connection `baseUrl` was configured with an internal Kubernetes cluster DNS name (`http://hope-vllm:8000/v1`) that the STT worker host (`192.168.112.2`) could not resolve.

Both issues were resolved via targeted database configuration updates without downtime or code changes.

---

## 2. Architecture & Data Flow

```
[Browser / Front-End]
       │
       ▼ (1. POST /api/v1/audio/transcription-jobs/stream/session)
[hope-api-gateway] (K8s: NodePort 32458 / Port 8868)
       │
       ▼ (2. POST /internal/streaming/sessions with X-Service-Token)
[hope-stt Worker] (Host Node: 192.168.112.2:8862)
       │
       │ (3. Audio streamed via Redis: stt:audio:{sessionId})
       ▼
 [VAD / Preprocessor] ──> Audio Utterance Slice
       │
       ▼ (4. POST /v1/audio/transcriptions via OpenAIEngine)
[vLLM Inference Engine] (Host Node: 192.168.112.2:9000/v1)
       │
       ▼ (5. JSON transcript returned to STT worker)
 [hope-stt Worker] ──> Redis: stt:result:{sessionId}
       │
       ▼ (6. WebSocket push /ws/stt/stream)
[Browser Live Transcript Box]
```

---

## 3. Issue 1: HTTP 502 Bad Gateway on Session Creation

### Symptoms
When requesting a live streaming session (`POST /api/v1/audio/transcription-jobs/stream/session`), the gateway returned:
```http
HTTP/1.1 502 Bad Gateway
```

### Root Cause
1. **Admin Console UI Omission:** The Admin Console registration schema (`model-meta.ts`) only included artifact file formats (`SAFETENSOR`, `ONNX`, `PYTORCH`, etc.) in `FORMAT_OPTIONS`, omitting `OPENAI`.
2. **Incorrect Model Row:** Because PyTorch was selected, the database record had:
   * `format = 'PYTORCH'`
   * `deploymentKind = 'SELF_HOSTED'`
   * `sourceUri = 's3://hope-models/whisper-turbo'`
3. **Dispatch Mismatch:** In `apps/stt/src/stt/processors/asr_engines.py`:
   ```python
   ASR_FORMAT_TO_NAME: dict[AiModelFormat, str] = {
       AiModelFormat.PYTORCH: "safetensor",   # Resolves to HuggingFace local file loader
       AiModelFormat.OPENAI: "openai",       # Resolves to OpenAIEngine (REST client)
   }
   ```
4. The STT worker attempted to load local `.pt` weights from MinIO/disk. Since the model was actually hosted on vLLM and had no local weights, the worker crashed with **HTTP 500**, which the API Gateway surfaced as **HTTP 502 Bad Gateway**.

### Resolution Applied
Updated the model record in `core."AiModel"`:
```sql
UPDATE core."AiModel"
SET 
  format = 'OPENAI',
  "deploymentKind" = 'CLOUD',
  "sourceUri" = 'openai/whisper-large-v3-turbo',
  "libraryName" = 'openai',
  "wireModelId" = 'openai/whisper-large-v3-turbo'
WHERE id = '01a1398e-4919-7bb6-8569-161cbc27bf3f';
```
* **Result:** Session creation succeeded with `HTTP 201 Created`.

---

## 4. Issue 2: Session Active, Mic Streaming, but No Transcripts

### Symptoms
* WebSocket connected successfully (`WS live`).
* Microphone capture meter showed active green audio levels.
* Session ran for 24+ seconds, but no words appeared in the transcript box.

### Root Cause
1. **Network Boundary Segregation:**
   * **STT Worker:** Running on host `192.168.112.2:8862` (external server node).
   * **vLLM Service:** Running on host `192.168.112.2:9000` (external server node).
   * **Kubernetes Cluster:** Running separately on `192.168.112.6` – `192.168.112.11`.
2. **Invalid `baseUrl`:** In `core."AiProviderConnection"`, the provider connection for tenant `50000000-0000-0000-0000-000000000001` was set to:
   ```
   http://hope-vllm:8000/v1
   ```
   `hope-vllm` is a Kubernetes **ClusterIP** service name. Because the STT worker process runs on host `192.168.112.2` outside the cluster, its host resolver cannot resolve `hope-vllm`.
3. **Silent Failure in Pipeline:**
   * When speech completed, the VAD preprocessor sent audio to `openai_recognize_utterance`.
   * `httpx.post("http://hope-vllm:8000/v1/audio/transcriptions")` threw `httpx.ConnectError: [Errno -2] Name or service not known`.
   * In `apps/stt/src/stt/streaming/inference.py`, the worker caught the non-critical exception, logged it, and degraded to empty text (`""`) to keep the stream alive without crashing the WebSocket.

### Resolution Applied
Updated `AiProviderConnection` and linked `sourceConnectionId` to use the host's direct address:
```sql
UPDATE core."AiProviderConnection"
SET "baseUrl" = 'http://192.168.112.2:9000/v1'
WHERE "tenantId" = '50000000-0000-0000-0000-000000000001' AND provider = 'openai';

UPDATE core."AiModel"
SET "sourceConnectionId" = '01a139d3-aed5-7710-b96f-bc06ca9cd9a2'
WHERE id = '01a1398e-4919-7bb6-8569-161cbc27bf3f';
```
* **Result:** STT worker successfully connected to vLLM on `http://192.168.112.2:9000/v1/audio/transcriptions`, generating real-time transcription segments over WebSocket.

---

## 5. Verification Matrix

| Test Step | Target Endpoint | Payload / Condition | Result |
| :--- | :--- | :--- | :--- |
| **vLLM Health** | `http://192.168.112.2:9000/v1/models` | GET | `200 OK` (`openai/whisper-large-v3-turbo` loaded) |
| **STT Worker Health** | `http://192.168.112.2:8862/api/v1/health` | GET (`X-Service-Token`) | `200 OK` (registered ASR engines include `openai`) |
| **Session Initialization** | `http://<gateway>:8868/.../stream/session` | POST (`agentSlug: whisper-v3-turbo`) | `201 Created` (returned `sessionId` + WS `ticket`) |
| **WebSocket Audio Stream** | `/ws/stt/stream` | Audio chunks streamed | Live transcript segments generated and rendered |

---

## 6. Permanent Recommendations

To prevent regression when adding future vLLM models from the Admin Console:
1. **Frontend Schema:** Include `'OPENAI'` in `FORMAT_OPTIONS` within `apps/admin-console/src/features/ai-models/components/model-meta.ts` and `AiModelFormat` in `apps/admin-console/src/features/ai-models/api/types.ts`.
2. **Provider Base URL Rule:** For components deployed on physical node `192.168.112.2`, always use host IP/port addresses (`http://192.168.112.2:9000/v1` or `http://127.0.0.1:9000/v1`), never internal Kubernetes Service names (`http://hope-vllm:8000/v1`).

---

## 7. Deep Dive: Why Does vLLM Require Format `OPENAI` Instead of `PYTORCH`?

### 1. vLLM Speaks the OpenAI Protocol
vLLM does **not** expose a proprietary or custom network protocol. Instead, vLLM implements the industry-standard **OpenAI API specification**. When vLLM runs, it exposes:
* `POST /v1/audio/transcriptions` (for speech-to-text with Whisper)
* `POST /v1/chat/completions` (for LLMs)
* `GET  /v1/models`

From the perspective of any client or worker, **communicating with vLLM is functionally identical to communicating with OpenAI**.

### 2. How the Vox Platform Distinguishes Models

In the Vox platform architecture, the `format` field tells the STT worker **how the model is executed**:

| Model Category | Formats | What the Platform Expects | Execution Path |
| :--- | :--- | :--- | :--- |
| **File-Based Models** | `PYTORCH`, `SAFETENSOR`, `ONNX`, `GGUF` | Raw weight files (`.pt`, `.safetensors`, `.onnx`) stored on disk or in MinIO/S3. | The STT worker downloads the files and loads weights directly into its own GPU/RAM memory using PyTorch, ONNXRuntime, or CTranslate2. |
| **Network / Protocol Engines** | `OPENAI`, `AZURE_SPEECH`, `SARVAM` | A remote HTTP REST / streaming server running in isolation. | The worker **loads no files into memory**. Instead, it instantiates an HTTP client (`OpenAIEngine`) and dispatches audio buffers across the network to the server's `/v1/audio/transcriptions` endpoint. |

### 3. What Happens If `PYTORCH` Is Selected for a vLLM Model?

If a vLLM-served model is registered as `PYTORCH`:
1. The platform assumes: *"This is a raw `.pt` weights file on local disk or MinIO."*
2. It attempts to load the model locally using `torch.load()` / `HuggingFaceLoader`.
3. Because the model is actually running inside an isolated vLLM container/process and has no local `.pt` weights on the STT worker, the file loader crashes with `FileNotFoundError` or unhandled load exception (`HTTP 500`).
4. The API Gateway receives the 500 from the STT worker and returns **502 Bad Gateway** to the browser.

### Key Rule of Thumb
* **`format: PYTORCH`** = *"I have a `.pt` weights file; load it locally into this worker's memory."*
* **`format: OPENAI`** = *"The model is running as an HTTP service behind an OpenAI-compatible REST server (vLLM); call it over the network."*
