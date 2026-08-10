# TASK-652 — BUG: clinical context does not reach the prompt ("no contextual patient data was provided")

| Field | Value |
|---|---|
| **Status** | **Pending** |
| **Type** | bugfix |
| **Priority** | **P0** — the model is generating clinical documents from an empty context and saying so |
| **Surfaces** | `hope-v2-dev` data (primary) + `ALaaSv3.0` (secondary) |
| **Reported** | 2026-08-10 — "it seems wrong as no context is picked up" |
| **Related** | TASK-634 D-27 (the code fix, committed and unpushed), TASK-650 (language), TASK-651 (template selection) |

---

## 1. Requirement

Everything the client sends — vitals, test results, previous visits, demographics,
transcript, prior pre-summary — must reach the prompt that generates the
pre-summary / summary. Nothing may be silently dropped.

---

## 2. Root Cause

There are **three independent context defects**. Two are confirmed; one is a
caller-side hardcode. They are grouped because they present identically to a
clinician: an output that says no information was supplied.

### 2.1 CONFIRMED — pre-summary: the deployed template has no placeholders (P0)

Live evidence, `hope-v2-dev`, 2026-08-10: a `/presummary` request carrying real
vitals, labs and prior visits returned

> *"No contextual patient data, diagnoses, or prior notes were provided in the request."*

The prompt-assembly chain in code is correct — `buildPreSummaryPrompt` →
`renderPreSummaryTemplate` → `buildPreSummaryVariables`
(`packages/applications/src/services/consultation/prompt/pre-summary-variables.ts:90-102`)
substitutes all nine v1 variables independently, with no gating on any other field.

The failure is **data, not code**. `buildPreSummaryPrompt` uses

```ts
const user = renderPreSummaryTemplate(governed || V1_PRE_SUMMARY_TEMPLATE, req);
```

so a **governed template row in the database silently overrides corrected code**.
The row on dev is the pre-TASK-634 **de-parameterized** body: its nine
`{placeholders}` were replaced during migration with the literal phrase
`provided in the request context` (TASK-634 §2.10 items 1-6). The prompt therefore
*promises* context and supplies none — and the model accurately reports that.

Proof it is the row and not the image: the same response carried **two vintages
at once** — a v1-shaped markdown body (title line, v1 order, `Latest Department
Note`) next to `structured_data` using v2 order and `Latest Dept Note` naming.
Mapper and template ship in the same image, so the prompt must come from the DB.

**Fix = replace the row.** A redeploy alone cannot fix it. Both
`PromptTemplate.content` **and** the `PromptVersion` snapshot at
`approvedVersionNumber` must change — the resolver serves the snapshot
(`prompt-resolution.service.ts:789-805`).

| Template | Template ID |
|---|---|
| ArcaAI pre-summary | `71000000-0000-0000-0001-000000000024` |
| SYSTEM pre-summary default | `71000000-0000-0000-0000-000000000040` |
| SYSTEM dept-free fork (native-only) | `71000000-0000-0000-0004-000000000002` |

Target sha256 for the ArcaAI row after the fix:
`d1b718001948db0aa05607803e96f30b429946e73774964eb6353c95b039b5ef` (3155 B).

### 2.2 CONFIRMED — browser pre-summary never sends test results (P1)

`ALaaSv3.0/apps/web_ui/hooks/useClinicalLogic.js:1790`

```js
const trimmedTests = "".trim();
```

`formatted_test_results` is therefore always `undefined` on the browser
pre-summary path. **Lab results have never reached pre-summary from the UI**,
independent of §2.1. This is also the pre-summary that is passed up and fed into
summarization, so the loss propagates.

Note the adjacent smell: vitals are sent twice on the summary path — as
`recentVitals` and again as `testResultsText` (`:1255-1256`), landing in
`session_data.test_results_text`. Decide whether that stays once real test
results flow; report, do not silently change.

### 2.3 NOT a defect — the summary path assembles context correctly

Verified at `apps/api/src/modules/smr-compat/summary-prompt.builder.ts:167-185`:
patient info, `pre_summary_text` (when `includePreSummary`), the transcript, then
`test_results` / `test_results_text`, then `previous_visits` / `previous_visits_text`
— each independently, structured-preferred with a text fallback.

So **do not rewrite the summary context assembly.** If summary output still looks
context-free after §2.1 and §2.2 land, the cause is upstream in what the caller
sends. Specifically check:
- `patient_info` is dropped wholesale when name/age/gender/DOB are all empty
  (`medical-summary.processor.ts:1038-1050`);
- `pre_summary_text` is `""` → `include_pre_summary_in_context: false`, silently,
  whenever the browser skipped its pre-summary step
  (`useClinicalLogic.js:1836-1843`, e.g. `encountersCount === 0`);
- the transcript is forwarded verbatim as a single `conversation_segments` entry
  (`:1059-1067`) — confirm it is non-empty.

---

## 3. Implementation Plan

### Phase 1 — restore the dev template rows (unblocks everything)

| # | Task | Agent tier | Effort |
|---|---|---|---|
| 1.1 | Dump the three template rows + their `PromptVersion` rows from `vox-dev` (id, content, sha256, `approvedVersionNumber`, `status`, `updatedAt`) to a timestamped file. Rollback material — non-negotiable. | sonnet-5 | medium |
| 1.2 | Deploy the restored code first (`29bf20f21`), then replace the rows. Ordering matters: deploy-then-seed also fixes the mangled `structured_data`; seed-first fixes context but leaves parsing mangled until the deploy lands (not harmful, just incomplete). | sonnet-5 | high |
| 1.3 | Verify **inside Postgres** that `sha256(PromptVersion.content)` equals the target above. Do not trust an application read. | sonnet-5 | medium |
| 1.4 | Re-run the reference request and confirm the supplied vitals / labs / prior visits are reflected in `pre_summary`. | sonnet-5 | medium |

### Phase 2 — ALaaS: stop dropping test results

| # | Task | Agent tier | Effort |
|---|---|---|---|
| 2.1 | Find the real test-results field in the patient payload (`apps/web_ui/public/mock/patientResponse.json` shows the shape) and format it like the sibling `formatted_vitals` / `formatted_previous_visits` builders in the same function. **If no such field exists, STOP and report** — do not invent a mapping and do not substitute vitals. | sonnet-5 | medium |
| 2.2 | Report on whether `testResultsText: recentVitalsRef.current` (`:1256`) should remain once real results flow. | sonnet-5 | medium |

### Phase 3 — make silent context loss impossible

| # | Task | Agent tier | Effort |
|---|---|---|---|
| 3.1 | Log at INFO, per request, which context blocks were present vs empty (booleans and lengths only — **never** content, this is PHI): `hasVitals`, `hasTestResults`, `hasPreviousVisits`, `hasPatientInfo`, `hasPreSummary`, `transcriptChars`. Today an empty context is indistinguishable from a full one in the logs. | sonnet-5 | medium |
| 3.2 | Add a guard test asserting every seeded pre-summary body still contains all nine `{placeholders}`. The de-parameterization in §2.1 shipped precisely because nothing checked. | sonnet-5 | high |
| 3.3 | Consider rejecting (or loudly warning on) a governed pre-summary template that carries none of the nine placeholders — that state can only produce a context-free prompt. | **opus-5** | high |

---

## 4. Verification Criteria

- [ ] `sha256(PromptVersion.content)` for the ArcaAI pre-summary = `d1b7…b5ef`
- [ ] Reference request returns a pre-summary that reflects the supplied vitals, labs and prior visits
- [ ] A patient with lab results shows them in the pre-summary (Phase 2)
- [ ] The INFO context line distinguishes a full from an empty context
- [ ] Placeholder guard test fails against the de-parameterized body (verify by pinning the old content in a fixture)
- [ ] `pnpm --filter @arcaai/api test lint` and `pnpm --filter @arcaai/database test` green

---

## 5. Notes for the executing agents

- **The pre-summary code is already correct.** Do not "fix" `buildPreSummaryPrompt`,
  `renderPreSummaryTemplate` or `buildPreSummaryVariables` — they were verified
  line by line on 2026-08-10. The defect is the stored row.
- The restored v1 template deliberately duplicates its title (FORMAT emits it
  unbolded, the mapper prepends the bolded form). Owner accepted this as v1
  parity — **not** a bug to fix here.
- Reference request and expected output are in TASK-634's Change History (D-27).

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-08-10 | Opened. Separated three defects that present identically: the de-parameterized governed row on dev (P0, data not code), the hardcoded-empty browser test results (P1), and a summary assembly path that is actually correct and must not be rewritten. Added a placeholder guard test and a PHI-safe context-presence log so this class of failure cannot recur silently. |
