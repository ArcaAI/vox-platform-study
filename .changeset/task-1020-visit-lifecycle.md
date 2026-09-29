---
'@arcaai/vox-node': minor
'@arcaai/vox': minor
---

TASK-1020 — consultation visit lifecycle: a single visit and a same-day return visit are two chained consultations, and the SDKs now say so.

**`@arcaai/vox-node`**

- `consultations.open` responses are typed and gain `status` (the 12-value `ConsultationStatus`, now exported), `visitType` (`'new-visit' | 'revisit'`), `externalRef` (`string | null`), `parentConsultationId` (`string | null`) and `recordable` (`boolean`). With an `externalRef` (the schema's marked encounter/event id) the same ref returns the same consultation and a new ref creates a new one; a `revisit` open with no parent gets a server-derived same-day parent; a signed or closed consultation is returned with `recordable: false` — do not call `recording.start` on it, open a return visit with a new `externalRef` instead.
- **Behaviour change (documented defect fix):** every HTTP 409 used to throw `QuotaExceededError`. A 409 is now a new exported `ConflictError` that carries the server's `code` (`CONSULTATION_NOT_RECORDABLE`, `CONSULTATION_TRANSITION_ILLEGAL`, `EXTERNAL_REF_CONFLICT`, `STT_SESSION_NOT_ACTIVE`), and `QuotaExceededError` extends `ConflictError` and is thrown only for `DOMAIN.QUOTA_EXCEEDED`. `instanceof QuotaExceededError` keeps working for real quota errors; code that used it as a catch-all for 409s should catch `ConflictError` (or match `status === 409` and `code`).
- New `consultations.waitForFinalNote(id, { since, timeoutMs = 180000, pollIntervalMs = 5000, signal })`: resolves with the latest summary only once it is newer than `since` and the consultation is note-ready, so a stale note from an earlier recording is never returned. Rejects with the new `FinalNoteUnavailableError` (closed `CLOSED_INCOMPLETE` with no fresh note) or `FinalNoteTimeoutError`.
- New `consultations.chain(id)` (`GET consultations/:id/chain`).
- Docs corrected: visit type and encounter id travel as schema-marked context fields (there is no separate request field), `recording.stop` moves the consultation to `DRAINING` rather than reverting it, and an STT `finalize` ends the session.

**`@arcaai/vox`**

- `ConsultationStatus` is now the real 12 Prisma values (`OPEN`, `PRIMED`, `RECORDING`, `DRAINING`, `DRAFT_PENDING_SENSORS`, `PENDING_REVIEW`, `SIGNED`, `TIMED_OUT`, `REOPENED`, `CLOSED_COMPLETE`, `CLOSED_INCOMPLETE`, `CLOSED`). The invented `TRANSCRIBING`, `SUMMARIZING`, `REVIEW` and `CANCELLED` and the lower-case `active`/`completed`/`cancelled` are removed from the union; `normalizeConsultationStatus` still accepts the three legacy strings (`LegacyConsultationStatus`) and maps them. `CONSULTATION_STATUS_ORDER` follows the real lifecycle.
- `OpenSessionInput` gains `parentConsultationId`, `context` and `metadata`. `Consultation` gains `parentConsultationId`, `visitType`, `externalRef` and `recordable`, and the `useArcaSession()` consultation now keeps `isNew`, `version`, `language`, `parentConsultationId`, `status`, `visitType`, `recordable` and `externalRef`.
- `isRevisit` reads `visitType`, then the top-level `parentConsultationId`, before the legacy `metadata` marker.
- `close()` / `reopen()` doc comments corrected: close ends at `CLOSED_COMPLETE` / `CLOSED_INCOMPLETE`, reopen at `REOPENED`.
