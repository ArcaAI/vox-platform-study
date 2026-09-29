# TASK-1008 — The EMR copy is the clinician's sign-off: revert "Save = full finish", make the trigger reliable, show its outcome

| Field | Value |
|---|---|
| Status | **Review** — merged locally into ALaaS `refactor-hope-integaration` (`3d19224`) and hope-v2 `dev-2.2`; NOT pushed (owner); §8 live verification pending |
| Type | bugfix + refactor (clinical sign-off semantics) |
| Branch | `dev-2.2` (hope-v2, docs only) · `refactor-hope-integaration` (ALaaSv3.0) |
| Repos | `arca/hope-v2` (docs + lifecycle guide), `ALaaSv3.0` (`apps/audio-stream-svc`, `apps/web_ui`) |
| Supersedes | TASK-1001 **D-10** ("ALaaS Save runs the full HOPE finish") |
| Opened | 2026-09-29 |
| Rules read | `00`, `01`, `04`, `07`, `08`, `11`, `14`, `_karpathy` |

## 1. Requirement

Owner, 2026-09-29, after a review of the ALaaS ↔ HOPE consultation lifecycle:

1. **Revert** the recent change that fires HOPE's approval signal when the clinician clicks
   **Save / Submit** (ALaaS `e02e390`, TASK-1001 wave 4). Save is not a sign-off.
2. **Find the indicator in ALaaS `web_ui`** that should fire the approval signal, so that a
   consultation the clinician finished lands `CLOSED_COMPLETE` in HOPE.
3. **Decision (owner, 2026-09-29):** the **EMR copy** is that trigger. One ticket, this one,
   covers both repos.

## 2. Current state (code-verified 2026-09-29)

### 2.1 Where the approval signal fires today

`UpdatedSummaryService.finishInHope` → `HopeConsultationFinishService.finish` runs
`summaries.update` (only if the text differs) → `summaries.approve` → `consultations.close`,
fire-and-forget, from **three** routes:

| Route (audio-stream-svc) | Added by | Reached from web_ui |
|---|---|---|
| `POST summary/save_summary` | `e02e390` (TASK-1001 wave 4) | Save dialog **No** ("save to DB only") and **Yes**; Copy to EMR in the recording tab |
| `POST summary/mark_copied_to_emr/:sessionId/:eventId` | `e7d5d97` (TASK-972) | after an EMR post (all screens) |
| `POST summary/mark_updated_summary_copied/:id` | `e7d5d97` (TASK-972) | after an EMR post (all screens) |

The Save dialog (`web_ui/components/RichTextEditor.jsx:1378-1489`) asks *"Would you like to copy
this summary to EMR case notes?"*; answering **No** still signs and closes the HOPE consultation.

### 2.2 Commit inventory — what goes, what stays

`refactor-hope-integaration` is pushed (`e02e390` is on `origin`), so the revert is a new revert
commit, never a history rewrite.

| Commit | Change | Decision |
|---|---|---|
| **`e02e390`** | `save_summary` → `finishInHope`; `edited` flag on the save result | **Revert.** `git apply --reverse --check` conflicts only in `medical-summary.controller.spec.ts` (constructor changed later by `6b2fc49`) — resolve by hand |
| `e7d5d97` | `consultation_link`, finish service, `mark_*` triggers | keep — this is the EMR-copy trigger |
| `5a342aa` | `CLOSED_INCOMPLETE` is not terminal for finish | keep — an EMR copy after the completion timeout must still sign |
| `7d47d50` | the edit leg names the clinician and carries `If-Match` | keep |
| `389886b` | duplicate-version prevention | keep |

HOPE code needs no revert: the completion timeout, `CLOSED_INCOMPLETE → SIGNED` and resume from
`CLOSED_INCOMPLETE` (TASK-1001 waves 5–6) stay valid under the new trigger.

### 2.3 Why the EMR copy is the right indicator

| Candidate signal | Explicit clinician intent | Final | Verdict |
|---|---|---|---|
| Save → No (DB only) | no — the clinician declined to submit | no | draft |
| Save → Yes (save + EMR copy) | yes, confirmed | once the EMR accepts | ✓ via the EMR-accepted event |
| Copy to EMR (recording / `summary` / `view` tabs) | yes, confirmed | yes — the note becomes the legal record | ✓ |
| `note.final`, auto-released review gate, timeout, tab close | no — machine events | no | never |

A signature is the clinician's explicit act (CMS signature requirements; AMA AI principles). The
EMR copy is the one confirmed "this is my note" moment every screen shares, and it already
converges server-side on the two `mark_*` routes (`copiedToEmr` false → true).

### 2.4 Defects on the EMR-copy path (must be fixed with the revert)

| # | Defect | Evidence | Effect |
|---|---|---|---|
| D1 | Copy to EMR is unreachable right after the note arrives — the structured read view does not render `editorRef`, so the handler toasts "No content available" until the clinician clicks Edit | `RichTextEditor.jsx:797` vs `:1323-1335` | the trigger fails on the normal path |
| D2 | Wrong id to the mark routes — `getSummaryById` puts the base `generated_summary` at `versions[0]`; the copy handler sends that id to `mark_updated_summary_copied/:id` (the `updated_summary` table). `handleSaveWithEMR` passes `saveResult.data.id` (a `generated_summary` id) as `versionId` | `RichTextEditor.jsx:527`, `:934-952`; `medical-summaries.service.ts:1402-1420`; `updated-summary.service.ts:179-192` | 404 → no sign-off, or another encounter's version marked and its text sent to HOPE |
| D3 | Marked "copied" although the EMR post failed | `SummaryVersions.jsx:153-155` ("regardless of EMR API result"), `:306` (checks only `API_BASE_URL`) | HOPE signs a note the EMR never received |
| D4 | The clinician's edits never reach HOPE — the base-row mark sends no `content`, and on realtime sessions the base row IS the clinician's text (`save_wav` creates an empty `generated_summary` at Stop, `audio-file.service.ts:118-140`; the first Save fills it via the insert path) | `updated-summary.service.ts:205-219`; `medical-summaries.service.ts:1342-1348` | HOPE signs its own AI draft; no `doctor_edit` correction, no training pair |
| D5 | Concurrent finishes — every trigger is `void finishInHope(...)` with no dedupe; a double click, a retry or two tabs race | `updated-summary.service.ts:196,215,252` | duplicate edit versions, or an edit that fails "approved and locked" |
| D6 | Every 409 is success — HOPE answers 409 to approve for "already signed" AND for "not ready" (`RECORDING`, `DRAINING`) | `hope-consultation-finish.service.ts:204-210,229-231,316-318` | `finished=true` with nothing signed, no retry |
| D7 | The outcome is invisible — only logged; the browser gets success from the local write; `isSummaryCopiedToEmr` is set even when the mark failed | `RichTextEditor.jsx:635-672`; `finishInHope` callers | no way to know the consultation reached `CLOSED_COMPLETE` |

## 3. Best practices applied

1. **Sign-off is one explicit clinician act** — never Save, a timeout, tab close or a machine event.
2. **One server-side trigger, single-flight per consultation, idempotent** — a repeat returns the
   recorded outcome instead of running again.
3. **What HOPE signs equals what the EMR received** — the copied text travels as `content`; the
   server compares it to HOPE's draft with the same normalisation as duplicate prevention
   (`isSameSummaryText`).
4. **Only verified success is success** — a 409 counts as done only after a fresh read shows
   `SIGNED` / `CLOSED_COMPLETE`.
5. **The outcome is persisted and shown** — the clinician sees Draft → Signed & closed, or a
   named failure with Retry.
6. **The browser declares intent; the server owns clinical state.**

## 4. Solution design

```
Copy to EMR (confirmed) ─► EMR accepts ─► POST mark_copied_to_emr/:s/:e { content, versionId? }
      └─► mark the matching version copied ─► finish (single-flight per consultation):
            update (if content ≠ HOPE draft) ─► approve ─► close ─► CLOSED_COMPLETE
            └─► persist outcome on consultation_link ─► GET hope-status/:s/:e ─► web_ui badge
Save / "No" ─► ALaaS draft only ─► HOPE stays PENDING_REVIEW
      (─► CLOSED_INCOMPLETE after the completion timeout; a later EMR copy still signs ─► CLOSED_COMPLETE)
```

## 5. Decisions

| # | Decision | Status |
|---|---|---|
| OD-1 | The EMR copy (Copy to EMR, or Save → Yes) is the only approval trigger; Save never signs. Supersedes TASK-1001 D-10 | **Decided** (owner, 2026-09-29) |
| OD-2 | One HOPE ticket (this one) covers both repos; no separate ALaaS plan doc | **Decided** (owner, 2026-09-29) |
| OD-3 | A note saved but never copied to the EMR ends `CLOSED_INCOMPLETE` (unsigned) at the completion timeout | **Decided** (owner, 2026-09-29): yes — never signed; a later copy still signs |
| OD-4 | Indicator = a badge in web_ui fed by a new `hope-status` route. Notifying the EHR host (`scribe.note.signed` postMessage) is deferred to the embedding ticket | **Decided** (owner, 2026-09-29): badge now, host message in the embedding ticket |
| OD-5 | Raise the tenant's `consultation.session.completionTimeoutMinutes` (default 5) so reviews that end with an EMR copy do not routinely pass through `CLOSED_INCOMPLETE` | **Decided** (owner, 2026-09-29): raise it — an owner settings write, not code; value chosen at deploy |
| OD-6 | `mark_updated_summary_copied/:id` kept for one release, then removed | **Decided** (owner, 2026-09-29): yes — deprecated now, removed next release |

## 6. Implementation plan (on go)

TDD per step: failing test first, then the minimal change. Lanes follow rule 14 — one worktree per
lane, branched from `refactor-hope-integaration` (ALaaS) / `dev-2.2` (hope-v2); the orchestrator
merges. Per the owner rule, lanes run only their own RED→GREEN files; one gate pass after the
full merge.

### Wave 1 — audio-stream-svc (lane A-BE)

| Step | Change | Tests (RED first) |
|---|---|---|
| 1 | Revert `e02e390`; resolve the spec conflict | `save_summary` never calls `finishInHope` — edited, unchanged and insert paths |
| 2 | `mark_copied_to_emr/:s/:e` accepts `{ content, versionId? }`; resolves or creates the version whose text matches `content`; a `versionId` not owned by this session/event → 404; always forwards `content` to finish | foreign `versionId` → 404; base-row mark with edited content forwards it (D2, D4); identical content → no update leg |
| 3 | Single-flight finish per `consultationId` (a concurrent caller joins the in-flight promise) | two concurrent marks → one update, one approve, one close (D5) |
| 4 | 409 on approve/close → re-read status; done only for `SIGNED` / `CLOSED_COMPLETE`; `RECORDING` / `DRAINING` → outcome `not_ready` | one case per status (D6) |
| 5 | Persist the outcome: `consultation_link` gains `hope_finish_status` (`pending \| signed \| closed \| failed \| not_ready \| skipped`), `hope_finish_error`, `hope_signed_at`, `hope_finish_updated_at` (+ migration SQL under `src/migrations/`) | outcome written for every branch of `finish` |
| 6 | `GET summary/hope-status/:s/:e` → stored outcome + HOPE's current status; `POST summary/hope-status/:s/:e/retry` → re-run finish (single-flight) | no link → `{ status: 'none' }`; retry after `failed` signs |

### Wave 2 — web_ui (lane A-UI)

| Step | Change | Tests |
|---|---|---|
| 1 | Copy to EMR works from the read view — text from the note model / `contentRef`, not `editorRef` (D1) | web_ui has no suite today: add Vitest for the extracted handler, or record the manual check in §9 |
| 2 | Mark copied ONLY after the EMR succeeded, sending `content`, in every screen: `RichTextEditor` (both paths), `SummaryVersions` (both paths), `AIDataModal`, `AIGeneratedSummaryPage` (D3). Never set "Copied to EMR" when the mark failed (D7) | as above |
| 3 | Sign-off badge next to the note, polling `hope-status` (2 s, up to 30 s) after a copy and on load: `Draft — not signed` · `Signing…` · `Signed & closed ✓ <time>` · `Sign-off pending — Retry` · `Not signed: <reason>`; shown in all three screens | as above |
| 4 | Save dialog wording: No → **Save draft**; Yes → **Save, sign & copy to EMR** | — |

### Wave 3 — hope-v2 docs (lane H-DOC)

1. `docs/guides/consultation-session-lifecycle.md` §3 (and §1 step 3): the ALaaS mapping becomes
   "Save → draft only; Copy to EMR → update / approve / close".
2. TASK-1001 README: Change History entry — D-10 superseded by TASK-1008 OD-1.
3. Tester note: how to read the badge.

## 7. Out of scope — follow-up tickets

From the 2026-09-29 lifecycle review; recorded so they are not lost:

- **EMR write-back server-side** — the broker's existing EMR provider (`emr.controller.ts`, FHIR
  `DocumentReference`) instead of the browser post with `VITE_EMR_BEARER_TOKEN`; makes "EMR
  accepted" a server event.
- **EHR embedding contract** — signed launch (SMART on FHIR or an EHR-signed JWT), origin-pinned
  `postMessage` for iframe and popup, `frame-ancestors`, authenticated consultation socket.
- **Explicit client state machine + "Sign & send"** — route `ConsultationWorkspace`, rehydrate from
  a broker session-state endpoint, Web Locks single-writer, connection / gap / consent UI.
- **Addendum after sign-off** — copying a later version to the EMR after HOPE signed needs
  `reopen` → update → approve (vox-node has no `reopen` yet); until then the badge shows
  "EMR updated after sign-off — HOPE not updated".
- **HOPE SDK / server gaps** — browser `vox` does not wrap `recording/start|stop` and its
  `ConsultationStatus` type is stale; vox-node lacks `reopen` and `waitForFinalNote` and maps every
  409 to `QuotaExceededError`; `recording.start` is accepted on a `SIGNED` consultation while the
  prime switch is off; `open` is get-or-create regardless of status.

## 8. Verification (after merge)

- `jest src/medical_summary src/consultation` green, `nest build` and `tsc` clean (audio-stream-svc).
- Replay (`npm run replay:consultation`, recipe in the ALaaS E2E notes), then through web_ui:
  1. Save → No: HOPE `PENDING_REVIEW`; badge `Draft — not signed`.
  2. Copy to EMR with an edit: HOPE `CLOSED_COMPLETE`; signed text = EMR text; a `doctor_edit`
     version exists.
  3. Copy after the completion timeout: `CLOSED_INCOMPLETE → SIGNED → CLOSED_COMPLETE`.
  4. Double click and two tabs: exactly one approve.
  5. EMR post fails: no mark, no sign-off; badge stays `Draft`.
  6. Copy to EMR right after `note.final` without clicking Edit: works (D1).

## 9. Implementation summary

Lanes (rule 14): **A-BE** audio-stream-svc — `opus` (clinical sign-off + concurrency: the verdict
stage); **A-UI** web_ui — `sonnet` (well-specified multi-file UI work under a pinned contract);
**H-DOC** — inline by the orchestrator. Each lane in its own ALaaS worktree off
`refactor-hope-integaration` @ `9333154`; both lanes built against the §6 HTTP contract in
parallel, no shared files.

### ALaaS (`refactor-hope-integaration`, merges `b7108dc` A-BE, `3d19224` A-UI — local, not pushed)

| Commit | What |
|---|---|
| `15efbe1` | revert of `e02e390` — `save_summary` never calls `finishInHope` (the expected spec conflict did not occur) |
| `16f8bc7` | `mark_copied_to_emr/:s/:e` takes `{ content, versionId?, updatedBy?, updatedById? }` (`mark-copied-to-emr.dto.ts`); version resolved by text (`isSameSummaryText`), a foreign `versionId` → 404, unmatched text → new `updated_summary`; content always forwarded; finish compares with the same normalisation (D2, D4) |
| `494a213` | single-flight finish per consultation id, in-process (D5) |
| `f781aa1` | a 409 on approve/close is re-read: done only for `SIGNED` / `CLOSED_*`; `RECORDING` / `DRAINING` / `OPEN` / `PRIMED` → `notReady` (D6) |
| `d4303aa` | outcome persisted on `consultation_link` (`hope_finish_status`, `hope_finish_error`, `hope_signed_at`, `hope_finish_updated_at`); migration `src/migrations/add-hope-finish-status.sql` |
| `db9f3bf` | `GET summary/hope-status/:s/:e`, `POST …/retry` (202; 404 unlinked; 409 `not copied to EMR`) |
| `8055c63` | orchestrator fix: a stored `pending` with no run in flight and older than 2 min reads as `failed` ("interrupted … retry") — a restart can no longer leave the badge at "Signing…" forever |
| `2dcf083` | web_ui: shared client `utils/emrSignOff.js` + `services/emrSignOffService.js`, badge model, `HopeSignOffBadge.jsx` |
| `e9f9133` | web_ui: Copy to EMR from the read view (D1); mark only after the EMR accepted, one call with `content`, in every screen (D3); "Copied to EMR" only when EMR + mark both succeeded (D7); badge beside every copy control; Save dialog → Cancel · **Save draft** · **Save, sign & copy to EMR**; copy confirm names the signer |

Deviations from the brief (accepted): a 409 on approve whose re-read shows `CLOSED_*` counts as
done; when an owned `versionId` and `content` disagree, content wins; the mark route keeps its
existing 201; `hope-status` reports `pending` while a run is in flight in this process.

### hope-v2 (`dev-2.2`)

- `docs/guides/consultation-session-lifecycle.md` — ALaaS mapping (Save draft → nothing; EMR copy
  → update / approve / close), §1, §3 and troubleshooting.
- TASK-1001 README — D-10 struck through and superseded; Change History entry.

### Gate evidence (merged tree, primary checkout, 2026-09-29)

```
audio-stream-svc  npx jest                         Test Suites: 2 failed, 39 passed, 41 total
                                                   Tests:       5 failed, 925 passed, 930 total
                  (the 5 failures — src/queue/consultation-workflow-run.spec.ts,
                   src/patient-data/department-name-map.spec.ts — fail identically on the
                   pre-merge base 9333154: 5 failed / 39 passed; out of scope)
                  jest src/medical_summary src/consultation   21 suites / 614 tests passed
                  npx tsc --noEmit                 exit 0
                  npx nest build                   ok
                  npx eslint src/medical_summary src/consultation   0 errors
web_ui            npm test                         tests 495, pass 483, fail 12
                  (the 12 are the pre-existing department-code / prior-case-notes failures;
                   baseline was 482 / 470 / 12; +13 new tests, all green)
                  npx vite build (to /tmp)         built in 2.30s
```

Worktrees `ALaaSv3.0-task-1008-{be,ui}` removed after the merge; branches `task-1008/{be,ui}`
deleted (merged).

### Deploy notes

- Non-development environments must apply `add-hope-finish-status.sql` by hand (`psql`), as with
  `add-hope-consultation-link.sql`; development relies on TypeORM `synchronize`.
- Single-flight is per process — correct for today's single broker replica; a second replica
  needs a shared lock.
- OD-5: raise `consultation.session.completionTimeoutMinutes` for the tenant at deploy.
- Not yet exercised in a browser or against the live stack — §8.

## 10. Change history

| Date | Change |
|---|---|
| 2026-09-29 | Opened: review of the Save / Submit sign-off (ALaaS `e02e390`), commit inventory, EMR-copy trigger analysis, defects D1–D7, plan. OD-1 and OD-2 decided by the owner. |
| 2026-09-29 | OD-3…OD-6 decided (recommendations accepted); go given. Lanes: A-BE (audio-stream-svc, opus), A-UI (web_ui, sonnet), H-DOC (inline). |
| 2026-09-29 | Implemented in two parallel ALaaS worktree lanes (A-BE opus, A-UI sonnet) + H-DOC inline; orchestrator fix `8055c63` (stale pending); merged locally into `refactor-hope-integaration` (`3d19224`) and gated on the merged tree; docs committed on `dev-2.2`. Not pushed (owner). Status → Review; §8 live verification pending. |
