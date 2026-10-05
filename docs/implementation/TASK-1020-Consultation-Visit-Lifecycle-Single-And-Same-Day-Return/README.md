# TASK-1020 — Consultation visit lifecycle: single visit and same-day return visit

| Field | Value |
|---|---|
| Status | **Review** — merged locally on `dev-2.2` and ALaaS `refactor-hope-integaration`, NOT pushed (owner pushes). SDK 4.1.0 published. Local rollout applied, and the two-visit audio replay passes every §7.4 criterion (§9.5). The dev-cluster rollout follows the push (§9.4) |
| Type | feature + bugfix (lifecycle correctness) |
| Branch | `dev-2.2` (hope-v2) · `refactor-hope-integaration` (ALaaSv3.0) |
| Repos | `arca/hope-v2` (DB, domains, applications, api, vox-node, vox, seeds), `ALaaSv3.0` (`apps/audio-stream-svc`, `apps/web_ui`) |
| Opened | 2026-09-29 |
| Rules read | `00`, `01`, `02`, `03`, `04`, `05`, `08`, `13`, `14`, `_karpathy` |
| Related | TASK-933 (service-account plane), TASK-951 (open markers), TASK-1001 (resume re-finalise), TASK-1003 (transport, 5-min completion timeout), TASK-1008 (EMR copy = sign-off, §7 follow-ups) |

## 1. Requirement

Review how a consultation lives and ends. The review covers HOPE and the ALaaS path: `web_ui ↔ audio-stream-svc ↔ @arcaai/vox-node ↔ HOPE`. It must handle two visit shapes:

1. **Single visit.** The patient sees the clinician once that day.
2. **Same-day return visit.** Example: a consultation in the morning, then labs and tests, then the patient returns in the afternoon to get the script / plan of care.

Deliverables:
- best practices
- the SDK changes (vox-node and vox)
- the ALaaS changes
- the content changes (agents, workflows, prompt and instruction fragments, document templates)

## 2. Current state (code-verified 2026-09-29)

### 2.1 The shape-2 flow is broken today

**`open` get-or-creates on `(tenant, patient, appointmentDate, doctor)` regardless of status.**
- The lookup is at `packages/applications/src/services/consultation/consultation/consultation.service.ts:1143`. `ConsultationRepository.findByUniqueKey` (`:57-71`) has no status predicate, no sort, and swallows all errors.
- On a match (`:1145-1177`), the call does none of the following:
  - persist the new context
  - change the visit type
  - honour `parentConsultationId`
  - dispatch a workflow
  - re-check consent
  - meter the visit

  The only thing it can change is the spoken-language mode.
- `createRevisit` (`:1357`) has no route and no caller. `open-consultation.request.ts:73-76` cites a `POST /consultations/:id/revisit` route that does not exist.

**Where ALaaS stands today.** After TASK-1008, a normal shape-1 visit ends with the morning note `SIGNED` or `CLOSED_COMPLETE`. The afternoon `start` then does the following:

| Step | What happens | Evidence |
|---|---|---|
| `open` | Returns the **signed morning** consultation, `isNew:false`. The `revisit` visit type, the event id, vitals and prior notes are discarded | `consultation.service.ts:1145-1177` |
| `recording.start` | The prime kill-switch is OFF by default, so the raw setter writes `RECORDING` on a SIGNED row. This bypasses the transition matrix | `consultation.service.ts:2303-2318`, `consultation-gates.constants.ts:212` |
| Afternoon transcript | Never reaches a note. A signed note is never re-finalised | `consultation-event.handler.ts:138-146, 477-479` |
| Afternoon completion | No completion timer. The row ends `CLOSED_INCOMPLETE` via the 24 h sweep while it still holds a signed note. `approve` is then a no-op, so it can never return to SIGNED | `harness-internal.service.ts:1860`, `summary.service.ts:911-920` |
| Broker `pollForFinalNote` | Has no freshness baseline, so it emits the **morning's** signed note as the afternoon `note.final` | ALaaS `consultation-broker.service.ts:1493-1541` |
| EMR copy | `finish` short-circuits on terminal status before comparing content. The badge reads "Signed & closed", but nothing reaches HOPE | ALaaS `hope-consultation-finish.service.ts:122-129` |

**If the morning note was NOT signed** (e.g. `CLOSED_INCOMPLETE` after the 5-min completion timeout), the afternoon recording re-finalises **one whole-day note**:
- The default `harness-doc` engine regenerates the note over every session, joined with `\n\n`, with no visit boundary. It does not use the tenant graph (`consultation-event.handler.ts:147-165`).
- The visit branch stays the morning's `new-visit` branch and template, frozen at the first open.

**A different clinician in the afternoon** is the only path that works today: it gets a new row with the parent set. The UTC day is the other escape: `appointmentDate` defaults to the **UTC** date (`consultation.service.ts:1140`), so an IST visit before 05:30 lands on the previous day.

### 2.2 Content exists but has no inputs

- **Vocabulary.** The owner's vocabulary already names shape 2: `revisit` = *"follow-up or revisit in the same day"* (`visit-type.catalogue.ts:12-14`).
- **Graphs.** All 11 ArcaAI department graphs branch `n_visit` on `trigger.context.visit_type`. Each branch uses its own per-visit agent and document template (`arcaai-<dept>-summary-<visit>` / `arcaai-<dept>-soap-<visit>`, `seed/28-workflow-library.ts:101-304`).
- **`same_day_prequel_summary`.**
  - All 22 department bodies reference it (`seed/07b-arcaai-clinical-content-v3.ts`, e.g. HEME revisit L113).
  - It has **no producer**: it was removed as dead (`prompt-assembly.service.test.ts:408-411`).
- **`carryForward`** (parent note → `prior_visit_summary`) exists. It fails OFF, no seeded graph enables it, and the live lane never reads it (`harness-internal.service.ts:686-748, 1366-1373`).
- **`formatted_test_results`** is always `''` (`pre-summary-variables.ts:126`). No context kind carries lab results.
- **Revisit prompts assume a weeks-old prior visit.** They use "Last Visit Complaints" and instruct "never restate the previous plan". At a same-day return, though, the afternoon visit **is** where the definitive plan and script are made.

### 2.3 SDK

**vox-node 4.0.1:**
- `open` returns `status: string` (untyped).
- Missing wrappers:
  - `reopen` — the route also refuses service accounts
  - `prime`
  - `chain`
  - `waitForFinalNote`
  - any freshness baseline on `summaries.latest`
- Every 409 is mapped to `QuotaExceededError` (`core/errors.ts:553-554`, pinned by a test). An illegal-transition 409 carries no `code`.
- Docs are stale in several places:
  - `consultation-realtime.ts:84-90` says "no separate visit type field"
  - the `consultations.ts` header
  - the recording "reverts" wording

**Browser `@arcaai/vox`:**
- `ConsultationStatus` is stale: 9 real values are missing and 4 invented ones are present.
- `OpenSessionInput` has no `parentConsultationId` or `context`.
- The `useArcaSession` memo drops `isNew` and `parentConsultationId`.
- `isRevisit` reads the wrong path.
- No `recording.start|stop` wrapper exists.

### 2.4 ALaaS

**Session store:**
- The store is in-process, keyed `sessionId::eventId`, with a 4 h TTL.
- The broker never reads the consultation status.
- Parent lookup uses the **admin plane** (`admin.consultationAdmin.list`): patient + department, with no date or status filter.
- `appointmentDate` is never sent.

**Visit identity:**
- No code defines what a second same-day visit's `eventId` is.
- Whether the EMR mints a new event per visit is **unconfirmed** (see OD-2).

**Resilience:**
- The web_ui reconnect budget (~71.5 s) exceeds the fixed 60 s detach grace. After the broker tears down, the next `start` re-attaches to a row still in `RECORDING`.
- `resume` replays nothing: `lastSeq` is parsed but unused.
- `SESSION_LOST` has no web_ui mapping.

**"Same day" has three definitions:**
- HOPE: UTC
- batch path: server-local
- `previous-casenotes`: UTC

The batch path's own design doc (`docs/same-day-revisit.md`) assumes IST.

## 3. Best practices applied

| # | Practice | Consequence here |
|---|---|---|
| BP-1 | **One clinical encounter = one consultation = one note = one signature** (FHIR `Encounter`; linked by `partOf` / episode) | The afternoon return is a **new consultation chained to the morning** (`parentConsultationId`). It is never a second recording on a signed row |
| BP-2 | **Signed documentation is immutable.** A change after signing is an explicit addendum (reopen → edit → re-sign), never an overwrite | Recording on SIGNED / CLOSED_COMPLETE is refused by name. The raw-setter bypass is narrowed to the legacy `OPEN` case only |
| BP-3 | **Idempotency keyed on the client's encounter identity, enforced by the database** | `open` keys on `externalRef` (the EMR event id) when present, with a partial unique index. Same ref = same encounter (retries and reconnects are safe). A new ref = a new encounter |
| BP-4 | **Explicit over implicit, with derived state where it is derivable** | Visit type comes from the client (schema marker). The parent link is derived server-side when absent. There is no third visit type: "same-day" is derived from a same-day predecessor |
| BP-5 | **A day is the tenant's local day** | `appointmentDate` defaults to the tenant time zone (a setting, tenant → SYSTEM). It is never the server's UTC date |
| BP-6 | **Carry context forward by reference, not by copy** | The afternoon prompt receives the morning note (signed > modified > raw) and the lab results as dated, attributed context. The morning row is never mutated |
| BP-7 | **Waiters need a freshness baseline** | `waitForFinalNote({ since })` returns only a note produced after the caller's stop. This removes the "morning note as afternoon result" class of bug |
| BP-8 | **Typed, coded errors** | 409s carry a `code`. The SDK raises `ConflictError` with the code, and `QuotaExceededError` only for quota codes |
| BP-9 | **Least privilege** | The broker stops using the admin plane for a business-plane lookup |
| BP-10 | **Pause within a visit ≠ return visit** | A clinician pause (minutes) is stop → start on the same consultation, re-finalised before sign-off (TASK-1001). Leaving for labs (hours) ends the encounter; the return opens a new one |

## 4. Target lifecycle

```
Shape 1 — single visit
  open(externalRef=E1, encounter.visit_type=new-visit) → C1 (isNew, recordable)
    → stt.createStreamSession → recording.start → [pause/resume = stop/start on C1, same note re-finalised]
    → recording.stop → waitForFinalNote(C1, since=stopAt) → review/edit
    → EMR copy → update → approve (SIGNED) → close (CLOSED_COMPLETE)
  Timeouts unchanged: 5-min completion → CLOSED_INCOMPLETE (still approvable), sweeps as today.

Shape 2 — same-day return
  Morning = shape 1 on C1 (ends SIGNED, or CLOSED_INCOMPLETE if unsigned — both fine).
  Afternoon: open(externalRef=E2, visit_type=revisit[, parentConsultationId=C1])
    → C2 (new row; parent = C1 explicit or derived: same patient, same tenant-local day, latest)
    → revisit branch; prompt receives same_day_prequel_summary (C1's note) + formatted_test_results
    → record → note → EMR copy → sign C2. C1 is never touched.
  Re-open of E1 or E2 (retry, reconnect, broker restart) returns the same row; if terminal → recordable:false.
```

## 5. Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | `open` stays the **only** entry (rule 08). The dead `createRevisit` and the phantom `/revisit` DTO doc are removed | One idempotent entry; the chain is expressed by the key plus the parent |
| D-2 | `externalRef` is promoted from a `metadata` marker to a **column**, with a partial unique index on `(tenantId, patientId, doctorId, externalRef) WHERE externalRef IS NOT NULL`. Legacy `metadata.externalRef` is backfilled | BP-3: DB-enforced idempotency, and no duplicate from racing opens |
| D-3 | Key rule: **with `externalRef`**, match on it. **Without it**, keep the legacy key, except: (a) a supplied `parentConsultationId` that differs from the match creates a new child; (b) a terminal match (SIGNED / CLOSED_COMPLETE) returns `recordable:false` (see OD-3) | Keeps legacy callers working; lets explicit follow-ups exist |
| D-4 | `recording.start` on SIGNED / CLOSED_COMPLETE / TIMED_OUT / REOPENED → **409 `CONSULTATION_NOT_RECORDABLE`**, even with the kill-switch OFF. The bypass stays for `OPEN` only | BP-2; closes the recorded TASK-1008 §7 defect |
| D-5 | The parent must belong to the **same patient** (400 `PARENT_PATIENT_MISMATCH`), not only the same tenant | A wrong parent contaminates chain, timeline and prequel |
| D-6 | The re-open path re-checks consent (`ensureConsultationConsent`). The lookup sorts newest-first and stops swallowing errors | A revocation since the morning is honoured; the result is deterministic |
| D-7 | The `open` response gains typed `status`, `visitType`, `externalRef` and **`recordable`**. The SDKs surface them | Clients stop guessing from `isNew` |
| D-8 | No third visit type. Same-day-ness is derived: `same_day_prequel_summary` is non-empty only when a same-day predecessor exists | Owner vocabulary (two types) is kept; no catalogue code change |
| D-9 | `waitForFinalNote` resolves only on a note newer than `since` (summary id / version / `createdAt` after stop) | BP-7 |
| D-10 | ArcaAI graphs enable carry-forward on both summary branches and on finalize; the live lane reads the prequel | Today the afternoon prompt gets no morning context at all |

## 6. Open decisions (owner)

| # | Question | Recommendation |
|---|---|---|
| **OD-1** | Model the day as **one consultation per visit, chained** (BP-1), or **one consultation per patient-day** with several recordings re-finalised into one note? | **Per visit, chained.** The per-day model breaks on the first signature (immutable), gives one EMR document for two encounters, and mixes morning and afternoon with no boundary |
| **OD-2** | ALaaS encounter identity: does the EMR mint a **new `eventId`** for the afternoon return? If not, what distinguishes the visits (a new `sessionId` per launch)? | Use `externalRef = eventId` if it is per visit. Otherwise use `externalRef = eventId:sessionId`. You know the EMR contract; this decides the ALaaS key |
| **OD-3** | Without `externalRef`, an `open` that hits a **terminal** consultation. Choices: (a) return it with `recordable:false` (the client must send `parentConsultationId` to start a follow-up), or (b) auto-create a chained `revisit` child | **(a).** A retry after sign-off must not spawn a spurious visit. ArcaAI always sends `externalRef`, so it is unaffected |
| **OD-4** | Derive the parent server-side when a `revisit` open names no parent? Proposed: same patient, same tenant-local day, latest by `createdAt`, any clinician, excluding self | **Yes.** It removes ALaaS's admin-plane search (BP-9). An explicit parent always wins |
| **OD-5** | Afternoon note content: (a) one **same-day-return instruction fragment** on the 11 revisit agents, mapping onto the existing revisit sections (Investigations Previous vs Current, Treatment Plan, Instructions & Orders), or (b) new per-department "same-day return" document templates | **(a).** No new shapes. The fragment lifts "never restate the previous plan" when a prequel exists: the afternoon plan and script are the definitive ones |
| **OD-6** | Lab results channel: a new `investigations` kind on `arcaai_consultation_scribe` (structured `[{name, value, unit, refRange, collectedAt, flag}]`) feeding `formatted_test_results`. Can ALaaS's EMR supply results at the return visit? | **Add the kind now** (optional field). ALaaS maps it if the EMR has it; otherwise results come from dictation |
| **OD-7** | vox-node 409 mapping: `ConflictError` (with `code`) for all 409s, and `QuotaExceededError extends ConflictError` only for quota codes. Ship as **4.1.0** (fix of a documented defect) or **5.0.0**? | **4.1.0.** It is the documented defect; `instanceof QuotaExceededError` still works for real quota errors. Changelog calls it out |
| **OD-8** | Day boundary setting `consultation.appointmentDay.timeZone` (global-kv, tenant → SYSTEM; SYSTEM default `UTC`; ArcaAI tenant row `Asia/Kolkata`) | **Yes** |
| **OD-9** | Addendum after sign-off (service-account `reopen` scope, vox-node `reopen`, approve-after-reopen writes a new signed version): in this ticket or a follow-up? | **Follow-up.** Neither visit shape needs it once visits are separate consultations |
| **OD-10** | A resumed recording within one visit is re-finalised by the default `harness-doc` engine, not the tenant graph (TASK-1001 D-3/D-4). Should it go through the governing graph? | **Follow-up**, after measuring whether the note shape differs. Out of the two-visit scope |
| **OD-11** | Ticket number **TASK-1020**. TASK-1019 is in use on another branch; TASK-1018 is not visible anywhere and may be in flight | Confirm |
| **OD-12** | After merge and gates: push `dev-2.2` (CI promotes to dev), push ALaaS, publish SDK 4.1.0 locally per the runbook | Ask at merge time |

### 6.1 Owner answers (2026-09-29)

All ODs as recommended; TASK-1020 confirmed; go. Resolutions where the recommendation was conditional:
- **OD-2:** `externalRef = eventId`. ALaaS's own batch same-day design (`docs/same-day-revisit.md`) already treats the return visit as the same `sessionId` with a **new `eventId`**, so the event id is the visit id. If the EMR is later found to reuse event ids, the broker switches to `eventId:sessionId` in one place (`buildExternalRef`).
- **OD-12:** pushes and the SDK publish will be asked at merge time.

## 7. Implementation plan (on go)

### 7.1 Contracts pinned before any lane starts

| Contract | Value |
|---|---|
| Open response additions | `status: ConsultationStatus` (12-value union), `visitType: 'new-visit' \| 'revisit'`, `externalRef: string \| null`, `recordable: boolean`, `parentConsultationId: string \| null` |
| Error codes (409 / 400) | `CONSULTATION_NOT_RECORDABLE`, `CONSULTATION_TRANSITION_ILLEGAL` (the bare `ConflictException` gets a code), `PARENT_PATIENT_MISMATCH`, `EXTERNAL_REF_CONFLICT` (same ref, different patient) |
| Prompt variables | `same_day_prequel_summary` (dated, attributed predecessor notes, same tenant-local day, signed > modified > raw); `formatted_test_results` (from the `investigations` kind) |
| Live lane scope | `trigger.context.same_day_prequel` (boolean) and `trigger.context.visit_type` are readable by fragment `when` conditions |
| Context kind | `investigations`: STRUCTURED, optional, `{ results: [{ name, value, unit?, refRange?, collectedAt?, flag? }] }`, persisted as a PRE item |
| Setting | `consultation.appointmentDay.timeZone` (IANA; `failMode: open-to-default` → `UTC`) |

### 7.2 Lanes

These are TDD lanes. Each lane runs only its own RED→GREEN files; the one gate pass runs after the full merge (owner rule). Every brief starts with `git merge --ff-only dev-2.2` plus a base-existence proof. Worktrees use the symlinked `node_modules` recipe; there is never a nested `pnpm install`.

| Lane | Tier | Owns | Delivers | Tests (RED first) |
|---|---|---|---|---|
| **L-OPEN** | opus | `packages/database` schema (no migration apply), `packages/domains` Consultation entity/mapper/repo, `consultation.service.ts` open/start paths, `open-markers.ts`, settings descriptor | D-2…D-7; OD-3/4/8 as answered. SQL is prepared in the ticket dir, never in `migrations/` | `consultation.service.open-encounter.test.ts`: same ref → same row; new ref same day → new child with derived parent; terminal legacy match → `recordable:false`; parent other patient → 400; start on SIGNED with switch OFF → 409; tenant-tz date |
| **L-CARRY** | opus | `prompt-assembly.service.ts`, `harness-internal.service.ts` (assemble), `prior-visit-summary.ts`, `live-documentation.service.ts` (variables + scope), `pre-summary-variables.ts` | The `same_day_prequel_summary` producer (live, finalize, pre-summary); `formatted_test_results` from `investigations`; `trigger.context.same_day_prequel` | `prompt-assembly.same-day-prequel.test.ts`: predecessor note present / absent / other day / other patient; test results formatting; live lane exposes the flag |
| **L-CONTENT** | sonnet | seeds `07g` (kind), `07b` v3 revisit bodies + new fragment, `28-workflow-library.ts` (carryForward), regenerated `29-*.generated.ts` | OD-5(a) fragment `arcaai-same-day-return` with `when: trigger.context.same_day_prequel`, on 11 revisit agents; `investigations` kind; carryForward on the graph | `task-930-workflow-seeds` byte-diff after regen; seed snapshot test for the fragment binding |
| **L-SDK** | sonnet | `packages/vox-node`, `packages/agentic-sdk-v2` | Typed open response; `ConflictError` split (OD-7); `consultations.waitForFinalNote(id, { since, timeoutMs, signal })` (harness-progress primary + `summary/latest` poll fallback); `consultations.chain(id)`; doc fixes. Browser: status union, `OpenSessionInput.parentConsultationId/context/metadata`, memo fields, `isRevisit` path. Changeset 4.1.0 | `errors.test.ts` (409 by code), `consultations.wait-for-final-note.test.ts` (stale note ignored), browser type tests |
| **L-ALS** | opus | ALaaS `audio-stream-svc` broker/adapter, `web_ui` start/reattach/errors | `externalRef` per OD-2 + tenant-local `appointmentDate`; honour `recordable:false` (show "signed — start a return visit" instead of recording); drop the admin-plane parent search (OD-4); `waitForFinalNote({ since })` replaces `pollForFinalNote`; map `investigations` if the EMR has results (OD-6); `finish` compares content before the terminal short-circuit; configurable detach grace ≥ reconnect budget (90 s); `SESSION_LOST` UI mapping; replay from `lastSeq` on resume; web_ui "Return visit" chip with the morning note read-only | `consultation-broker.service.spec.ts`: afternoon start with a new event → new consultation, stale morning note never emitted as `note.final`; `recordable:false` path; resume replay; `hope-consultation-finish.service.spec.ts` content-changed-on-terminal |

### 7.3 Waves

1. **Wave 1**, in parallel: L-OPEN, L-CARRY, L-CONTENT, L-SDK. There is no file overlap; the contracts are in §7.1.
2. **Orchestrator merge.** Merge wave 1 into `dev-2.2`, then run these steps in order:
   1. Author the migration on the shadow DB (rule 02); name it `task_1020_consultation_external_ref`, with backfill and the partial unique index.
   2. `db:generate` and `gen:model`.
   3. Seed regen check.
   4. Regenerate the five API artifacts. Route DTOs change, so run all of `api:build`, `api:route-manifest`, `api:openapi`, `api:portal` and `vox-node gen:admin`.
   5. Run one gate pass: `@arcaai/database`, `@arcaai/domains`, `@arcaai/applications`, `@arcaai/api`, `@arcaai/vox-node`, `@arcaai/vox` build + test + lint, and the relevant e2e specs.
3. **Wave 2**: L-ALS, against the built vox-node, using the symlink until 4.1.0 is published.
4. **Wave 3**, runtime proof on the dev stack. Run the ALaaS replay twice on the same day:
   1. **Morning:** new-visit E1, stop, final note, EMR copy, approve, close. Expect C1 `CLOSED_COMPLETE`.
   2. **Afternoon:** revisit E2 with investigations, stop. Expect a new C2 whose parent is C1, the revisit branch, and a prompt capture showing the prequel and the results.
   3. **Afternoon finish:** EMR copy and sign C2.
   4. **Re-open E1:** expect `recordable:false`, and recording refused with 409.

   Paste the evidence into §9.

### 7.4 Verification criteria

- The two-visit replay (wave 3) produces **two** signed consultations, each with its own note. C1's note bytes are unchanged after the afternoon.
- The afternoon prompt capture contains `same_day_prequel_summary` (C1's note, dated) and `formatted_test_results`.
- The afternoon note follows the revisit shape and states the full plan and prescription.
- No `recording.start` succeeds on a SIGNED row, whatever the kill-switch state.
- A racing double `open` with the same `externalRef` yields one row.
- An IST visit at 00:30 lands on the IST date.

## 8. Out of scope — follow-ups

- **OD-9 addendum after sign-off.** Needs a service-account `reopen` scope, vox-node `reopen`, and approve-after-reopen writing a new signed version.
- **OD-10 governed resume re-finalise.**
- **SYSTEM reference workflow `general-medicine-consultation`** has no visit split and no `documentTemplateSlug`, so every non-ArcaAI tenant gets the 4-section fail-open shape for revisits.
- **Governing-engine re-finalise bypass** (`harness-gateway.service.ts:403-416`) for governed consultations.
- **ALaaS store.** A Redis-backed session store and horizontal scale (integration plan §3.3).

## 9. Implementation summary

### 9.1 What changed, per lane

| Lane (tier) | Repo · merge | Delivered |
|---|---|---|
| L-OPEN (opus) | hope-v2 `b1af8ef92` | `Consultation.externalRef` column + `Consultation_encounterKey_idx`; `findByExternalRef`; legacy lookup newest-first, no longer swallows errors; open keyed on the encounter (same ref = same row, new ref = new consultation, `EXTERNAL_REF_CONFLICT` across patients); legacy key + `parentConsultationId === match` creates a child; OD-4 derived same-day parent for `revisit`; `PARENT_PATIENT_MISMATCH`; `recording.start` bypass kept for `OPEN` only, otherwise 409 `CONSULTATION_NOT_RECORDABLE`; illegal transitions carry `CONSULTATION_TRANSITION_ILLEGAL`; `ConsultationResponse` gains `recordable`, `visitType`, `externalRef`; setting `consultation.appointmentDay.timeZone`; dead `createRevisit` removed |
| L-CARRY (opus) | hope-v2 `81ffc5275` | `same-day-prequel.ts` (walks the parent chain, same patient and day, signed > modified > raw, 6000-char blocks); `same_day_prequel_summary` and `formatted_test_results` (from `investigations`) wired into the live lane, harness assemble, prompt assembly and pre-summary; `trigger.context.same_day_prequel` on the live scope and the handoff; **`persistDraft` no longer overwrites a signed note** (the probe found a real defect: an approved RAW_SUMMARY was rewritten on re-delivery; now skipped with a warn log) |
| L-CONTENT (sonnet) | hope-v2 `309d310f3` | `investigations` kind on `arcaai_consultation_scribe`; fragment `same_day_return` (tag `arcaai-same-day-return`, `when: has(trigger.context.same_day_prequel) && trigger.context.same_day_prequel == true`) bound to the 11 revisit agents only, between `clinical_note` and the language policy; `29-*.generated.ts` regenerated |
| L-SDK (sonnet) | hope-v2 `e6c50fd25` | vox-node: typed `ConsultationOpenResponse` (status union, `visitType`, `externalRef`, `recordable`, `parentConsultationId?`), `ConflictError` (+ `QuotaExceededError extends ConflictError`, quota code only), `waitForFinalNote` with `FinalNoteUnavailableError` / `FinalNoteTimeoutError`, `chain()`, doc fixes. vox: real 12-value `ConsultationStatus` (+ `LegacyConsultationStatus`), `OpenSessionInput.parentConsultationId/context/metadata`, memo keeps `isNew/version/language/parent/status/visitType/recordable/externalRef`, `isRevisit` fixed. Changeset: minor (4.1.0) |
| Orchestrator | hope-v2 `62ebde1a0`, `93b84ce7b`, `0681017da` | Migration `20260929153857_task_1020_consultation_external_ref` (column, legacy-marker backfill keeping the newest per key, lookup index, partial unique index); racing-open recovery (the loser of the unique index returns the winner row); vox-node `parentConsultationId` optional (the gateway omits it for a first visit); admin-console playground treats SIGNED / CLOSED_COMPLETE / CLOSED_INCOMPLETE as closed; openapi, portal specs and vox-node admin schemas regenerated; prettier |
| L-ALS (opus) | ALaaS `0e6b773` | `buildExternalRef` = `eventId` (`ENCOUNTER_ID_REQUIRED` without one); no `appointmentDate`; admin-plane parent search removed (HOPE derives it); identity frame carries `consultationStatus`, `recordable`, `parentConsultationId`, `isNew`; `recordable:false` means no STT session and no recording, emitting `CONSULTATION_NOT_RECORDABLE`; `waitForFinalNote({ since })` replaces the unbaselined poll; `visit.prequel` downlink + web_ui "Return visit" chip and read-only earlier-note panel; `investigations` pass-through (no EMR source exists today); EMR copy on a signed consultation compares content first, storing `emr_updated_after_signoff` rather than `closed`, and the single-flight is keyed by content; `ALAAS_DETACH_GRACE_MS` (90 s); resume replays frames after `lastSeq`; error copy for `SESSION_LOST` / `CONSULTATION_NOT_RECORDABLE` / `ENCOUNTER_ID_REQUIRED` / `EXTERNAL_REF_CONFLICT` / `PARENT_PATIENT_MISMATCH` |

Deviations accepted by the orchestrator:
- **Consent on re-open (D-6) dropped.** `ensureConsultationConsent` GRANTS rather than checks, so calling it on re-open would undo a patient's revocation. Re-open stays consent-silent and a test pins that.
- **D-10 replaced.** The prequel is produced from the parent chain unconditionally; the graphs' `carryForward` stays off, because turning it on would inject the morning note twice.
- **Fragment key** is `same_day_return`, because keys cannot contain hyphens.

### 9.2 Gates (one pass after the full merge)

| Package | test | typecheck | lint |
|---|---|---|---|
| `@arcaai/database` | 107 files / 1982 tests ✓ | ✓ | (no lint script) |
| `@arcaai/domains` | 178 files / 2003 tests ✓ | ✓ | ✓ |
| `@arcaai/applications` | 1000 files / 15379 tests ✓ | ✓ | ✓ |
| `@arcaai/api` | 356 files / 4657 tests ✓ | ✓ | ✓ |
| `@arcaai/vox-node` | 41 files / 605 tests ✓ | ✓ | ✓ |
| `@arcaai/vox` | 216 files / 3298 tests ✓ | ✓ | ✓ |
| `@arcaai/admin-console` | — | ✓ | — |

- `gen:model` / `gen:entity` / `gen:factory` checks: no drift, and schema coverage is OK.
- The shadow-DB `migrate diff` after the migration prints an empty migration.
- No new lint warning sits on a TASK-1020 line: every flagged line blames to an earlier commit.
- Three files the lanes touched were already prettier-dirty before this ticket; they are left as they were.

ALaaS, run in the worktree against the built vox-node:
- `tsc` is clean.
- `jest src/consultation src/medical_summary`: 643/643.
  - `consultation.gateway.spec` "re-attaches … with resume" is flaky. It failed 1 of 3 runs on the pre-merge base `c8bbeca` and 0 of 3 on the merge.
- `web_ui` `node --test`: 503/515. The 12 failures are the known pre-existing department-code and prior-case-notes tests.

### 9.3 Runtime proof (dev stack, real gateway + Postgres, vox-node 4.1.0 build, ArcaAI service account)

```
1 morning open E1       {"isNew":true,"status":"OPEN","visitType":"new-visit","externalRef":"E1","recordable":true,"parent":null,"date":"2026-09-29"}
2 re-open E1 (retry)    {"id":<same as 1>,"isNew":false, ...}
3 afternoon open E2     {"isNew":true,"visitType":"revisit","externalRef":"E2","parent":<id of 1>}   ← new consultation, server-derived parent
4 racing opens E3       [{"id":X,"isNew":true},{"id":X,"isNew":false}]                              ← one row
5 chain(E2)             [morning, afternoon]
   (morning row set to SIGNED directly in the DB — my own proof row)
6 re-open signed E1     {"status":"SIGNED","recordable":false}
7 recording.start SIGNED: ConflictError 409 CONSULTATION_NOT_RECORDABLE   (kill-switch OFF; status stays SIGNED)
```

Side effect: the first attempt provisioned a dev clinician `auto_6a0b79169f3dec35` with staff id `arcaai_doctor`. That is TASK-950 find-or-provision, working as designed. It was reused for the proof and left in place.

### 9.4 Rollout status

| Step | Local dev | Dev cluster |
|---|---|---|
| Content (`rollout.mjs`): `same_day_return` template, 11 revisit agents, ArcaAI `casenote-finalization`, scribe schema v2 with `investigations` | ✓ template v2, revisit agents v3, finalizer v2; rerun = all `skip` | **After the push deploys.** Run `HOPE_BASE_URL=<cluster> HOPE_ADMIN_PASSWORD=… node docs/implementation/TASK-1020-*/rollout.mjs`, first with `DRY_RUN=1` |
| Setting `consultation.appointmentDay.timeZone = Asia/Kolkata` (ArcaAI) | ✓ read back | same script, same run |
| Migration `task_1020_consultation_external_ref` | ✓ (dev DB via `db:push` + partial unique index by hand) | applied by the `hope-db-migrate` job on deploy |
| SDK 4.1.0 | published to GitHub Packages (7 packages); version commit `02ae9e071`; tag `SDK-4.1.0` exists locally, and the owner pushes it | — |
| ALaaS on 4.1.0 | `a024be1` (manifest + lockfile + regenerated tenant context) | ships with the ALaaS push |

Stale ALaaS doc: `docs/hope-integration/02-vox-node-adapter.md` still describes `findLatestConsultation`.

### 9.5 Two-visit audio replay (local stack, 2026-09-29/30)

**Run 1** (the afternoon replayed the morning WAV) found two TASK-1020 defects and one pre-existing ALaaS defect. All three are fixed:
- The fragment placeholders used `{{context.*}}` and rendered empty on the live lane. They now use `{{trigger.context.*}}` (HOPE `6647034e9`).
- The finalizer never saw the prequel or the results. ArcaAI now has its own `casenote-finalization`, composed of `clinical_note`, then `same_day_return`, then the language policy (`069a139a5`).
- The prequel was dated in UTC; it now uses the tenant zone, e.g. "22:23 IST" (`68b864286`).
- ALaaS (pre-existing, `f399db1`/`708043b`): a live snapshot that arrived before the first section patch gave the note template generic keys, so `note.final` held 22 sections, 11 of them empty twins. The template now adopts the patch identity (ALaaS `9cfe427`).
- ALaaS also: `investigations` is now a known kind, and the replay script takes the event id, department code, visit type and investigations (`af2e8ab`).

**Run 2** used a fresh patient, a synthesized 47 s afternoon clip (the doctor reviews Hb 10.2 L and FBS 142 H and prescribes), and investigations in the start frame.

| Criterion (§7.4) | Result |
|---|---|
| Two consultations, each with its own note | PASS: C1 `new-visit` and C2 `revisit` (parent C1), each with its own RAW_SUMMARY, both approved, both `CLOSED_COMPLETE` |
| C1 unchanged after the afternoon | PASS: RAW_SUMMARY / PRE_SUMMARY hashes and the consultation row are identical before, after C2's sign-off, and after the re-open |
| The prompt (live and finalizer) carries prequel + results | PASS: the fragment text contains "### Earlier visit today (22:23 IST, status CLOSED_COMPLETE) …" and both result lines, in the live revisit call and in the `casenote-finalization` call; no `{{…}}` is left |
| The afternoon note states the full plan and results | PASS on content: Hb 10.2 [L] and FBS 142 [H]; ferrous sulphate 325 mg PO OD × 3 months; metformin 500 mg PO BD; aspirin 81 mg continued; diet and walking advice; review in 4 weeks with repeat Hb and HbA1c; ED if chest pain; it refers back to the morning ECG and troponin |
| No duplicate sections | PASS: 11 sections, 0 duplicates |
| Re-opening the signed E1 is refused | PASS: `CONSULTATION_NOT_RECORDABLE`, no STT session, nothing recorded |

Artifacts: session scratchpad `replay1020/run2/` (prompt captures `p29` live, `p43` harness stage 2, `p48` finalizer).

### 9.6 Follow-ups found by the replay (pre-existing, not TASK-1020)

- **The finalizer is blind to headings.** Its system prompt says to keep the partial summaries' headings, but its user turn is the section contents joined together with NO headings. The model therefore invents its own ("Chief Complaint / History/Interventions / …"), puts the plan under a non-template heading, does not update the diagnosis, and repeats the chief complaint. The morning new-visit note had the same shape. **This affects every note, not only return visits.** Recommended next ticket: pass the section titles, and the template's heading list, into the finalizer input.
- **Live section routing.** `treatment_plan` was never patched: the plan landed three times, in `current_medications`, `additional_data` and `instructions_and_orders`. A stale "No new instructions…" line also survives next to the real orders.
- **Degraded pre-summary.** `case-notes-pre-summary` is `degraded` on every visit when no case notes are sent.
- **ALaaS stream-close 404.** `closeStreamSession` answers 404 once per visit.

## 10. Change history

| Date | Change |
|---|---|
| 2026-10-05 | **OD-1 reversed by TASK-1045 D-3** (`docs/implementation/TASK-1045-Consultation-Lifecycle-Simplification/`): a consultation is now an EPISODE with encounters (`ConsultationEncounter`). `externalRef` selects the encounter, not the consultation; `open` returns the non-closed consultation of (tenant, doctor, patient, department) and appends an encounter for a new ref or an ended-encounter revisit; with none open it creates a new consultation chained to the latest closed one. The appointment date left the key, and the 12-state machine became 7 states + `processing`. |
| 2026-09-30 | Owner: do rollout steps 1–3, pushes later. Done:
- SDK 4.1.0 published; ALaaS on 4.1.0.
- `rollout.mjs` applied locally.
- Run-1 replay defects fixed (lane L-FIX merged `dfd76e779`; ALaaS `af2e8ab`, `9cfe427`).
- Run-2 replay passes all criteria (§9.5); pre-existing follow-ups in §9.6. |
| 2026-09-29 | Wave 1 + 2 merged (hope-v2 `b1af8ef92`…`0681017da`, ALaaS `0e6b773`), migration authored on the shadow DB, gate pass green, lifecycle proven live (§9.3). Status → Review. Deviations recorded in §9.1. |
| 2026-09-29 | Owner: all ODs as recommended, TASK-1020 confirmed, go. Wave 1 lanes L-OPEN, L-CARRY, L-CONTENT, L-SDK spawned in sibling worktrees `../hope-v2-task-1020-<lane>`. |
| 2026-09-29 | Plan written from a four-lane read-only discovery: HOPE lifecycle, SDKs, ALaaS broker/web_ui, content. Deciding facts re-verified by the orchestrator: `consultation.service.ts:1143-1177`, `:2296-2330`; `ConsultationEntity.ts:39-78`; `consultation-event.handler.ts:132-170, 470-495`; `visit-type.catalogue.ts:1-30`. |
