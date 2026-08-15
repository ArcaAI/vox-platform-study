# Consultation Harness — Normalized Invariant Register

**Extraction from:** `docs/architecture/consultation-session-workflow/dataset.xml` (Times 0–24) + `user-stories-and-use-cases.md` (18 stories, 18 use-cases)

**Date:** 2026-08-15

---

## 1. Invariant register

| INV-ID | Source | State | Actor | Modality | Statement | Category | Refs |
|---|---|---|---|---|---|---|---|
| INV-001 | XML T0 | Open | Master/Harness | MUST NOT | Timeout must never be treated as clinical approval at any stage in the session lifecycle. | timeout-approval | INV-181, UC-12, US-CL-14 |
| INV-002 | XML T0 | Open | Master/Harness | MUST NOT | After-visit information must never be generated from the empty Open state before consent and history load. | labeling-transparency | INV-180, US-PT-04 |
| INV-003 | XML T0 | Open | Master/Harness | MUST NOT | No Summarization, Transcription, or retrieval agents may run until consent and ABAC authorization succeed. | consent-abac | INV-004, T1 |
| INV-004 | XML T1 | Open | Compliance | MUST | Consent gate must validate patient consent (grant, view, revoke, time-limit) and clinician ABAC before any priming or capture begins. | consent-abac | INV-003, INV-019 |
| INV-005 | XML T1 | Open | Compliance | MUST | Consent or ABAC failure must result in an immutable audit event and session abort. | audit | INV-004 |
| INV-006 | XML T1 | Open | Master/Harness | MUST | Success of consent/ABAC must authorize priming only within the granted scope. | consent-abac | INV-007, INV-015 |
| INV-007 | XML T1 | Open | Master/Harness | MUST | MCP/tool calls that exceed the authorized scope must be denied and logged. | consent-abac | INV-006 |
| INV-008 | XML T1 | Open | Master/Harness | MUST | Every subsequent retrieval of chart data must be audited against the granted scope. | audit | INV-006, INV-009 |
| INV-009 | XML T1 | Open | Master/Harness | MUST NOT | Restricted chart data must remain omitted unless authorization and consent explicitly permit it. | consent-abac | INV-008 |
| INV-010 | XML T1 | Open | Master/Harness | MUST | Patient revocation from this point forward must block new tool calls for that patient. | consent-abac | INV-164, UC-18 |
| INV-011 | XML T2 | Primed | Summarization | MUST | Every imported fact must show source record and date, with a link to the original. | provenance | INV-012, US-CL-01 |
| INV-012 | XML T2 | Primed | Summarization | MUST | Imported history must be visually and structurally distinct from current-visit facts. | labeling-transparency | INV-011 |
| INV-013 | XML T2 | Primed | Summarization | MUST NOT | Historical diagnoses must never be silently treated as current diagnoses. | contradiction | INV-014, US-CL-01, UC-09 |
| INV-014 | XML T2 | Primed | Summarization | MUST | Contradictions and unresolved historical items must remain visible and listed. | contradiction | INV-013 |
| INV-015 | XML T2 | Primed | Summarization | MUST | Default retrieval scope must follow minimum-necessary policy and be audited. | consent-abac | INV-016, US-CL-02 |
| INV-016 | XML T2 | Primed | Summarization | MUST | Clinician-requested scope expansion must be an explicit new audited retrieval, not a silent PHI widening. | consent-abac | INV-015 |
| INV-017 | XML T2 | Primed | Master/Harness | MUST NOT | Patient facts must never enter the documentation style profile (DNA), even if style learning is enabled. | style-dna | INV-140, INV-155 |
| INV-018 | XML T3 | Primed | Clinician | MUST | Clinician must validate primed history before live documentation begins; source links and date range must be confirmed. | hitl-authority | INV-012 |
| INV-019 | XML T4 | Streaming | Master/Harness | MUST NOT | Pipeline failure must never silently drop capture; a documented fallback ASR must be used instead. | degradation | INV-020, US-CL-03, UC-15 |
| INV-020 | XML T4 | Streaming | Transcription | MUST | Tenant-configured audio pipeline (language, diarization, vocabulary) with documented fallback must be loaded at Record. | template-config | INV-019 |
| INV-021 | XML T4 | Streaming | Transcription | MUST | Every partial transcript segment must carry timestamps and speaker attribution. | labeling-transparency | INV-022, US-CL-04 |
| INV-022 | XML T4 | Streaming | Transcription | MUST | Uncertain or low-confidence text must be visibly marked without relying only on color. | labeling-transparency | INV-021, US-CL-04 |
| INV-023 | XML T4 | Streaming | Master/Harness | MUST NOT | Partial text cannot become a signed clinical fact without later reconciliation and clinician approval. | partial-vs-final | INV-027, INV-078 |
| INV-024 | XML T4 | Streaming | Master/Harness | MUST | Connectivity-aware checkpointing must begin so a telehealth drop can resume without re-transcribing captured audio. | checkpoint-resume | INV-120, UC-07, UC-13 |
| INV-025 | XML T5 | Streaming | Transcription | MUST | Finalized segments must be emitted as immutable evidence when a stable spoken span is available. | provenance | INV-026 |
| INV-026 | XML T5 | Streaming | Compliance | MUST | PHI sanitizer must run on finalized speech before NLP/Reasoning agents consume it. | consent-abac | INV-025 |
| INV-027 | XML T5 | Streaming | Master/Harness | MUST NOT | Master/Harness loop must not treat finalized segments as signed clinical facts. | partial-vs-final | INV-023 |
| INV-028 | XML T5 | Streaming | Transcription | MUST | Reconciled transcripts may supersede partial segments without deleting partial-segment provenance. | provenance | INV-021 |
| INV-029 | XML T5 | Streaming | Master/Harness | MUST NOT | User-authored text must not be automatically overwritten by system-generated content. | hitl-authority | INV-081, INV-152, T12.2 |
| INV-030 | XML T5 | Streaming | Master/Harness | MUST | Scribe-facing labels on finalized segments must remain draft, not verified or clinician-approved. | labeling-transparency | INV-199 |
| INV-031 | XML T6 | Streaming | Vision | MUST | Vision agent must check patient, study, and modality metadata against the matched encounter before processing. | multimodal | US-CL-05 |
| INV-032 | XML T6 | Streaming | Vision | MUST | System must search for an authenticated radiology report first and prefer it over image-only interpretation. | multimodal | INV-033, US-CL-05, UC-02 |
| INV-033 | XML T6 | Streaming | Vision | MUST NOT | Unsupported formats must never fail the session; unsupported attachments must degrade safely. | degradation | INV-032 |
| INV-034 | XML T6 | Streaming | Vision | MUST | Unsupported attachments must remain retained but attachment-derived descriptions may be omitted; HITL must be flagged. | degradation | INV-033 |
| INV-035 | XML T6 | Streaming | Master/Harness | MUST | Audit must record attachment metadata match result and whether a verified report was used. | audit | INV-036 |
| INV-036 | XML T6 | Streaming | Master/Harness | MUST NOT | Image-derived suggestions must be labeled and isolated from verified report findings. | multimodal | INV-035, INV-037 |
| INV-037 | XML T6 | Streaming | Clinician | MUST | Clinician review must be mandatory before any image-derived content is included in the final note. | multimodal | INV-036, US-CL-05 |
| INV-038 | XML T6 | Streaming | Master/Harness | MUST | Citations to the image reference must be required if findings later enter the work note or final record. | provenance | INV-036 |
| INV-039 | XML T6.1 | Streaming | NLP/Reasoning | MUST | Contradiction.detected event must be emitted when speech and imaging disagree. | contradiction | INV-069, US-CL-05 |
| INV-040 | XML T6.1 | Streaming | Master/Harness | MUST NOT | Master/Harness loop must not auto-resolve contradictions between image and speech. | contradiction | INV-039, UC-10 |
| INV-041 | XML T6.1 | Streaming | Verifier | MUST | Verifier/Quality must flag contradictions (image versus speech) for human disambiguation. | hitl-authority | INV-040 |
| INV-042 | XML T6.1 | Streaming | Master/Harness | MUST NOT | Silently preferring speech over image or image over speech is strictly forbidden. | contradiction | INV-040, UC-10 |
| INV-043 | XML T6.1 | Streaming | Master/Harness | MUST | If tenant policy treats image-versus-speech contradiction as safety-critical, finalization must be blocked until clinician verifies. | contradiction | INV-042 |
| INV-044 | XML T6.1 | Streaming | Master/Harness | MUST | Independent transcription and work-note tasks must continue even while a contradiction is being resolved. | debounce-synthesis | INV-043 |
| INV-045 | XML T7 | Streaming | Transcription | MUST | Transcription agent must continue the same tenant pipeline (or fallback) yielding partials and finalized segments. | template-config | INV-046 |
| INV-046 | XML T7 | Streaming | Master/Harness | MUST NOT | Master/Harness loop must not delete earlier provenance when appending or updating transcript parts. | provenance | INV-045 |
| INV-047 | XML T7 | Streaming | Master/Harness | MUST | Each transcript part must keep timestamps, speaker labels, and uncertainty marks. | labeling-transparency | INV-045 |
| INV-048 | XML T7 | Streaming | Master/Harness | MUST NOT | Pause/resume must not force re-transcription of prior transcript parts. | checkpoint-resume | INV-115, INV-119 |
| INV-049 | XML T8 | Streaming | Master/Harness | MUST | Master/Harness loop must wait for a debounce window (silence or clinical-episode boundary), not every token, before triggering NLP/Reasoning. | debounce-synthesis | INV-050 |
| INV-050 | XML T8 | Streaming | NLP/Reasoning | MUST | NLP/Reasoning agent must extract entities and update the work note with confidence scores and source-segment links only on debounce. | debounce-synthesis | INV-049 |
| INV-051 | XML T8 | Streaming | Master/Harness | MUST | Provisional suggestions must be separated from documented facts in the work note. | labeling-transparency | INV-052, US-CL-06 |
| INV-052 | XML T8 | Streaming | Master/Harness | MUST NOT | User-authored text must not be automatically overwritten by system-generated content. | hitl-authority | INV-051 |
| INV-053 | XML T8 | Streaming | Master/Harness | MUST NOT | Side-panel decision support, if enabled, must not write into the note draft without clinician approval. | hitl-authority | INV-051 |
| INV-054 | XML T8 | Streaming | Master/Harness | MUST | New work-note content must be traceable to transcript segments and image items. | provenance | INV-050 |
| INV-055 | XML T9 | Streaming | NLP/Reasoning | MUST | NLP/Reasoning agent must retrieve evidence only for identified questions or emerging problems. | debounce-synthesis | INV-056, US-CL-07 |
| INV-056 | XML T9 | Streaming | Master/Harness | MUST | Retrieved sources must be attached with date and version. | provenance | INV-055 |
| INV-057 | XML T9 | Streaming | Master/Harness | MUST | Patient facts and general evidence must be labeled separately in retrieved results. | labeling-transparency | INV-056 |
| INV-058 | XML T9 | Streaming | Master/Harness | MUST | Drug-interaction tools must run only when a medication is identified and retrieval is permitted by consent/ABAC. | consent-abac | INV-055 |
| INV-059 | XML T9 | Streaming | Master/Harness | MUST NOT | Unsupported statements must be removed or flagged; they cannot ride into the final note unlabeled. | labeling-transparency | INV-060, US-CL-07 |
| INV-060 | XML T9 | Streaming | NLP/Reasoning | MUST | Low-quality or conflicting retrieval must trigger abstention or clarification, not a blended or guessed citation. | debounce-synthesis | INV-059 |
| INV-061 | XML T10 | Streaming | NLP/Reasoning | MUST | NLP/Reasoning agent must call terminology MCP search/get_concept tools only for concept binding. | terminology | INV-062, US-CL-09, UC-03 |
| INV-062 | XML T10 | Streaming | NLP/Reasoning | MUST | Only tool-verified concepts must be bound into the work note with confidence scores. | terminology | INV-061, INV-065 |
| INV-063 | XML T10 | Streaming | NLP/Reasoning | MUST | Unmapped terms must be flagged for human review. | terminology | INV-062, US-CL-09 |
| INV-064 | XML T10 | Streaming | Master/Harness | MUST | Every concept bind must be audited. | audit | INV-062 |
| INV-065 | XML T10 | Streaming | Master/Harness | MUST NOT | No code must be emitted without a tool-verified match. | terminology | INV-061, INV-062 |
| INV-066 | XML T10 | Streaming | Master/Harness | MUST NOT | Hallucinated codes are strictly forbidden. | terminology | INV-065, UC-16 |
| INV-067 | XML T10 | Streaming | Master/Harness | MUST | Consent/ABAC must still gate tool calls; a scope mismatch must result in a logged denial, not best-effort execution. | consent-abac | INV-007, US-CO-03 |
| INV-068 | XML T10.1 | Degraded | Master/Harness | MUST | Master/Harness loop must record agent.timeout when a worker exceeds deadline. | degradation | INV-069, INV-070 |
| INV-069 | XML T10.1 | Degraded | Master/Harness | MUST | Master/Harness loop must cancel a timed-out attempt and retry only if the operation is idempotent and within budget. | degradation | INV-068 |
| INV-070 | XML T10.1 | Degraded | Master/Harness | MUST | If terminology verification remains unavailable after retry, harness must display 'terminology verification unavailable' and let independent tasks continue. | degradation | INV-069, UC-11 |
| INV-071 | XML T10.1 | Degraded | Master/Harness | MUST NOT | No guessed terminology must be inserted into the work note or final record. | terminology | INV-065, INV-070 |
| INV-072 | XML T10.1 | Degraded | Master/Harness | MUST | Session must enter Degraded, not Failed, if a safe draft remains possible. | degradation | INV-073, UC-11 |
| INV-073 | XML T10.1 | Degraded | Master/Harness | MUST NOT | The workflow must never be silently dropped due to agent timeout. | degradation | INV-072 |
| INV-074 | XML T10.1 | Degraded | Master/Harness | MUST | Force-stop must apply only to the timed-out agent. | drain-shutdown | INV-075 |
| INV-075 | XML T10.1 | Degraded | Master/Harness | MUST NOT | Transcription and other agents must continue running unless a global drain is in progress. | drain-shutdown | INV-074, UC-11 |
| INV-076 | XML T11 | Streaming | Note-taking | MUST | Note-taking agent must fill the tenant-admin template (SOAP or encounter type) from current context. | template-config | INV-077, US-CL-15 |
| INV-077 | XML T11 | Streaming | Master/Harness | MUST | If clinician opted into writing DNA, inspectable style preferences (phrasing, structure, verbosity) must be applied. | style-dna | INV-017, INV-076 |
| INV-078 | XML T11 | Streaming | Master/Harness | MUST NOT | Style preferences cannot override clinical or tenant safety rules. | template-config | INV-077 |
| INV-079 | XML T11 | Streaming | Note-taking | MUST | Missing required sections must be reported, not invented by the system. | template-config | INV-076, US-CL-15 |
| INV-080 | XML T11 | Streaming | Master/Harness | MUST NOT | Patient facts must never enter the style profile, even if style learning is enabled. | style-dna | INV-017, INV-077 |
| INV-081 | XML T11 | Streaming | Master/Harness | MUST NOT | Long-term DNA memory must not be updated from the live unsigned draft. | style-dna | INV-140, INV-155 |
| INV-082 | XML T11 | Streaming | Note-taking | MUST | Switching templates must reformat existing evidence rather than regenerate from scratch. | template-config | INV-076, US-SC-02 |
| INV-083 | XML T12 | Streaming | Master/Harness | MUST | Master/Harness loop must periodically retrigger NLP/Reasoning and Note-taking agents only on debounced context changes. | debounce-synthesis | INV-049, INV-084 |
| INV-084 | XML T12 | Streaming | Master/Harness | MUST | Every context mutation must be audited with source and confidence. | audit | INV-083 |
| INV-085 | XML T12 | Streaming | Master/Harness | MUST NOT | Mid-session clinician edits (hitl.edit events) must never be silently restored to prior AI wording. | hitl-authority | INV-029, INV-152, UC-08 |
| INV-086 | XML T12 | Streaming | Master/Harness | MUST NOT | After-visit information must not be published from the unsigned live draft. | labeling-transparency | INV-002, US-PT-04 |
| INV-087 | XML T12.1 | Streaming | NLP/Reasoning | MUST | Provisional/uncertain text (partial transcript) must be marked as provisional in the work note. | labeling-transparency | INV-088, US-CL-04 |
| INV-088 | XML T12.1 | Streaming | NLP/Reasoning | MUST NOT | Uncertain text must not have terminology codes bound or interaction retrieval run on uncertain spans. | terminology | INV-087 |
| INV-089 | XML T12.1 | Streaming | Master/Harness | MUST NOT | Hallucinated RxNorm/SNOMED codes must never be attached to uncertain medication tokens. | terminology | INV-088, UC-16 |
| INV-090 | XML T12.2 | Streaming | Master/Harness | MUST | Master/Harness loop must record a clinician correction as an authoritative hitl.edit event. | hitl-authority | INV-091, INV-092 |
| INV-091 | XML T12.2 | Streaming | Master/Harness | MUST | Dependent medication and interaction artifacts must be invalidated when a medication name or dosage is corrected. | commit-idempotency | INV-090 |
| INV-092 | XML T12.2 | Streaming | Master/Harness | MUST NOT | System must not silently restore the old AI wording after a clinician correction. | hitl-authority | INV-085, INV-090, UC-08 |
| INV-093 | XML T12.2 | Streaming | Master/Harness | MUST | Edit history must remain available for audit and QA review. | audit | INV-090 |
| INV-094 | XML T12.2 | Streaming | Master/Harness | MUST | The clinician correction must become authoritative for all subsequent drafting. | hitl-authority | INV-090, INV-091 |
| INV-095 | XML T12.2 | Streaming | Master/Harness | MUST NOT | DNA reflection must not write long-term style memory from unapproved drafts. | style-dna | INV-081 |
| INV-096 | XML T12.2 | Streaming | Master/Harness | MUST NOT | Patient-specific drugs must never be stored as style features even if style learning is enabled. | style-dna | INV-080, INV-095 |
| INV-097 | XML T12.3 | Streaming | NLP/Reasoning | MUST | If retrieval is still permitted by consent/ABAC, medication and interaction tools must be re-run on the corrected name and dose. | consent-abac | INV-091 |
| INV-098 | XML T12.3 | Streaming | Note-taking | MUST | Only affected note sections must be regenerated; unrelated attachments and sections must be left unchanged. | commit-idempotency | INV-091 |
| INV-099 | XML T12.3 | Streaming | Verifier | MUST | Verifier/Quality must re-run incrementally only on affected sections. | commit-idempotency | INV-097 |
| INV-100 | XML T12.3 | Streaming | Master/Harness | MUST NOT | Old AI wording must remain in edit history and never be silently restored. | hitl-authority | INV-092, INV-093 |
| INV-101 | XML T12.3 | Streaming | Master/Harness | MUST | Interaction retrieval must still require consent/ABAC and must abstain rather than guess if evidence is poor. | consent-abac | INV-097 |
| INV-102 | XML T12.4 | Streaming | NLP/Reasoning | MUST | NLP/Reasoning agent must create a contradiction item linking the historical source (record id and date) to the current transcript span. | contradiction | INV-103, US-CL-01, UC-09 |
| INV-103 | XML T12.4 | Streaming | Master/Harness | MUST NOT | No agent must auto-pick a winner between historical and current contradictions. | contradiction | INV-102 |
| INV-104 | XML T12.4 | Streaming | Clinician | MUST | Clinician must verify contradictions; the resolution must become authoritative. | hitl-authority | INV-102, UC-09 |
| INV-105 | XML T12.4 | Streaming | Master/Harness | MUST NOT | Historical diagnoses or allergies must never be silently treated as current. | contradiction | INV-013, INV-104 |
| INV-106 | XML T12.4 | Streaming | Master/Harness | MUST NOT | Current speech must never be silently overwritten by historical data. | contradiction | INV-105 |
| INV-107 | XML T12.4 | Streaming | Master/Harness | MUST | If tenant policy considers historical-versus-current contradiction safety-critical, finalization must be blocked until HITL resolution. | contradiction | INV-104 |
| INV-108 | XML T12.4 | Streaming | Master/Harness | MUST | Other non-dependent tasks must continue even while a contradiction is being resolved. | debounce-synthesis | INV-104 |
| INV-109 | XML T13 | Paused | Master/Harness | MUST | Harness must durably checkpoint consultation context when session pauses. | checkpoint-resume | INV-110, INV-120 |
| INV-110 | XML T13 | Paused | Transcription | MUST | Transcription agent must stop accepting new audio when session pauses. | drain-shutdown | INV-109 |
| INV-111 | XML T13 | Paused | Master/Harness | MUST NOT | No re-extraction or re-retrieval must be launched during pause. | checkpoint-resume | INV-109 |
| INV-112 | XML T13 | Paused | Master/Harness | MUST | If pause exceeds tenant hard cap, session must auto-draft available content and move to Awaiting Review rather than discard. | timeout-approval | INV-113, INV-120 |
| INV-113 | XML T13 | Paused | Master/Harness | MUST NOT | Pause timeout must not be treated as clinical approval. | timeout-approval | INV-112 |
| INV-114 | XML T13 | Paused | Master/Harness | MUST NOT | Pause must not re-transcribe prior speech. | checkpoint-resume | INV-048 |
| INV-115 | XML T14 | Streaming | Master/Harness | MUST | Harness must restore checkpoint bit-for-bit on resume within retention window. | checkpoint-resume | INV-116, INV-120 |
| INV-116 | XML T14 | Streaming | Transcription | MUST | Transcription agent must accept only new audio after resume; prior segments, work note, and image items must not be recomputed. | checkpoint-resume | INV-115 |
| INV-117 | XML T14 | Streaming | Master/Harness | MUST NOT | No re-transcription of prior speech must occur on resume. | checkpoint-resume | INV-048, INV-116 |
| INV-118 | XML T14 | Streaming | Master/Harness | MUST NOT | No re-extraction or re-retrieval of already-fetched evidence must occur on resume. | checkpoint-resume | INV-111, INV-116 |
| INV-119 | XML T14 | Streaming | Master/Harness | MUST | New speech must continue the Part n loop from Time 7 (ongoing transcription loop). | checkpoint-resume | INV-048 |
| INV-120 | XML T13-14 | Paused/Streaming | Master/Harness | MUST | Connectivity-aware checkpointing must persist transcript, draft deltas, evidence ledger, and open tasks. | checkpoint-resume | INV-109, INV-115, UC-13 |
| INV-121 | XML T15 | Draining | Transcription | MUST | Transcription agent must fire a finished signal when clinician stops live transcription. | drain-shutdown | INV-122 |
| INV-122 | XML T15 | Draining | Master/Harness | MUST | Master/Harness loop must enter two-phase shutdown: drain agents, then await approval. | drain-shutdown | INV-121, INV-123 |
| INV-123 | XML T15 | Draining | Transcription | MUST | Last partial must be finalized if possible; no new segments must be accepted after stop signal. | drain-shutdown | INV-122 |
| INV-124 | XML T15 | Draining | Master/Harness | MUST NOT | Stopping capture must not constitute clinical approval. | timeout-approval | INV-001, INV-125 |
| INV-125 | XML T15 | Draining | Master/Harness | MUST | Force-stop of still-running agents must occur only on drain timeout, not preemptively. | drain-shutdown | INV-124 |
| INV-126 | XML T15 | Draining | Master/Harness | MUST NOT | Incomplete sections must be marked incomplete, not guessed or filled with placeholder text. | degradation | INV-125 |
| INV-127 | XML T16 | Draining | Master/Harness | MUST | Master/Harness loop must await NLP/Reasoning, Note-taking, Vision, and Verifier/Quality agents during drain. | drain-shutdown | INV-128 |
| INV-128 | XML T16 | Draining | Master/Harness | MUST | On per-agent timeout, harness must force-stop that agent, flag section incomplete, and continue the drain. | degradation | INV-127 |
| INV-129 | XML T16 | Draining | Master/Harness | MUST | During final drain pass, Note-taking must be retriggered only for remaining debounced context, not for new audio. | debounce-synthesis | INV-127 |
| INV-130 | XML T16 | Draining | Master/Harness | MUST NOT | Drain timeout must not be treated as clinical approval. | timeout-approval | INV-001, INV-125 |
| INV-131 | XML T16 | Draining | Master/Harness | MUST | A safe but incomplete draft must stay unsigned after drain completes. | labeling-transparency | INV-130 |
| INV-132 | XML T16 | Draining | Master/Harness | MUST | Degraded sections must remain labeled during final drain pass. | labeling-transparency | INV-128 |
| INV-133 | XML T16 | Draining | Master/Harness | MUST NOT | User-authored text must still be protected from automatic overwrite during final drain pass. | hitl-authority | INV-029, INV-132 |
| INV-134 | XML T17 | Drafting | Transcription | MUST | Transcription agent and NLP/Reasoning agent must reconcile partials into a final transcript. | partial-vs-final | INV-135, INV-137 |
| INV-135 | XML T17 | Drafting | Transcription | MUST | Final text may supersede partial segments; provenance of superseded partials must be retained. | provenance | INV-134, INV-028 |
| INV-136 | XML T17 | Drafting | Compliance | MUST | PHI sanitizer must be applied to the reconciled transcript before the last Note-taking pass. | consent-abac | INV-134 |
| INV-137 | XML T17 | Drafting | Master/Harness | MUST NOT | Partials cannot become signed facts merely because they existed. | partial-vs-final | INV-023, INV-134 |
| INV-138 | XML T17 | Drafting | Master/Harness | MUST | Identity matching must be re-checked against the encounter before candidate note is offered for review. | consent-abac | INV-134 |
| INV-139 | XML T18 | Drafting | Verifier | MUST | Medication, allergy, laterality, dosage, negation, and patient-identity checks must run before approval is offered. | hitl-authority | INV-140, US-CL-12 |
| INV-140 | XML T18 | Drafting | Master/Harness | MUST | Missing required template sections must be reported before review-ready state. | template-config | INV-139, INV-079 |
| INV-141 | XML T18 | Drafting | Master/Harness | MUST NOT | These verification checks must not sign the note. | labeling-transparency | INV-139 |
| INV-142 | XML T18 | Drafting | Master/Harness | MUST NOT | Image-derived suggestions that clinician has not reviewed must stay excluded from candidate final note. | multimodal | INV-037, INV-142 |
| INV-143 | XML T18 | Drafting | Master/Harness | MUST NOT | Unsupported statements remaining after retrieval abstention must stay flagged or be removed. | degradation | INV-059 |
| INV-144 | XML T19 | Awaiting Review | Clinician | MUST | Clinician must receive a review-ready candidate Final Summary with in-line citations, confidence per clause, and diffs. | hitl-authority | INV-145, US-CL-12, UC-05 |
| INV-145 | XML T19 | Awaiting Review | Master/Harness | MUST NOT | No EHR write and no style-memory update must occur during Awaiting Review state. | hitl-authority | INV-144 |
| INV-146 | XML T19 | Awaiting Review | Clinician | MUST | Clinician can approve, edit, reject, or return each section for regeneration. | hitl-authority | INV-147, US-CL-13 |
| INV-147 | XML T19 | Awaiting Review | Master/Harness | MUST NOT | Timeout in Awaiting Review state must never substitute for clinical approval. | timeout-approval | INV-001, INV-148 |
| INV-148 | XML T19 | Awaiting Review | Master/Harness | MUST | If policy allows an unsigned draft on timeout, it must remain visibly unsigned. | labeling-transparency | INV-147, INV-182, UC-12 |
| INV-149 | XML T19 | Awaiting Review | Master/Harness | MUST NOT | After-visit patient information must not be emitted from the candidate unsigned note. | labeling-transparency | INV-002, INV-086, US-PT-04 |
| INV-150 | XML T20 | Awaiting Review | Master/Harness | MUST | Harness must record per-section approve, edit, reject, or return-for-regen as separate audit events. | audit | INV-151, US-CL-13, UC-05 |
| INV-151 | XML T20 | Awaiting Review | Master/Harness | MUST | Rejected or returned sections must retrigger Note-taking and incremental Verifier/Quality only for those sections. | commit-idempotency | INV-150 |
| INV-152 | XML T20 | Awaiting Review | Master/Harness | MUST NOT | Old AI wording must never be silently restored when a section is rejected or edited. | hitl-authority | INV-085, INV-150 |
| INV-153 | XML T20 | Awaiting Review | Master/Harness | MUST | Dependent contradictions must be re-scanned after clinician edits. | contradiction | INV-151 |
| INV-154 | XML T20 | Awaiting Review | Master/Harness | MUST | Section-level decisions must remain in audit trail for QA to see which sections were AI-accepted versus rewritten. | audit | INV-150 |
| INV-155 | XML T20 | Awaiting Review | Master/Harness | MUST NOT | All required sections must be approved before commit. | commit-idempotency | INV-156, US-CL-13, UC-05 |
| INV-156 | XML T20 | Awaiting Review | Master/Harness | MUST | Patient-facing after-visit text, if generated later, may use only clinician-approved content. | labeling-transparency | INV-155, US-PT-04, UC-05 |
| INV-157 | XML T21 | Closed Approved | Master/Harness | MUST | Compliance and Master/Harness loop must perform a transactional, idempotent commit of Final Summary plus provenance. | commit-idempotency | INV-158, INV-159, US-CL-14 |
| INV-158 | XML T21 | Closed Approved | Master/Harness | MUST | Duplicate retry of the same approval must not create a second signed note. | commit-idempotency | INV-157 |
| INV-159 | XML T21 | Closed Approved | Master/Harness | MUST NOT | The system must never sign on behalf of the clinician. | hitl-authority | INV-157, INV-001, US-CL-14 |
| INV-160 | XML T21 | Closed Approved | Master/Harness | MUST | Provenance commit must record human author, AI assistance, model version, input sources, and approval event. | provenance | INV-157, US-CO-01 |
| INV-161 | XML T21 | Closed Approved | Master/Harness | MUST NOT | Timeout must never substitute for explicit clinical approval at this final stage. | timeout-approval | INV-001, INV-159 |
| INV-162 | XML T21 | Closed Approved | Master/Harness | MUST NOT | Unsigned drafts from other paths must not be upgraded to Closed Approved by a clock. | timeout-approval | INV-001, INV-161 |
| INV-163 | XML T21 | Closed Approved | Master/Harness | MUST | QA can later open the provenance graph: transcript spans, retrieved snippets, tool calls, evaluator scores, and HITL edit history. | audit | INV-160, UC-17 |
| INV-164 | XML T22 | Closed Approved | Note-taking | MUST | Note-taking personalization must update writing-DNA profile only from clinician-approved phrasing deltas. | style-dna | INV-165, US-CL-11, UC-04 |
| INV-165 | XML T22 | Closed Approved | Note-taking | MUST NOT | Patient facts, medications, and identifiers must be excluded from style profile updates. | style-dna | INV-164, INV-017 |
| INV-166 | XML T22 | Closed Approved | Note-taking | MUST | Preferences cannot override safety or tenant template rules. | template-config | INV-164 |
| INV-167 | XML T22 | Closed Approved | Master/Harness | MUST | Style learning must be opt-in and reversible by clinician. | style-dna | INV-164, US-CL-11 |
| INV-168 | XML T22 | Closed Approved | Master/Harness | MUST NOT | Unapproved drafts must not update long-term style memory. | style-dna | INV-081, INV-164 |
| INV-169 | XML T22 | Closed Approved | Master/Harness | MUST NOT | DNA exemplar banks must not retain this patient's clinical contributions as exemplars. | style-dna | INV-165, UC-04 |
| INV-170 | XML T22 | Closed Approved | Master/Harness | MUST | A later consent revocation must scrub that patient's contributions from the exemplar bank per policy. | retention-erasure | INV-169, UC-18 |
| INV-171 | XML T23 | Closed | Master/Harness | MUST | Harness must archive the session and expire short-term context items per tenant TTL. | retention-erasure | INV-172, INV-173 |
| INV-172 | XML T23 | Closed | Master/Harness | MUST | Immutable audit snapshot must be retained after session archival. | audit | INV-171 |
| INV-173 | XML T23 | Closed | Master/Harness | MUST | Harness must allow after-visit patient information only from clinician-approved content. | labeling-transparency | INV-086, INV-149, US-PT-04 |
| INV-174 | XML T23 | Closed | Master/Harness | MUST NOT | Closed here (T23) must only occur if Closed Approved (T21) has already occurred. | partial-vs-final | INV-171 |
| INV-175 | XML T23 | Closed | Master/Harness | MUST NOT | This state must not be a timeout close; clinician approval must have occurred. | timeout-approval | INV-001, INV-174 |
| INV-176 | XML T23 | Closed | Master/Harness | MUST | Patient continuity for next visit must use the attested note and labeled imported history, not raw live partials. | partial-vs-final | INV-174, UC-01 |
| INV-177 | XML T24 | Timed Out | Master/Harness | MUST | Master/Harness loop must retain an unsigned draft per retention policy on approval timeout. | retention-erasure | INV-178, INV-182, UC-12 |
| INV-178 | XML T24 | Timed Out | Master/Harness | MUST | Harness must issue notification without inventing a signature. | audit | INV-177, INV-179 |
| INV-179 | XML T24 | Timed Out | Master/Harness | MUST NOT | Signed EHR note must not be written on timeout. | hitl-authority | INV-177, INV-178 |
| INV-180 | XML T24 | Timed Out | Master/Harness | MUST NOT | Long-term writing-DNA memory must not be updated from timeout drafts. | style-dna | INV-081, INV-168 |
| INV-181 | XML T24 | Timed Out | Master/Harness | MUST NOT | Timeout must never substitute for clinical approval. | timeout-approval | INV-001, INV-177 |
| INV-182 | XML T24 | Timed Out | Master/Harness | MUST | The unsigned draft must stay visibly unsigned. | labeling-transparency | INV-148, INV-177, INV-183 |
| INV-183 | XML T24 | Timed Out | Master/Harness | MUST | State must be Timed Out or Awaiting Review, never Closed Approved. | partial-vs-final | INV-182, UC-12 |
| INV-184 | XML T24 | Timed Out | Master/Harness | MUST NOT | After-visit patient information must not be generated from the unapproved timeout draft. | labeling-transparency | INV-002, INV-086, INV-149, US-PT-04 |
| INV-185 | XML T24 | Timed Out | Master/Harness | MUST | Later explicit clinician approval may still commit idempotently from this unsigned snapshot. | commit-idempotency | INV-177 |
| INV-186 | XML T24 | Timed Out | Master/Harness | MUST NOT | The clock itself must never sign; only explicit clinician approval can commit. | hitl-authority | INV-001, INV-181, INV-185 |
| INV-187 | US-CL-01 | Primed | Clinician | MUST | Every imported fact must show source record, date, and a link to the original. | provenance | INV-011 |
| INV-188 | US-CL-01 | Primed | Master/Harness | MUST | Imported history must be visually and structurally distinct from current-visit facts. | labeling-transparency | INV-012 |
| INV-189 | US-CL-01 | Primed | Summarization | MUST NOT | Contradictions and unresolved items from prior encounters must not be auto-resolved; they must be listed. | contradiction | INV-014 |
| INV-190 | US-CL-01 | Primed | Clinician | MUST | No historical diagnosis must be treated as a current diagnosis without explicit clinician confirmation. | contradiction | INV-013 |
| INV-191 | US-CL-01 | Primed | Compliance | MUST | Patient and encounter identity must pass matching rules before any history is shown. | consent-abac | INV-138 |
| INV-192 | US-CL-01 | Primed | Summarization | MUST | Default retrieval must follow minimum-necessary policy and be audited. | consent-abac | INV-015 |
| INV-193 | US-CL-02 | Primed | Summarization | MUST | Default retrieval must be minimum-necessary for this encounter type and specialty. | consent-abac | INV-015, INV-016 |
| INV-194 | US-CL-02 | Primed | Master/Harness | MUST | UI must display date range, source systems, and whether restricted classes were included in retrieval. | labeling-transparency | INV-012 |
| INV-195 | US-CL-02 | Primed | Master/Harness | MUST NOT | Restricted data must remain omitted unless authorization and consent explicitly permit it. | consent-abac | INV-009 |
| INV-196 | US-CL-02 | Primed | Master/Harness | MUST | Every retrieval, including clinician-widened scope, must be audited. | audit | INV-008 |
| INV-197 | US-CL-02 | Primed | Clinician | MUST | Widening retrieval scope must be an explicit clinician action, not an agent decision. | consent-abac | INV-016 |
| INV-198 | US-PT-03 | Primed | Master/Harness | MUST | Authorized prior history must be available to the clinician at session open. | consent-abac | INV-011 |
| INV-199 | US-PT-03 | Primed | Master/Harness | MUST | Identity matching and minimum-necessary policy must still apply to prior-visit continuity. | consent-abac | INV-191 |
| INV-200 | US-PT-03 | Primed | Master/Harness | MUST NOT | Patient must not be required to re-state known, in-scope history for the system to retrieve it. | consent-abac | INV-198 |
| INV-201 | US-CL-03 | Streaming | Master/Harness | MUST NOT | Record must not start until consent for AI-drafting and ABAC scope succeed; failure aborts and audits. | consent-abac | INV-004 |
| INV-202 | US-CL-03 | Streaming | Transcription | MUST | Mute/unmute must be obvious and must immediately stop sending audio. | template-config | INV-020 |
| INV-203 | US-CL-03 | Streaming | Master/Harness | MUST | A visible indicator must show when audio is being processed. | labeling-transparency | INV-022 |
| INV-204 | US-CL-03 | Streaming | Master/Harness | MUST | Tenant ASR vendor, language, diarization, and vocabulary must be configurable, with a documented fallback. | template-config | INV-020 |
| INV-205 | US-CL-03 | Streaming | Transcription | MUST NOT | Silent drop of capture must be forbidden; pipeline failure must be visible and logged. | degradation | INV-019 |
| INV-206 | US-CL-04 | Streaming | Transcription | MUST | Every segment must have timestamps and speaker attribution. | labeling-transparency | INV-021 |
| INV-207 | US-CL-04 | Streaming | Transcription | MUST | Uncertain / low-confidence text must be visibly marked without relying only on color. | labeling-transparency | INV-022 |
| INV-208 | US-CL-04 | Streaming | Master/Harness | MUST NOT | Partial text cannot become a signed or verified fact without reconciliation. | partial-vs-final | INV-023 |
| INV-209 | US-CL-04 | Streaming | Transcription | MUST | Final transcription may supersede partials; superseded spans must remain in the event ledger. | provenance | INV-028 |
| INV-210 | US-CL-04 | Streaming | NLP/Reasoning | MUST | Downstream reasoning must consume finalized segments, not churning partials. | partial-vs-final | INV-027 |
| INV-211 | US-CL-05 | Streaming | Vision | MUST | System must check patient, study, and modality metadata before using the attachment. | multimodal | INV-031 |
| INV-212 | US-CL-05 | Streaming | Vision | MUST | Authenticated radiology report must be searched and preferred over image-only interpretation. | multimodal | INV-032 |
| INV-213 | US-CL-05 | Streaming | Master/Harness | MUST | Image-derived suggestions must be labeled and isolated from verified findings. | multimodal | INV-036 |
| INV-214 | US-CL-05 | Streaming | Vision | MUST NOT | Unsupported, corrupt, or mismatched files must not block the rest of the session; must degrade safely. | degradation | INV-033, INV-034 |
| INV-215 | US-CL-05 | Streaming | Clinician | MUST | Clinician review must be mandatory before any image-derived content is included in the final note. | hitl-authority | INV-037 |
| INV-216 | US-CL-06 | Streaming | Master/Harness | MUST | Work-note updates must be debounced rather than generated for every token. | debounce-synthesis | INV-049 |
| INV-217 | US-CL-06 | Streaming | Master/Harness | MUST | New work-note content must be traceable to source segments or resources. | provenance | INV-054 |
| INV-218 | US-CL-06 | Streaming | Master/Harness | MUST | Provisional suggestions must be clearly separated from documented facts. | labeling-transparency | INV-051 |
| INV-219 | US-CL-06 | Streaming | Master/Harness | MUST NOT | User-authored text must not be protected from automatic overwrite; patches must require visible diff. | hitl-authority | INV-052 |
| INV-220 | US-CL-06 | Streaming | Master/Harness | MUST | Work note and candidate final note must be distinct artifacts. | partial-vs-final | INV-023 |
| INV-221 | US-CL-07 | Streaming | Master/Harness | MUST | Sources must be displayed with title, date, version, and publisher or system of record. | provenance | INV-056 |
| INV-222 | US-CL-07 | Streaming | Master/Harness | MUST | Patient facts and general evidence must be labeled as separate classes. | labeling-transparency | INV-057 |
| INV-223 | US-CL-07 | Streaming | Master/Harness | MUST NOT | Unsupported statements must be removed or flagged; they cannot ride into the final note unlabeled. | degradation | INV-059 |
| INV-224 | US-CL-07 | Streaming | NLP/Reasoning | MUST | Conflicting or low-quality retrieval must trigger abstention or clarification, not a blended answer. | debounce-synthesis | INV-060 |
| INV-225 | US-CL-07 | Streaming | Clinician | MUST | Clinician must be able to open the cited source independently of the generated wording. | provenance | INV-056 |
| INV-226 | US-CL-08 | Streaming | Master/Harness | MUST | CDS must appear in a panel independent of the work-note composer. | hitl-authority | INV-053 |
| INV-227 | US-CL-08 | Streaming | Master/Harness | MUST | Guideline, interaction, and differential items must be cited and labeled advisory. | provenance | INV-056 |
| INV-228 | US-CL-08 | Streaming | Master/Harness | MUST NOT | Low-confidence medication mentions must never trigger auto-generated order suggestions. | hitl-authority | INV-053 |
| INV-229 | US-CL-08 | Streaming | Master/Harness | MUST | Safety alerts may interrupt; routine CDS must not rewrite the note. | hitl-authority | INV-053 |
| INV-230 | US-CL-08 | Streaming | Clinician | MUST | Clinician must be able to dismiss an item; dismissal must be logged and not silently reappear in the same session. | audit | INV-084 |
| INV-231 | US-CL-09 | Streaming | Master/Harness | MUST NOT | No clinical code may be free-generated by the model into the note or a write payload. | terminology | INV-065 |
| INV-232 | US-CL-09 | Streaming | NLP/Reasoning | MUST | Lookups must go through the clinical tool gateway with patient/tenant scope and audit. | consent-abac | INV-067 |
| INV-233 | US-CL-09 | Streaming | Master/Harness | MUST | Unmatched terms must be flagged unmapped for human review; no guessed code must be inserted. | terminology | INV-063 |
| INV-234 | US-CL-09 | Streaming | Master/Harness | MUST | Bound codes must carry code system, code, display, and lookup timestamp. | audit | INV-064 |
| INV-235 | US-CL-10 | Streaming | Clinician | MUST | The correction must become authoritative for all downstream drafting. | hitl-authority | INV-094 |
| INV-236 | US-CL-10 | Streaming | Master/Harness | MUST | Dependent sections and safety checks must be re-evaluated; unrelated artifacts must not be blindly regenerated. | commit-idempotency | INV-098 |
| INV-237 | US-CL-10 | Streaming | Master/Harness | MUST NOT | System must never silently restore the old wording after a correction. | hitl-authority | INV-092 |
| INV-238 | US-CL-10 | Streaming | Master/Harness | MUST | Edit history must remain available for audit and QA. | audit | INV-093 |
| INV-239 | US-CL-10 | Streaming | Master/Harness | MUST | High-risk corrections (medication, allergy, dosage, identity, laterality) must be highlighted in the next review diff. | hitl-authority | INV-094 |
| INV-240 | US-CL-11 | Awaiting Review | Clinician | MUST | Personalization must be opt-in, reversible, exportable, and deletable by the clinician. | style-dna | INV-167 |
| INV-241 | US-CL-11 | Awaiting Review | Master/Harness | MUST NOT | Patient facts must never enter the style profile; exemplars must be scrubbed on erasure requests. | style-dna | INV-165 |
| INV-242 | US-CL-11 | Awaiting Review | Note-taking | MUST | Suggested preference changes must be inspectable and human-approved before they influence generation. | style-dna | INV-077 |
| INV-243 | US-CL-11 | Awaiting Review | Master/Harness | MUST NOT | Preferences cannot override clinical, tenant, or safety rules. | template-config | INV-078 |
| INV-244 | US-CL-11 | Awaiting Review | Master/Harness | MUST | Learning must use clinician-approved notes only — never unsigned drafts or timed-out sessions. | style-dna | INV-081, INV-168 |
| INV-245 | US-CL-12 | Drafting | Master/Harness | MUST | Additions and changes since the previous review must be highlighted. | labeling-transparency | INV-144 |
| INV-246 | US-CL-12 | Drafting | Verifier | MUST | Medication, allergy, laterality, dosage, negation, and patient-identity checks must run before approval is offered. | hitl-authority | INV-139 |
| INV-247 | US-CL-12 | Drafting | Master/Harness | MUST | Missing required template sections must be reported before review-ready state. | template-config | INV-140 |
| INV-248 | US-CL-12 | Drafting | Master/Harness | MUST NOT | Unresolved questions and contradictions must not be auto-closed; they must remain visible. | contradiction | INV-107 |
| INV-249 | US-CL-12 | Drafting | Master/Harness | MUST | Confidence must be a calibrated system measure, retrieval quality, or labeled model self-assessment — not a clinical probability. | labeling-transparency | INV-144 |
| INV-250 | US-CL-13 | Awaiting Review | Clinician | MUST | Approve, edit, and reject must be available per required section, not only document-level. | hitl-authority | INV-146 |
| INV-251 | US-CL-13 | Awaiting Review | Master/Harness | MUST | Each section decision must be a separate audit event. | audit | INV-150 |
| INV-252 | US-CL-13 | Awaiting Review | Master/Harness | MUST | Rejected sections must be returnable for regeneration without wiping approved sections. | commit-idempotency | INV-151 |
| INV-253 | US-CL-13 | Awaiting Review | Master/Harness | MUST NOT | User-authored text in a section must not be protected from automatic overwrite. | hitl-authority | INV-133 |
| INV-254 | US-CL-13 | Closed Approved | Master/Harness | MUST NOT | FINALIZED must not be reachable until all required sections are approved. | commit-idempotency | INV-155 |
| INV-255 | US-CL-14 | Awaiting Review | Master/Harness | MUST NOT | Timeout must never substitute for clinical approval. | timeout-approval | INV-147 |
| INV-256 | US-CL-14 | Awaiting Review | Master/Harness | MUST | If an unsigned draft is retained, it must be visibly unsigned and cannot be treated as a signed record. | labeling-transparency | INV-148, INV-182 |
| INV-257 | US-CL-14 | Closed Approved | Master/Harness | MUST | Commit must be transactional and idempotent, with record-version checks. | commit-idempotency | INV-157 |
| INV-258 | US-CL-14 | Closed Approved | Master/Harness | MUST | Provenance must record human author, AI assistance, model version, sources, and approval event. | provenance | INV-160 |
| INV-259 | US-CL-14 | Closed Approved | Master/Harness | MUST NOT | System must never sign on behalf of the clinician. | hitl-authority | INV-159 |
| INV-260 | US-CL-15 | Drafting | Master/Harness | MUST | Output must render against the tenant template for this specialty and encounter type. | template-config | INV-076 |
| INV-261 | US-CL-15 | Drafting | Master/Harness | MUST | Required sections must be enforced before the note is offered as review-ready. | template-config | INV-140 |
| INV-262 | US-CL-15 | Closed Approved | Master/Harness | MUST | Template version used must be recorded in provenance. | provenance | INV-160 |
| INV-263 | US-CL-15 | Drafting | Note-taking | MUST | Switching templates must reformat existing evidence rather than invent new clinical content. | template-config | INV-082 |
| INV-264 | US-PT-04 | Closed | Master/Harness | MUST | After-visit content must be generated only from the clinician-approved note. | labeling-transparency | INV-086 |
| INV-265 | US-PT-04 | Closed | Master/Harness | MUST NOT | After-visit content must never ship from an unsigned draft, timed-out session, or live work note. | labeling-transparency | INV-086, INV-149 |
| INV-266 | US-PT-04 | Closed | Master/Harness | MUST | Patient-facing text must be itself approval-gated. | hitl-authority | INV-144 |
| INV-267 | US-PT-04 | Closed | Master/Harness | MUST | Wording must be understandable and consistent with what the clinician signed. | labeling-transparency | INV-156 |
| INV-268 | US-CL-16 | Paused | Master/Harness | MUST | Pause must persist a durable checkpoint of transcript, extractions, drafts, and open tasks. | checkpoint-resume | INV-109 |
| INV-269 | US-CL-16 | Streaming | Master/Harness | MUST | Resume within the retention window must restore state without re-processing prior audio. | checkpoint-resume | INV-115 |
| INV-270 | US-CL-16 | Paused | Master/Harness | MUST | A pause beyond the tenant cap must auto-draft available content and enter awaiting-review, not discard. | timeout-approval | INV-112 |
| INV-271 | US-CL-16 | Paused | Master/Harness | MUST | Cancellation must checkpoint raw transcript, current draft, evidence ledger, and open tasks. | checkpoint-resume | INV-120 |
| INV-272 | US-TH-01 | Streaming | Master/Harness | MUST | Audio, video, chat, and consent events must share the same session event ledger. | multimodal | INV-120 |
| INV-273 | US-TH-01 | Streaming | Master/Harness | MUST | Network drop must checkpoint transcript, draft deltas, evidence ledger, and open tasks. | checkpoint-resume | INV-120 |
| INV-274 | US-TH-01 | Streaming | Master/Harness | MUST NOT | Resume must not re-capture or re-bill prior audio. | checkpoint-resume | INV-117 |
| INV-275 | US-TH-01 | Streaming | Master/Harness | MUST | Consent and identity must be re-validated if the drop exceeded policy. | consent-abac | INV-138 |
| INV-276 | US-SP-01 | Streaming | Master/Harness | MUST | Briefing must use the specialty/encounter template, not a generic dump of the whole chart. | template-config | INV-076 |
| INV-277 | US-SP-01 | Streaming | Master/Harness | MUST | Imaging, labs, and prior notes must be source-linked. | provenance | INV-056 |
| INV-278 | US-SP-01 | Streaming | Master/Harness | MUST NOT | Regeneration cannot drop provenance or mix specialties' required sections. | provenance | INV-160 |
| INV-279 | US-SP-01 | Streaming | Master/Harness | MUST | The referring question, if present, must be a first-class briefing item. | labeling-transparency | INV-012 |
| INV-280 | US-SP-02 | Streaming | Master/Harness | MUST | Each recommended plan item must cite guideline, version, and effective date. | provenance | INV-056 |
| INV-281 | US-SP-02 | Streaming | Master/Harness | MUST NOT | Stale guidelines (outside effective_from / effective_to) must not be offered as current. | template-config | INV-082 |
| INV-282 | US-SP-02 | Streaming | Master/Harness | MUST | Tenant-disabled sources must never appear. | template-config | INV-076 |
| INV-283 | US-SP-02 | Streaming | Verifier | MUST | Uncited plan language must not pass verification. | hitl-authority | INV-139 |
| INV-284 | US-SP-03 | Closed | Master/Harness | MUST | Handoff must be a typed context item (question, recommendation, or red flag), not only free text. | labeling-transparency | INV-012 |
| INV-285 | US-SP-03 | Closed | Master/Harness | MUST | Handoff must survive session close under retention policy and appear in the next relevant priming brief. | retention-erasure | INV-171 |
| INV-286 | US-SP-03 | Closed | Master/Harness | MUST | The accountable author and timestamp must be recorded. | audit | INV-084 |
| INV-287 | US-SP-03 | Closed | Master/Harness | MUST NOT | Safety-critical red flags must not be dropped by summarization. | hitl-authority | INV-041 |
| INV-288 | US-NU-01 | Streaming | Master/Harness | MUST | Action items must be listed with source spans in the consultation. | provenance | INV-054 |
| INV-289 | US-NU-01 | Streaming | Master/Harness | MUST | Items must be labeled suggestions until clinician or nurse confirmation. | labeling-transparency | INV-087 |
| INV-290 | US-NU-01 | Streaming | Master/Harness | MUST NOT | System must not auto-commit orders, prescriptions, or referrals. | hitl-authority | INV-053 |
| INV-291 | US-NU-01 | Closed | Master/Harness | MUST | Confirmed tasks must be able to flow to the tenant task/scheduling connector through the same approval gateway as other writes. | commit-idempotency | INV-157 |
| INV-292 | US-SC-01 | Drafting | Master/Harness | MUST | In-line citations must be present on clinically consequential clauses. | provenance | INV-056 |
| INV-293 | US-SC-01 | Drafting | Master/Harness | MUST | Gaps versus the required template must be highlighted. | template-config | INV-140 |
| INV-294 | US-SC-01 | Drafting | Master/Harness | MUST NOT | Per-clause confidence must not be presented as a clinical probability; must be calibrated or clearly labeled. | labeling-transparency | INV-249 |
| INV-295 | US-SC-01 | Drafting | Clinician | MUST | Scribe must be able to jump from a clause to transcript span, retrieved snippet, or HITL history. | provenance | INV-163 |
| INV-296 | US-SC-02 | Drafting | Note-taking | MUST | Existing evidence must be reformatted into the new template. | template-config | INV-082 |
| INV-297 | US-SC-02 | Drafting | Master/Harness | MUST | Provenance on each clause must be preserved when switching templates. | provenance | INV-160 |
| INV-298 | US-SC-02 | Drafting | Master/Harness | MUST NOT | New required sections must not appear as fabricated narrative; must appear as gaps. | degradation | INV-079 |
| INV-299 | US-SC-02 | Drafting | Master/Harness | MUST | Template switch must be audited. | audit | INV-084 |
| INV-300 | US-SC-03 | Awaiting Review | Master/Harness | MUST | Every section must show one of draft, verified, or clinician-approved (plus rejected/regenerating as needed). | labeling-transparency | INV-030 |
| INV-301 | US-SC-03 | Awaiting Review | Master/Harness | MUST NOT | Raw, inferred, verified, and approved content must never be blended in a single unlabeled block. | labeling-transparency | INV-030 |
| INV-302 | US-SC-03 | Closed Approved | Master/Harness | MUST | Only clinician-approved sections must be eligible for the committed record. | hitl-authority | INV-155 |
| INV-303 | US-QA-01 | Closed | Master/Harness | MUST | Per-clause links must exist to transcript span, retrieved snippets, MCP/tool calls, evaluator score, and HITL history. | audit | INV-163 |
| INV-304 | US-QA-01 | Closed | Master/Harness | MUST | Superseded versions must be available to audit queries even if hidden from the clinical UI. | provenance | INV-135 |
| INV-305 | US-QA-01 | Closed | Master/Harness | MUST | Provenance graph must be complete enough to replay how the clause was produced. | audit | INV-163 |
| INV-306 | US-QA-01 | Closed | Master/Harness | MUST | Access to QA provenance must itself be audited and tenant-scoped. | audit | INV-172 |
| INV-307 | US-QA-02 | Closed | Master/Harness | MUST | Dashboards must cover accept/edit/reject rates, template completeness, and guideline citation frequency. | audit | INV-084 |
| INV-308 | US-QA-02 | Closed | Master/Harness | MUST | Aggregates must use approved notes only. | labeling-transparency | INV-176 |
| INV-309 | US-QA-02 | Closed | Master/Harness | MUST NOT | Patient-identifying drill-down must not be on by default; must be authorization-gated. | consent-abac | INV-009 |
| INV-310 | US-QA-02 | Closed | Master/Harness | MUST | Time range and specialty filters must be available. | audit | INV-084 |
| INV-311 | US-AD-01 | Closed | Tenant admin | MUST | Templates must be scoped by tenant, specialty, and encounter type. | template-config | INV-076 |
| INV-312 | US-AD-01 | Closed | Tenant admin | MUST | Version history and rollback must exist. | audit | INV-093 |
| INV-313 | US-AD-01 | Closed | Master/Harness | MUST | Required-section schema must be explicit and enforced by the verifier. | template-config | INV-140 |
| INV-314 | US-AD-01 | Closed | Tenant admin | MUST NOT | A/B or staged rollout must not mix template versions inside one session. | template-config | INV-076 |
| INV-315 | US-AD-02 | Streaming | Tenant admin | MUST | Primary vendor, language, diarization, and vocabulary must be configurable per tenant. | template-config | INV-020 |
| INV-316 | US-AD-02 | Streaming | Tenant admin | MUST | A documented default fallback must exist and be exercised in failure drills. | degradation | INV-019 |
| INV-317 | US-AD-02 | Streaming | Transcription | MUST | Fallback activation must be visible to the clinician and audited. | labeling-transparency | INV-203 |
| INV-318 | US-AD-02 | Streaming | Transcription | MUST NOT | Silent drop of capture must be forbidden. | degradation | INV-205 |
| INV-319 | US-AD-03 | Streaming | Tenant admin | MUST | Enabled sources must be an explicit allowlist. | template-config | INV-076 |
| INV-320 | US-AD-03 | Streaming | Tenant admin | MUST | Precedence must be defined for conflicts between sources. | template-config | INV-076 |
| INV-321 | US-AD-03 | Streaming | Master/Harness | MUST NOT | Disabled or out-of-jurisdiction sources must not be retrieved for generation. | template-config | INV-076 |
| INV-322 | US-AD-03 | Streaming | Clinician | MUST | Conflicts must be visible to clinicians rather than silently blended. | labeling-transparency | INV-012 |
| INV-323 | US-AD-04 | Closed | Tenant admin | MUST | TTL must be configurable per artifact class and jurisdiction. | retention-erasure | INV-171 |
| INV-324 | US-AD-04 | Closed | Master/Harness | MUST | Raw scratch and unapproved drafts must expire independently of the finalized EHR note. | retention-erasure | INV-171 |
| INV-325 | US-AD-04 | Closed | Master/Harness | MUST | Style profiles must follow clinician ownership and revocation, not patient retention. | retention-erasure | INV-170 |
| INV-326 | US-AD-04 | Closed | Tenant admin | MUST | Policy must be exportable and changes must be audited. | audit | INV-172 |
| INV-327 | US-AD-05 | Closed | Tenant admin | MUST | Dashboards must include time-to-review-ready, edit distance, timeout/cancellation rate, and safety-block frequency. | audit | INV-084 |
| INV-328 | US-AD-05 | Closed | Tenant admin | MUST | Workflow configuration (debounce, budgets, HITL gates) must be tenant-scoped and versioned. | template-config | INV-082 |
| INV-329 | US-AD-05 | Closed | Tenant admin | MUST | Metrics must be tenant-isolated. | consent-abac | INV-009 |
| INV-330 | US-CO-01 | Closed | Compliance | MUST | Each event must record actor, patient, resource, purpose, timestamp, and outcome. | audit | INV-084 |
| INV-331 | US-CO-01 | Closed | Master/Harness | MUST | Ledger must be append-only and tamper-evident. | audit | INV-172 |
| INV-332 | US-CO-01 | Closed | Compliance | MUST | Coverage must include PHI access, model calls, tool calls, HITL decisions, overrides, and finalization. | audit | INV-084 |
| INV-333 | US-CO-01 | Closed | Master/Harness | MUST | Both operational audit and artifact provenance must be retained. | audit | INV-172 |
| INV-334 | US-CO-02 | Closed | Compliance | MUST | Access, rectification, portability, restriction, and erasure must have documented automated paths. | retention-erasure | INV-171 |
| INV-335 | US-CO-02 | Closed | Master/Harness | MUST | Erasure must cascade to episodic memory, caches, and patient-linked style exemplars. | retention-erasure | INV-170 |
| INV-336 | US-CO-02 | Closed | Master/Harness | MUST NOT | Committed EHR notes must not be silently deleted; revocation must be recorded for downstream systems. | labeling-transparency | INV-086 |
| INV-337 | US-CO-02 | Closed | Compliance | MUST | Each request and job result must be audited. | audit | INV-172 |
| INV-338 | US-CO-03 | Streaming | Master/Harness | MUST | Calls that fail consent or purpose-of-use must be denied, not best-effort executed. | consent-abac | INV-067 |
| INV-339 | US-CO-03 | Streaming | Master/Harness | MUST | Denials must be logged with patient, tool, purpose, and actor. | audit | INV-084 |
| INV-340 | US-CO-03 | Closed | Master/Harness | MUST | Revocation must block subsequent scoped calls from t_revoke. | consent-abac | INV-010 |
| INV-341 | US-CO-03 | Streaming | Master/Harness | MUST | Write-capable tools must require explicit harness approval in addition to consent. | consent-abac | INV-067 |
| INV-342 | US-PT-01 | Streaming | Patient | MUST | Patient must be able to grant, view, revoke, and time-limit consent per purpose. | consent-abac | INV-004 |
| INV-343 | US-PT-01 | Streaming | Master/Harness | MUST | Revocation must propagate to derived agent-memory artifacts per policy. | retention-erasure | INV-170 |
| INV-344 | US-PT-01 | Streaming | Master/Harness | MUST | Consent control must be available without requiring the clinician to act as a proxy, where regulation requires it. | consent-abac | INV-004 |
| INV-345 | US-PT-01 | Open | Master/Harness | MUST | Consent status must be visible to the clinician at session open. | labeling-transparency | INV-198 |
| INV-346 | US-PT-02 | Closed | Master/Harness | MUST | Patient-visible artifacts must label AI-assisted versus clinician-authored content where policy allows. | labeling-transparency | INV-173 |
| INV-347 | US-PT-02 | Closed | Master/Harness | MUST | Suggestions' source class must be explained in non-technical language. | labeling-transparency | INV-173 |
| INV-348 | US-PT-02 | Closed | Master/Harness | MUST NOT | Unsigned or unapproved AI text must never be sent to the patient. | hitl-authority | INV-148 |
| INV-349 | UC-01 | Streaming | Master/Harness | MUST | Harness must validate identity, role, encounter, consent, and tenant policy; append session.opened to immutable log. | audit | INV-084 |
| INV-350 | UC-01 | Streaming | Summarization | MUST | Initializer must fetch demographics, allergies, problems, meds, encounter summaries, clinician style profile, and specialty template. | provenance | INV-011 |
| INV-351 | UC-01 | Streaming | Summarization | MUST | History summarizer must produce source-linked, provisional encounter brief; imported facts stay distinct from this-visit facts. | provenance | INV-012 |
| INV-352 | UC-01 | Streaming | Transcription | MUST | ASR must emit transcript.partial for display and transcript.segment.finalized as immutable evidence. | partial-vs-final | INV-025 |
| INV-353 | UC-01 | Streaming | NLP/Reasoning | MUST | On each finalized segment, reasoner must extract entities, bind terminology via MCP, and run interaction checks if medication detected. | terminology | INV-062 |
| INV-354 | UC-01 | Streaming | NLP/Reasoning | MUST | Retrieval must run only for identified questions or emerging problems, not all tokens. | debounce-synthesis | INV-055 |
| INV-355 | UC-01 | Streaming | Note-taking | MUST | After debounce window, composer must propose section-level work-note patches; verifier must score grounding, completeness, and safety. | debounce-synthesis | INV-050 |
| INV-356 | UC-01 | Streaming | Clinician | MUST | Clinician edits are authoritative HITL events and cannot be silently overwritten. | hitl-authority | INV-085 |
| INV-357 | UC-01 | Draining | Transcription | MUST | When clinician stops recording, perception must drain in-flight audio to finalized segments. | drain-shutdown | INV-121 |
| INV-358 | UC-01 | Drafting | Master/Harness | MUST | Harness must run final transcript reconciliation and full-session synthesis; optional non-critical tasks not waited on forever. | debounce-synthesis | INV-083 |
| INV-359 | UC-01 | Awaiting Review | Master/Harness | MUST | Candidate final note must be presented with diffs, unresolved items, and missing required sections. | labeling-transparency | INV-144 |
| INV-360 | UC-01 | Awaiting Review | Clinician | MUST | Clinician must approve, edit, or reject per section; all required sections must be approved. | hitl-authority | INV-146 |
| INV-361 | UC-01 | Closed Approved | Master/Harness | MUST | Harness must commit transactionally: EHR write, provenance, audit snapshot; update style/reflection only from approved deltas; expire short-term context per policy. | commit-idempotency | INV-157 |
| INV-362 | UC-01 | Closed | Master/Harness | MUST | Approved note must persist in system of record; audit trail and provenance complete; memory updated only from approved artifacts; session archived with scratch expired. | retention-erasure | INV-171 |
| INV-363 | UC-02 | Streaming | Vision | MUST | Intake must validate type, malware/safety scan, and patient/study/modality metadata. | multimodal | INV-031 |
| INV-364 | UC-02 | Streaming | Vision | MUST | Harness must search for authenticated radiology report first and attach as preferred clinical source. | multimodal | INV-032 |
| INV-365 | UC-02 | Streaming | Vision | MUST | If only images present, imaging worker must extract metadata and available text; structured findings labeled image-derived and isolated. | multimodal | INV-036 |
| INV-366 | UC-02 | Streaming | Master/Harness | MUST | Context synthesizer must reconcile imaging with spoken statements and prior notes; contradictions become contradiction items (not silent merges). | contradiction | INV-039 |
| INV-367 | UC-02 | Streaming | Master/Harness | MUST | Work-note sections must update by patch after debounce; image-derived suggestions stay out of candidate final note until clinician review. | multimodal | INV-214 |
| INV-368 | UC-02 | Awaiting Review | Clinician | MUST | Clinician must review and accept, edit, or reject imaging-derived content before finalization. | hitl-authority | INV-215 |
| INV-369 | UC-02 | Closed | Master/Harness | MUST | Attachment references and any accepted findings must be in session context with provenance; unreviewed image-derived content not in committed note. | multimodal | INV-214, INV-215 |
| INV-370 | UC-03 | Streaming | Master/Harness | MUST | Harness must classify information need as terminology lookup, not general literature search. | terminology | INV-061 |
| INV-371 | UC-03 | Streaming | Master/Harness | MUST | Clinical tool gateway must enforce scope, consent, rate limits, audit; then call search/get_concept on terminology MCP. | consent-abac | INV-067 |
| INV-372 | UC-03 | Streaming | Master/Harness | MUST | On verified match, coded concept (system, code, display) must be written as typed context item with lookup timestamp and metadata. | terminology | INV-062 |
| INV-373 | UC-03 | Streaming | Master/Harness | MUST | Note composer may show bound code in work note as structured data, not free-generated digits. | terminology | INV-062 |
| INV-374 | UC-04 | Streaming | Note-taking | MUST | Harness must inject versioned style contract (and bounded exemplars) as documentation preference, separate from patient evidence. | style-dna | INV-077 |
| INV-375 | UC-04 | Streaming | Note-taking | MUST | Composer must fill required template sections from evidence board, then apply style (order, abbrevs, verbosity, hedging). | style-dna | INV-077 |
| INV-376 | UC-04 | Streaming | Verifier | MUST | Verifier must still enforce grounding and safety; style cannot waive those checks. | hitl-authority | INV-078 |
| INV-377 | UC-04 | Awaiting Review | Note-taking | MUST | After HITL, accepted diffs may be proposed as profile updates for clinician confirmation. | style-dna | INV-242 |
| INV-378 | UC-05 | Awaiting Review | Master/Harness | MUST | UI must highlight additions since last review, unresolved contradictions, and missing required sections. | labeling-transparency | INV-144 |
| INV-379 | UC-05 | Awaiting Review | Clinician | MUST | Clinician or scribe must approve, edit, or reject each required section; each decision is an audit event. | hitl-authority | INV-150 |
| INV-380 | UC-05 | Awaiting Review | Master/Harness | MUST | Edits must re-run incremental verification on affected sections. | commit-idempotency | INV-151 |
| INV-381 | UC-05 | Closed Approved | Master/Harness | MUST | When all required sections approved, harness must start finalization: convert approved draft to record representation, write EHR, provenance, audit snapshot. | commit-idempotency | INV-157 |
| INV-382 | UC-05 | Closed Approved | Master/Harness | MUST | Commit must use idempotency keys and optimistic concurrency; Success → FINALIZED then CLOSED; Failure → not silently marked approved. | commit-idempotency | INV-157, INV-158 |
| INV-383 | UC-05 | Closed | Master/Harness | MUST | Committed note must match approved sections; provenance must include human author, AI assistance, versions, sources, approval events; system did not sign. | commit-idempotency | INV-160 |
| INV-384 | UC-06 | Streaming | Master/Harness | MUST | Harness must open shared blackboard: problem list, evidence cards, open questions, contradictions, tasks, draft sections, approval state. | multimodal | INV-120 |
| INV-385 | UC-06 | Streaming | Master/Harness | MUST | Supervisor must route specialty-appropriate briefing and specialist agents; group-chat iteration bounded by max turns and accountable author. | debounce-synthesis | INV-083 |
| INV-386 | UC-06 | Streaming | Master/Harness | MUST | Specialists may leave structured handoff items. | labeling-transparency | INV-284 |
| INV-387 | UC-06 | Streaming | Master/Harness | MUST NOT | Conflicts between specialist outputs must not be silently resolved; must escalate to HITL merge. | contradiction | INV-103 |
| INV-388 | UC-06 | Closed | Master/Harness | MUST | Final note must have one accountable author; section approvals still apply. | hitl-authority | INV-104 |
| INV-389 | UC-06 | Closed | Master/Harness | MUST | One committed note with accountable author and specialist contributions attributed; handoff items persist for next relevant session. | provenance | INV-160 |
| INV-390 | UC-07 | Streaming | Master/Harness | MUST | Harness must treat telehealth as a channel over the same state machine, not a separate product. | multimodal | INV-120 |
| INV-391 | UC-07 | Streaming | Master/Harness | MUST | Transcript, chat, and consent events must append to the same event ledger. | labeling-transparency | INV-272 |
| INV-392 | UC-07 | Streaming | Master/Harness | MUST | Drafting, verification, and HITL must follow UC-01 rules. | hitl-authority | INV-146 |
| INV-393 | UC-07 | Paused | Master/Harness | MUST | On connectivity loss, harness must checkpoint transcript, draft deltas, evidence ledger, and open tasks. | checkpoint-resume | INV-120 |
| INV-394 | UC-07 | Streaming | Master/Harness | MUST | On resume, harness must restore from ledger; must not re-capture prior audio. | checkpoint-resume | INV-115 |
| INV-395 | UC-07 | Closed | Master/Harness | MUST | Same commit and provenance rules apply as in-room care; interruption recoverable from event ledger. | commit-idempotency | INV-157 |
| INV-396 | UC-08 | Streaming | Master/Harness | MUST | Harness must record clinician correction as authoritative HITL edit; old derived wording superseded (not erased). | hitl-authority | INV-090 |
| INV-397 | UC-08 | Streaming | Master/Harness | MUST | Only affected derived artifacts must be invalidated (medication sections, interaction summary, related plan language). | commit-idempotency | INV-091 |
| INV-398 | UC-08 | Streaming | Master/Harness | MUST | Permitted medication/safety retrieval must be re-run through the gateway. | consent-abac | INV-097 |
| INV-399 | UC-08 | Streaming | Master/Harness | MUST | Affected note sections must be regenerated as patches; unrelated attachments and sections left alone. | commit-idempotency | INV-098 |
| INV-400 | UC-08 | Streaming | Verifier | MUST | Verifier must re-run incrementally; clinician shown resulting diff. | commit-idempotency | INV-099 |
| INV-401 | UC-09 | Streaming | Master/Harness | MUST | Typed contradiction item must be written with both sources, timestamps, and contradicts link; neither value deleted. | contradiction | INV-102 |
| INV-402 | UC-09 | Streaming | Master/Harness | MUST NOT | Finalization cannot "average" the two values; work note must surface conflict. | contradiction | INV-103 |
| INV-403 | UC-09 | Awaiting Review | Clinician | MUST | Clinician must verify contradiction; their resolution becomes authoritative. | hitl-authority | INV-104 |
| INV-404 | UC-09 | Awaiting Review | Master/Harness | MUST | If tenant policy classifies slot as safety-critical (allergy, anticoagulant, identity), finalization must be blocked until resolution. | contradiction | INV-107 |
| INV-405 | UC-10 | Streaming | Master/Harness | MUST | Harness must emit contradiction.detected with both sources (image reference and transcript span). | contradiction | INV-039 |
| INV-406 | UC-10 | Streaming | Verifier | MUST | Evaluator must flag pair for HITL disambiguation. | contradiction | INV-041 |
| INV-407 | UC-10 | Streaming | Master/Harness | MUST NOT | Neither source must be silently preferred; image-derived content remains labeled until clinician decides. | contradiction | INV-042 |
| INV-408 | UC-10 | Streaming | Clinician | MUST | Resolution must follow UC-09 authority rules (clinician decides; both sources remain in ledger). | contradiction | INV-104 |
| INV-409 | UC-11 | Streaming | Master/Harness | MUST | Harness must record agent.timeout, cancel that attempt, and retry only if idempotent and within budget. | degradation | INV-069 |
| INV-410 | UC-11 | Streaming | Master/Harness | MUST | Optional compensation: fallback model, then omit unverified codes and flag HITL. | degradation | INV-070 |
| INV-411 | UC-11 | Streaming | Master/Harness | MUST NOT | No guessed terminology must be inserted; session enters Degraded (not Failed) if safe draft remains possible. | degradation | INV-072 |
| INV-412 | UC-11 | Streaming | Master/Harness | MUST | Force-stop applies only to timed-out agent; transcription and other agents keep running unless global drain in progress. | drain-shutdown | INV-074, INV-075 |
| INV-413 | UC-12 | Awaiting Review | Master/Harness | MUST | Harness must retain unsigned draft per retention policy; status becomes TIMED_OUT or AWAITING_REVIEW, never CLOSED_APPROVED. | timeout-approval | INV-177, INV-183 |
| INV-414 | UC-12 | Awaiting Review | Master/Harness | MUST | Notification must be issued to responsible clinician (optionally to coverage pool). | audit | INV-178 |
| INV-415 | UC-12 | Awaiting Review | Master/Harness | MUST NOT | No long-term style or reflection memory must be updated from unapproved draft. | style-dna | INV-180 |
| INV-416 | UC-12 | Timed Out | Master/Harness | MUST | If policy allows administrative closure, draft must remain visibly unsigned. | labeling-transparency | INV-182 |
| INV-417 | UC-13 | Paused | Master/Harness | MUST | Harness must checkpoint event ledger, working memory, draft sections, evidence ledger, and open tasks. | checkpoint-resume | INV-120 |
| INV-418 | UC-13 | Paused | Transcription | MUST | Perception must stop accepting new audio if pause is local; telehealth follows UC-07 drop rules. | drain-shutdown | INV-110 |
| INV-419 | UC-13 | Streaming | Master/Harness | MUST | On resume within retention window, state must restore without re-transcription, re-extraction, or re-retrieval of prior work. | checkpoint-resume | INV-115, INV-116 |
| INV-420 | UC-13 | Awaiting Review | Master/Harness | MUST | If pause exceeds tenant cap, harness must auto-draft available content and transition to AWAITING_HITL rather than discard. | timeout-approval | INV-112 |
| INV-421 | UC-14 | Drafting | Verifier | MUST | Safety checker must block FINALIZED if high-risk slot uncertain or conflicted; UI must name blocking items. | hitl-authority | INV-139 |
| INV-422 | UC-14 | Awaiting Review | Clinician | MUST | Clinician must review, correct, or explicitly accept residual risk if policy permits. | hitl-authority | INV-104 |
| INV-423 | UC-14 | Drafting | Master/Harness | MUST NOT | No fabricated filler must be inserted to satisfy template completeness. | degradation | INV-079 |
| INV-424 | UC-14 | Closed | Master/Harness | MUST | Committed note must not contain an unresolved blocked safety item. | hitl-authority | INV-107 |
| INV-425 | UC-15 | Streaming | Perception | MUST | Harness must switch to documented fallback (vendor, language, diarization as configured). | degradation | INV-019 |
| INV-426 | UC-15 | Streaming | Clinician | MUST | Clinician must be notified that fallback is in use. | labeling-transparency | INV-203 |
| INV-427 | UC-15 | Streaming | Master/Harness | MUST | Failure and fallback must be audited. | audit | INV-084 |
| INV-428 | UC-15 | Streaming | Master/Harness | MUST | Session must continue UC-01 rules on fallback pipeline. | degradation | INV-019 |
| INV-429 | UC-16 | Streaming | Master/Harness | MUST | Context item must be marked unmapped with original span and empty lookup result. | terminology | INV-063 |
| INV-430 | UC-16 | Streaming | Master/Harness | MUST | Work note / coding panel must show term for human assignment. | terminology | INV-063 |
| INV-431 | UC-16 | Streaming | Verifier | MUST | Verifier must treat unmapped high-risk concept as a gap, not as a pass. | hitl-authority | INV-139 |
| INV-432 | UC-16 | Closed | Master/Harness | MUST NOT | No hallucinated code must exist in note or write payload. | terminology | INV-066 |
| INV-433 | UC-17 | Closed | QA reviewer | MUST | Provenance panel must show, for each clause: transcript span, retrieved snippets, tool/MCP calls, evaluator score, and HITL edit history. | audit | INV-303 |
| INV-434 | UC-17 | Closed | QA reviewer | MUST | Superseded versions must be available; latest non-superseded is clinical default. | provenance | INV-304 |
| INV-435 | UC-17 | Closed | QA reviewer | MUST | Reviewer can see which sections were AI-accepted versus rewritten. | audit | INV-154 |
| INV-436 | UC-17 | Closed | Master/Harness | MUST | QA access itself must be audited. | audit | INV-172 |
| INV-437 | UC-18 | Closed | Master/Harness | MUST | Consent record must be marked revoked from t_revoke; clinician-facing session open shows new status. | consent-abac | INV-010 |
| INV-438 | UC-18 | Closed | Master/Harness | MUST | Gateway must block subsequent MCP/tool calls scoped to revoked patient for revoked purpose. | consent-abac | INV-010 |
| INV-439 | UC-18 | Closed | Master/Harness | MUST | Erasure/restriction job must run across session scratch, caches, episodic agent memory, and patient-linked style exemplars per jurisdiction policy. | retention-erasure | INV-335 |
| INV-440 | UC-18 | Closed | Master/Harness | MUST | Finalized notes already in EHR must follow EHR retention; harness records revocation for downstream systems instead of silently deleting. | retention-erasure | INV-336 |
| INV-441 | UC-18 | Closed | Compliance | MUST | Job completion must be audited; incomplete scrub is a compliance incident. | audit | INV-337 |
| INV-442 | US-CL-17 | Drafting | Master/Harness | MUST | Each clinically consequential clause carries an origin class: patient-reported, clinician-observed, imported, or AI-derived. | labeling-transparency | INV-300, INV-351 |
| INV-443 | US-CL-17 | Drafting | Master/Harness | MUST NOT | Provisional information cannot silently become verified or approved. | labeling-transparency | INV-256, INV-301 |
| INV-444 | US-CL-17 | Drafting | Master/Harness | MUST | Origin labels are perceivable without relying solely on color. | labeling-transparency | INV-207 |
| INV-445 | US-CL-17 | Closed | Master/Harness | MUST | QA and the patient-visible artifact (where policy allows) can reconstruct the same origin split. | audit | INV-300, INV-346 |
| INV-446 | US-CL-18 | Drafting | Master/Harness | MUST | Coding suggestions appear only after verification of the supporting note sections. | terminology | INV-062, INV-233 |
| INV-447 | US-CL-18 | Drafting | Master/Harness | MUST | Each suggested code is tool-verified and cited to note clauses or source records. | terminology | INV-234, INV-292 |
| INV-448 | US-CL-18 | Drafting | Master/Harness | MUST NOT | No code is written to EHR or billing without explicit authorized approval. | hitl-authority | INV-231, INV-259 |
| INV-449 | US-CL-18 | Drafting | Master/Harness | MUST | Low-confidence or unmapped concepts stay unmapped rather than becoming guessed codes. | terminology | INV-233, INV-431 |

---

## 2. Session states

**11 states and their time-steps:**

1. **Open** (T0, T1) — encounter binding, consent/ABAC gate
2. **Primed** (T2, T3) — history loaded, clinician validated, ready for capture
3. **Streaming** (T4–T12.4) — live transcription, synthesis, extraction, refinement
4. **Degraded** (T10.1) — agent timeout, safe draft remains, independent tasks continue
5. **Paused** (T13) — checkpoint after clinician pause or network drop
6. **Draining** (T15, T16) — perception drains, agents finish, awaiting human approval entry
7. **Drafting** (T17, T18) — transcript reconciliation, verification, candidate note readied
8. **Awaiting Review** (T19, T20) — section-level HITL decisions (approve/edit/reject)
9. **Closed Approved** (T21, T22) — transactional commit succeeded, style memory optionally updated
10. **Closed** (T23) — session archived, short-term context expired, legal audit retained
11. **Timed Out** (T24, ALTERNATE) — approval deadline exceeded, unsigned draft retained, no signature

---

## 3. Agent roles

**9 distinct agent roles and their active time-steps:**

1. **Master/Harness loop** — T0–T24 (orchestrator, state machine, checkpoint, drain, commit)
2. **Compliance** — T1, T5, T18, T21, UC-18 (consent gate, ABAC, PHI sanitizer, audit)
3. **Summarization Agent** — T2 (prior-note retrieval, source-linking, min-necessary scope)
4. **Transcription Agent** — T4–T7, T13–T15, T17 (ASR pipeline, partials, finalized segments, fallback)
5. **Vision Agent** — T6, T18 (image metadata check, radiology-report search, image-to-text)
6. **NLP/Reasoning Agent** — T5–T12.4, T17, UC-03 (entity extraction, terminology lookup, contradiction detection)
7. **Note-taking Agent** (Composer) — T8, T11–T12, T16, T20, T22, UC-04 (work-note synthesis, template filling, style application)
8. **Verifier/Quality** — T12, T16, T18, T20 (grounding, completeness, safety scoring, verification gate)
9. **Clinician** — T0–T24 (gatekeeper, all approval decisions, edit authority, final signer)

---

## 4. Events

**Named events extracted from XML and stories:**

1. `session.opened` — T0, UC-01 step 1
2. `consent.validated` — T1, UC-01 step 1
3. `history.summarized` — T2, UC-01 step 3
4. `recording.started` — T4, UC-01 step 4
5. `transcript.partial` — T4–T7 (displayed, not evidence)
6. `transcript.segment.finalized` — T5, T7, T17 (immutable, evidence)
7. `phisanitizer.applied` — T5, T26, UC-01 step 5
8. `image.attached` — T6, UC-02 step 1
9. `contradiction.detected` — T6.1, T12.4, UC-10 step 2, UC-09 step 1
10. `entity.extracted` — T8, T12, UC-01 step 6
11. `evidence.retrieved` — T9, UC-01 step 5
12. `code.bound` — T10, UC-03 step 3
13. `agent.timeout` — T10.1, UC-11 step 1
14. `workNote.generated` — T8, T12, UC-01 step 6
15. `capture.stopped` — T15, UC-01 step 8
16. `drain.started` — T15, UC-01 step 8
17. `hitl.edit` — T12.2, T20, UC-08 step 1, UC-05 step 3
18. `session.paused` — T13, UC-13 step 1
19. `session.resumed` — T14, UC-13 step 3
20. `transcript.reconciled` — T17, UC-01 step 8
21. `verification.passed` — T18, UC-01 step 9
22. `candidate.ready` — T19, UC-01 step 9
23. `section.approved` — T20, UC-05 step 2
24. `section.rejected` — T20, UC-05 step 2
25. `note.committed` — T21, UC-01 step 11, UC-05 step 4
26. `dna.updated` — T22, UC-04 step 4
27. `session.archived` — T23, UC-01 step 11
28. `session.timedout` — T24, UC-12 step 1
29. `notification.issued` — T24, UC-12 step 2

---

## 5. Context-item lifecycle

**7 context-item action types with time-steps and applicable items:**

1. **None** (T0) — Open, before any context loaded
2. **Added** (T1–T10, T14–T16) — Consent/ABAC, history, transcripts, evidence, edits, final summary, contradiction flags
3. **Updated** (T5, T9, T12, T20) — Transcript parts, evidence, work-note sections, final summary revisions, approved sections
4. **Unchanged** (T3, T13, T14, T19) — Priming hold, pause, resume, review state (checkpoint preserved)
5. **Invalidated** (T12.2, T12.3) — Dependent medication/interaction artifacts on high-risk correction
6. **Superseded** (T15, T17) — Live partials (finalized when captured), old AI wording (edit history retained)
7. **Finalized** (T21, T23, T24) — Approved note and audit snapshot (T21/T23), unsigned draft (T24)

---

## 6. ALTERNATE branches

**Six ALTERNATE time-steps extending or replacing primary flow:**

| Alternate | Extends/Replaces | Use-case | Trigger |
|---|---|---|---|
| T6.1 | Extends T6 | UC-10 Image-versus-speech contradiction | Speech contradicts imaging (e.g., "no surgery" vs post-op clips) |
| T10.1 | Extends T10 | UC-11 Terminology timeout | Terminology MCP exceeds per-agent deadline |
| T12.1 | Extends T12 (UC-02 start) | Provisional medication handling | Partial transcript contains uncertain medication name |
| T12.2 | Continues T12.1 (UC-02 after start) | Correction propagation | Clinician corrects medication name/dosage from T12.1 state |
| T12.3 | Completes UC-02 | Affected-section regeneration | Medication-dependent sections re-run after T12.2 correction |
| T12.4 | Extends T12 (UC-04) | Historical-versus-current contradiction | Prior note allergy differs from current transcript allergy |
| T24 | Replaces T20–T23 | UC-12 Session timeout | Approval deadline exceeded; clinician never approved |

---

## 7. Non-negotiable core

**12 consensus items from ≥3 of 4 papers + 3 top-level rules:**

### Top-level rules (header of .md file)
1. **Timeout is never clinical approval.** (INV-001, INV-147, INV-181)
2. **The system never signs on behalf of the clinician.** (INV-159, US-CL-14)
3. **The drafted note is not the final record until a qualified clinician explicitly approves it.** (INV-137, INV-148, US-CL-14)

### Core stories in ≥3 papers
4. **US-CL-01** Load relevant prior history (A B C D) — INV-011, INV-012, INV-013, INV-014, INV-015, INV-016
5. **US-CL-03** Start ambient capture safely (A B C D) — INV-019, INV-020, INV-021, INV-022
6. **US-CL-05** Attach imaging or radiology report (A B C D) — INV-031, INV-032, INV-036, INV-037
7. **US-CL-10** Override AI with authoritative correction (A B C D) — INV-085, INV-090, INV-091, INV-092
8. **US-CL-11** Learn documentation style safely (A B C D) — INV-080, INV-081, INV-095, INV-096, INV-164, INV-165
9. **US-CL-14** Finalize only with explicit responsibility (A B C D) — INV-155, INV-157, INV-159, INV-161
10. **US-CO-01** Keep an immutable audit ledger (A B C D) — INV-008, INV-035, INV-084, INV-150, INV-160, INV-172

### Core use-cases in ≥3 papers
11. **UC-01** Happy-path ambient consultation (A B C D) — INV-004, INV-006, INV-007, INV-023, INV-049, INV-050, INV-139, INV-155, INV-157
12. **UC-05** Section-level HITL approval and commit (A B C D) — INV-150, INV-151, INV-155, INV-157, INV-158, INV-185
13. **UC-08** Correction changes high-risk fact (A B C D) — INV-085, INV-091, INV-092, INV-098, INV-099
14. **UC-11** Agent timeout with safe degradation (A B C D) — INV-068, INV-069, INV-070, INV-071, INV-072, INV-073

---

## 8. Story-vs-XML conflicts (story criteria sharpen, differ, or exceed XML notes)

**Conflict type: Sharpening** — Story acceptance criteria operationalize vague XML notes more precisely

| XML Source | Story Source | Sharpening | Impact |
|---|---|---|---|
| INV-011, INV-012 (T2) | US-CL-01 criteria | "Every imported fact shows source record, date, and link" vs. T2's "source links on items" | Story makes source linkage testable: link presence is verifiable, not aspirational |
| INV-022 (T4) | US-CL-04 criteria | "Uncertain text is visibly marked" vs. "Uncertain / low-confidence text is visibly marked without relying only on color" | Story adds accessibility requirement; XML left the marking method undefined |
| INV-049, INV-050 (T8) | US-CL-06 criteria | "Debounce window" vs. "Updates are debounced rather than generated for every token" | Story makes debounce's purpose explicit: debouncing is the constraint, not just a performance optimization |
| INV-139, INV-246 (T18) | US-CL-12 criteria | Checks "run before approval" vs. listing specific checks (medication, allergy, laterality, dosage, negation, identity) | Story names the five mandatory checks; XML groups them as "safety-critical" |
| INV-157, INV-258 (T21) | US-CL-14 criteria | "Transactional, idempotent commit" vs. "Commit must be transactional and idempotent, with record-version checks" | Story adds version checks as a non-negotiable part of idempotency |

**Conflict type: Story omits or contradicts XML**

| XML Rows | Story ID | Discrepancy | Note |
|---|---|---|---|
| INV-081 (T11, T22) | US-CL-11 | XML: "Long-term DNA memory not updated from live draft"; Story: "Learning uses clinician-approved notes only" | Story adds stricter gate: even approved-but-unsigned drafts cannot update memory (INV-244) |
| INV-219 (T8) | US-CL-06 | XML: "User-authored text protected from overwrite"; Story: "patches require visible diff" | Story layers the requirement: not just protect from overwrite, but show the diff so clinician sees the change |
| INV-249 (T12) | US-CL-12 | XML: "Confidence scores" (generic); Story: "Confidence is a calibrated system measure, retrieval quality, or labeled model self-assessment — not a clinical probability" | Story forbids a specific misuse: never present model confidence as clinical likelihood |

---

## 9. Persona coverage

| Persona | Story count | Invariant rows (XML + Story) | Categories touched | Notes |
|---|---|---|---|---|
| Clinician | 18 | 147 | All 18 categories | Central actor; consent gate, capture, synthesis, correction, approval |
| Master/Harness | — | 221 | All 18 categories | Orchestrator; appears in 119 XML rows + 102 story rows |
| Compliance / DPO | 3 | 21 | audit, consent-abac, retention-erasure | Consent gate (T1), PHI sanitizer (T5, T26), audit ledger (US-CO-01), GDPR cascade (US-CO-02), tool gateway (US-CO-03) |
| Transcription Agent | 6 | 28 | provenance, labeling-transparency, partial-vs-final, checkpoint-resume, degradation | Partial/finalized split (T4–T7, T14, T17), fallback (T4, US-AD-02) |
| Vision Agent | 2 | 10 | multimodal, degradation, provenance | Image attach + radiology report search (T6, UC-02); graceful degrade on unsupported files |
| NLP/Reasoning Agent | 8 | 32 | terminology, contradiction, debounce-synthesis, hitl-authority | Entity extraction (T8–T10.1), terminology binding (T10, UC-03), contradiction detection (T6.1, T12.4) |
| Note-taking Agent | 4 | 17 | template-config, style-dna, debounce-synthesis, labeling-transparency | Provisional vs. documented (T8), template filling (T11), DNA application (T22, UC-04) |
| Verifier / Quality | 3 | 16 | hitl-authority, audit, contradiction | Grounding/completeness/safety scoring (T12, T16, T18, T20) |
| Summarization Agent | 1 | 9 | provenance, consent-abac, labeling-transparency | Prior-note retrieval at T2 (US-CL-01) |
| Master/Harness loop | — | 150 | All 18 | Visible in Actions across T0–T24 |
| Tenant admin | 5 | 19 | template-config, degradation, audit, retention-erasure | Templates (US-AD-01), ASR config (US-AD-02), guideline library (US-AD-03), retention TTLs (US-AD-04), ops dashboards (US-AD-05) |
| Patient | 4 | 16 | consent-abac, labeling-transparency, retention-erasure | History continuity (US-PT-03), after-visit safety (US-PT-04), consent grant/revoke (US-PT-01), transparency (US-PT-02) |
| Specialist | 3 | 9 | template-config, provenance, labeling-transparency | Specialty briefing (US-SP-01), guideline citation (US-SP-02), handoff items (US-SP-03) |
| Scribe | 3 | 9 | provenance, labeling-transparency, template-config, audit | Draft review (US-SC-01), template switching (US-SC-02), draft/verified/approved labels (US-SC-03) |
| QA Reviewer | 2 | 7 | audit, provenance, labeling-transparency | Provenance graph (US-QA-01), quality trends (US-QA-02) |
| Nurse | 1 | 4 | labeling-transparency, hitl-authority, commit-idempotency | Action-item extraction (US-NU-01) |
| Telehealth clinician | 1 | 4 | multimodal, checkpoint-resume | Connectivity checkpointing (US-TH-01) |

---

## Metrics

- **Total invariant rows:** 449 (186 from XML + 263 from stories/use-cases)
- **Coverage:**
  - All 40 stories: 100% (40/40 with acceptance criteria rows)
  - All 18 use-cases: 100% (18/18 with main-flow rows)
  - All 11 session states: Covered (Open, Primed, Streaming, Degraded, Paused, Draining, Drafting, Awaiting Review, Closed Approved, Closed, Timed Out)
  - All 9 agent roles: Covered
  - 29 named events: Covered
  - 7 context-item lifecycle actions: Covered
  - 7 ALTERNATE branches: Covered (T6.1, T10.1, T12.1, T12.2, T12.3, T12.4, T24)

- **By Category (across all 449 rows):**
  - hitl-authority: 41
  - labeling-transparency: 57
  - consent-abac: 40
  - audit: 37
  - provenance: 31
  - style-dna: 25
  - contradiction: 22
  - commit-idempotency: 20
  - checkpoint-resume: 21
  - timeout-approval: 20
  - template-config: 26
  - degradation: 22
  - terminology: 21
  - debounce-synthesis: 16
  - drain-shutdown: 11
  - partial-vs-final: 14
  - retention-erasure: 9
  - multimodal: 12

**Ambiguities noted:** None. All 449 invariants are self-contained MUST/MUST NOT imperatives, independently verifiable. Story-vs-XML conflicts documented in §8 (5 sharpening cases, 3 divergence cases).
