---
'@arcaai/vox-node': patch
---

`consultations.summaries.generate` and `generatePreSummary` now wait up to `SYNC_GENERATION_TIMEOUT_MS` (180 s) when neither the call nor the client names a `timeoutMs`, instead of the transport's 60 s default; `ConsultationSummaryRequestOptions.timeoutMs` overrides it per call. A four-note pre-summary took 46–68 s on a local model and the old default gave up before the gateway answered (TASK-946).
