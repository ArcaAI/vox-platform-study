# Streaming STT Load Test Latency Calculations & Formulas

This document details the exact mathematical formulas, timeline synchronization logic, and statistical methods used by [`vllm.py`](./vllm.py) to produce benchmark reports such as [`logs/concurrency_1/vllm_test_output_1.txt`](./logs/concurrency_1/vllm_test_output_1.txt).

---

## 1. High-Level Latency Decomposition

The total time experienced by an end-user from connection start to receiving speech transcripts is decomposed into discrete network and computation phases:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                     FULL LATENCY                                       │
├──────────────────────────┬───────────────────────────┬─────────────────────────────────┤
│ 1. HTTP Session Creation │ 2. WebSocket Handshake    │      3. WebSocket RTT           │
│    (Gateway REST POST)   │    (TCP + WS Upgrade)     ├────────────────┬────────────────┤
│                          │                           │ 4. Server ASR  │ 5. Gateway &   │
│                          │                           │    Inference   │    Transit     │
│                          │                           │    (Whisper)   │    Overhead    │
└──────────────────────────┴───────────────────────────┴────────────────┴────────────────┘
```

---

## 2. Metric Formulas & Source References

### Metric 1: HTTP Session Creation Latency
Measures the duration of the HTTP REST handshake to initialize a streaming session.

$$\text{Session Creation Latency (ms)} = (t_{\text{session\_created}} - t_{\text{session\_start}}) \times 1000$$

* **Source in [`vllm.py`](./vllm.py#L279-L292)**:
  ```python
  t_sess = time.perf_counter()
  session_id, ticket, current_active, max_concurrent = await client.create_session_async(sample_rate)
  result.session_create_ms = round((time.perf_counter() - t_sess) * 1000.0, 2)
  ```
* **Covers**:
  * HTTP request trip to Gateway (`POST /internal/streaming/sessions`).
  * `CapacityGuard` slot reservation and Redis session creation.
  * Ephemeral WebSocket auth ticket generation.
  * HTTP response return trip.

---

### Metric 2: WebSocket Connection Latency
Measures the TCP connection and protocol upgrade handshake.

$$\text{WebSocket Handshake Latency (ms)} = (t_{\text{ws\_connected}} - t_{\text{ws\_start}}) \times 1000$$

* **Source in [`vllm.py`](./vllm.py#L333-L342)**:
  ```python
  t_ws = time.perf_counter()
  async with websockets.connect(ws_url, ...) as ws:
      result.ws_handshake_ms = round((time.perf_counter() - t_ws) * 1000.0, 2)
  ```
* **Covers**:
  * TCP 3-way handshake (`SYN` $\rightarrow$ `SYN-ACK` $\rightarrow$ `ACK`).
  * TLS/SSL negotiation (if secure `wss://`).
  * WebSocket upgrade request (`GET ... HTTP/1.1` with `Upgrade: websocket`).
  * Gateway validation of auth ticket and response (`101 Switching Protocols`).

---

### Metric 3: Server ASR Inference Latency
Measures the pure neural network inference time on the GPU/CPU for the current audio segment.

$$\text{Server ASR Latency (ms)} = \text{float}(\text{data}[\text{"inferenceMs"}]) \quad \text{or} \quad \text{float}(\text{data}[\text{"inference\_ms"}])$$

* **Source in [`vllm.py`](./vllm.py#L391)**:
  ```python
  server_asr_ms = float(data.get("inferenceMs") or data.get("inference_ms") or 0.0)
  ```
* **Covers**:
  * Audio spectrogram extraction.
  * Speech recognition neural network forward pass (e.g. Whisper / NeMo model).
  * Beam search / greedy decoding and timestamp alignment.
  * Measured and reported directly by the server in the transcript frame payload.

---

### Metric 4: WebSocket Round-Trip Time (WS RTT)
Measures the wall-clock time between sending the audio containing the end of a spoken phrase and receiving its transcribed text.

$$\text{WS RTT (ms)} = \max(0.0, (t_{\text{recv}} - t_{\text{send}})) \times 1000$$

* **Source in [`vllm.py`](./vllm.py#L393-L404)**:
  ```python
  ref_time = stream_start_time if stream_start_time > 0 else stream_start_t
  send_t = ref_time
  if audio_sent_timeline:
      for aud_s, t in audio_sent_timeline:
          if aud_s >= speech_end:
              send_t = t
              break
      else:
          send_t = audio_sent_timeline[-1][1]

  ws_rtt_ms = round(max(0.0, recv_t - send_t) * 1000.0, 2)
  ```

#### Timeline Correlation Logic:
1. Audio is sent in continuous 250ms chunks.
2. The sender records every chunk sent into an `audio_sent_timeline` array:
   ```python
   # aud_s = cumulative audio seconds sent so far
   # send_t = wall clock time (time.perf_counter()) when this chunk was sent
   audio_sent_timeline.append((audio_time_cursor, send_t))
   ```
3. When the server delivers a transcript with `speech_end` (e.g., $1.8\text{ s}$), the code finds the chunk where `aud_s >= speech_end` to grab the **exact clock time `send_t` when that audio left the machine**.

---

### Metric 5: Gateway & Transit Overhead
Measures all latency outside the neural network computation.

$$\text{Gateway \& Transit Overhead (ms)} = \max(0.0, \text{WS RTT} - \text{Server ASR Inference})$$

* **Source in [`vllm.py`](./vllm.py#L407)**:
  ```python
  gateway_overhead_ms = max(0.0, round(ws_rtt_ms - server_asr_ms, 2))
  ```
* **Covers**:
  * Client-to-Gateway WebSocket network transmission.
  * Gateway framing and writing audio into Redis Streams (`audio:stream`).
  * STT worker queue wait time (worker scheduling delay).
  * VAD (Voice Activity Detection) and audio pre-processing.
  * STT worker publishing transcripts back to Redis pub/sub.
  * Gateway WebSocket push back to the client.

---

### Metric 6: Full Latency (Combo)
Combines session initialization overhead with the live streaming round-trip latency.

$$\text{Full Latency (ms)} = \text{Session Creation} + \text{WS Handshake} + \text{WebSocket RTT}$$
$$\text{Full Latency (ms)} = \text{Session Creation} + \text{WS Handshake} + \text{Server ASR Inference} + \text{Gateway Overhead}$$

* **Source in [`vllm.py`](./vllm.py#L604-L609)**:
  ```python
  combo_vals = []
  for r in results:
      base_setup = r.session_create_ms + r.ws_handshake_ms
      for m in r.metrics:
          combo_vals.append(base_setup + m.ws_rtt_ms)
  ```

---

## 3. Statistical Calculations (Columns)

Each metric row in the summary table is calculated across all observations $X = [x_1, x_2, \dots, x_N]$:

```python
def calc(arr):
    a = np.array(arr)
    return {
        "avg": float(np.mean(a)),
        "p50": float(np.percentile(a, 50)),
        "p95": float(np.percentile(a, 95)),
        "min": float(np.min(a)),
        "max": float(np.max(a)),
    }
```

| Column | Mathematical Formula | Meaning |
| :--- | :---: | :--- |
| **Average (Mean)** | $\mu = \frac{1}{N} \sum_{i=1}^{N} x_i$ | Arithmetic average of all samples. |
| **P50 (Median)** | $\text{Percentile}_{50}(X)$ | 50% of transcript events completed faster than this latency. |
| **P95** | $\text{Percentile}_{95}(X)$ | 95% of transcript events completed faster than this latency (tail latency). |
| **Min** | $\min(X)$ | Best-case performance recorded during the test. |
| **Max** | $\max(X)$ | Worst-case peak latency observed. |

---

## 4. Walkthrough Example from `vllm_test_output_1.txt`

Taking the actual data from [`vllm_test_output_1.txt`](./logs/concurrency_1/vllm_test_output_1.txt):

```text
--------------------------------------------------------------------------------------------
Latency Metric                             Average      P50 (Median)   P95          Min        Max       
--------------------------------------------------------------------------------------------
1. Full Latency                              735.54 ms      701.46 ms    987.56 ms  688.47 ms  1000.75 ms
2. HTTP Session Creation Latency             400.64 ms      400.64 ms    400.64 ms  400.64 ms  400.64 ms
3. WebSocket Connection Latency              177.88 ms      177.88 ms    177.88 ms  177.88 ms  177.88 ms
4. Server ASR Inference Latency               59.73 ms       60.00 ms     73.57 ms   46.50 ms   78.10 ms
5. Gateway & Transit Overhead                 97.29 ms       64.30 ms    352.74 ms   57.51 ms  365.06 ms
--------------------------------------------------------------------------------------------
```

### Verification Proof:
1. **Base Setup Cost**:
   $$\text{Session Creation} (400.64\text{ ms}) + \text{WS Handshake} (177.88\text{ ms}) = \mathbf{578.52\text{ ms}}$$
   *(Constant across all transcripts for this single-session run).*

2. **Average WebSocket RTT**:
   $$\text{Server ASR} (59.73\text{ ms}) + \text{Gateway Overhead} (97.29\text{ ms}) = \mathbf{157.02\text{ ms}}$$

3. **Average Full Latency**:
   $$\text{Base Setup} (578.52\text{ ms}) + \text{Average WS RTT} (157.02\text{ ms}) = \mathbf{735.54\text{ ms}}$$
   *(Exactly matches line 12: `735.54 ms`)*

4. **Minimum Full Latency**:
   $$\text{Base Setup} (578.52\text{ ms}) + \text{Min WS RTT} (109.95\text{ ms}) = \mathbf{688.47\text{ ms}}$$
   *(Exactly matches line 12: `688.47 ms`)*
