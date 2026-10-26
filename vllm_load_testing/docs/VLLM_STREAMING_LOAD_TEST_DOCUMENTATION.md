# vLLM STT Streaming Load Test Documentation

This document explains what the load test does, how latency is calculated, and how failures are detected.

---

## 1. What the Load Test Does

The load test (`vllm.py`) benchmarks the real-time Speech-to-Text (STT) streaming pipeline under concurrent user loads without doing any local audio modeling on the client workstation.

The workflow follows 5 steps:

```
[ Client (vllm.py) ]
       │
       │  1. Authenticate & Create Session (HTTP)
       ▼
[ API Gateway: Port 32458 ]
       │
       │  2. Establish WebSocket Connection
       ▼
[ WebSocket Stream: /ws/stt/stream ]
       │
       │  3. Stream Raw PCM Audio in Real Time (100ms chunks)
       ▼
[ Server STT Pipeline -> Whisper-v3-turbo Agent (vLLM) ]
       │
       │  4. Decode Audio to Text
       ▼
[ Receive Transcripts via WebSocket ]
```

1. **Connects to the API Gateway:**  
   Authenticates with the API Gateway (`http://192.168.112.6:32458/api/v1/auth/login`) using credentials to acquire a JWT bearer token.

2. **Creates an STT Streaming Session:**  
   Sends an HTTP POST request to `/api/v1/audio/transcription-jobs/stream/session` requesting a streaming session. The Gateway initializes the pipeline and returns a unique `sessionId` and WebSocket ticket.

3. **Connects to the WebSocket:**  
   Opens a persistent WebSocket connection to `ws://192.168.112.6:32458/ws/stt/stream` using the session ID and ticket.

4. **Streams Audio to Whisper-v3-turbo Agent:**  
   Reads the test audio file (16 kHz, 16-bit mono PCM) and streams binary chunks every 100 ms (matching natural human speaking cadence). On the server, the audio passes through VAD/denoising and is dispatched to the vLLM Whisper-v3-turbo engine for transcription.

5. **Gets Back Transcripts:**  
   Listens asynchronously on the WebSocket for incoming transcript frames (`{"type": "transcript", "text": "...", "inferenceMs": ...}`) and measures response timings until audio streaming finishes.

---

## 2. How Latency is Calculated

For every transcript received over the WebSocket, three latency metrics are measured:

| Metric | Source / Formula | Description |
| :--- | :--- | :--- |
| **1. WebSocket Return Latency (Wire RTT)** | `recv_time - sent_time` | **True wire round-trip time.** Measures the time elapsed from the exact millisecond the audio chunk containing the speech was sent over the network until the resulting transcript arrived back at the client. |
| **2. Server ASR Inference** | `msg["inferenceMs"]` | **Pure GPU decode time.** Extracted directly from the server payload. This is the exact duration the vLLM Whisper-v3-turbo model spent decoding the audio frame on the GPU. |
| **3. Gateway & Transit Overhead** | `ws_rtt_ms - server_asr_ms` | **Network and queue delay.** Calculated as the difference between total wire time and GPU execution time. Represents the time audio spent traveling through the network, gateway routing, and waiting in server queues before execution. |

### Summary Statistics
Across all transcript frames in a test run, the script calculates:
- **P50 (Median):** Typical latency experienced by 50% of requests.
- **P95 (95th Percentile):** Tail latency experienced under peak load.
- **Min / Max:** Best-case network round-trip and worst-case tail delays.

---

## 3. How Failures are Checked

Each concurrent worker is monitored through **4 strict validation checkpoints**. If any checkpoint fails, the request is flagged as **FAILED** with an explicit error reason:

```
[ Worker Start ]
       │
       ├──► [ Checkpoint 1: HTTP Session Creation ] ──(Fails: HTTP 502/503/400) ──► FAILED
       │
       ├──► [ Checkpoint 2: WebSocket Connection ]   ──(Fails: Handshake/Timeout) ──► FAILED
       │
       ├──► [ Checkpoint 3: Error Message Frames ]   ──(Fails: Server {"type":"error"}) ──► FAILED
       │
       └──► [ Checkpoint 4: Transcript Validation ]   ──(Fails: 0 transcripts received) ──► FAILED
```

1. **HTTP Session Creation:**  
   - **Check:** The session creation endpoint must return HTTP status `200` or `201` with a valid `sessionId`.  
   - **Failure:** If the server returns a `502 Bad Gateway`, `504 Gateway Timeout`, or network error, the session is marked as failed.

2. **WebSocket Handshake:**  
   - **Check:** The client must complete the WebSocket handshake within the connection timeout.  
   - **Failure:** If the connection is refused, times out, or fails authentication (HTTP 401/403), the session is marked as failed.

3. **Server Error Frames:**  
   - **Check:** The WebSocket stream is actively parsed for error responses.  
   - **Failure:** If the server emits a message with `{"type": "error"}` or a fatal payload during audio streaming, the worker records the error message and marks the session as failed.

4. **Transcript Completion:**  
   - **Check:** The server must return at least one valid transcript text frame before the session closes.  
   - **Failure:** If audio streaming completes successfully but zero transcripts were returned (`transcripts_received == 0`), the test flags the session as failed (silent drop).

---

### Pass Rate Formula
$$\text{Pass Rate (\%)} = \left( \frac{\text{Passed Sessions}}{\text{Total Sessions Attempted}} \right) \times 100$$
