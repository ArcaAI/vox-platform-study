# Consultation Harness — Consolidated User Stories and Use-Cases

| | |
|---|---|
| **Status** | Research synthesis (not verified against current HOPE code) |
| **Date** | 2026-08-15 |
| **Companion** | [dataset.xml](./dataset.xml) (time-stepped session workflow) |

Product catalog for a harness-first, event-driven consultation workflow. Synthesized from four redesign papers. This is software and product architecture, not clinical, legal, or regulatory guidance. Features that interpret medical images, recommend diagnoses or treatments, or influence time-critical care require jurisdiction-specific clinical validation and regulatory review.

**Non-negotiable safety rules across the catalog**

- Timeout is never clinical approval.
- The system never signs on behalf of the clinician.
- The drafted note is not the final record until a qualified clinician explicitly approves it.

---

## 1. Sources and merge method

| ID | Paper |
|---|---|
| A | *Harness Agentic Loop Workflow Brainstorming 2* |
| B | *Redesigning a Multi-Specialty Healthcare Consultation Agentic Workflow: A Harness-First Architecture* |
| C | *Harness Agentic Loop Workflow Brainstorming* |
| D | *Modern Medical Consultation Agentic Workflow Redesign* |

Raw inventory was **53** story statements and **24** named use-cases. Same actor plus same outcome collapsed into **40** stories and **18** use-cases. Acceptance criteria were unioned, not averaged. Unique-to-one-paper items (nurse tasks, telehealth, GDPR erasure, specialty handoff) were kept because the original XML timeline never named them.

Two clinician stories were lifted from requirements that were never written as stories in the source notes:

- **US-CL-17** clause origin labeling — from A FR-C01 and D’s raw / inferred / verified / approved split.
- **US-CL-18** assisted coding suggestions — from B’s coding assistant and D’s coding agent.

---

## 2. Inventory

### 2.1 Stories by persona

| Persona | IDs | Count |
|---|---|---|
| Clinician | US-CL-01 … US-CL-18 | 18 |
| Specialist | US-SP-01 … US-SP-03 | 3 |
| Nurse | US-NU-01 | 1 |
| Telehealth clinician | US-TH-01 | 1 |
| Scribe | US-SC-01 … US-SC-03 | 3 |
| QA reviewer | US-QA-01, US-QA-02 | 2 |
| Tenant admin | US-AD-01 … US-AD-05 | 5 |
| Compliance / DPO | US-CO-01 … US-CO-03 | 3 |
| Patient | US-PT-01 … US-PT-04 | 4 |

### 2.2 Use-cases by kind

| Kind | IDs | Count |
|---|---|---|
| Happy path | UC-01 … UC-07 | 7 |
| Safety / exception | UC-08 … UC-16 | 9 |
| Governance | UC-17, UC-18 | 2 |

### 2.3 Paper inventory before merge

| Paper | Stories named | Use-cases named | What it uniquely added |
|---|---|---|---|
| A — Brainstorming 2 | 10 clinician epics | 5 | Tightest acceptance criteria; four-artifact note split; timeout ≠ approval |
| B — Harness-first architecture | 23 across 7 personas | 8 | Scribe / QA / admin / DPO / patient; GDPR cascade; specialty handoff |
| C — Brainstorming 1 | 12 | 4 | Terminology-only coding; two-phase drain then human gate |
| D — Modern medical redesign | 8 persona stories | 7 | Nurse tasks, telehealth channel, multidisciplinary board |

---

## 3. User stories

Each story uses the form **As a … I want … so that …**, then a full description, acceptance criteria, related use-cases, and source mapping.

---

### Epic: Priming and history

#### US-CL-01 — Load relevant prior history

**Persona:** Clinician · **Sources:** A, B, C, D (all four) · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation)

> As a clinician, I want the system to retrieve and summarize relevant prior consultation information at session open so that I can begin with accurate context without reading every historical note.

Session priming is the first clinical act of the harness. All four papers treat prior-note summarization as a one-shot, source-linked brief produced after identity, consent, and encounter matching succeed — not as a growing chat string dumped into the prompt. Imported history stays distinguishable from this-visit facts. Historical diagnoses must never be silently treated as current. The clinician can always open the original source. Paper B adds a latency bar (brief visible shortly after `session.opened`) and an initializer that also loads problems, allergies, meds, style profile, and the specialty template into a session progress manifest.

**Original IDs:** A US-01 · B US-CL-02 · C US-2 · D physician/specialist brief

**Acceptance criteria**

- Every imported fact shows source record, date, and a link to the original.
- Imported history is visually and structurally distinct from current-visit facts.
- Contradictions and unresolved items from prior encounters are listed, not resolved.
- No historical diagnosis is treated as a current diagnosis without clinician confirmation.
- Patient and encounter identity must pass matching rules before any history is shown.
- Default retrieval follows minimum-necessary policy and is audited.

#### US-CL-02 — Control historical retrieval scope

**Persona:** Clinician · **Sources:** A, B · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation)

> As a clinician, I want to choose or understand the history retrieval scope so that unrelated information is not unnecessarily exposed.

Paper A makes scope a first-class clinician story because ambient documentation otherwise over-retrieves PHI. The UI must show which date range and source systems were queried. Restricted classes stay omitted unless authorization permits them. This is the product face of purpose-of-use and minimum-necessary, not an admin-only setting. Widening scope is an explicit clinician action, not an agent decision.

**Original IDs:** A US-02 · B consent / min-necessary implied

**Acceptance criteria**

- Default retrieval is minimum-necessary for this encounter type and specialty.
- The UI displays date range, source systems, and whether restricted classes were included.
- Restricted data is omitted unless authorization and consent permit it.
- Every retrieval — including clinician-widened scope — is audited.
- Widening scope is an explicit clinician action, not an agent decision.

#### US-PT-03 — Have prior visits inform this one

**Persona:** Patient · **Sources:** C · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation)

> As a patient, I want my prior consultation history to inform this visit so that care is continuous and I do not repeat myself.

Paper C’s patient continuity story — the beneficiary view of US-CL-01. Continuity is not an unlimited chart dump: only authorized, identity-matched, minimum-necessary history is used.

**Original IDs:** C US-12

**Acceptance criteria**

- Authorized prior history is available to the clinician at open.
- Identity matching and minimum-necessary still apply.
- The patient is not required to re-state known, in-scope history for the system to retrieve it.

---

### Epic: Ambient capture

#### US-CL-03 — Start ambient capture safely

**Persona:** Clinician · **Sources:** A, B, C, D (all four) · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation), [UC-07](#uc-07--telehealth-consultation), [UC-15](#uc-15--asr-pipeline-failure-then-fallback)

> As a clinician, I want live transcription to start when I toggle Record, with mute and a visible processing indicator, so that I can focus on the patient instead of typing.

Ambient capture is the core clinician job-to-be-done across all four papers. Capture must not start until consent and access checks succeed. Mute is a first-class control, not a browser afterthought. The tenant audio pipeline has a documented fallback so a vendor outage does not silently drop the visit. Paper D extends the same control plane to telehealth audio/video and chat events.

**Original IDs:** A US-03 · B US-CL-01 · C US-1 · D physician live draft

**Acceptance criteria**

- Record does not start until consent for AI-drafting and ABAC scope succeed; failure aborts and audits.
- Mute/unmute is obvious and immediately stops sending audio.
- A visible indicator shows when audio is being processed.
- Tenant ASR vendor, language, diarization, and vocabulary are configurable, with a documented fallback.
- Silent drop of capture is forbidden; pipeline failure is visible and logged.

#### US-CL-04 — See safe partial transcription

**Persona:** Clinician · **Sources:** A, B, D · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation)

> As a clinician, I want partial transcription to appear during the consultation so that documentation can begin without waiting until the end, without partial text becoming a signed fact.

The original XML mixed partial and final transcript into one string. Papers A, B, and D split `transcript.partial` (advisory, may churn) from `transcript.segment.finalized` (immutable). Only finalized segments trigger extraction, retrieval, and note patches. Partials may be shown in the UI. Every segment carries timestamps and speaker attribution. Uncertain spans are marked. Final reconciliation may supersede partials without deleting provenance.

**Original IDs:** A US-03 · B transcript.partial vs finalized · D speaker-aware events

**Acceptance criteria**

- Every segment has timestamps and speaker attribution.
- Uncertain / low-confidence text is visibly marked without relying only on color.
- Partial text cannot become a signed or verified fact without reconciliation.
- Final transcription may supersede partials; superseded spans remain in the event ledger.
- Downstream reasoning consumes finalized segments, not churning partials.

---

### Epic: Multimodal intake

#### US-CL-05 — Attach imaging or a radiology report

**Persona:** Clinician · **Sources:** A, B, C, D (all four) · **Related:** [UC-02](#uc-02--image-assisted-consultation), [UC-10](#uc-10--image-versus-speech-contradiction)

> As a clinician, I want to attach a CT/MRI/DICOM study or report so that relevant imaging information can be included in the consultation context, completely and defensibly.

Imaging is in the original XML (CT attach) and in every paper, with a shared safety line: prefer an authenticated radiology report over model-generated image interpretation. Image-derived suggestions are labeled, isolated from verified findings, and require clinician review before they enter the final note. Unsupported or corrupt files degrade safely. Patient, study, and modality metadata are checked. This is CDS/documentation assistance, not an unregulated diagnostic device.

**Original IDs:** A US-05 · B US-CL-03 · C US-3 · D image-assisted UC

**Acceptance criteria**

- System checks patient, study, and modality metadata before using the attachment.
- Authenticated radiology report is searched and preferred over image-only interpretation.
- Image-derived suggestions are labeled and isolated from verified findings.
- Unsupported, corrupt, or mismatched files degrade safely and do not block the rest of the session.
- Clinician review is mandatory before any image-derived content is included in the final note.

---

### Epic: Live synthesis and clinical decision support

#### US-CL-06 — Maintain an evolving work note

**Persona:** Clinician · **Sources:** A, C, D · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation)

> As a clinician, I want a continuously updated work note so that emerging findings, gaps, and contradictions stay organized during the consultation.

The work note is volatile operational state, not the final record. Updates are debounced (silence window or clinical-episode boundary), not generated per token. New content traces to transcript spans, attachments, or EHR resources. Provisional suggestions stay separated from documented facts. Clinician-authored text is never silently overwritten; the composer proposes section-level patches. Paper A separates work note, candidate final note, approved note, and committed record as four artifacts.

**Original IDs:** A US-06 · C US-4 · D incremental draft SOAP

**Acceptance criteria**

- Updates are debounced rather than generated for every token.
- New content is traceable to source segments or resources.
- Provisional suggestions are clearly separated from documented facts.
- User-authored text is protected from automatic overwrite; patches require a visible diff.
- Work note and candidate final note are distinct artifacts.

#### US-CL-07 — Ask evidence-grounded questions

**Persona:** Clinician · **Sources:** A, B, D · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation), [UC-03](#uc-03--terminology-standardization)

> As a clinician, I want the system to retrieve approved terminology and evidence so that I can independently assess its suggestions.

Clinical RAG is mandatory in papers A, B, and D. Patient-specific facts and general medical knowledge are retrieved separately, never from one undifferentiated index. Every retrieved item carries source, date, version, jurisdiction, and retrieval timestamp. Material claims are cited or labeled unsupported. Low-quality or conflicting retrieval abstains rather than guessing. The clinician must be able to review the basis of any recommendation.

**Original IDs:** A US-07 · B retrieval/citation · D FHIR-RAG-MEDS pattern

**Acceptance criteria**

- Sources are displayed with title, date, version, and publisher or system of record.
- Patient facts and general evidence are labeled as separate classes.
- Unsupported statements are removed or flagged; they cannot ride into the final note unlabeled.
- Conflicting or low-quality retrieval triggers abstention or clarification, not a blended answer.
- Clinician can open the cited source independently of the generated wording.

#### US-CL-08 — See live decision support without interrupting the note

**Persona:** Clinician · **Sources:** B, D · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation), [UC-14](#uc-14--low-confidence-safety-block)

> As a clinician, I want relevant guideline snippets, drug-interaction warnings, and differential candidates surfaced in a side panel as I speak, without interrupting the note draft.

Paper B separates CDS from documentation: the side panel is advisory and cited; the note composer does not auto-insert warnings as signed findings. Low-confidence medication mentions never auto-generate orders. Paper D adds care-plan and coding agents on the same pattern — suggestions, not writes, until a human gate. CDS is risk-tiered: safety alerts are high priority; style polish is low.

**Original IDs:** B US-CL-05 · D CDS / care-plan agents

**Acceptance criteria**

- CDS appears in a panel independent of the work-note composer.
- Guideline, interaction, and differential items are cited and labeled advisory.
- Low-confidence medication mentions never trigger auto-generated order suggestions.
- Safety alerts can interrupt; routine CDS does not rewrite the note.
- Clinician can dismiss an item; dismissal is logged and must not silently reappear in the same session.

#### US-CL-09 — Bind codes only through terminology tools

**Persona:** Clinician · **Sources:** B, C · **Related:** [UC-03](#uc-03--terminology-standardization), [UC-16](#uc-16--terminology-lookup-miss)

> As a clinician, I want coded findings mapped to approved terminology (SNOMED, ICD, LOINC, RxNorm/OMOP) through a controlled tool so that codes are auditable and not hallucinated.

Paper C’s hallucination-preventive pattern: the model does not free-generate clinical codes. The harness calls a terminology MCP server and binds only tool-verified matches. Unmapped terms are flagged for human review. Paper B fires this on entity detection (for example medication → interaction check + code map). No code is emitted into the note or EHR without a verified match or explicit clinician assignment.

**Original IDs:** C US-10 · B terminology MCP

**Acceptance criteria**

- No clinical code is free-generated by the model into the note or a write payload.
- Lookups go through the clinical tool gateway with patient/tenant scope and audit.
- Unmatched terms are flagged unmapped for human review; no guessed code is inserted.
- Bound codes carry code system, code, display, and lookup timestamp.

#### US-CL-10 — Override AI with an authoritative correction

**Persona:** Clinician · **Sources:** A, B, C, D (all four) · **Related:** [UC-08](#uc-08--correction-changes-a-high-risk-fact)

> As a clinician, I want my correction to override an AI-derived statement and re-evaluate dependents so that the note reflects my judgment and errors do not propagate.

Clinician edits are the highest-authority context items in the session. The harness preserves the edit, never silently restores old wording, and invalidates only affected derived artifacts (for example a medication name change re-runs interaction checks and regenerates those sections, not an unrelated attachment). Edit history remains available. Paper B re-runs the verifier incrementally on the edited section. Style/reflection learning from the edit is opt-in and never writes patient facts into the style profile.

**Original IDs:** A US-04 · B UC-05 · C US-8 · D ClinicianEdit

**Acceptance criteria**

- The correction becomes authoritative for all downstream drafting.
- Dependent sections and safety checks are re-evaluated; unrelated artifacts are not blindly regenerated.
- The system never silently restores the old wording.
- Edit history remains available for audit and QA.
- High-risk corrections (medication, allergy, dosage, identity, laterality) are highlighted in the next review diff.

#### US-CL-17 — See where each clause came from

**Persona:** Clinician · **Sources:** A, D (lifted from requirements) · **Related:** [UC-05](#uc-05--section-level-hitl-approval-and-commit), [UC-17](#uc-17--post-consultation-qa-provenance-review)

> As a clinician, I want every note clause labeled by origin — patient-reported, clinician-observed, imported history, or AI-derived — so that I know what I am signing.

Paper A’s documentation requirement FR-C01 and paper D’s rule to separate raw, inferred, verified, and approved content. Mixing these classes is the main context-contamination failure of the original XML. Attribution is a clinician-facing label as well as an audit field. Provisional information must not silently become verified.

**Original IDs:** A FR-C01 · D separate raw / inferred / verified / approved

**Acceptance criteria**

- Each clinically consequential clause carries an origin class: patient-reported, clinician-observed, imported, or AI-derived.
- Provisional information cannot silently become verified or approved.
- Origin labels are perceivable without relying solely on color.
- QA and the patient-visible artifact (where policy allows) can reconstruct the same origin split.

#### US-CL-18 — Receive assisted coding suggestions

**Persona:** Clinician · **Sources:** B, D (lifted from agent lists) · **Related:** [UC-03](#uc-03--terminology-standardization), [UC-05](#uc-05--section-level-hitl-approval-and-commit)

> As a clinician, I want suggested diagnosis and procedure codes after the note is verified so that coding is assisted without auto-committing claims.

Paper D’s coding agent and paper B’s coding assistant sit after verification, not in the live token stream. Suggestions are bound through terminology tools (US-CL-09), risk-tiered, and HITL-gated. They must not write to the EHR or billing system without explicit approval. Low-confidence mentions never become codes.

**Original IDs:** B coding assistant · D coding agent / finalization step 8

**Acceptance criteria**

- Coding suggestions appear only after verification of the supporting note sections.
- Each suggested code is tool-verified and cited to note clauses or source records.
- No code is written to EHR or billing without explicit authorized approval.
- Low-confidence or unmapped concepts stay unmapped rather than becoming guessed codes.

---

### Epic: Personalization

#### US-CL-11 — Learn documentation style safely

**Persona:** Clinician · **Sources:** A, B, C, D (all four) · **Related:** [UC-04](#uc-04--personalized-note-generation)

> As a clinician, I want the assistant to remember my documentation preferences so that future drafts require fewer formatting edits.

Called a documentation preference profile or writing-style DNA in the papers; A warns not to use “DNA” if it implies biometric data. The profile holds structure, abbreviations, verbosity, hedging, list-versus-narrative — never patient clinical facts. It is opt-in, editable, deletable, portable, tenant- and clinician-scoped. Learning is from approved notes and inspectable suggested updates, not covert psychological profiling. Preferences cannot override clinical or tenant safety rules. Paper B adds a cold start from specialty defaults plus a weekly reflection job that asks the clinician to confirm pattern updates.

**Original IDs:** A US-10 · B US-CL-04 · C US-6 · D writing-style DNA

**Acceptance criteria**

- Personalization is opt-in, reversible, exportable, and deletable by the clinician.
- Patient facts never enter the style profile; exemplars are scrubbed on erasure requests.
- Suggested preference changes are inspectable and human-approved before they influence generation.
- Preferences cannot override clinical, tenant, or safety rules.
- Learning uses clinician-approved notes only — never unsigned drafts or timed-out sessions.

---

### Epic: Review and finalization

#### US-CL-12 — Review a candidate final note

**Persona:** Clinician · **Sources:** A, B, D · **Related:** [UC-05](#uc-05--section-level-hitl-approval-and-commit), [UC-14](#uc-14--low-confidence-safety-block)

> As a clinician, I want a review-ready note that highlights unresolved and newly added content so that I can efficiently verify it.

Review-ready is a harness state, not a model opinion. Before the note is offered for approval, medication, allergy, laterality, dosage, negation, and patient-identity checks run, and missing required template sections are reported. Additions and changes since the last review are highlighted. Paper B’s evaluator scores grounding, completeness, and safety and can request bounded regeneration. Paper A forbids presenting a generic model percentage as clinical probability.

**Original IDs:** A US-08 · B verifier completeness · D verification gate

**Acceptance criteria**

- Additions and changes since the previous review are highlighted.
- Medication, allergy, laterality, dosage, negation, and patient-identity checks run before approval is offered.
- Missing required template sections are reported.
- Unresolved questions and contradictions remain visible; they are not auto-closed.
- Confidence is a calibrated system measure, retrieval quality, or labeled model self-assessment — not a clinical probability.

#### US-CL-13 — Approve, edit, or reject by section

**Persona:** Clinician · **Sources:** A, B, D · **Related:** [UC-05](#uc-05--section-level-hitl-approval-and-commit)

> As a clinician, I want to approve, edit, or reject each section of the final summary independently, with an audit trail on every decision, so that I retain control without rewriting the whole note.

Section-level HITL is explicit in papers A, B, and D. Rejected sections can be regenerated; approved sections are frozen against automatic overwrite. Only when all required sections are approved does the harness enter finalization. QA can later see which sections were AI-accepted versus rewritten. This is the product expression of “the drafted note is not the final record.”

**Original IDs:** A US-08 · B US-CL-06 · D section-level HITL

**Acceptance criteria**

- Approve, edit, and reject are available per required section, not only document-level.
- Each decision is a separate audit event.
- Rejected sections can be returned for regeneration without wiping approved sections.
- User-authored text in a section is protected from automatic overwrite.
- FINALIZED is unreachable until all required sections are approved.

#### US-CL-14 — Finalize only with explicit responsibility

**Persona:** Clinician · **Sources:** A, B, C, D (all four) · **Related:** [UC-05](#uc-05--section-level-hitl-approval-and-commit), [UC-12](#uc-12--session-timeout-without-approval)

> As a clinician, I want the final note stored only after my approval so that clinical accountability remains clear.

The strongest shared safety rule in the package: timeout is not approval, and the system never signs on behalf of the clinician. If policy allows keeping an unsigned draft on timeout, it remains visibly unsigned. Commit is transactional and idempotent, with provenance for human author, AI assistance, model/prompt versions, input sources, and the approval event. Paper C frames shutdown as a two-phase commit: drain agents, then human-gated close.

**Original IDs:** A US-09 · B US-CL-06 · C US-7 · D finalization

**Acceptance criteria**

- Timeout never substitutes for clinical approval.
- If an unsigned draft is retained, it is visibly unsigned and cannot be treated as a signed record.
- Commit is transactional and idempotent, with record-version checks.
- Provenance records human author, AI assistance, model version, sources, and approval event.
- The system never signs on behalf of the clinician.

#### US-CL-15 — Get a template-conformant summary

**Persona:** Clinician · **Sources:** B, C, D · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation), [UC-04](#uc-04--personalized-note-generation)

> As a clinician, I want the Final Summary to follow my organization’s note template so that it is immediately usable in the EHR.

Tenant templates (SOAP, HPI, procedure, discharge, specialty briefs) are the documentation contract. The verifier enforces required sections before review-ready. Paper B allows switching templates without regenerating evidence from scratch — evidence is reformatted, provenance kept. Template version used is stored on the committed note.

**Original IDs:** C US-5 · B template aligner · D SOAP/APSO

**Acceptance criteria**

- Output renders against the tenant template for this specialty and encounter type.
- Required sections are enforced before the note is offered as review-ready.
- The template version used is recorded in provenance.
- Switching templates reformats existing evidence rather than inventing new clinical content.

#### US-PT-04 — Receive after-visit information only from approved notes

**Persona:** Patient · **Sources:** D · **Related:** [UC-05](#uc-05--section-level-hitl-approval-and-commit), [UC-12](#uc-12--session-timeout-without-approval)

> As a patient, I want understandable after-visit information that reflects what my clinician approved so that I do not receive unreviewed AI text.

Paper D’s patient persona. After-visit summaries, instructions, and patient-facing messages are high-risk writes. They generate only from the approved note, never from an open session or unsigned draft. Language must be understandable, not a dump of the clinician SOAP.

**Original IDs:** D patient persona

**Acceptance criteria**

- After-visit content is generated only from the clinician-approved note.
- It never ships from an unsigned draft, timed-out session, or live work note.
- Patient-facing text is itself approval-gated.
- Wording is understandable and consistent with what the clinician signed.

---

### Epic: Continuity and interruption

#### US-CL-16 — Pause and resume without losing work

**Persona:** Clinician · **Sources:** B, D · **Related:** [UC-13](#uc-13--interrupted-consultation), [UC-07](#uc-07--telehealth-consultation)

> As a clinician, I want to pause the session, step out, and come back later without losing transcript, extractions, or drafts so that a real consult is not lost to interruption.

Consultations are long-running and interruptible. Paper B requires durable checkpoints so resume restores state bit-for-bit — no re-transcription of prior speech, no re-extraction, no re-retrieval. A pause beyond a tenant cap auto-drafts what exists and waits for HITL rather than discarding. Paper D adds network-drop checkpointing of the event ledger, draft deltas, evidence ledger, and open tasks.

**Original IDs:** B US-CL-07 · D interrupted session

**Acceptance criteria**

- Pause persists a durable checkpoint of transcript, extractions, drafts, and open tasks.
- Resume within the retention window restores state without re-processing prior audio.
- A pause beyond the tenant cap auto-drafts available content and enters awaiting-review, not discard.
- Cancellation checkpoints raw transcript, current draft, evidence ledger, and open tasks.

#### US-TH-01 — Resume a dropped remote session

**Persona:** Telehealth clinician · **Sources:** D · **Related:** [UC-07](#uc-07--telehealth-consultation), [UC-13](#uc-13--interrupted-consultation)

> As a telehealth clinician, I want live transcript, patient context, and connectivity-aware checkpointing so that an interrupted remote session can resume safely.

Paper D’s third channel on the same control plane: in-room, multi-clinician, and telehealth. Telehealth adds video/chat/consent events and treats network drop as a first-class interruption. Resume rebuilds from the event ledger rather than re-capturing prior audio. Same approval and provenance rules as in-room care.

**Original IDs:** D telehealth clinician + telehealth UC

**Acceptance criteria**

- Audio, video, chat, and consent events share the same session event ledger.
- Network drop checkpoints transcript, draft deltas, evidence ledger, and open tasks.
- Resume does not re-capture or re-bill prior audio.
- Consent and identity are re-validated if the drop exceeded policy.

---

### Epic: Specialty collaboration

#### US-SP-01 — Open a specialty briefing

**Persona:** Specialist · **Sources:** B, D · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation), [UC-06](#uc-06--multidisciplinary-consultation)

> As a specialist, I want imaging findings, labs, and prior notes consolidated into a specialty-appropriate briefing template so that I can start the consult with structured context.

Same evidence board, different template. A cardiology referral and a radiology over-read should not share a generic SOAP dump. Source links stay on every briefing item. Silent regeneration that drops provenance is forbidden. This is the multi-specialty product of the original single-timeline XML.

**Original IDs:** B US-SP-01 · D specialist consult brief

**Acceptance criteria**

- Briefing uses the specialty/encounter template, not a generic dump of the whole chart.
- Imaging, labs, and prior notes are source-linked.
- Regeneration cannot drop provenance or mix specialties’ required sections.
- The referring question, if present, is a first-class briefing item.

#### US-SP-02 — Cite guidelines on recommended plans

**Persona:** Specialist · **Sources:** B, D · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation), [UC-06](#uc-06--multidisciplinary-consultation)

> As a specialist, I want every recommended plan to cite the guideline (for example NCCN, AJCC, ESC, or tenant SOP) with version and effective date so that recommendations are auditable.

Specialist CDS is guideline-grounded. Retrieval filters by effective dates so stale pathways are not cited as current. Tenant allowlists and precedence (US-AD-03) decide which sources may appear. Uncited plan language is blocked by the verifier.

**Original IDs:** B US-SP-02 · D guideline retrieval

**Acceptance criteria**

- Each recommended plan item cites guideline, version, and effective date.
- Stale guidelines (outside `effective_from` / `effective_to`) are not offered as current.
- Tenant-disabled sources never appear.
- Uncited plan language cannot pass verification.

#### US-SP-03 — Leave a structured handoff

**Persona:** Specialist · **Sources:** B · **Related:** [UC-06](#uc-06--multidisciplinary-consultation)

> As a specialist, I want to leave a structured handoff item — question, recommendation, or red flag — for the referring clinician so that it persists into their next session.

Unique to paper B. Handoffs must not be buried in free-text narrative if they are meant to drive the next encounter. They are typed context items that survive session close under retention policy and show up in the referring clinician’s priming brief.

**Original IDs:** B US-SP-03

**Acceptance criteria**

- Handoff is a typed context item (question, recommendation, or red flag), not only free text.
- It survives session close under the retention policy and appears in the next relevant priming brief.
- The accountable author and timestamp are recorded.
- Safety-critical red flags cannot be dropped by summarization.

#### US-NU-01 — Extract follow-up tasks from the consult

**Persona:** Nurse · **Sources:** D · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation), [UC-05](#uc-05--section-level-hitl-approval-and-commit)

> As a nurse, I want action items and care-plan updates extracted from the consultation so that follow-up tasks are not missed.

Unique to paper D’s nurse persona and care-plan agent. Tasks are suggestions until a clinician or nurse confirms them. The harness must not auto-commit orders, referrals, or schedule writes. Extraction should run off the approved or explicitly confirmed note sections, not off churning partial transcript.

**Original IDs:** D nurse persona

**Acceptance criteria**

- Action items are listed with source spans in the consultation.
- Items are labeled suggestions until clinician or nurse confirmation.
- No auto-committed orders, prescriptions, or referrals.
- Confirmed tasks can flow to the tenant task/scheduling connector through the same approval gateway as other writes.

---

### Epic: Documentation operations

#### US-SC-01 — Review a cited draft efficiently

**Persona:** Scribe · **Sources:** B, D · **Related:** [UC-05](#uc-05--section-level-hitl-approval-and-commit), [UC-17](#uc-17--post-consultation-qa-provenance-review)

> As a scribe, I want the drafted note surfaced with in-line citations, per-clause confidence, and gaps highlighted so that I can prioritize review.

Scribes (and AI-augmented documentation specialists) need a review surface that is denser than the clinician’s live panel. Gaps versus the tenant template, unsupported clauses, and low-confidence spans should sort the work. Confidence must not be presented as clinical probability.

**Original IDs:** B US-SC-01 · D scribe draft labels

**Acceptance criteria**

- In-line citations are present on clinically consequential clauses.
- Gaps versus the required template are highlighted.
- Per-clause confidence is calibrated or clearly labeled, never as a clinical probability.
- The scribe can jump from a clause to transcript span, retrieved snippet, or HITL history.

#### US-SC-02 — Switch templates without full regeneration

**Persona:** Scribe · **Sources:** B · **Related:** [UC-05](#uc-05--section-level-hitl-approval-and-commit)

> As a scribe, I want to switch between templates (SOAP, HPI-only, procedure note, discharge) without regenerating from scratch so that existing evidence is reused rather than rewritten.

Unique to paper B. Template change is a re-projection of the evidence board, not a new clinical inference pass. Provenance stays. Missing sections for the new template are reported as gaps, not filled with invented content.

**Original IDs:** B US-SC-02

**Acceptance criteria**

- Existing evidence is reformatted into the new template.
- Provenance on each clause is preserved.
- New required sections appear as gaps, not as fabricated narrative.
- The template switch is audited.

#### US-SC-03 — See draft vs verified vs approved labels

**Persona:** Scribe · **Sources:** D · **Related:** [UC-05](#uc-05--section-level-hitl-approval-and-commit)

> As a scribe, I want AI-generated sections clearly labeled as draft, verified, or clinician-approved so that I never confuse model output with the signed record.

Paper D’s scribe story, aligned with A’s four-artifact split. The label is operational state on the section, not a style flourish. Mixing states in one paragraph is a defect.

**Original IDs:** D medical scribe

**Acceptance criteria**

- Every section shows one of draft, verified, or clinician-approved (plus rejected/regenerating as needed).
- Raw, inferred, verified, and approved content are never blended in a single unlabeled block.
- Only clinician-approved sections are eligible for the committed record.

#### US-QA-01 — Open the provenance graph of a finalized note

**Persona:** QA reviewer · **Sources:** B, D · **Related:** [UC-17](#uc-17--post-consultation-qa-provenance-review)

> As a QA reviewer, I want to open any finalized note and see the full provenance graph — transcript spans, retrieved snippets, tool calls, evaluator scores, and HITL edits — so that I can audit how the note was produced.

Post-hoc explainability is a named use-case in papers B and D. QA is a distinct persona from the attending: they arrive after FINALIZED and must reconstruct production without access to live session memory.

**Original IDs:** B US-QA-01 · D post-consult review

**Acceptance criteria**

- Per-clause links exist to transcript span, retrieved snippets, MCP/tool calls, evaluator score, and HITL history.
- Superseded versions are available to audit queries even if hidden from the clinical UI.
- The graph is complete enough to replay how the clause was produced.
- Access to QA provenance is itself audited and tenant-scoped.

#### US-QA-02 — See quality trends across the tenant

**Persona:** QA reviewer · **Sources:** B · **Related:** [UC-17](#uc-17--post-consultation-qa-provenance-review)

> As a QA reviewer, I want per-clinician rejection rates, per-template completeness scores, and per-guideline citation frequencies so that quality drift is visible.

Paper B’s trend story. Aggregates are over approved notes. Default views are de-identified at the patient level. These metrics also feed DNA/template retraining gates and canary rollback.

**Original IDs:** B US-QA-02

**Acceptance criteria**

- Dashboards cover accept/edit/reject rates, template completeness, and guideline citation frequency.
- Aggregates use approved notes only.
- Patient-identifying drill-down is off by default and authorization-gated.
- Time range and specialty filters are available.

#### US-AD-01 — Configure and version note templates

**Persona:** Tenant admin · **Sources:** B, C, D · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation)

> As a tenant admin, I want to create, version, A/B test, and roll back note templates per specialty and encounter type so that outputs meet our documentation standards.

Templates are tenant-owned procedural memory, not clinician DNA. Version history and rollback are required because a bad template ships into live consults. Paper B adds A/B testing; paper C bundles this with audio-pipeline control as governance.

**Original IDs:** B US-AD-01 · C US-9 · D administrator workflows

**Acceptance criteria**

- Templates are scoped by tenant, specialty, and encounter type.
- Version history and rollback exist.
- Required-section schema is explicit and enforced by the verifier.
- A/B or staged rollout does not mix template versions inside one session.

#### US-AD-02 — Configure the audio pipeline and fallback

**Persona:** Tenant admin · **Sources:** B, C · **Related:** [UC-15](#uc-15--asr-pipeline-failure-then-fallback)

> As a tenant admin, I want to configure which ASR vendor is used — including language, diarization strategy, and vocabulary — with a documented default fallback, so that capture remains available if the primary pipeline fails.

Vendor lock-in on ASR is a named risk in paper B. The fallback must be explicit, tested, and logged. Clinicians should see that fallback is in use; they should not discover it after a silent empty transcript.

**Original IDs:** B US-AD-02 · C US-9 / UC-1 alternate

**Acceptance criteria**

- Primary vendor, language, diarization, and vocabulary are configurable per tenant.
- A documented default fallback exists and is exercised in failure drills.
- Fallback activation is visible to the clinician and audited.
- Silent drop of capture is forbidden.

#### US-AD-03 — Control the guideline library

**Persona:** Tenant admin · **Sources:** B · **Related:** [UC-01](#uc-01--happy-path-ambient-consultation)

> As a tenant admin, I want to control which guideline sources are enabled and which take precedence on conflict so that retrieval stays inside approved clinical policy.

Unique to paper B. The RAG stack is not “the open web.” Allowlists, precedence, and jurisdiction/effective-date filters are tenant policy. Conflicts are surfaced, not silently ranked into a single answer.

**Original IDs:** B US-AD-03

**Acceptance criteria**

- Enabled sources are an explicit allowlist.
- Precedence is defined for conflicts between sources.
- Disabled or out-of-jurisdiction sources are not retrieved for generation.
- Conflicts are visible to clinicians rather than silently blended.

#### US-AD-05 — Operate quality and throughput dashboards

**Persona:** Tenant admin · **Sources:** D · **Related:** [UC-11](#uc-11--agent-timeout-with-safe-degradation), [UC-17](#uc-17--post-consultation-qa-provenance-review)

> As an administrator, I want configurable workflows and audit dashboards for quality, throughput, and compliance review so that operations can see how the harness is behaving.

Paper D’s administrator story plus paper A’s online metrics: time to first partial, time to review-ready, edit distance, timeout rate, stale-result rejections, safety-block frequency, audit completeness. This is operations, not clinical QA (US-QA-02), though they share some series.

**Original IDs:** D administrator

**Acceptance criteria**

- Dashboards include time-to-review-ready, edit distance, timeout/cancellation rate, and safety-block frequency.
- Workflow configuration (debounce, budgets, HITL gates) is tenant-scoped and versioned.
- Metrics are tenant-isolated.

---

### Epic: Governance and privacy

#### US-AD-04 — Set retention TTLs by artifact class

**Persona:** Tenant admin · **Sources:** B · **Related:** [UC-18](#uc-18--consent-revocation-and-gdpr-erasure)

> As a tenant admin, I want to set retention TTLs per artifact class per jurisdiction so that session scratch, drafts, and finalized notes expire correctly.

Paper B proposes class-level TTL (raw ASR, accepted segments, drafts, finalized notes, style profiles, episodic summaries). Paper A insists canonical patient history stay in the EHR, with agent memory holding links and derived summaries that expire. Policy must be exportable for DPIA.

**Original IDs:** B US-AD-04

**Acceptance criteria**

- TTL is configurable per artifact class and jurisdiction.
- Raw scratch and unapproved drafts expire independently of the finalized EHR note.
- Style profiles follow clinician ownership and revocation, not patient retention.
- Policy is exportable and changes are audited.

#### US-CO-01 — Keep an immutable audit ledger

**Persona:** Compliance / DPO · **Sources:** A, B, C, D (all four) · **Related:** [UC-17](#uc-17--post-consultation-qa-provenance-review)

> As a compliance officer, I want every PHI access, model call, tool call, and HITL decision recorded on an immutable, tamper-evident ledger so that the system can satisfy HIPAA audit controls.

Present in all four papers. FHIR-style split: provenance on how an artifact was produced, AuditEvent for operational access. The ledger covers prompts/outputs as permitted, retrieved sources, tool calls, approvals, overrides, and finalization. Paper B maps this to 45 CFR §164.312(b). Paper A adds that model, prompt, tool, policy, source, and artifact versions are all recorded.

**Original IDs:** A FR-H02 · B US-CO-01 · C US-11 · D compliance officer

**Acceptance criteria**

- Each event records actor, patient, resource, purpose, timestamp, and outcome.
- The ledger is append-only and tamper-evident.
- Coverage includes PHI access, model calls, tool calls, HITL decisions, overrides, and finalization.
- Operational audit and artifact provenance are both retained.

#### US-CO-02 — Honor data-subject rights across memory tiers

**Persona:** Compliance / DPO · **Sources:** B · **Related:** [UC-18](#uc-18--consent-revocation-and-gdpr-erasure)

> As a DPO, I want a documented, automated path for GDPR access, rectification, portability, restriction, and erasure requests so that they cascade into embeddings, caches, and memory tiers.

Paper B’s DPO story and UC-18. Erasure is incomplete if vector stores, style exemplars, and caches keep the patient. Finalized notes already in the EHR follow EHR retention; the harness does not silently delete them, but records revocation for downstream systems. Regular DPIA review is part of the requirement, not only a one-shot job.

**Original IDs:** B US-CO-02

**Acceptance criteria**

- Access, rectification, portability, restriction, and erasure have documented automated paths.
- Erasure cascades to episodic memory, caches, and patient-linked style exemplars.
- Committed EHR notes are not silently deleted; revocation is recorded for downstream systems.
- Each request and job result is audited.

#### US-CO-03 — Enforce consent at the tool gateway

**Persona:** Compliance / DPO · **Sources:** A, B · **Related:** [UC-18](#uc-18--consent-revocation-and-gdpr-erasure)

> As a compliance officer, I want the tool gateway to deny any call that does not match the patient’s active consent scope, with a logged denial, so that purpose-of-use is enforced at the connector boundary.

MCP is not the security boundary — the clinical tool gateway is (papers A and B). Every outbound call checks user, tenant, patient, encounter, purpose of use, and consent. Write-capable tools need stronger authorization. After revocation, future calls are blocked. Denials are first-class audit events.

**Original IDs:** B US-CO-03 · A consent / purpose-of-use

**Acceptance criteria**

- Calls that fail consent or purpose-of-use are denied, not best-effort executed.
- Denials are logged with patient, tool, purpose, and actor.
- Revocation blocks subsequent scoped calls from `t_revoke`.
- Write-capable tools require explicit harness approval in addition to consent.

#### US-PT-01 — Grant and revoke AI-documentation consent

**Persona:** Patient · **Sources:** B · **Related:** [UC-18](#uc-18--consent-revocation-and-gdpr-erasure)

> As a patient, I want to grant, view, revoke, and time-limit my consent for AI-assisted documentation, and I want that revocation to propagate to every derived artifact.

Paper B’s patient-direct consent story. Consent is purpose-scoped (treatment, research, secondary use, AI-drafting). Revocation propagates: new tool calls stop; memory tiers scrub per policy. This is the human-facing side of US-CO-03 and UC-18.

**Original IDs:** B US-PT-01

**Acceptance criteria**

- Patient can grant, view, revoke, and time-limit consent per purpose.
- Revocation propagates to derived agent-memory artifacts per policy.
- The control is available without requiring the clinician to act as a proxy, where regulation requires it.
- Status is visible to the clinician at session open.

#### US-PT-02 — See which parts of the note were AI-drafted

**Persona:** Patient · **Sources:** B · **Related:** [UC-05](#uc-05--section-level-hitl-approval-and-commit)

> As a patient, I want to know which parts of my note were AI-drafted and where the AI’s suggestions came from so that the record is transparent to me.

Transparency toward the patient, not only QA. Where policy allows a patient-visible artifact, AI-assisted versus clinician-authored labeling should match the origin classes in US-CL-17, in understandable language.

**Original IDs:** B US-PT-02

**Acceptance criteria**

- Patient-visible artifacts label AI-assisted versus clinician-authored content where policy allows.
- Suggestions’ source class is explained in non-technical language.
- Unsigned or unapproved AI text is never sent to the patient.

---

## 4. Use-cases

---

### Happy path

#### UC-01 — Happy-path ambient consultation

**Kind:** Happy path · **Sources:** A, B, C, D (all four)

The core in-room visit: prime history, stream transcription, debounce a work note, retrieve evidence only for identified questions, stop and drain, section-level HITL, transactional commit, then close.

**Actors:** Clinician, patient (in room), harness, compliance, history summarizer, ASR/perception, NLP/reasoner, retrieval, note composer, verifier, EHR via MCP

**Related stories:** US-CL-01, US-CL-03, US-CL-06, US-CL-14, US-CL-15

**Original IDs:** A UC-01 · B UC-01 · C UC-1 · D single-provider

**Preconditions**

- Clinician authenticated; patient and encounter bound.
- Consent active for AI-drafting; ABAC scope resolved.
- Tenant template and audio pipeline loaded.

**Trigger:** Clinician opens the encounter and starts Record after consent and access checks succeed.

**Main flow**

1. Harness opens the session, validates identity, role, encounter, consent, and tenant policy, and appends `session.opened` to the immutable log.
2. Initializer fetches demographics, allergies, problems, meds (EHR), last N encounter summaries (episodic memory), clinician style profile, and the specialty template, then builds a session progress manifest.
3. History summarizer produces a source-linked, provisional encounter brief. Imported facts stay distinct from this-visit facts.
4. Perception starts. ASR emits `transcript.partial` for display and `transcript.segment.finalized` as immutable evidence. Finalized segments pass PHI sanitization before reasoning.
5. On each finalized segment, the reasoner extracts entities, binds terminology via MCP, and — if a medication is detected — calls drug-interaction check. Retrieval runs only for identified questions or emerging problems.
6. After a debounce window (silence or episode boundary), the composer proposes section-level work-note patches. The verifier scores grounding, completeness, and safety. Failure requests bounded regeneration.
7. Clinician may edit at any time. Edits are authoritative HITL events and cannot be silently overwritten.
8. Clinician stops recording. Perception drains in-flight audio to finalized segments. Harness runs final transcript reconciliation and full-session synthesis. Optional non-critical tasks are not waited on forever.
9. Candidate final note is presented with diffs, unresolved items, and missing required sections. Harness enters durable `AWAITING_HITL`.
10. Clinician approves, edits, or rejects per section. Required sections must all be approved.
11. Harness commits transactionally: EHR write (for example Encounter + DocumentReference), provenance, audit snapshot. Style/reflection memory updates only from approved deltas. Short-term context expires per policy. Session `CLOSED`.

**Alternate / exception flows**

- Consent or ABAC failure at open → abort, audit, no capture.
- ASR failure → [UC-15](#uc-15--asr-pipeline-failure-then-fallback) fallback pipeline.
- Non-critical agent timeout → [UC-11](#uc-11--agent-timeout-with-safe-degradation) degrade and abstain.
- Contradiction on allergy/meds/identity → [UC-09](#uc-09--history-conflicts-with-current-statement), may block finalization.
- No approval before wall-clock cap → [UC-12](#uc-12--session-timeout-without-approval) unsigned draft, never silent close.

**Postconditions**

- Approved note persisted in the system of record.
- Audit trail and provenance complete.
- Memory tiers updated only from approved artifacts.
- Session archived; scratch expired per TTL.

#### UC-02 — Image-assisted consultation

**Kind:** Happy path · **Sources:** A, B, C, D (all four)

Mid-session CT/MRI/DICOM or radiology-report attach joins the evidence board without becoming an unreviewed diagnosis.

**Actors:** Clinician, harness, attachment intake, imaging intake, vision/perception, retrieval (radiology reports), note composer, verifier

**Related stories:** US-CL-05, US-SP-01

**Original IDs:** A US-05 · B UC-02 · C UC-1 multimodal · D image-assisted

**Preconditions**

- Session is `STREAMING` or `DRAFTING`.
- Patient identity already bound.

**Trigger:** Clinician attaches a CT/MRI/DICOM study or a radiology report during the visit.

**Main flow**

1. Intake validates type, malware/safety scan, and patient/study/modality metadata.
2. Harness searches for an authenticated radiology report first and attaches it as the preferred clinical source.
3. If only images are present, the imaging worker extracts metadata and available text. Structured findings (for example RadLex-mapped) are labeled image-derived and isolated from verified findings.
4. Context synthesizer reconciles imaging with spoken statements and prior notes. Contradictions become contradiction items (see [UC-10](#uc-10--image-versus-speech-contradiction)), not silent merges.
5. Work-note sections update by patch after debounce. Image-derived suggestions stay out of the candidate final note until clinician review.
6. Clinician reviews and accepts, edits, or rejects imaging-derived content before finalization.

**Alternate / exception flows**

- Unsupported, corrupt, or mismatched patient/study → degrade safely; do not block transcription; flag for clinician.
- No radiology report available → proceed with labeled, review-gated image-derived suggestions only; do not invent a definitive CT diagnosis unless the product is validated for that intended use.

**Postconditions**

- Attachment references and any accepted findings are in session context with provenance.
- Unreviewed image-derived content is not in the committed note.

#### UC-03 — Terminology standardization

**Kind:** Happy path · **Sources:** B, C

A candidate clinical concept is bound only through a terminology tool. No code is emitted without a verified match.

**Actors:** Harness, NLP/reasoner, terminology MCP, note composer, clinician

**Related stories:** US-CL-09, US-CL-18

**Original IDs:** C UC-2 · B terminology MCP on entity detect

**Preconditions**

- A finalized transcript segment or note clause contains a candidate concept.
- Terminology server is in the tenant allowlist.

**Trigger:** Reasoner detects a candidate clinical concept (problem, medication, finding, procedure).

**Main flow**

1. Harness classifies the information need as terminology lookup, not general literature search.
2. Clinical tool gateway enforces scope, consent, rate limits, and audit, then calls `search` / `get_concept` on the terminology MCP.
3. On a verified match, the coded concept (system, code, display) is written as a typed context item with lookup timestamp and confidence/retrieval metadata.
4. Note composer may show the bound code in the work note as structured data, not as free-generated digits.

**Alternate / exception flows**

- No match → [UC-16](#uc-16--terminology-lookup-miss) unmapped flag; no guessed code.
- Terminology timeout → [UC-11](#uc-11--agent-timeout-with-safe-degradation); note shows verification unavailable.

**Postconditions**

- Either a tool-verified code is bound, or the term is explicitly unmapped.
- The lookup is in the audit ledger.

#### UC-04 — Personalized note generation

**Kind:** Happy path · **Sources:** A, B, C, D (all four)

The composer fills the tenant template, then adapts phrasing and structure from an opt-in style profile built only from approved notes.

**Actors:** Note composer, style/procedural memory, clinician, harness

**Related stories:** US-CL-11, US-CL-15

**Original IDs:** C UC-3 · A US-10 · B DNA injection · D LTM style

**Preconditions**

- Clinician has opted in, or specialty-default profile is in use as cold start.
- Style profile contains no patient clinical data.

**Trigger:** Note composer runs (debounced work-note update or candidate-final pass).

**Main flow**

1. Harness injects the versioned style contract (and bounded few-shot exemplars) as documentation preference, separate from patient evidence.
2. Composer fills required template sections from the evidence board, then applies style (order, abbreviations, verbosity, hedging).
3. Verifier still enforces grounding and safety; style cannot waive those checks.
4. After HITL, accepted diffs may be proposed as profile updates for clinician confirmation (paper B weekly reflection; paper A inspectable suggestions).

**Alternate / exception flows**

- Clinician has opted out → specialty/tenant default template only.
- Unsigned or timed-out session → no style-memory write ([UC-12](#uc-12--session-timeout-without-approval)).

**Postconditions**

- Draft matches template plus permitted style.
- Style profile unchanged unless the clinician approved a preference update.

#### UC-05 — Section-level HITL approval and commit

**Kind:** Happy path · **Sources:** A, B, C, D (all four)

Review-ready candidate note is decided section by section. The record is written only after required sections are approved.

**Actors:** Clinician or scribe, harness, verifier, finalization/commit, EHR, audit ledger

**Related stories:** US-CL-12, US-CL-13, US-CL-14, US-SC-03

**Original IDs:** A UC-01 steps 10–12 · B UC-06 · C UC-4 · D human-review

**Preconditions**

- Transcription drained or session otherwise review-ready.
- Verifier has run grounding, completeness, and safety checks.

**Trigger:** Harness presents a review-ready candidate final note.

**Main flow**

1. UI highlights additions since last review, unresolved contradictions, and missing required sections.
2. Clinician or scribe approves, edits, or rejects each required section. Each decision is an audit event.
3. Edits re-run incremental verification on affected sections ([UC-08](#uc-08--correction-changes-a-high-risk-fact) if high-risk).
4. When all required sections are approved, harness starts the finalization transaction: convert approved draft to the clinical-record representation, write EHR, write provenance, write audit snapshot.
5. Commit uses idempotency keys and optimistic concurrency. Success → `FINALIZED` then `CLOSED`. Failure → not silently marked approved; retry or compensate.

**Alternate / exception flows**

- Any required section still rejected or incomplete → remain in `AWAITING_HITL`.
- Timeout waiting for approval → [UC-12](#uc-12--session-timeout-without-approval).
- Safety-critical unresolved contradiction → block ([UC-09](#uc-09--history-conflicts-with-current-statement) / [UC-14](#uc-14--low-confidence-safety-block)).

**Postconditions**

- Committed note matches approved sections.
- Provenance includes human author, AI assistance, versions, sources, approval events.
- System did not sign for the clinician.

#### UC-06 — Multidisciplinary consultation

**Kind:** Happy path · **Sources:** D

A shared evidence board with a supervisor routing specialist workers. Conflicts are resolved by an accountable final author, not a silent merge.

**Actors:** Referring clinician, specialists, harness/supervisor, specialist agents, shared evidence board, accountable final author

**Related stories:** US-SP-01, US-SP-02, US-SP-03

**Original IDs:** D multidisciplinary consultation

**Preconditions**

- Encounter type is team or referral consult.
- Participants have role-appropriate ABAC grants on the same patient/encounter.

**Trigger:** Team consult starts, or a specialist is routed onto a shared evidence board.

**Main flow**

1. Harness opens a shared blackboard: problem list, evidence cards, open questions, contradictions, tasks, draft sections, approval state.
2. Supervisor routes specialty-appropriate briefing (US-SP-01) and specialist agents; group-chat style iteration is bounded by max turns and an accountable author.
3. Specialists may leave structured handoff items (US-SP-03).
4. Conflicts between specialist outputs escalate to HITL merge; nothing is dropped silently.
5. Final note has one accountable author. Section approvals still apply.

**Alternate / exception flows**

- Participant lacks consent/ABAC → they cannot see PHI; denial audited.
- Unbounded group discussion → harness enforces iteration/token/time caps.

**Postconditions**

- One committed note with accountable author and specialist contributions attributed.
- Handoff items persist for the next relevant session.

#### UC-07 — Telehealth consultation

**Kind:** Happy path · **Sources:** D

Remote visit on the same harness control plane, with chat/video/consent events and connectivity-aware resume.

**Actors:** Telehealth clinician, patient, telehealth platform connector, harness, ASR, note composer

**Related stories:** US-TH-01, US-CL-16

**Original IDs:** D telehealth consultation

**Preconditions**

- Telehealth session and consent events are bound to the same encounter.
- Audio/video pipeline is the tenant telehealth configuration.

**Trigger:** Remote audio/video session starts, or chat/consent events arrive.

**Main flow**

1. Harness treats telehealth as a channel over the same state machine, not a separate product.
2. Transcript, chat, and consent events append to the same event ledger.
3. Drafting, verification, and HITL follow [UC-01](#uc-01--happy-path-ambient-consultation).
4. On connectivity loss, checkpoint transcript, draft deltas, evidence ledger, and open tasks ([UC-13](#uc-13--interrupted-consultation)).
5. On resume, restore from the ledger; do not re-capture prior audio.

**Alternate / exception flows**

- Drop exceeds policy → re-validate consent/identity; auto-draft and await HITL rather than discard.
- Chat-only interval → still typed events; not mixed into transcript without speaker/source labels.

**Postconditions**

- Same commit and provenance rules as in-room care.
- Interruption is recoverable from the event ledger.

---

### Safety / exception

#### UC-08 — Correction changes a high-risk fact

**Kind:** Safety / exception · **Sources:** A, B, C, D (all four)

A clinician correction to medication, allergy, dosage, laterality, or identity invalidates dependents and shows a diff — it does not silently rewrite the rest of the note.

**Actors:** Clinician, harness, medication/safety retrieval, note composer, verifier

**Related stories:** US-CL-10

**Original IDs:** A UC-02 · B UC-05 · C US-8 · D ClinicianEdit

**Preconditions**

- A derived statement exists (often marked provisional or uncertain).

**Trigger:** Clinician corrects an uncertain medication, allergy, dosage, laterality, or identity span.

**Main flow**

1. Harness records the correction as an authoritative HITL edit; old derived wording is superseded, not erased.
2. Only affected derived artifacts are invalidated (medication sections, interaction summary, related plan language).
3. Permitted medication/safety retrieval is re-run through the gateway.
4. Affected note sections are regenerated as patches. Unrelated attachments and sections are left alone.
5. Verifier re-runs incrementally. Clinician is shown the resulting diff.

**Alternate / exception flows**

- Correction is low-risk wording → still authoritative, but skip heavy retrieval if policy allows.
- Retrieval unavailable → show verification unavailable; do not guess the new interaction profile.

**Postconditions**

- Note and safety artifacts match the clinician’s correction.
- Edit history is intact for QA.

#### UC-09 — History conflicts with current statement

**Kind:** Safety / exception · **Sources:** A, D

Prior note and live transcript disagree. The system creates a contradiction item and asks the clinician; it does not pick a winner.

**Actors:** Harness, context synthesizer, clinician, verifier

**Related stories:** US-CL-01, US-CL-12, US-CL-14

**Original IDs:** A UC-04 · D low-confidence / contradiction

**Preconditions**

- A prior-note fact and a current-visit statement occupy the same slot (for example allergy status).

**Trigger:** Synthesizer detects a conflict between imported history and current transcript or clinician input.

**Main flow**

1. A typed contradiction item is written with both sources, timestamps, and a `contradicts` link. Neither value is deleted.
2. Work note surfaces the conflict. Finalization is not allowed to “average” the two.
3. Clinician verifies. Their resolution becomes authoritative.
4. If tenant policy classifies the slot as safety-critical (allergy, anticoagulant, identity), finalization is blocked until resolution.

**Alternate / exception flows**

- Clinician ignores a non-critical conflict → may proceed if policy allows, with the contradiction still visible and audited.
- Safety-critical unresolved at approval time → [UC-14](#uc-14--low-confidence-safety-block) block.

**Postconditions**

- Resolution, if any, is clinician-authored.
- Both original statements remain in the ledger.

#### UC-10 — Image versus speech contradiction

**Kind:** Safety / exception · **Sources:** B

Spoken history disagrees with imaging (for example “no prior surgery” versus post-op clips). HITL disambiguation is required.

**Actors:** Vision/imaging intake, synthesizer, clinician, harness

**Related stories:** US-CL-05

**Original IDs:** B UC-02 extension

**Preconditions**

- [UC-02](#uc-02--image-assisted-consultation) imaging context exists alongside transcript.

**Trigger:** Imaging finding contradicts a spoken or imported historical statement.

**Main flow**

1. Harness emits `contradiction.detected` with both sources (image reference and transcript span).
2. Evaluator flags the pair for HITL disambiguation.
3. Neither source is silently preferred. Image-derived content remains labeled until the clinician decides.
4. Resolution follows [UC-09](#uc-09--history-conflicts-with-current-statement) authority rules.

**Alternate / exception flows**

- Clinician defers → contradiction stays open; safety-critical cases block finalization.

**Postconditions**

- Committed note does not contain an unresolved silent merge of image and speech.

#### UC-11 — Agent timeout with safe degradation

**Kind:** Safety / exception · **Sources:** A, B, C, D (all four)

A worker exceeds its deadline. The harness cancels that task, may retry if idempotent, abstains rather than guessing, and keeps independent work running.

**Actors:** Harness, timed-out worker, fallback model (optional), clinician-facing UI

**Related stories:** US-CL-09, US-AD-05

**Original IDs:** A UC-03 · B UC-04 · C UC-1 timeout alt · D timeout degrade

**Preconditions**

- Per-task deadline, token budget, and criticality are in the loop contract.

**Trigger:** A worker (for example terminology retrieval) exceeds its node timeout.

**Main flow**

1. Harness records `agent.timeout`, cancels that attempt, and does not force-stop unrelated agents (the original XML’s global watchdog is rejected).
2. Retry only if the operation is idempotent and within retry/budget policy; optional failover to a fallback model.
3. If still unavailable, the note displays a precise degradation, such as “terminology verification unavailable.” No guessed terminology, differentials, or filler is inserted.
4. Independent tasks continue. Session enters `DEGRADED` if a safe draft remains possible, not `FAILED`.

**Alternate / exception flows**

- Critical path timeout (for example ASR drain) → mark capture incomplete; still do not fabricate transcript.
- Budget exhausted → same abstention path; no unbounded loop.

**Postconditions**

- Clinician can see which capabilities were unavailable.
- Partial output is retained; no silent omission of the failure.

#### UC-12 — Session timeout without approval

**Kind:** Safety / exception · **Sources:** A, B, C

Work is done but nobody approved. The harness keeps an unsigned draft, notifies, and never treats timeout as sign-off.

**Actors:** Harness, notification service, clinician, audit ledger

**Related stories:** US-CL-14, US-PT-04

**Original IDs:** A UC-05 · B TIMED_OUT saga · C UC-4 escalate, not silent close

**Preconditions**

- Candidate note may be complete; approval event has not arrived.

**Trigger:** HITL wait exceeds the tenant wall-clock cap, or the clinician never returns.

**Main flow**

1. Harness retains an unsigned draft per retention policy. Status becomes `TIMED_OUT` or `AWAITING_REVIEW` — never `CLOSED_APPROVED` or `FINALIZED`.
2. Notification is issued to the responsible clinician (and optionally a coverage pool).
3. No long-term style or reflection memory is updated from the unapproved draft.
4. If policy allows administrative closure, the draft remains visibly unsigned.

**Alternate / exception flows**

- Clinician later reopens → `REOPENED` / resume HITL from the retained draft (paper A exceptional state `REOPENED`).
- Patient-facing after-visit generation is forbidden from this state (US-PT-04).

**Postconditions**

- No signed record exists unless a later explicit approval occurs.
- Draft and audit trail are retained per TTL.

#### UC-13 — Interrupted consultation

**Kind:** Safety / exception · **Sources:** B, D

Clinician steps out, takes a call, or the network drops. Durable checkpoint; resume is bit-for-bit; over-cap pause auto-drafts and waits for HITL.

**Actors:** Clinician, harness (durable execution), perception

**Related stories:** US-CL-16, US-TH-01

**Original IDs:** B UC-03 · D interrupted session

**Preconditions**

- Session is `STREAMING` or `DRAFTING`.

**Trigger:** `session.pause`, network drop, client disconnect, or worker restart.

**Main flow**

1. Harness checkpoints event ledger, working memory, draft sections, evidence ledger, and open tasks.
2. Perception stops accepting new audio if the pause is local; telehealth follows [UC-07](#uc-07--telehealth-consultation) drop rules.
3. On resume within the retention window, state restores without re-transcription, re-extraction, or re-retrieval of prior work.
4. If pause exceeds tenant cap, auto-draft available content and transition to `AWAITING_HITL` rather than discard.

**Alternate / exception flows**

- Worker crash mid-task → durable retry of idempotent work; stale results rejected by session version (paper A FR-H07).
- Duplicate events after reconnect → idempotency keys prevent double writes.

**Postconditions**

- No user-visible data loss of already-captured evidence.
- Session can continue to [UC-01](#uc-01--happy-path-ambient-consultation) or [UC-05](#uc-05--section-level-hitl-approval-and-commit).

#### UC-14 — Low-confidence safety block

**Kind:** Safety / exception · **Sources:** A, D

Conflicting evidence or a below-threshold high-risk claim blocks finalization. The clinician must review. Nothing is fabricated to look complete.

**Actors:** Verifier/safety checker, harness, clinician

**Related stories:** US-CL-08, US-CL-12, US-CL-14

**Original IDs:** D low-confidence scenario · A safety-critical block

**Preconditions**

- A high-risk slot (medication, allergy, identity, laterality, critical phrase) is uncertain or conflicted.

**Trigger:** Verifier confidence below `T_block`, or a safety-critical contradiction remains open.

**Main flow**

1. Safety checker blocks `FINALIZED`. The UI names the blocking items.
2. Clinician must review, correct, or explicitly accept residual risk if policy even allows that (many tenants will not for identity/allergy).
3. No fabricated filler is inserted to satisfy template completeness.

**Alternate / exception flows**

- Clinician resolves via [UC-08](#uc-08--correction-changes-a-high-risk-fact) / [UC-09](#uc-09--history-conflicts-with-current-statement) → block lifts after re-verification.
- Clinician abandons → unsigned draft path ([UC-12](#uc-12--session-timeout-without-approval)).

**Postconditions**

- No committed note contains an unresolved blocked safety item.

#### UC-15 — ASR pipeline failure then fallback

**Kind:** Safety / exception · **Sources:** B, C

Primary speech pipeline fails at Record. Documented fallback ASR is used. Silent empty capture is forbidden.

**Actors:** Perception/ingestion, tenant audio config, clinician, harness

**Related stories:** US-CL-03, US-AD-02

**Original IDs:** C UC-1 alternate · B US-AD-02

**Preconditions**

- Tenant has a documented fallback ASR.

**Trigger:** Primary audio pipeline fails when Record is requested or mid-session.

**Main flow**

1. Harness switches to the documented fallback (vendor, language, diarization as configured).
2. Clinician is notified that fallback is in use.
3. Failure and fallback are audited.
4. Session continues [UC-01](#uc-01--happy-path-ambient-consultation) on the fallback pipeline.

**Alternate / exception flows**

- Fallback also fails → capture stops visibly; session can still proceed on typed notes/attachments; no fake transcript.

**Postconditions**

- Either audio is captured on a known pipeline, or capture is explicitly down.

#### UC-16 — Terminology lookup miss

**Kind:** Safety / exception · **Sources:** C

MCP search returns no match. The term is flagged unmapped. No guessed code is inserted.

**Actors:** Terminology MCP, harness, clinician or coder

**Related stories:** US-CL-09, US-CL-18

**Original IDs:** C UC-1 alternate

**Preconditions**

- [UC-03](#uc-03--terminology-standardization) lookup was attempted.

**Trigger:** Terminology search returns no acceptable match.

**Main flow**

1. Context item is marked unmapped with the original span and the empty lookup result.
2. Work note / coding panel shows the term for human assignment.
3. Verifier treats an unmapped high-risk concept as a gap, not as a pass.

**Alternate / exception flows**

- Clinician assigns a code manually → becomes authoritative; still audited.

**Postconditions**

- No hallucinated code exists in the note or write payload.

---

### Governance

#### UC-17 — Post-consultation QA provenance review

**Kind:** Governance · **Sources:** B, D

A QA reviewer opens a finalized note and walks the per-clause provenance graph.

**Actors:** QA reviewer, audit/provenance store, harness read API

**Related stories:** US-QA-01, US-QA-02, US-CO-01

**Original IDs:** B UC-07 · D explainability / QA

**Preconditions**

- Note is `FINALIZED` / committed. Reviewer is authorized for QA access.

**Trigger:** QA opens a finalized note for audit.

**Main flow**

1. Provenance panel shows, for each clause: transcript span, retrieved snippets, tool/MCP calls, evaluator score, and HITL edit history.
2. Superseded versions are available. Latest non-superseded is the clinical default.
3. Reviewer can see which sections were AI-accepted versus rewritten.
4. The QA access itself is audited.

**Alternate / exception flows**

- Incomplete provenance → quality defect; note still cannot be silently altered by QA without a governed amendment path.

**Postconditions**

- Reviewer can reconstruct how the note was produced without live session memory.

#### UC-18 — Consent revocation and GDPR erasure

**Kind:** Governance · **Sources:** B

Patient revokes AI-drafting consent or files an erasure request. Future tool calls stop. Memory tiers are scrubbed. EHR notes are not silently deleted.

**Actors:** Patient, DPO/compliance, consent service, MCP gateway, erasure job, EHR (downstream)

**Related stories:** US-PT-01, US-CO-02, US-CO-03, US-AD-04

**Original IDs:** B UC-08

**Preconditions**

- Patient has an identity in the tenant. Prior AI-drafting may have occurred.

**Trigger:** Patient revokes AI-drafting consent, or a data-subject erasure/restriction request is filed.

**Main flow**

1. Consent record is marked revoked from `t_revoke`. Clinician-facing session open shows the new status.
2. Gateway blocks subsequent MCP/tool calls scoped to that patient for the revoked purpose.
3. Erasure/restriction job runs across session scratch, caches, episodic agent memory, and patient-linked style exemplars, per jurisdiction policy.
4. Finalized notes already in the EHR follow EHR retention. The harness records revocation for downstream systems instead of silently deleting the legal record.
5. Job completion is audited. Incomplete scrub is a compliance incident.

**Alternate / exception flows**

- In-flight session at revoke → stop AI drafting immediately; preserve unsigned work per policy; do not generate new suggestions.
- Access/portability request (not erasure) → export permitted artifacts without changing clinical records.

**Postconditions**

- No new AI-drafting occurs under the revoked purpose.
- Agent-memory copies are gone or restricted per policy.
- Legal EHR retention is respected and logged.

---

## 5. Core consensus (treat as non-negotiable)

Eight clinician stories and five use-cases sit in at least three papers. They are the product core for rewriting the XML timeline in [dataset.xml](./dataset.xml).

| Item | Type | Shared outcome |
|---|---|---|
| US-CL-01 Prior history | Story | Minimum-necessary, source-linked summary at open |
| US-CL-03 Ambient capture | Story | Live transcription with mute, indicator, and fallback |
| US-CL-05 Imaging intake | Story | Report-first attach; clinician review before use |
| US-CL-10 Correction override | Story | Clinician edit is authoritative; dependents re-run |
| US-CL-11 Style memory | Story | Opt-in profile from approved notes; no PHI in it |
| US-CL-14 Explicit approval | Story | Timeout is not approval; system never signs |
| US-CO-01 Immutable audit | Story | Every access, tool call, and HITL decision is ledgered |
| UC-01 Happy path | Use-case | Prime → stream → debounce draft → HITL → commit → close |
| UC-02 Image-assisted | Use-case | Mid-session imaging joins context without silent merge |
| UC-05 HITL commit | Use-case | Section review then transactional write |
| UC-08 High-risk correction | Use-case | Med/allergy/identity correction invalidates dependents |
| UC-11 Agent timeout | Use-case | Degrade and abstain; do not force-stop the session |

---

## 6. Unique additions worth keeping

These appeared in only one paper but fill gaps the original XML never named.

**From paper B (harness-first)**

- US-SP-03 cross-specialty handoff items
- US-SC-02 switch templates without full regeneration
- US-QA-02 quality-trend dashboards
- US-AD-03 guideline allowlist and precedence
- US-AD-04 retention TTLs per artifact class
- US-CO-02 cascading GDPR erasure
- US-PT-01 / US-PT-02 patient consent and transparency
- UC-10 image versus speech contradiction
- UC-18 consent revocation cascade

**From paper D (modern redesign)**

- US-NU-01 nurse action items / care-plan extraction
- US-TH-01 telehealth connectivity checkpointing
- US-SC-03 draft / verified / approved labels
- US-AD-05 ops quality dashboards
- US-PT-04 after-visit information only from approved notes
- UC-06 multidisciplinary shared evidence board
- UC-07 telehealth consult channel

---

## 7. Index

### Stories

| ID | Title | Persona | Epic | Papers |
|---|---|---|---|---|
| US-CL-01 | Load relevant prior history | Clinician | Priming & history | A B C D |
| US-CL-02 | Control historical retrieval scope | Clinician | Priming & history | A B |
| US-CL-03 | Start ambient capture safely | Clinician | Ambient capture | A B C D |
| US-CL-04 | See safe partial transcription | Clinician | Ambient capture | A B D |
| US-CL-05 | Attach imaging or a radiology report | Clinician | Multimodal intake | A B C D |
| US-CL-06 | Maintain an evolving work note | Clinician | Live synthesis & CDS | A C D |
| US-CL-07 | Ask evidence-grounded questions | Clinician | Live synthesis & CDS | A B D |
| US-CL-08 | Live decision support without interrupting the note | Clinician | Live synthesis & CDS | B D |
| US-CL-09 | Bind codes only through terminology tools | Clinician | Live synthesis & CDS | B C |
| US-CL-10 | Override AI with an authoritative correction | Clinician | Live synthesis & CDS | A B C D |
| US-CL-11 | Learn documentation style safely | Clinician | Personalization | A B C D |
| US-CL-12 | Review a candidate final note | Clinician | Review & finalization | A B D |
| US-CL-13 | Approve, edit, or reject by section | Clinician | Review & finalization | A B D |
| US-CL-14 | Finalize only with explicit responsibility | Clinician | Review & finalization | A B C D |
| US-CL-15 | Get a template-conformant summary | Clinician | Review & finalization | B C D |
| US-CL-16 | Pause and resume without losing work | Clinician | Continuity & interruption | B D |
| US-CL-17 | See where each clause came from | Clinician | Live synthesis & CDS | A D |
| US-CL-18 | Receive assisted coding suggestions | Clinician | Live synthesis & CDS | B D |
| US-SP-01 | Open a specialty briefing | Specialist | Specialty collaboration | B D |
| US-SP-02 | Cite guidelines on recommended plans | Specialist | Specialty collaboration | B D |
| US-SP-03 | Leave a structured handoff | Specialist | Specialty collaboration | B |
| US-NU-01 | Extract follow-up tasks from the consult | Nurse | Specialty collaboration | D |
| US-TH-01 | Resume a dropped remote session | Telehealth clinician | Continuity & interruption | D |
| US-SC-01 | Review a cited draft efficiently | Scribe | Documentation operations | B D |
| US-SC-02 | Switch templates without full regeneration | Scribe | Documentation operations | B |
| US-SC-03 | See draft vs verified vs approved labels | Scribe | Documentation operations | D |
| US-QA-01 | Open the provenance graph of a finalized note | QA reviewer | Documentation operations | B D |
| US-QA-02 | See quality trends across the tenant | QA reviewer | Documentation operations | B |
| US-AD-01 | Configure and version note templates | Tenant admin | Documentation operations | B C D |
| US-AD-02 | Configure the audio pipeline and fallback | Tenant admin | Documentation operations | B C |
| US-AD-03 | Control the guideline library | Tenant admin | Documentation operations | B |
| US-AD-04 | Set retention TTLs by artifact class | Tenant admin | Governance & privacy | B |
| US-AD-05 | Operate quality and throughput dashboards | Tenant admin | Documentation operations | D |
| US-CO-01 | Keep an immutable audit ledger | Compliance / DPO | Governance & privacy | A B C D |
| US-CO-02 | Honor data-subject rights across memory tiers | Compliance / DPO | Governance & privacy | B |
| US-CO-03 | Enforce consent at the tool gateway | Compliance / DPO | Governance & privacy | A B |
| US-PT-01 | Grant and revoke AI-documentation consent | Patient | Governance & privacy | B |
| US-PT-02 | See which parts of the note were AI-drafted | Patient | Governance & privacy | B |
| US-PT-03 | Have prior visits inform this one | Patient | Priming & history | C |
| US-PT-04 | After-visit information only from approved notes | Patient | Review & finalization | D |

### Use-cases

| ID | Name | Kind | Papers |
|---|---|---|---|
| UC-01 | Happy-path ambient consultation | Happy path | A B C D |
| UC-02 | Image-assisted consultation | Happy path | A B C D |
| UC-03 | Terminology standardization | Happy path | B C |
| UC-04 | Personalized note generation | Happy path | A B C D |
| UC-05 | Section-level HITL approval and commit | Happy path | A B C D |
| UC-06 | Multidisciplinary consultation | Happy path | D |
| UC-07 | Telehealth consultation | Happy path | D |
| UC-08 | Correction changes a high-risk fact | Safety / exception | A B C D |
| UC-09 | History conflicts with current statement | Safety / exception | A D |
| UC-10 | Image versus speech contradiction | Safety / exception | B |
| UC-11 | Agent timeout with safe degradation | Safety / exception | A B C D |
| UC-12 | Session timeout without approval | Safety / exception | A B C |
| UC-13 | Interrupted consultation | Safety / exception | B D |
| UC-14 | Low-confidence safety block | Safety / exception | A D |
| UC-15 | ASR pipeline failure then fallback | Safety / exception | B C |
| UC-16 | Terminology lookup miss | Safety / exception | C |
| UC-17 | Post-consultation QA provenance review | Governance | B D |
| UC-18 | Consent revocation and GDPR erasure | Governance | B |
