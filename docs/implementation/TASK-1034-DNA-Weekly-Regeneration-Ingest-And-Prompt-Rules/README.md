# TASK-1034 — DNA writing style: weekly feedback-gated regeneration, tenant-admin ingest, style + rules in the prompt

**Status:** In Progress (owner go 2026-10-02)
**Type:** feature
**Branch:** dev-2.2
**Raised:** 2026-10-02, after the ALaaS ↔ cluster E2E (lifecycle, sign-off and DNA all passed; see §2.4)

## 1. Requirement Analysis

Owner asks, 2026-10-02:

1. **R1 — scheduled weekly generation, gated on feedback.** A DNA writing-style report is regenerated
   by a scheduled job once a week, per clinician, ONLY when that clinician produced new feedback or
   updates during the week. A clinician with nothing new is skipped.
2. **R2 — tenant-admin ingest.** A tenant admin can ingest historical case notes per clinician, and
   those notes feed DNA report generation.
3. **R3 — DNA applied at generation time when enabled.** The clinician's personalised DNA style is
   used as writing instructions and redaction rules when summaries are generated, whenever DNA
   redaction is enabled on the workflow/agent.

Also done the same day, outside this ticket's code: the seeded ArcaAI clinicians on the dev cluster now carry
`UserProfile.staffId` 1001–1006 (`arcaai_doctor` … `arcaai_doctor_heme`, `_neur` = 1003). An
EMR-identified consultation now lands on the real clinician instead of an `auto_*` user, which is
what makes DNA reach the same user that owns the consultations.

## 2. Current State Evaluation (code-verified 2026-10-02)

### 2.1 R1 — PARTIAL

| Aspect | Today | Gap |
|---|---|---|
| Scheduler | `DnaRegenerationScheduler` (`dna-regeneration.scheduler.ts`), a `CronJob` that re-reads `dna-regen.*` AppSettings on `app-settings.cache-refreshed` | — |
| Cadence | `DEFAULTS = { enabled: false, cron: '0 0 1 * *' }`, seeded the same way (`seed/08-dna-writing-style.ts:520-575`): **monthly and off** | Weekly default; on |
| Settings | `dna-regen.*` are seeded AppSettings only, with no settings-registry descriptor (only `dna-profile-retention.*` has one) | Register descriptors so they are governed and console-reachable |
| Who is regenerated | `regenerateAllDoctors()` queues **every** doctor that has a latest report (lines 126-192) | (a) No "new feedback" filter. (b) A clinician who has never had a report is never picked. (c) Opted-out doctors are queued, then fail in the processor |
| Watermark | None | Needed: compare the "last report at" time with the newest feedback |
| Sample source | `findFinalSummariesByDoctor` → RAW/MODIFIED_SUMMARY with an `approved` version, newest 50 (`processor.ts:267-317`) | Does not read persisted ingested history (R2) |

### 2.2 R2 — PARTIAL

| Aspect | Today | Gap |
|---|---|---|
| API | `POST dna-writing-styles/ingest` (TASK-974): admin names any in-tenant clinician, 200 items / 20k chars each / 400k total, 202 + job | — |
| Storage | **Not persisted by design.** The text rides only in the BullMQ payload of one job | Scheduled runs cannot reuse it. One ingest produces one report and is then forgotten |
| Mixing | The processor uses ingested samples **or** approved summaries, never both | One corpus for both |
| Console | Only the playground ingest pane (a raw JSON textarea plus a user id) | A tenant-admin screen with a clinician picker and file upload |

### 2.3 R3 — mostly EXISTS; the rules are not instructions

| Aspect | Today | Gap |
|---|---|---|
| Enablement | `core.agent` `config.dna.enabled` (one flag = style pass and redaction gate), plus the doctor's opt-in (`resolveEffectiveDnaRedactionEnabled`); on in the seeded ArcaAI graphs | One flag covers both; no separate "redaction" switch |
| Style text → finalizer prompt | Live handoff emits `dna_style_text` / `dna_style_id`; the finalizer instruction renders `{{context.dna_style_text}}`; the harness gateway lane renders `dnaStyleBlock` | Proved live 2026-10-02 (`note.final.dnaStyleId` set) |
| Redaction rules | Applied **after** generation by the deterministic engine (`core.py` `_deterministic_redaction`, `workflows.py` `apply_redaction`); never shown to the model | Requirement says "writing instructions/rules" → also render them in the prompt |
| Live per-flush summary / pre-summary | No DNA injection found in the per-flush lane; the pre-summary passes `dnaStyleId` through ungated | Decide whether the live preview should be styled (OD-6) |
| Rule source | Hand-written by the doctor or admin (`redaction-rules.ts`) | Not derived from the analysis (out of scope unless OD-7) |

### 2.4 E2E evidence that motivated this

Cluster run 2026-10-02: DNA job via ALaaS failed with "No approved text samples" because the
mapping user (`arcaai_doctor_heme`) was not the consultation owner (`auto_*`, staff-id
provisioned). After two EMR-copy sign-offs, a manual `admin/dna-writing-styles/generate/:doctorId` for
the owning user produced report `01a0fad5-6b97…`, and the next consultation's `note.final` carried
that `dnaStyleId`. The staffId fix above removes the identity split; nothing scheduled the generation.

## 3. Proposed design

### R1 — feedback-gated weekly job

- Default `dna-regen.enabled = true`, `dna-regen.cron = '0 2 * * 1'` (Monday 02:00, tenant time zone
  if OD-2 says so), registered as settings-registry descriptors (platform tier, tenant-overridable
  per OD-2).
- Candidate set = every in-tenant clinician with **feedback since their latest report's `createdAt`**
  (or since `now − 7d` when they have no report), where feedback is (OD-1):
  `ContextItemVersion` rows with `changeReason='approved'` on that doctor's summaries, summary edits
  (`MODIFIED_SUMMARY` versions), and new ingested samples (R2).
- Skip, and log a counted `skipped:no_feedback` / `skipped:opted_out` / `skipped:quota`, BEFORE
  queuing: run the opt-out check (`resolveEffectiveDnaStyleEnabled`) and the existing spend check in the
  scheduler, not only in the processor.
- Minimum-sample floor (OD-3) so one edit does not regenerate a profile.
- Job payload `origin:'scheduler'`, idempotency key `dna-regen:<tenant>:<doctor>:<isoWeek>`, so a
  restarted scheduler cannot double-run a week.

### R2 — persisted ingest corpus

- New model `DnaWritingSample` (tenant-scoped, soft-delete, PHI **encrypted at rest** via the same
  Vault-Transit path the report text uses — OD-4): `doctorId`, `text`(ciphertext), `writtenAt`,
  `kind`, `sourceRef`, `ingestBatchId`, `consumedByReportId?`.
- `POST dna-writing-styles/ingest` persists, then (unchanged contract) enqueues an immediate job; a
  `generate=false` flag lets an admin load history and let the weekly job pick it up.
- The processor builds ONE corpus: approved summaries + stored samples, newest first, capped by
  `max-samples` / `max-context-chars`; ingested items count as feedback for R1.
- `sourceRef` dedupes per doctor (re-uploading the same export is a no-op).
- Console: tenant `/dna-writing-styles` gains an **Ingest** tab — clinician picker, file upload
  (`.txt` / `.json` / `.csv` with `text,writtenAt[,kind,sourceRef]`), preview, submit, job status;
  also a per-clinician "samples" count and delete (soft).

### R3 — style and rules into the prompt, gated

- Keep `config.dna.enabled` as the gate, and split the meaning (OD-5): `dna.style` (writing
  instructions) and `dna.redaction` (rules), with `dna.enabled: true` read as both for
  back-compat.
- Render a `dna_redaction_rules_text` variable (a human-readable list of the rules: "never write
  X", "write Y as Z") next to `dna_style_text` in the finalizer fragment and the harness gateway
  `dnaStyleBlock`, only when the gate is on. The deterministic post-generation pass stays as the
  guarantee (the model may ignore an instruction; the engine does not).
- Pre-summary: gate `dnaStyleId` through the same resolver (today it is passed ungated).
- Live per-flush lane: per OD-6.

## 4. Owner decisions

| # | Decision | Options | Recommendation |
|---|---|---|---|
| OD-1 | What counts as "feedback" | (a) sign-offs only; (b) sign-offs + clinician edits of the note; (c) b + ingested samples | **c** |
| OD-2 | Cadence scope | (a) one platform cron; (b) platform default, tenant may override day/time; (c) b + tenant time zone | **b**, run in the tenant zone (`consultation.appointmentDay.timeZone` exists) |
| OD-3 | Minimum new feedback to regenerate | 1 / 3 / 5 items in the week | **3** (configurable `dna-regen.min-new-samples`) |
| OD-4 | Persist ingested text (PHI) | (a) persist encrypted; (b) keep payload-only (current), so the weekly job never sees it | **a** — R2 cannot feed scheduled runs otherwise |
| OD-5 | Separate "redaction" switch from "style" | (a) one flag (today); (b) `dna.style` + `dna.redaction`, `enabled` = both | **b** — the requirement names redaction specifically |
| OD-6 | Style the live per-flush preview | yes / no | **no** — keep the live lane fast; style applies at the finalizer, which is the note that is signed |
| OD-7 | Derive redaction rules from the DNA analysis | yes / no (rules stay hand-written) | **no** in this ticket |
| OD-8 | Console ingest file formats | txt / json / csv | **json + csv** → owner: **JSON, CSV and plain text** |

## 4a. Owner answers (2026-10-02)

- OD-1…OD-7 **as recommended**; OD-8 **JSON, CSV and plain text**.
- **Framing (owner):** a DNA writing-style report is the agent/workflow **memory** of a clinician — detected,
  extracted and generated when the clinician **updates the generated summary**. → Every edit/sign-off of a
  generated summary is CAPTURED as a memory sample (`DnaWritingSample`, source `EDIT` / `SIGNOFF`), next to
  tenant-admin ingested history (source `INGEST`). The weekly job consumes new memory into a new report.
- **New:** a console screen for DNA writing-style **report / memory management**.

## 4b. Pinned contract (lanes build against this; changes go through the orchestrator)

**Model** `DnaWritingSample` (`core`, tenant-scoped, soft delete, OCC not needed):
`id, tenantId, doctorId, source DnaSampleSource(EDIT|SIGNOFF|INGEST), textCiphertext, aiDraftCiphertext?,
writtenAt, kind?, sourceRef?, contentHash (sha256 of normalised text), ingestBatchId?, consultationId?,
contextItemId?, consumedByReportId?, consumedAt?` + the standard meta/status/audit fields. Index
`(tenantId, doctorId, createdAt)`; dedupe = same `(tenantId, doctorId, contentHash)` not DELETED → no-op.
Text is Vault-Transit encrypted exactly like the report text; plaintext is never logged or returned unredacted.

**Capture:** after a successful summary update (new `MODIFIED_SUMMARY` / summary version) and after approve/sign-off,
`DnaMemoryCaptureService.capture({ consultationId, contextItemId, source })` writes one sample for
`Consultation.doctorId` IF `resolveEffectiveDnaStyleEnabled` is true; failures never fail the clinical action.

**Feedback for R1** = unconsumed samples created since the doctor's latest report (`createdAt`), or the last 7 days
when there is no report; regenerate when count ≥ `dna-regen.min-new-samples` (default 3). Generation corpus =
approved summaries ∪ samples (newest first, existing caps); used samples get `consumedByReportId`.

**Settings descriptors** (platform default, tenant-overridable): `dna-regen.enabled` (true), `dna-regen.cron`
(`0 2 * * 1`), `dna-regen.min-new-samples` (3), `dna-regen.max-samples`, `dna-regen.max-context-chars`,
`dna-regen.job-delay-ms`; the run uses the tenant zone `consultation.appointmentDay.timeZone`.

**HTTP** (all JSON; admin routes `@ForbidApiKey`, `manage`/`read:DnaWritingStyleReport`, tenant-scoped, 404-over-403):
- `POST dna-writing-styles/ingest` — unchanged + optional `generate?: boolean` (default `true`); items persisted (source `INGEST`); response adds `stored`, `duplicates`.
- `GET admin/dna-writing-styles/memory/summary` → `[{ doctorId, username, displayName, total, unconsumed, bySource:{EDIT,SIGNOFF,INGEST}, lastSampleAt, lastReportAt, latestReportId, dnaEnabled }]`
- `GET admin/dna-writing-styles/memory?doctorId=&source=&consumed=&page=&limit=` → `PaginatedResponse<{ id, doctorId, source, kind, writtenAt, sourceRef, consultationId, consumed, consumedByReportId, preview (≤200 chars, PHI-redacted), createdAt }>`
- `DELETE admin/dna-writing-styles/memory/:id` → 204 (soft)
- `GET admin/dna-writing-styles/schedule` → `{ enabled, cron, minNewSamples, timeZone, nextRunAt, lastRun: { at, queued, skipped:{ noFeedback, optedOut, quota, belowFloor } } | null }`
- `PUT admin/dna-writing-styles/schedule` body `{ enabled?, cron?, minNewSamples? }` → same shape (tenant-scope settings)
- `POST admin/dna-writing-styles/schedule/run` → `{ queued, skipped:{…}, jobs:[{ doctorId, jobId }] }` (this tenant only)

**R3 contract:** `core.agent` `config.dna` gains optional `style?: boolean`, `redaction?: boolean`; `enabled:true` ⇒ both
unless one is set explicitly `false`. New prompt variable `dna_redaction_rules_text` (bullet list rendered from the
doctor's rules; empty when the redaction gate is off), emitted by the live handoff next to `dna_style_text` and
rendered by `prompt-assembly` `dnaStyleBlock`; the finalizer fragment renders it under "Never include / always rewrite".

**Console:** `/dna-writing-styles` becomes "DNA Writing Style Memory" — tabs **Reports** (existing), **Memory**
(per-clinician summary → sample list, delete), **Ingest** (clinician picker; `.json` / `.csv` / `.txt`, preview, `generate`
toggle, job status), **Schedule** (settings + "Run now" + last-run result).

## 5. Implementation plan (TDD, layer order)

1. **DB** — `DnaWritingSample` model + migration `task_1034_dna_writing_sample`; `ResourceType` value;
   allow-lists. Settings descriptors for `dna-regen.*` (+ `min-new-samples`); seed defaults weekly/on.
2. **Domain** — hand-authored entity/factory/mapper/repository; repository queries
   `countFeedbackSince(doctorId, since)` and `findSamplesForCorpus(doctorId, limit)`.
3. **Applications** —
   - scheduler: candidate query, pre-queue opt-out/quota/floor skips, ISO-week idempotency key;
   - ingest service: persist (encrypted), dedupe on `sourceRef`, `generate` flag;
   - processor: merged corpus; mark consumed samples;
   - prompt assembly / live handoff: `dna_redaction_rules_text`, split gate, pre-summary gating.
4. **Harness** — finalizer fragment renders the rules text; replay-compat untouched (prompt
   variable only, no workflow-code change).
5. **API** — ingest DTO `generate?`; `GET dna-writing-styles/samples?doctorId=` + soft delete; regenerate the
   five artifacts.
6. **Console** — Ingest tab + samples list on `/dna-writing-styles`.
7. **Seed/content** — ArcaAI finalizer fragment carries the rules block; republish via a rollout script
   (published agents freeze fragments).

### TDD list (RED first)

- scheduler skips a doctor with 0 feedback since the last report; queues one with ≥ floor; queues a
  never-reported doctor with ≥ floor in the window; skips opted-out before queuing; one job per
  ISO week across a restart.
- ingest persists ciphertext, never plaintext; a duplicate `sourceRef` is a no-op; `generate=false` queues
  nothing; cross-tenant clinician → 404.
- processor corpus merges both sources, respects caps, and its order is newest first.
- prompt: rules text present iff `dna.redaction` on and the doctor opted in; `dna.enabled:true` ⇒ both.
- pre-summary: `dnaStyleId` dropped when the gate is off.
- e2e: tenant-admin ingest → weekly trigger (manual run endpoint) → report → next note carries
  `dnaStyleId` and the rules text appears in the captured finalizer prompt.

### Verification

Unit + e2e gates per layer; then a live cluster proof: ingest 20 historical notes for
`arcaai_doctor_heme` (1006), trigger the scheduler once, assert a report; run an ALaaS replay as
1006 and confirm `dnaStyleId` and a redaction rule honoured in the note.

## 6. Implementation Summary

_Not started._

## 7. Change History

- 2026-10-02 — Plan drafted from the code survey; dev-cluster staffId 1001–1006 set on the seeded ArcaAI clinicians.
