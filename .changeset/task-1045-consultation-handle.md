---
'@arcaai/vox-node': major
'@arcaai/vox': major
'@arcaai/types': major
---

TASK-1045 — consultation lifecycle simplification: one consultation handle, seven statuses, one processing marker. A major: the exported `ConsultationStatus` type changes meaning. If the same release also carries another major, this entry adds no extra bump (the fixed group moves together).

**The lifecycle vocabulary (`@arcaai/types`, re-exported by both SDKs)**

- `@arcaai/types` `ConsultationStatus` is now seven values: `OPEN`, `RECORDING`, `PAUSED`, `STOPPED`, `APPROVED`, `CLOSED_COMPLETE`, `CLOSED_INCOMPLETE`. The twelve-value status (`PRIMED`, `DRAINING`, `DRAFT_PENDING_SENSORS`, `PENDING_REVIEW`, `SIGNED`, `TIMED_OUT`, `REOPENED`, `CLOSED`) is `LegacyConsultationStatus`; the SDKs keep their own twelve-value `ConsultationStatus` marked `@deprecated` for one release.
- Background work is a second field, `processing`: `IDLE`, `FINALIZING_TRANSCRIPT`, `SUMMARIZING`, `PROCESSING_ATTACHMENT`, `AWAITING_REVIEW`, `FAILED` (with `processingReason`). "Is the note ready" is not a status of its own: a written note is `status === 'STOPPED'` with `processing === 'IDLE'` and `processingReason === 'NOTE_READY'`; `AWAITING_REVIEW` means a written note a human must look at (coverage gaps, escalation). Use `isNoteReady(state)` (exported by `@arcaai/types` and both SDKs) rather than comparing fields.
- A closed consultation carries `closedReason` (`AUTO`, `MANUAL`, `APPROVED`) and `closedAt`; the response also carries `lastActivityAt`, `autoCloseAt`, `reopenCount`, `reopenAllowed`, `currentEncounterSeq`, `encounters` and `approval`.
- `LifecycleEvent` (`opened`, `encounter_appended`, `started`, `paused`, `stopped`, `transcript_final`, `processing_changed`, `approved`, `closed`, `reopened`) is the frame of `GET consultations/:id/events`, which always speaks the seven-value vocabulary.

- Inline citation labels in a generated note (`[S7 E1]`, `[A2]`) stay in HOPE's note; `stripCitationLabels(text)` and `citationLabelsOf(text)` (all three packages) give the EMR / export text and the chip labels.

**`@arcaai/vox-node`**

- `hope.consultations.open(request)` now resolves a `ConsultationHandle` (also exported); `hope.consultations.attach(id)` builds one for a consultation you did not open. The handle carries the open response's fields and tracks `status`, `processing` and `version` as commands and events arrive. Verbs: `start`, `pause`, `stop`, `generateSummary({ sectionKeys, outputLanguage, wait })`, `sendAttachment`, `sendFeedback` (+ `feedbackReasonCodes`), `approve`, `close`, `reopen`, `history` (+ `historyAll`), `recap`, `on('transcript' | 'status' | 'capture-state' | 'error')` and `dispose()`. `approve` / `close` / `reopen` send `If-Match` from the handle's own version unless `ifMatch` is passed.
- Callers that run their own STT session bind it with `handle.startCapture(sttSessionId)` (no SDK socket); `handle.refresh()` re-reads the consultation and updates `status`, `processing` and `version`; `hope.consultations.feedbackReasonCodes()` reads the tenant's reason codes with no consultation open.
- `start` opens the STT session, binds it and connects the socket; call it again after `pause` to resume. `stop` waits for the final transcript by default (`waitForFinal`). `sendAttachment` uploads direct to storage with retries and resolves once the gateway has processed it; it throws `AttachmentUploadError` / `AttachmentFailedError`.
- Every call the handle makes sends `X-Hope-Lifecycle: 2` (`LIFECYCLE_HEADER`, `withLifecycleHeader`). Without that header the gateway projects `status` onto the old twelve values for one release.
- `@deprecated` in favour of the handle: `consultations.recording.{start,stop}` (use `start` / `pause` / `stop`), `consultations.waitForFinalNote` (use `stop` plus `generateSummary({ wait: true })`, or the `status` events), and the `(id, request, { ifMatch })` signature of `consultations.close` (use `handle.close()`).

**`@arcaai/vox`**

- New `useConsultation()` (from `@arcaai/vox` and `@arcaai/vox/core`): one hook over `useArcaSession`, `useArcaAudio` and `useArcaSummary` returning `status`, `processing`, `isCapturing`, `segments` and the verbs `start`, `pause`, `stop`, `generateSummary({ sectionKeys })`, `sendAttachment`, `sendFeedback`, `approve`, `close`, `reopen`, `history`, `recap`. Every command carries `X-Hope-Lifecycle: 2`.
- `audio.start` / `audio.stop` and the per-summary approve are `@deprecated` in favour of `useConsultation`; the per-summary approve now approves the whole consultation.
- New `ConsultationLifecycleStatus` / `ConsultationProcessingState` types and `toLifecycleState`, which splits an older status into `{ status, processing }`. The twelve-value `ConsultationStatus` is `@deprecated` and is removed in the release after 5.0.
