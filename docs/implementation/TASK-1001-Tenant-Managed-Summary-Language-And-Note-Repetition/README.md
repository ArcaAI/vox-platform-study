# TASK-1001 — Tenant-managed summary language, and note repetition

| | |
|---|---|
| **Status** | Review — wave 4 (live-note script guard, OD-14 re-finalise) deployed on `hope-v2-dev` (`6b864c73`) and verified by replay; ALaaS Save sign-off committed, not pushed; awaiting owner sign-off |
| **Type** | bugfix + feature |
| **Branch** | `dev-2.2` |
| **Repos** | `arca/hope-v2` (primary) · `ALaaSv3.0` (secondary, latent defects) |
| **Reported by** | Tester, 2026-09-22 — *"the summary generated now for hematology contains malayalam words as well as repeated sentences"*, displayed **in ALaaS** |
| **Ticket number** | `docs/archive/**` is off-limits this sprint, so `1001` is taken from the `docs/implementation/` high-water mark (TASK-1000). Confirm before the branch is cut. |
| **Related** | TASK-1000 (truncated live-summary JSON — landed `b358a82a9`), TASK-947 (composable instructions), TASK-939 (turn contract), TASK-932 §3.7 (summary language), TASK-891 OD-1 (STT language posture) |

---

## Requirement Analysis

Two defects in one tester report, independently root-caused and **both confirmed against
`hope-v2-dev` with decrypted evidence**.

**Part A — language.** The hematology note was written partly in Malayalam. It should have been
English, and more importantly **a tenant admin has no way to say so.** The requirement is not
"hardcode English" — it is that a tenant admin manages the output language from the Instructions /
Prompt template or from agent configuration, including a conditional translation instruction
driven by consultation context.

**Part B — repetition.** The same note repeated sentences. **Confirmed: the duplication is in
HOPE's STORED note**, not in the client's rendering. ALaaS renders faithfully what HOPE saved.

Classification: clinical-surface severity. A clinician is handed a note in the wrong language with
the same clinical statements repeated up to six times.

---

## Current State Evaluation

### Evidence — `hope-v2-dev`, 2026-09-22, consultation `01a0c7ba-cd2b-794e-b6fa-e12e12a33a0a`

Hematology, workflow `arcaai-heme-consultation`, template `arcaai-heme-soap-new-visit`, tenant
`50000000-…-0001`, opened 06:08:23 UTC by `alaas.audio-stream-svc`. Synthetic test patient
(`patientRegNo` 777888). It ran **three separate recording sessions**: 06:08:53–06:11:12,
06:52:57–06:57:26, 07:40:23–07:42:39.

### B0 — CONFIRMED: the stored note repeats. Decrypted 2026-09-22.

Read through Vault Transit (`hope-phi`, `contentKeyVersion=1`) under a purpose-made
`hope-phi-ro` policy and a 2-minute, use-limited token, both **revoked and deleted immediately
after** (verified: policy absent, no temp files). **The clinical plaintext is deliberately NOT
reproduced in this document**; the structure below is what matters and is sufficient to drive the
fix.

Let **S1** and **S2** be the two distinct content blocks the model produced for `plan_of_care`.
The stored section contains, in order:

| Block | Content | Why the guard missed it |
|---|---|---|
| 1 | `S1` | — (first write) |
| 2 | `S2` | — (genuinely new) |
| 3 | `S1 + S2` concatenated | **superset restatement** — the combined string is not a contiguous substring of the stored `S1\n\nS2` |
| 4 | `S1' + S2` where `S1'` differs from `S1` by **one space** (`tg, atg` → `tg,atg`) | **whitespace variant** |
| 5 | `S1 + S2` again | superset restatement |
| 6 | `S2` then `S1` | **reordering** |
| 7 | `S2''` where doses differ by spacing (`1000mg` → `1000 mg`, `5mg` → `5 mg`) | **whitespace variant** |

`diagnosis` shows the same mechanism in its purest form: two distinct blocks, then a third block
that is those two **concatenated verbatim** — defeated only because storage joins with `\n\n`
while the restatement joins with a single space.

**Every duplicate is an exact-sentence repeat modulo whitespace, punctuation or ordering. Not one
of them is a paraphrase.** This is decisive for the fix design (see OD-5).

The same decrypted text also confirms **Part A in situ** — the note is code-switched mid-sentence
(e.g. `day care-ൽ വെച്ച് തരാം`), exactly as the prompt instructed.

### B1 — the append guard is an exact-substring check

[turn-contract.ts:343-352](../../../packages/applications/src/services/consultation/live-documentation/realtime/turn-contract.ts) —
untouched by TASK-1000:

```ts
} else if (contribution?.addition) {
  const addition = contribution.addition.trim();
  if (addition.length > 0 && !before.includes(addition)) {
    after = before.trim().length > 0 ? `${before.trim()}\n\n${addition}` : addition;
    writes.push({ sectionKey, title, idx, mode: 'append', content: addition });
  }
}
```

`!before.includes(addition)` is a case-, whitespace- and punctuation-sensitive containment test of
the **whole trimmed addition**. It catches only a byte-identical contiguous repeat. Every shape in
the B0 table sails through.

### B2 — why this consultation and not the others

`plan_of_care` and `diagnosis` are the only two sections that received appends **across resumed
recording sessions**. On resume the clinician recaps; the model re-emits what it already wrote
plus a new detail; the guard cannot see below whole-addition granularity.

| Section | Target | Peers (4 other consultations) | Ratio |
|---|---|---|---|
| `plan_of_care` | rev **6** / 2685 B | rev 1–3 / 205–905 B | **3.3–13×** |
| `diagnosis` | rev **3** / 1365 B | rev 2–3 / 373–377 B | **3.6× at equal revision count** |

Every section written inside a single session is within peer range.

> Figures drift while testing continues — `plan_of_care` was rev 5 / 2417 B earlier the same day.

### B3 — no revision history exists

`DocumentSection.provenance` is **NULL on every row**; there is no `DocumentSectionVersion` table.
Only the current ciphertext survives, so the turn-by-turn diff is unrecoverable. Every other
candidate column (`AgentTrajectoryStep.payloadRef`, `HarnessAuditEvent.*`, `AuditLog.data`,
`WorkflowRun.resultRef`) holds only non-PHI operational metadata. **Nothing in the system records
what a turn actually proposed** — which is why B0 required decryption and why Phase 5's telemetry
matters.

### B4 — decoding has no repetition pressure

All 44 `arcaai-*-summary-*` agents plus `case-notes-pre-summary`, `casenote-finalization` and
`general-medicine-summarization` run `lms-gemma-4-e2b-it-qat` (2B QAT) at `temperature: 0`,
`maxTokens: 2048`, with **no `frequencyPenalty` and no `presencePenalty`**. Both knobs already
exist in `GENERATION_PROPERTY`
([agent-schemas.ts:107](../../../packages/workflow-contract/src/agent-schemas.ts)) and are simply
unset — a configuration gap, not a code gap.

### A1 — `ml-en` is the STT code-switch mode, not an output language

`Consultation.metadata.summaryLanguage` is written from `OpenConsultationRequest.language`
([consultation.service.ts:1162](../../../packages/applications/src/services/consultation/consultation/consultation.service.ts)).
ALaaS sends `ml-en` — the value of `ASR_PARAMETERS.decoding.languageMode`. The module that owns
the field states the rule being broken, in its own header:

> *"The transcript's language and the note's language are independent, so declaring one must never
> silently set the other."*

Four of the five consultations that day carry `ml-en`; the 04:13 one carried `en`.

### A2 — the platform collapses `ml-en` to Malayalam, in two resolvers that disagree

`SUMMARY_LANGUAGE_PATTERN` accepts `ml-en` (shaped exactly like the legitimate `en-IN`). Both
resolvers then take the primary subtag:

| Resolver | `ml-en` → | absent → |
|---|---|---|
| `summaryLanguageName()` ([summary-language.ts:89](../../../packages/applications/src/services/consultation/consultation/summary-language.ts)) | `Malayalam` | `null` — "no language declared" |
| `resolveV1LanguageName()` ([pre-summary-variables.ts:63](../../../packages/applications/src/services/consultation/prompt/pre-summary-variables.ts)) | `Malayalam` | **`'English'`** |

### A3 — code beats configuration, so the tenant admin has no lever

`operatingFrame()`
([live-documentation.service.ts:5200](../../../packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts))
**generates** the language directive and appends it *after* the rendered instruction:

> `Write every section value in Malayalam (ml-en), whatever language was spoken. Keep the section keys and headings exactly as given, in English.`

| Lane | Source of the directive | Tenant-editable? |
|---|---|---|
| `case-notes-pre-summary` | `{{context.language_name}}` in the prompt template | **yes** |
| Live SOAP summary | `operatingFrame()` — generated in code | **no** |

### A4 — the mechanism the requirement asks for already exists and is unused

TASK-947 shipped composable instructions: `instruction.fragments[]`, ordered, each an inline
`systemPrompt` **or** a `promptTemplateId`, each with an optional CEL `when` over the render scope
(`context.*`, `trigger.*`, `input.*`, `vars.*`, `nodes.*`); absent `when` = always included.

| Capability | Where | State |
|---|---|---|
| Fragments (max 16); CEL `when` (max 2000 chars) | `PROMPT_FRAGMENT_SCHEMA`, `AGENT_PROMPT_FRAGMENT_MAX` | shipped |
| Tenant-admin editor | `apps/admin-console/.../fragment-list-editor.tsx` | shipped |
| Per-call "which fragments ran / were excluded" | `AgentTestCompositionResponse`, draft test panel | shipped |
| Authoring validation (`PROMPT_VARIABLE_CONFLICT`) | `agent-findings.ts:43` | shipped |
| **Used by any seeded ARCAAI agent** | — | **no** |

Every summary agent binds a single template instead:
`{ "promptTemplateId": "71000000-…-020", "promptVersionNumber": 3 }`.

The agent **parameters** form is schema-driven, so anything added to `AGENT_PARAMETER_SCHEMAS`
gets a console control with no UI work. `TEXT_GENERATION_PARAMETERS` is
`additionalProperties: false`, so a new field is a contract change.

---

## Secondary findings — ALaaS and the stream contract (real, but NOT the reported cause)

B0 settles that HOPE saved duplicated text. These defects were found while investigating and are
**latent**: each could produce duplication independently, none is required to explain this report.
They are carried here so they are not lost, and are sequenced **after** the primary fix.

| # | Finding | Location | Severity |
|---|---|---|---|
| **S-1** | `LivePlane.open()` replaces `this.stream` **without closing the previous handle**, and `broker.start()` has no already-streaming guard. A duplicate `POST recording/start` **14s apart** (observed 06:08:25 / 06:08:39) opened **two concurrent subscriptions** that both ran ~152s and tore down within **3ms** of each other. Every event was delivered twice. | `ALaaSv3.0` `live-plane.ts:111-116`, `consultation-broker.service.ts:311-327` | high — confirmed to have occurred |
| **S-2** | `LivePlane.reopen()` resets `attempts = 0` when the **handle** is created, not when the stream is healthy; `subscribeToSse` returns synchronously before the request is issued. The documented 5-attempt backoff cap is **unreachable**, so any repeating failure becomes one subscribe per second indefinitely. Did **not** fire here (all requests 200). | `ALaaSv3.0` `live-plane.ts:395-419` | high — latent |
| **S-3** | The unit test pinning S-2's cap passes only because it mocks a `throw` the real adapter cannot produce — it validates an unreachable path. | `consultation-broker.service.spec.ts:132-150` | medium |
| **S-4** | **Section-identity twinning.** `findHeldIndex` merges by exact `documentKey::sectionKey`, or by title-slug **only when one identity is generic**. Two specific identities sharing a title, or any title drift, **insert a twin** that nothing ever removes (`orderSections` dedupes on key only). | `ALaaSv3.0` `reducer/document.js:166-178`, `liveSummaryModel.js:160-175` | high — **interacts with Part A** |
| **S-5** | `concat(extra)` appends every final-document row whose `sectionKey` matched no live section; `formatCaseNoteForExport` joins all of them, so a key mismatch prints the same paragraph twice in the exported note. | `ALaaSv3.0` `liveSummaryModel.js:641-643` | medium |
| **S-6** | The published SDK type omits `appended` entirely and documents `content` only as *"One section's new state"*. The rule *"`content` is ALWAYS the whole body"* exists only in HOPE's internal DTO. An integrator reading the SDK can reasonably implement append. | `packages/vox-node/src/types/consultation-realtime.ts:404-425` | medium — contract drift |
| **S-7** | The route's OpenAPI description still claims *"Each event is a LiveSummaryEventDto JSON"* for a channel that has been multiplexed since TASK-932. | `apps/api/.../consultation.controller.ts:1033-1035` | low |
| **S-8** | `ContextInterceptor` re-fires "Request completed" repeatedly on a long-lived SSE response with a growing `durationMs`. This **corrupts every log-based request aggregation**: the apparent "58 stream opens" were in fact **4 distinct connections**. | `apps/api` `ContextInterceptor` | medium — observability integrity |
| **S-9** | Late join replays the note snapshot and `presummary` but **never a `section.patch`**, and `isDuplicateOfLiveSummarySnapshot` returns early for `section.patch` so no cross-plane dedup exists. The snapshot DTO carries no `sectionKey` or `revision`, so a reconnecting client cannot seed its revision map. | `live-documentation.service.ts:4536-4599`, `dto/live-summary.dto.ts:97-103` | medium |

**S-4 collides with Part A.** The title-slug fallback is the only defence against twinning and
assumes byte-identical headings. Translating section headings would **cause** duplicate sections
in ALaaS. `operatingFrame`'s language line currently also carries *"Keep the section keys and
headings exactly as given, in English"* — retiring it into a tenant-editable fragment without
preserving that clause would introduce this defect. Phase 3 pins it with a test.

### Scope boundary against TASK-1000

The four `finish_reason: "length"` generations that day belong to `01a0c77b-08c8…` and are
TASK-1000's defect, fixed in `b358a82a9` — which touched `live-documentation.service.ts`,
`degrade-codes.ts` and added `output-budget.ts`, **not** `turn-contract.ts`. No overlap in file or
cause.

---

## Owner Decisions Required

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **OD-1** | Where a tenant admin authors the output-language policy | (a) `instruction.fragments[]` → a shared PromptTemplate; (b) new `parameters.output.language`; (c) a `GlobalSetting` descriptor | **(a)** — exists, has a console editor and per-call telemetry, and expresses conditional translation. (c) cannot express "based on the context" |
| **OD-2** | Does tenant configuration beat the caller's per-consultation `language`? | (a) config wins when set, absent ⇒ caller flows through; (b) caller always wins; (c) a tenant flag | **(a)** — mirrors `AiProviderConnection`'s "absent = no opinion". No new flag, no change for non-adopters |
| **OD-3** | Retire `operatingFrame`'s generated language step into a seeded policy fragment? | (a) retire; (b) keep, sourced from resolved config | **(a)** — one mechanism for every lane. Must carry the headings-stay-English clause (S-4) |
| **OD-4** | Reject a code-switch tag at `/consultations/open`? | (a) 400; (b) accept and normalise; (c) accept as today | **SUPERSEDED 2026-09-23 by the owner: accept.** `ml-en` declares code-switched transcription with Malayalam primary; it is a legitimate SOURCE value. The wave-1 400 is reversed at the DTO; the OUTPUT grammar still refuses a mixed language |
| **OD-5** | Dedup strength | (a) exact-normalised sentence dedup; (b) add similarity/paraphrase dropping; (c) similarity flagging only | **(a) now, (c) later — settled by evidence.** Every observed duplicate is an exact-sentence repeat modulo whitespace, punctuation or ordering. **No paraphrase dropping is needed to fix this report**, and similarity dropping risks silently losing clinical content |
| **OD-6** | Promote repetition pressure to a degrade code + metric? | (a) yes; (b) log only | **(a)** — 11 of 13 flushes carried refusals and nothing surfaced it |
| **OD-7** | Model tier for the summary agents | (a) keep 2B; (b) evaluate larger | **ANSWERED 2026-09-22: (a) keep `gemma-4-e2b-it-qat`.** Consequence: the sentence dedup is the ONLY structural defence against repetition |
| **OD-8** | Ship the English-only policy as a SYSTEM reference-set default? | (a) yes; (b) tenant opt-in only | **(a)**, noting content is cloned — existing tenants need an edit or a reference-set sync |
| **OD-10** | **ANSWERED 2026-09-23: (b) build the plumbing.** Phase 6 was a no-op as specified. `frequencyPenalty` / `presencePenalty` exist in `AGENT_PARAMETER_SCHEMAS` but **never reach a provider**: `resolve_request_defaults` (`apps/text/src/text/core/defaults.py`) returns exactly `{temperature, max_tokens, top_p}`, `grep` for the penalties across `apps/text/src` returns zero hits, the LM Studio adapter's only `extra_body` passthrough is a retention `ttl`, and `TEXT_PLANE_GENERATION_PARAMS` declares the honest set with a publish gate behind it | (a) accept dedup-only; (b) plumb the penalties through `apps/text` (`GenerateRequest`, `defaults.py`, the adapters, `AiRuntimeProfile` columns, the contract's param list) | Built in wave 2 (lanes P1/P2) as runtime platform settings — no Prisma change — because a published agent's parameters cannot be updated |
| **OD-11** | ~~Does the frozen v1-compat surface keep its `'English'` default?~~ | — | **RESOLVED during integration: yes.** §A2 first called it drift; that was wrong. The compat PRE-SUMMARY template renders `{language_name}` into a live instruction and is pinned by byte-identical golden fixtures, so `null` there would emit *"Write ALL bullet content in ."* The default stays; the shared grammar now rejects `ml-en` first, so it lands on v1's unknown→English rule. The native path keeps absent ⇒ `null`. Two surfaces, two contracts |
| **OD-9** | Do the ALaaS defects (S-1…S-5) ship in this ticket or a sibling? | (a) sibling ticket in `ALaaSv3.0`, this ticket owns HOPE; (b) one ticket across both repos | **ANSWERED 2026-09-23: (a).** `ALaaSv3.0/docs/HOPE_TASK_1001_LIVE_SUMMARY_CLIENT_FIX_PLAN.md`, merged into `refactor-hope-integaration` (`50bf477`) |
| **OD-12** | **NEW 2026-09-23 (owner): output language.** *"ALaaS still sends the language: `ml-en` indicates code-mixed/code-switch enabled for realtime/job transcription, Malayalam as main language. The summarization (both pre-summary and summary) is still in English by admin configuration OR by default."* | — | **Implemented in wave 2 (lane L5).** The output language never reads `open.language`: the tenant's selected policy fragment, else the platform default `consultation.summary.outputLanguage` (English), which the runtime states and which names and overrides the corpus's "write in the conversation language" clause. Supersedes the TASK-891/TASK-932 "absent is not English" posture on the native path |
| **OD-13** | Cluster rollout of the policy fragment | heme first / all 22 / hope-reset | **ANSWERED 2026-09-23: all 22 at once**, via the admin API (new agent versions; previous versions stay as the rollback target) |
| **OD-14** | Should a RESUMED recording re-finalise the note? | re-run the finalize on every stop / only when the resume added content / keep one finalize per consultation (today) | **ANSWERED 2026-09-23 (owner): re-finalise on a stop after a resume, supersede-via-restart, never overwrite a signed note** — wave 4 lane L-I. |

---

## Implementation Plan

TDD throughout. Phases 1–3 (language) and 4–6 (repetition) are independent lanes with disjoint
file boundaries and may run in parallel.

> **Agents implementing any lane run NO gating tests** — no suite, build, lint or typecheck. Each
> lane runs only its own new RED→GREEN test file. The orchestrator runs the full gate **once**,
> after every lane is merged to `dev-2.2`.

### Phase 1 — the language tag is validated as a language (OD-4)

- **RED** `summary-language.task1001.test.ts`: `ml-en`, `en-ml` refused; `en`, `ml`, `en-IN`,
  `zh-Hant-HK` accepted.
- Discriminator: `ml-en` and `en-IN` are shape-identical, so shape cannot decide. Rule: **a
  two-letter second subtag that is itself a known language primary subtag is not a region.**
- 400 at `/consultations/open` naming both fields and the STT-vs-note distinction.
- Files: `summary-language.ts`, `open-consultation.request.ts`.

### Phase 2 — one resolver, one absent-posture (OD-2)

- **RED**: `resolveSummaryLanguage()` returns the agent's configured language when set, the
  consultation's declaration when not, `null` when neither — and **never** `'English'` by default.
- Collapse `summaryLanguageName()` and `resolveV1LanguageName()` onto it.
- Files: `summary-language.ts`, `pre-summary-variables.ts`.

### Phase 3 — the language directive becomes a policy fragment (OD-1, OD-3, OD-8)

- **RED** `live-documentation.operating-frame.task1001.test.ts`: `operatingFrame` emits no language
  line; the policy arrives via the fragment; **the rendered instruction still requires section keys
  and headings to stay English (S-4 regression pin)**; a consultation declaring `ml` still produces
  a Malayalam note through the fragment path.
- Seed one shared *Output language policy* PromptTemplate and reference it as an unconditional
  fragment on the summary agents; conditional translation is a sibling fragment with a `when`.
- Confirm the CEL scope path in the **draft test panel** before seeding — the realtime lane builds
  `{ trigger: { context }, … }`, so it may be `trigger.context.language`.
- Files: `live-documentation.service.ts`, `07b-arcaai-clinical-templates.ts`,
  `29-arcaai-agents-and-workflows.generated.ts`.

### Phase 4 — sentence-level append dedup (OD-5) — **the fix for the reported defect**

- **RED** `turn-contract.task1001.test.ts`, driven directly by the B0 shapes:
  - `S1\n\nS2` stored, addition `S1 + S2` (single-space join) ⇒ **no write**, one refusal;
  - addition differing only by a space inside `tg, atg` ⇒ **no write**;
  - addition with doses respaced `1000mg`→`1000 mg`, `5mg`→`5 mg` ⇒ **no write**;
  - addition `S2` then `S1` (reordered) ⇒ **no write**;
  - three-sentence addition of which two are stored ⇒ appends **exactly one** sentence;
  - sentences differing in a **number, dose, date or laterality** (`1000mg` vs `100mg`) ⇒
    **appended** — the clinical-safety floor;
  - **the sentence splitter must not split on a period between digits** (`1.05 ng/mL`,
    `488.2 IU/mL`) — pin this explicitly;
  - the appended text is the **original**, never the normalised comparison form.
- Implementation: split `before` and `addition` into sentences; normalise **for comparison only**
  (lowercase, strip all whitespace, strip trailing sentence punctuation) — this equates the
  whitespace variants while preserving every digit, so the safety floor holds; drop sentences
  already present; append the residue in original order.
- Extend `TurnRefusalReason` with `addition-already-present`; carry a dropped-sentence count on
  `AppliedTurn` for Phase 5.
- File: `realtime/turn-contract.ts` — untouched by TASK-1000, no merge risk.

### Phase 5 — make repetition pressure visible (OD-6)

- **RED**: a flush window whose refusal and dropped-sentence counts exceed the threshold publishes
  the degrade event and increments the counter.
- Add `LIVE_DEGRADE_REPETITION_PRESSURE = 'repetition_pressure'` beside TASK-1000's
  `output_truncated`, plus a counter for refusals and dropped sentences.
- Files: `degrade-codes.ts`, `live-documentation.service.ts`.

### Phase 6 — decoding pressure — **BUILT in wave 2 (OD-10 b)**

**Not implemented, and not implementable as written.** The penalties are declared in the agent
schema but are inert on this platform's TEXT plane (evidence in OD-10). Earlier drafts of this
ticket twice described Phase 6 as "pure configuration, no code, no deploy" — that was wrong.

With OD-7 answered (E2B stays), there is no decode-time mitigation at all, so **Phase 4's sentence
dedup carries the entire load**. That is what it was designed for: every duplicate observed in the
decrypted note was an exact repeat modulo whitespace, punctuation or ordering.

### Phase 7 — HOPE-side contract and observability (S-6, S-7, S-8, S-9)

- Add `appended` to the published SDK type and state the whole-body rule (S-6); correct the route
  description (S-7); fix `ContextInterceptor`'s repeated SSE logging (S-8); decide on S-9's
  late-join gap.
- Files: `packages/vox-node/src/types/consultation-realtime.ts`, `consultation.controller.ts`,
  `ContextInterceptor`, `live-documentation.service.ts`.

### Phase 8 — ALaaS (S-1…S-5), per OD-9 most likely a sibling ticket

Expedite **S-1** (close before replace + a repeat-`start` guard): confirmed to have occurred, and
a one-line close removes the leak.

---

## Practices this ticket commits to

1. **One place states a runtime rule.** Phase 3 changes *which* single place — generated code to
   one shared, tenant-editable template — not how many.
2. **The policy fragment is a pointer, never inlined.** ~44 agents referencing one template means
   the admin edits one row.
3. **Do not pin `promptVersionNumber` on the policy fragment** unless freezing it deliberately.
4. **One rule per fragment.** English-only and translate-to-X are separate fragments with mutually
   exclusive `when`s.
5. **Section keys and headings stay English** — now a tested requirement, not advice (S-4).
6. **Absent ≠ English.**
7. **Never silently drop clinical content.** Dedup drops only provably identical sentences; the
   evidence shows nothing weaker is needed.
8. **Content is cloned; configuration cascades.** SYSTEM reference-set seeding reaches new tenants
   only.
9. **Agent edits need a per-tenant republish** (TASK-994).
10. **Verify fragments in the draft test panel, not by reading JSON.**
11. **PHI plaintext is never written into a repo document.** B0 records structure, not content.

---

## Verification Criteria

- [ ] `ml-en` at `/consultations/open` returns 400; `en-IN` still accepted
- [ ] One resolver; `'English'` is never a silent default
- [ ] `operatingFrame` emits no language line; policy arrives via fragment in both lanes
- [ ] The rendered instruction still requires English section keys and headings (S-4 pin)
- [ ] A Malayalam-English transcript on a tenant whose policy says English produces an English note
- [ ] **Each B0 shape — superset, whitespace variant, reorder — produces no write**
- [ ] A three-sentence addition with two already stored appends exactly one sentence
- [ ] `1.05 ng/mL` and `488.2 IU/mL` are never split mid-number
- [ ] `1000mg` vs `100mg` is treated as NEW
- [ ] `repetition_pressure` fires on a synthetic repeating turn
- [ ] **Full gate run once after all lanes are merged to `dev-2.2`** — `pnpm --filter @arcaai/applications test`, `--filter @arcaai/workflow-contract test`, `--filter @arcaai/admin-console build lint test`
- [ ] Re-run the heme scenario on `hope-v2-dev` across **resumed recording sessions** — the trigger — and attach the flush table, section revisions and rendered prompt

---

## Implementation Summary

Built in four parallel lanes, each in its own worktree with a disjoint file boundary; merged to
`dev-2.2` and gated once, by the orchestrator, after every lane landed.

| Lane | Branch | Commit | What shipped |
|---|---|---|---|
| L2 | `task-1001-dedup` | `a7414f37d` | Sentence-level append dedup in `turn-contract.ts`; `TurnRefusalReason` gains `addition-already-present`; `AppliedTurn.droppedSentenceCount` |
| L1 | `task-1001-lang-resolve` | `b359fdbab` | Code-switch rejection inside `SUMMARY_LANGUAGE_PATTERN`; `resolveSummaryLanguage` |
| L3 | `task-1001-policy-fragment` | `6f20bcfbf` | Language step retired from `operatingFrame`; shared *Output language policy* template + unconditional fragment on all 22 department agents; `repetition_pressure` degrade code |
| L4 | `task-1001-contract-docs` | `4d65dd52b` | `appended` added to the published SDK type; corrected live-summary route description; `ContextInterceptor` completion log moved to `finalize()` |
| — | integration | `640762e55` | v1 parity restored (OD-11), seed guards taught the composite form, harness + type fixes, API artifacts regenerated |

### What the lanes found that the plan had wrong

1. **`resolvePrompt` in `25-agents.ts` handled only the single-template and inline forms.** A
   `fragments` instruction fell through to `resolvedPrompt: null`, which would have published all
   22 department agents **with no prompt at all**, silently falling back to a generic system
   prompt. Caught and fixed inside L3; flagged by it as the lane's highest-risk change.
2. **A one-word sentence must never be dropped.** Splitting on "terminator + whitespace" makes
   `Inj.` / `Tab.` / `Dr.` standalone tokens. Since `Inj.` appears in almost any plan that already
   names an injection, a *new* drug order would have had its route silently deleted. L2 added a
   two-word eligibility rule — it can only ever keep content — and pinned it.
3. **The ticket named the wrong seed file.** `29-…generated.ts` holds only workflow-engine blobs
   (`grep -c promptTemplateId` → 0); the agent specs are in the hand-authored sibling.
4. **Phase 6 is inert** (OD-10) and **OD-11 reversed** — both recorded above.

### Gate — one pass, after everything landed

| Suite | Result |
|---|---|
| `@arcaai/applications` | 14878 passed, 10 skipped |
| `@arcaai/database` | 1907 passed |
| `@arcaai/api` | 4861 passed, 5 skipped |
| `@arcaai/workflow-contract` | 974 passed |
| `@arcaai/vox-node` | 587 passed |
| typecheck | clean (applications, workflow-contract, database, api) |
| lint | 0 errors; no new warnings in any changed file |
| `api:openapi:check` / `api:portal:check` / `gen:admin:check` | no drift |

**RED verified**, since no lane ran tests: with `turn-contract.ts` restored to the pre-fix
commit, all **12** of the new dedup tests fail; restored, all 12 pass.

**One pre-existing failure, out of scope.** `agentPromotion/.../membership-bounded-sync.integration.test.ts`
throws in `afterAll` with *"Authentication failed… credentials for `test` are not valid"* — its two
tests are skipped and nothing in this ticket touches `agentPromotion`, Prisma credentials or tenant
context.

### Not done (as of wave 1 — every item below was closed by waves 2 and 3)

- **Phase 6** — blocked on OD-10.
- **Phase 7 partial** — S-9 (the late-join gap) left out; it is a design question, not a defect fix.
- **Phase 8 / ALaaS (S-1…S-5)** — untouched, pending OD-9. **S-1 is confirmed to have occurred**
  and is close to a one-line fix; it should be expedited.
- **OD-8 half done** — the policy is ArcaAI-tenant content; the SYSTEM reference-set agents would
  need their own SYSTEM-tenant policy row.
- **No cluster verification yet** — the fix is merged, not deployed. The scenario must be re-run
  across **resumed recording sessions**, which is the trigger.

---

### Wave 2 — 2026-09-23 (owner decisions OD-7, OD-9, OD-10, OD-12, OD-13)

Five opus lanes, each in its own worktree with a disjoint file boundary; no lane ran a gate. The
orchestrator merged, gated once, verified RED, then destroyed every worktree and branch.

| Lane | Repo | Commits | What shipped |
|---|---|---|---|
| P1 | hope-v2 `apps/text` | `9e759cbe4`, `279b82028` | `frequency_penalty` / `presence_penalty` resolved request → platform default → nothing; `0` is never sent. Forwarded by `lm-studio`, `openai_compat`, `vllm`, `llama-cpp`, `openai`, `azure_openai`; dropped with a once-per-process WARNING by `ollama`, `anthropic`, `bedrock`, `vertex`. A **platform-default** penalty reaches only the self-hosted OpenAI-compatible engines (managed endpoints such as Azure GPT-5 refuse penalties with a 400); a request-authored one reaches any supporting engine. **The judge path never takes a penalty** — a repetition penalty on a Yes/No verdict can bias the verdict tokens |
| P2 | hope-v2 TS | `432dd3aa4` | Descriptors `text.generation.frequencyPenalty` / `presencePenalty` (`global-kv`, platform, default `0`, range −2…2) served in the effective-config `generation` group; agent-level values forwarded at the five `/generate` call sites; LM Studio model rows' honest set gains both penalties |
| L5 | hope-v2 TS | `f93606b38` | OD-12. `ml-en` accepted at open (`SOURCE_LANGUAGE_PATTERN`); output language = selected tenant policy, else platform default `consultation.summary.outputLanguage` (`global-kv`, default `en`, refuses a code-switch value); `operatingFrame` states the default and names the override it wins over; pre-summary `language_name` and the final-summary path use the resolved OUTPUT language; platform-reserved key `OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY` in `@arcaai/types`; policy text now names the conflict it overrides |
| A1 | ALaaS broker | `11f8813` | S-1 (a repeat `start` builds a fresh runtime and fully closes the old one — also fixed a stacked STT socket and a detach timer that killed the *restarted* session), S-2 (counter resets only on the first frame from the current subscription), S-3 (cap test driven through `onError`) |
| A2 | ALaaS web_ui | `4b1e427` | S-4 (same-document, same-title twins collapse, higher revision wins; edit-locked twins never hidden), S-5 (a durable row overlays the live section by title before duplicates are dropped) |

**Corrections to earlier claims in this ticket, found by the wave-2 scout:**
- **Publish FREEZES the resolved fragment text** into `compiledConfig.resolvedPrompt`. Editing the shared policy template does NOT reach any note until each agent is branched and republished. Practices #2/#3 ("edit one row") were wrong as written: the pointer saves the per-agent instruction edit, not the republish. The runtime-editable lever is the platform-default setting.
- The HEME v3 clinical bodies already say the note is entirely in English; the historical Malayalam came from `operatingFrame`'s old appended line. Other departments and older corpus versions carry "the section content MUST be in the conversation language" (~40 occurrences), which is why the default step must name and override it.

**Gate — one pass, after all five lanes landed (HOPE `9e8db9d91`):** applications 14943 passed · database 1917 · api 4863 · vox 3807 · workflow-contract 974 · vox-node 587 · types 79 · `apps/text` pytest 1957, ruff clean, mypy clean · typecheck clean incl. `apps/api` `__tests__` (the CI step) · openapi / portal / gen:admin no drift · no new lint warnings in touched files. **ALaaS (`50bf477`):** `nest build` 0 · jest 625/625 tests · web_ui 377/377.

**RED verified** (no lane could witness its own): with the pre-L5 code restored, 32 of 45 English-by-default tests fail (the 13 that pass are the untouched v1-parity cases), 45/45 after; with pre-P1 `apps/text` restored, all 133 penalty tests error at collection (the symbols do not exist), 133/133 after.

**Pre-existing, out of scope:** `agentPromotion` membership-sync integration file (stale `test` DB credentials in `afterAll`; its tests are skipped) · ALaaS jest suites `sanitization.util`, `create-notification.dto`, `audio.controller`, `medical-summary.controller` fail identically on the pre-merge base (Jest transform config) · `black --check` flags `test_task871_output_gate.py` (TASK-969) · four touched TS files were already unformatted before this ticket.

### Cluster verification — `hope-v2-dev`, 2026-09-23 (build `9e8db9d9`)

**Rollout (OD-13, all 22 at once):** policy template `01a0cc2d-8576-7288-94bd-37067c9fb80b` created and approved on the ArcaAI tenant; all 22 `arcaai-*-summary-*` agents branched, given `fragments: [clinical_note, output_language_policy]`, validated, published and activated through the admin API as `arcaai_admin`. Post-condition: 22 slugs, each exactly one active version, each composite with the policy. Every v1 stays PUBLISHED as the rollback target (`rollout.mjs --rollback`). `arcaai-bren-summary-new-visit` became v3 because of a tester's v2 draft, left untouched. Flush telemetry confirms the live lane ran on the new version: `prompt_fragments: ["clinical_note","output_language_policy"]`.

**`ml-en` accepted:** `open` with `language: "ml-en"` answered 201 on every run.

**Resumed-recording re-runs** (HEME, 107 s Malayalam follow-up recorded → stopped → resumed with a 60 s recap of already-documented content + new speech). Flush telemetry on the RESUME flush — the exact moment the reported defect was produced:

| Run | Penalty | Dropped on resume | Refused rewrites | `repetition_pressure` | Repeats in final note | Malayalam in note |
|---|---|---|---|---|---|---|
| `01a0cc2d-f82f` | 0 | 3 + 2 | 3 + 2 | 2 flushes | 0 | 0 |
| `01a0cc3d-885b` (A/B baseline) | 0 | 7 | 3 + 3 | 2 flushes | 0 | 0 |
| `01a0cc45-04c8` (A/B penalty) | **0.3** | 12 + 12 | 4 + 4 | 2 flushes | 0 | 0 |

Every run: the resume made the model restate what it had already written, and the sentence dedup dropped those sentences where the old whole-addition check would have appended them. Section revisions stayed 1–2 at 125–425 bytes, against the reported note's `plan_of_care` at revision 6 / 2685 bytes.

**Penalty A/B — decision: keep `frequencyPenalty` at 0** (restored, settings `version 2`). The penalty arm needed the dedup MORE (25 dropped vs 7) and distorted a clinical value: the recording's pain score "from eight to two" became "reduced to about two-thirds of its previous level" (the penalty-0 run rendered it correctly). n=1 per arm, but the mechanism agrees: this defect is the model re-copying the PRIOR NOTE from its prompt across turns, which a completion-side frequency penalty does not target. The plumbing remains for in-generation loops.

**New finding — cross-section repeats.** One run filed the same paragraph (lecture content with no clinical home) into both `family_history` and `diagnosis`, as a near-duplicate ("many of the symptoms" / "symptoms"). Per-section dedup cannot see it by design. Owner decision 2026-09-23: FLAG, NEVER DROP — lane X1 (HOPE `duplicate` annotation kind, near-duplicate matching with digit tokens required to match exactly) and lane X2 (ALaaS renders it on the routed clinical screen; the export stays byte-identical).

### Cross-section duplicate flag — lanes X1 (HOPE) and X2 (ALaaS), verified on the cluster

Owner decision 2026-09-23: **flag, never drop.** HOPE `03270e7a5` (merged `d6632ce18`, artifacts `dc4c218f5`): `SECTION_ANNOTATION_KINDS` gains `duplicate`; `SectionAnnotationDto` gains `duplicateOf` (sectionKey) and `duplicateOfTitle`. A run of ≥2 consecutive eligible sentences in the text a turn writes to section S that all match sentences of ONE other section T (T's stored text, or its post-turn text when T precedes S in template order) gets one annotation on S. Two sentences match when their normalised forms are equal, or when word-token Jaccard ≥ 0.8 AND their number tokens are identical as a multiset (so `1000 mg` never matches `100 mg`; `1.05` is one token; Malayalam words stay whole). Content is never dropped or altered. The flag is persisted on `DocumentSection.annotations`, published on `section.patch`, returned by `GET /consultations/:id/documents/sections`, dropped on a replace or a clinician edit (stale offsets), and counted in `repetition_pressure` and as `turnCrossSectionDuplicates` on the flush log. The first exact-match rule would have MISSED the observed pair ("many of the symptoms" vs "symptoms"); the near-duplicate rule was added after measuring it. ALaaS renders it on both screens (see the sibling ticket).

**Gate (after merge):** applications 14976 passed · api 4863 · vox-node 587 · api tsc incl. tests 0 errors · typecheck set green · openapi / portal / gen:admin no drift. **RED:** with the pre-X1 turn contract and store restored, 25 of 29 flag tests fail; 29/29 after. Realtime suite 212/212 after formatting.

**Cluster (`dc4c218f`, consultation `01a0cc66-faef`):** the case reproduced and was flagged — `diagnosis` carries `{kind: duplicate, duplicateOf: family_history, duplicateOfTitle: "Family History"}` over the near-duplicate paragraph; both copies kept; flush 04:02:16 logged `turnCrossSectionDuplicates: 1`, `turnDroppedSentences: 2`, `repetition_pressure`; the resume flush before it dropped 3. Final note: 0 repeated sentences within any section, 0 Malayalam, all six spoken clinical facts intact including "pain from eight to two".

**Open from X1/X2:** the final note built after `note.final` from durable rows carries no annotations, so a section whose final text differs from its live text shows no flag — needs HOPE's final document to carry `duplicate` annotations. A long sentence differing only by a negation can be flagged (never dropped). The admin-console playground keeps its own annotation-kind list, already missing `finding` and now `duplicate`.

### Wave 3 — 2026-09-23: every open item closed (owner: "finish all open/remaining items")

Five HOPE lanes (L-A…L-E) and two ALaaS lanes (A-A, A-B), all Opus, disjoint by file, no gates in
any lane; one orchestrator gate after the merge.

| Lane | Commit(s) | What landed |
|---|---|---|
| L-A final note + summary paths | `5e01afd04` | `GET summary/latest` gains `SummaryResponse.sections[] {sectionKey, title, start, end, annotations?}` — the finalizer narrative split with ALaaS's own heading rule, each section carrying `duplicate` flags from the SAME detector (`crossSectionDuplicateAnnotations`, exported from `turn-contract.ts`); `content` byte-identical. The note ALaaS shows at `note.final` IS that narrative, so this is where a flag has to live. Direct `generateSummary` appends the named-override sentence (follow-up #1). The two processors and `ChainSummaryService` read `consultation.summary.outputLanguage` instead of an `'en'` literal (#3) — a per-request `language`/`locale` no longer chooses the note there. |
| L-B harness | `4fce970be` | The durable lane's `core.agent` TEXT_GENERATION arm appends the platform default's language step, per candidate, when no `output_language_policy` fragment was selected (#2, #4). Read inside the activity (effective-config client, fails open to `en`); no workflow change, replay-safe. `consultation.summary.outputLanguage` gains `consumedBy: ['harness']`. |
| L-C SYSTEM reference set | `a7354450c`, `f01877b61` | OD-8 finished: SYSTEM + Global "Output language policy" rows; `general-medicine-summarization` and `casenote-finalization` carry it unpinned, last. Found and fixed on the way: **the SYSTEM General Medicine template shared its id with the department-free pre-summary**, so the seeded SYSTEM `general-medicine-summarization` (and every clone) froze the PRE-SUMMARY prompt — confirmed live on the local DB and on `hope-v2-dev` (SYSTEM + ArcaAI). Moved to `…0004-000000000004`; a guard test now fails on any duplicate prompt seed id. `AgentService.referenceInstruction` no longer pins an unpinned fragment on clone. |
| L-D reconnect | `b0c0e260e`, `772a08428` | S-9: late join replays one `section.patch` per saved section after the snapshot (dedup by `documentKey::sectionKey` + revision); `LiveSummarySection` gains optional `documentKey`/`sectionKey`/`revision`. F5: a replayed terminal completes the stream. Found on the way: `start()` never cleared the cached `closed` snapshot, so after F5 a client joining a RESUMED recording before its first flush would be ended by the previous session's `closed` — now cleared atomically (Lua, `closed`-only, so a live session's snapshot is never touched). |
| L-E console + guard | `f36aca3ec` | Console: "Spoken language" label (#5); `finding`/`duplicate` kinds and an "Also in <title>" badge. `recording/start` answers **409 `STT_SESSION_NOT_ACTIVE`** for a closed/finalizing/rejected/unknown STT session (fails open when apps/stt cannot be asked) — the HOPE half of #6. vox-node CHANGELOG. |
| A-A / A-B (ALaaS) | sibling ticket | Final-note flags from both HOPE sources, the null-final crash, Race 2 (#6), the fake adapter, the four jest suites, and closing a superseded walk's STT session so the 409 can fire. |

Integration (orchestrator): one shared `defaultOutputLanguageInstruction` for the live frame and
the direct path (the harness parity test pins it); pre-summary `{{language_name}}` names the output
language natively (`hi` → Hindi; v1's map said English); the applications package's own vitest run
no longer picks up live-DB `integration/**` suites; a stale TASK-995 timeout test (120 s → 300 s)
and black/prettier drift in pre-existing files.

**Gate (merged `dev-2.2`, one pass):** build 20/20 · typecheck 26/26 (api incl. tests, applications,
database, vox-node, vox, admin-console) · applications 15033 passed · api 4863 · database 1961 ·
vox-node 587 · vox 3807 · admin-console 3728 + lint + production build · contracts/cross-tenant 414 ·
harness pytest 2740 passed, ruff clean, mypy clean · route manifest unchanged, OpenAPI/portal
regenerated, `openapi:check` / `portal:check` / `gen:admin:check` no drift · no new lint warnings in
touched files. **RED:** with the pre-wave-3 source restored, all 8 new applications test files fail
(53 tests) and both new seed test files fail; the harness suite fails to collect against the old
`core.py`.

### English-only instructions — owner directive 2026-09-23 (lane L-G + cluster rollout)

> *"for now, all pre-summary and summary must be in english, therefore, prompt instructions and
> configuration must be set to english"*

The runtime already forced English; the directive is that the TEXT and the CONFIGURATION say so too.

- **Configuration:** `consultation.summary.outputLanguage` written explicitly as `en` at system scope on
  `hope-v2-dev` (it was only the code default).
- **Code + seeds (L-G `f31661b72`, merged `013dc456a`):** the corrective JSON-repair retry (runtime — it
  said *"MUST be in the conversation language. Do NOT include any English words inside values"*), the
  SYSTEM base prompt ("Always respond in CONVERSATION LANGUAGE"), the JSON enforcement note, the
  General Medicine body's rule 5 (*"in the conversation language ({{language}})"*, the SOURCE tag — the
  `language` binding is gone), and both SYSTEM pre-summary defaults (the `{{language_name}}`
  localisation block → the ArcaAI v3 English-only wording; placeholder kept). Checksum locks updated
  deliberately. Untouched: the v1/v2 ArcaAI history rows (current is v3, already English), the v1
  compat wrappers (they substitute `English`), the override sentences.
- **Cluster (admin API, `scratchpad/rerun/english-rollout.mjs`, nothing destructive):** 10 template rows
  (SYSTEM + Global + ArcaAI pre-summary defaults and their department-free forks, Global General
  Medicine, the three Global SMR rows) got an approved English v2. Global `general-medicine-summarization`
  and `casenote-finalization` → v2 with the policy fragment; Global `case-notes-pre-summary` → v2 on
  Global's own English clone (binding the SYSTEM row directly is refused: content is cloned); all three
  promoted into SYSTEM (v2) — which also replaces the SYSTEM General Medicine agent that had frozen the
  PRE-SUMMARY prompt; ArcaAI synced the reference-set templates and republished its
  `general-medicine-summarization` (its tenant-default TEXT_GENERATION agent, same defect) on the
  English body + its own policy. Every previous version stays PUBLISHED as the rollback.
  **Post-check:** one active version per slug in every tenant; **0** active TEXT_GENERATION agents whose
  frozen prompt carries a conversation-language / localisation clause; every pre-summary agent carries
  "Write the entire pre-summary in English".

### Cluster verification — wave 3 (build `87728892`, consultation `01a0cccb-1243`)

Resumed hematology recording (`ml-en`), A → stop → 90 s → B1 (recap + new content) → stop:
- live note **0** repeated sentences, **0** Malayalam characters, prompt fragments
  `[clinical_note, output_language_policy]`;
- a subscriber joining each segment saw **0** stale `closed` snapshots before its own stop (L-D);
- `recording/start` naming the closed STT session → **409 `STT_SESSION_NOT_ACTIVE`** (L-E);
- final note (`summary/latest`): English, 0 Malayalam, 0 repeated sentences.

**Found — owner decision needed (OD-14):** a RESUMED recording is never re-finalised. Every test
consultation holds exactly ONE `RAW_SUMMARY`, written after the FIRST stop; the resume's stop writes
none, so `summary/latest` — and ALaaS's `note.final` — shows the first segment's note without what
was said after the resume. Pre-existing (not introduced here); A-B saw the same from the ALaaS side.
Whether a resume should re-run the finalize (and how it relates to the live note, which does carry
the resumed content) is a lifecycle decision, left open.

### Follow-ups — status after wave 3
1. ~~Direct summary-generation path~~ — closed by L-A.
2. ~~SYSTEM `general-medicine-summarization` on the durable lane~~ — closed by L-B (runtime step) and L-C (policy fragment; id collision fixed).
3. ~~`'en'` literals in the processors and chain summary~~ — closed by L-A.
4. ~~Fallback candidate language step~~ — closed by L-B (decided per candidate).
5. ~~Console "Summary language" label~~ — closed by L-E.
6. ~~ALaaS races and the fake adapter~~ — closed by L-E (HOPE 409) and A-B (ALaaS).
7. ~~Penalty value~~ — measured 2026-09-23: kept at 0.

Still open, recorded rather than built:
- `DocumentSectionStore.lock()` does not bump `revision`, so a client discards a replayed `locked` patch.
- The live flush publishes its snapshot before the section writes land, so live snapshots carry no `revision`; only late-join snapshots are stamped.
- harness-progress / harness-assurance replay the previous run's `closed` until the new run publishes (clients already stop there).
- `harness-internal.service.ts` passes the workflow node's `conversationLanguage` (default `en`) — admin configuration under OD-12, left as is.
- The durable step applies to every TEXT_GENERATION `core.agent`, not only note writers; a tenant agent that must write another language opts out with its own `output_language_policy` fragment.


## Wave 4 — tester report 2026-09-23: "mixed English and Malayalam after the latest deployment" + OD-14

### Evidence (consultation `01a0cd63-e0ab`, ArcaAI, General Medicine, `ml-en`, recorded 4× 08:31–09:44 UTC)
- **Configuration is English at every layer**: `consultation.summary.outputLanguage=en` (SYSTEM); active
  `arcaai-gen-summary-new-visit` v2 ("THE NOTE IS WRITTEN ENTIRELY IN ENGLISH" + `output_language_policy`);
  the live `operatingFrame` language step; ArcaAI `case-notes-pre-summary` v1 / `casenote-finalization` v1.
- **Decrypted stats (owner-approved, scoped Transit token, revoked):** Malayalam script in exactly one item —
  the LIVE note snapshot (`PRE_SUMMARY/LIVE_SOAP_SNAPSHOT`, 147 chars, Plan section: a doctor instruction copied
  verbatim from the transcript, ASR errors included). Final note, all pre-summaries, all 10 prior ALaaS case
  notes: 0. ALaaS reads `documents/sections` (the live note) after every stop — that is what the tester saw.
- **Cause:** instruction-following on `gemma-4-e2b-it-qat` with ~16k-token live prompts, not configuration.
  Nothing inspects a live section's script before it is persisted and published.
- **OD-14, three stacked causes** (cluster, Temporal + DB):
  1. `HarnessDocWorkflow` parks at the clinician gate after its draft, waiting for an `approval` signal that
     ALaaS never sends — five `harness-doc-*` runs from 2026-09-23 are still open. The loop awaits that child,
     so every later `consultation-ending` signal lands on a parked loop.
  2. `document:start` answers `already_running` while that run is open, so every regenerate (incl. the
     existing `POST summary/async`) is a silent no-op after the first draft.
  3. `createStreamingTranscriptInner`'s second idempotency layer is keyed on the CONSULTATION, not the STT
     session: a resumed session's aggregate transcript is never persisted and its `TranscriptionCreated`
     is never emitted. (`01a0cd63` and the replay both hold exactly one `STT_AGGREGATE`.)
- **Replay** (`scratchpad/repro/repro.mjs`, the consultation's own four MinIO recordings,
  `hope-recordings-arcaai/2026/09/23/streams/<session>/raw/complete.wav`) on `c4f52db5`, consultation `01a0cdd9`:
  final note written once after R1 and never refreshed after R2–R4 (OD-14 reproduced). The Malayalam leak did
  not recur on that run (0 chars) — it is non-deterministic, and the original prompt also carried 10 prior
  case notes.

### Owner decisions (2026-09-23)
| # | Decision |
|---|---|
| D-1 | The script guard keys off the platform `consultation.summary.outputLanguage` = `en` (any Indic-script character, U+0900–U+0DFF), whether or not the tenant has a policy fragment. |
| D-2 | One translate-only retry per affected section write; if it still carries Indic script or fails, KEEP the original and count it (never drop clinical text). |
| D-3 | OD-14 by supersede-via-restart: `document:start` gains `supersede`, which terminates the open `harness-doc-<id>` run and starts a fresh one; the fresh run adopts the same `RAW_SUMMARY` row (newest-wins). No workflow-code change → no replay risk. |
| D-4 | A SIGNED (approved) note is never re-finalised automatically. |
| D-5 | If the guard cannot hold the live note to English on the replay, switch the live/summary agents to `lms-gemma-4-e4b` (present on the LM Studio volume, not loaded; SYSTEM catalogue row exists). Supersedes OD-7's "keep E2B" only on that evidence. |

### Lanes
| Lane | Scope | Files |
|---|---|---|
| **L-H** live-note script guard | Pure helper (count Indic script; repair a turn's writes + sections). After the turn is applied — graph and legacy branches alike — and before NER / publish / `publishSectionPatches`: when D-1 holds, one translate-only TEXT call per affected write (same live selection + quota + tenant headers as the grammar pass), accepted only if Indic-free. Repaired write's `duplicate` offsets no longer index the text, so they are dropped for that write. Flush log + stats gain `turnScriptRepairs` / `turnScriptRepairsUnresolved`. | `live-documentation/realtime/script-guard.ts` (new), `live-documentation.service.ts` |
| **L-I** OD-14 re-finalise | (a) aggregate idempotency per STT session (stamp `sttSessionId`; a legacy aggregate without one never blocks a different session); (b) `TranscriptionCreated` for a consultation that already holds an UNSIGNED harness draft → regenerate with `supersede`, whole-visit transcript, regardless of the first-generation stand-down (the harness already owns the note); (c) harness `document:start` `supersede` → `id_conflict_policy=TERMINATE_EXISTING`. | `sttInternal.service.ts`, `consultation-event.handler.ts`, `note-generation` types/service, `harness-gateway.service.ts`, `apps/harness/.../internal.py` (+ request model) |
| **A-C** ALaaS sign-off | ALaaS sends HOPE's approval when the clinician Saves/Submits the summary — review in progress. | ALaaS backend |

### Implementation (2026-09-23, `dev-2.2`, primary checkout — no worktrees)
| Lane | Commit | What |
|---|---|---|
| L-H | `b50b2c4fa` | `realtime/script-guard.ts` (`countIndicScript`, `repairTurnScript`); `guardTurnScript` runs inside the graph lane's `generateDocument` handler (before downstream grounding) and after the legacy `applyTurn`; `translateSectionText` = one `/generate` on the live selection with `translateOnlyInstruction` (`summary-language.ts`). Flush log gains `turnScriptRepairs` / `turnScriptRepairsUnresolved`; the stats DTO is untouched (no API artifact change). |
| L-I | `df10e2ee5`, `526b39306` | STT sends `metadata.sessionId` on the streaming finalize; `createStreamingTranscriptInner` keys the aggregate per session (`sttSessionId`); `ConsultationEventHandler.resumedSessionPlan` → `supersede` on an unsigned draft (whole-visit transcript, oldest first), `signed` stops; `GenerateParams` / `HarnessStartContext.supersede`; harness `document:start` `supersede` → `WorkflowIDConflictPolicy.TERMINATE_EXISTING`; `HARNESS_DRAFT_SUBTYPE` shared constant. |

RED witnessed for every new test: script guard (module missing; service tests 3/5 fail with the guard short-circuited), transcript key (2 fail), handler (3/5 fail), seam + gateway pins (2 fail with the spreads removed), harness supersede (1 fail), STT metadata (1 fail).

**Gate (one pass, after both lanes):** applications `954 files / 15056 passed, 4 skipped`, typecheck clean, eslint 0 errors on touched files · harness unit `2738 passed` · STT unit `3820 passed, 1 failed` — `test_task799_env_surface::test_minio_credentials_default_to_empty`, pre-existing and unrelated (fails identically with no env file and no host vars; this wave touches only `session_manager.py`'s finalize call).

### Cluster verification — `hope-v2-dev`, build `6b864c73` (pipeline #1312), 2026-09-23
Replay of `01a0cd63`'s own four MinIO recordings (consultation `01a0ce4c`, General Medicine, `ml-en`,
stop/resume between each), against the baseline run on `c4f52db5` (`01a0cdd9`):

| Stop | Baseline: final note | Fixed: final note (same row, updated in place) | Live note Malayalam | Final note Malayalam |
|---|---|---|---|---|
| R1 | written, 939 chars | written 12:48:19, 715 chars | 0 | 0 |
| R2 (resume) | **not refreshed** | refreshed 12:51:30, 2568 chars | 0 | 0 |
| R3 (resume) | **not refreshed** | refreshed 12:54:59, 2879 chars | 0 | 0 |
| R4 (resume) | **not refreshed** | refreshed 12:58:19, 3295 chars | 0 | 0 |

- Each resumed session's `STT_AGGREGATE` is persisted with its `sttSessionId`; the gateway logs
  `Resumed recording — re-finalising the note over the whole visit` per resume.
- A real ALaaS consultation (`01a0cd09`, first draft written 06:55 before the fix, legacy un-stamped
  aggregate) was resumed by the tester at 12:26: both new sessions persisted and the draft re-finalised at
  12:27:47 over all three. A resume from `PENDING_REVIEW` still starts (the `requirePrimedBeforeRecording`
  kill-switch is OFF — pre-existing posture, unchanged).
- The script guard fired live: an earlier replay's resume flush (12:36:26) logged `turnScriptRepairs: 1,
  turnScriptRepairsUnresolved: 0` — the reported failure mode, caught and translated. Since the deploy:
  1 repair, 0 unresolved (Loki). **D-5 (switch to E4B) not needed on this evidence**; E4B remains available
  (`lms-gemma-4-e4b`, not loaded).
- Found in passing, not addressed: `stt.stream.job_row_open_failed` — `TranscriptionJob_pipelineId_fkey`
  violated when a streaming session opens its job row (the session still works; it is absent from the job list).

**ALaaS (`ALaaSv3.0@4e89a4e`, branch `refactor-hope-integaration`, committed, not pushed):** `save_summary`
now runs `finishInHope` (update → approve → close, owner: "Save = full finish") after the local save, fire-and-forget;
the correction is sent only when the Save created a new edited version. jest 36/36, `tsc` clean. A signed HOPE
consultation cannot record again.

### Verification
- RED→GREEN unit tests per lane; one gate pass after merge (owner rule).
- Cluster: re-run the replay; after EVERY stop `summary/latest.createdAt` ≥ stop time and the note reflects the
  resumed recordings; live note 0 Indic script; flush telemetry shows `turnScriptRepairs` when it fires.

## Waves 5–6 — consultation completion timeout, late sign-off, resume (owner, 2026-09-23)

**Owner requirements.** "Time out and close the consultation session after 5 min if there is no approval
signal." Then: the tenant admin configures the timeout in **Settings** ("where tenant admin can see all
tenant settings and where the platform admin can see the platform and default settings for tenants to fall
back"), platform default 5 min; the clock starts when recording has **stopped and the final summary is
generated** ("ready to complete"); an approval signal (ALaaS Save/Submit) completes it, else it times out; the
end-user may resume or continue a `CLOSED_INCOMPLETE` session; a lifecycle user guide for tenant/customer
engineers.

| # | Decision |
|---|---|
| D-6 | At the timeout the harness gate ends and the consultation lands `CLOSED_INCOMPLETE` (closed unsigned). |
| D-7 | A late approval still signs: `CLOSED_INCOMPLETE → SIGNED`, then `close` → `CLOSED_COMPLETE`. |
| D-8 | The timeout is a settings-registry key, `consultation.session.completionTimeoutMinutes` (`maxScope: tenant`, tenant → SYSTEM → 5, whole minutes 1..10080). The wave-5 `HarnessPolicy.gateMaxEscalations` column (never pushed) was withdrawn with its migration. |
| D-9 | Resume is a sanctioned edge: `CLOSED_INCOMPLETE → RECORDING` (works with `requirePrimedBeforeRecording` ON too). |
| D-10 | ALaaS Save runs the full HOPE finish (update → approve → close); a `CLOSED_INCOMPLETE` consultation is not "already finished" for it. |
| D-11 | The guide lives in the repo only (`docs/guides/consultation-session-lifecycle.md`). |

**How it works.** The timer is the harness clinician gate (`HarnessDocWorkflow`), a durable Temporal timer
started when the final-note draft is persisted. `HarnessPolicyService.getEffectivePolicy` derives it from the
setting on every return path (`gateSlaSeconds = minutes × 60`, `gateMaxEscalations = 1`), as it already serves
`tokenBudgetPerRun`; a lookup failure serves the 5-minute code default, never the row's 24 h. The harness takes
its abandon bound from the policy (`gate_max_escalations`, clamped ≥ 1; `None` ⇒ the input default — replay-safe,
no patch marker). On the terminal abandon `recordEscalation` moves `PENDING_REVIEW → TIMED_OUT → CLOSED_INCOMPLETE`
(one OCC write; WORM `SESSION_TIMED_OUT` + `SESSION_CLOSED_INCOMPLETE`), `DRAINING` / `DRAFT_PENDING_SENSORS` →
`CLOSED_INCOMPLETE`, and leaves `RECORDING` (a resumed session) alone; a retried terminal is a no-op success (it
used to 409). A resumed recording's stop re-finalises (wave 4) and starts a fresh gate.

| Commit | What |
|---|---|
| `88aad4fd9` / merge `f01e0b444` | J2 harness: policy-driven `gate_max_escalations` |
| `57f3d1eec` / merge `a81dbbd74` | J3: terminal abandon closes `CLOSED_INCOMPLETE`; `CLOSED_INCOMPLETE → SIGNED`; approve accepts it |
| `2bde97e85`, `af4504bf3` | stale "reaches only REOPENED" notes corrected |
| `b15d3920b` | `CLOSED_INCOMPLETE → RECORDING` (25 legal transitions) |
| `484aa8429` | the setting + effective-policy overlay; `gateMaxEscalations` storage withdrawn; console shows the timeout read-only on Harness Policy, pointing to Settings; API artifacts |
| `329f4a416` | Consultation Session Lifecycle guide; client guide ch. 7 table; tenant admin guide section |
| ALaaS `e02e390`, `219bf2a` | Save → HOPE finish; `CLOSED_INCOMPLETE` not terminal for finish |

Superseded in passing: the J1 commit `8f3b7b989` (column + migration + console knob) — its storage is removed
again by `484aa8429` before any push, so no environment ever held the column.


## Change History

| Date | Change |
|---|---|
| 2026-09-23 | Waves 5–6 (owner): completion timeout as a tenant setting (default 5 min) enforced by the harness gate, closed unsigned at expiry, late sign-off signs, resume from `CLOSED_INCOMPLETE`, ALaaS Save signs off; lifecycle guide. |
| 2026-09-23 | Wave 4 deployed (`6b864c73`) and verified: final note refreshed after all four stops of the replay, 0 Malayalam in live and final notes, guard repaired 1 live leak; ALaaS Save → HOPE sign-off (`4e89a4e`). |
| 2026-09-23 | Wave 4 opened: tester report on `01a0cd63` investigated (config English everywhere; live snapshot leak on E2B; OD-14 root-caused to three stacked defects), replay harness from the consultation's own MinIO recordings, owner answered OD-14 + D-1…D-5. |
| 2026-09-22 | Ticket opened. Both defects root-caused against `hope-v2-dev`. Design drafted; OD-1…OD-8 pending. |
| 2026-09-23 | Owner directive: English-only instructions and configuration. L-G merged, gated, RED verified; platform setting set to `en`; 10 template rows + Global/SYSTEM/ArcaAI agents republished through the admin API (SYSTEM + ArcaAI General Medicine agents off the pre-summary prompt). Cluster-verified on `87728892`. OD-14 opened (resumed recording not re-finalised). |
| 2026-09-23 | Wave 3 — every open item: final-note flags on `summary/latest`, English by default on the direct/processor/harness paths, SYSTEM reference-set policy (and the General Medicine id collision it exposed), late-join section replay + F5 + resumed-recording snapshot clear, console label/badge, `recording/start` 409 for a stale STT session; ALaaS sibling lanes. Merged, gated once, RED verified, worktrees destroyed. |
| 2026-09-23 | Cross-section duplicate flag (X1 HOPE, X2 ALaaS) merged, gated, RED verified, deployed `dc4c218f`, verified on the cluster. Penalty A/B: kept at 0. 22-agent policy rollout done via the admin API. |
| 2026-09-23 | Wave 2: owner answered OD-7/9/10/12/13. Penalty plumbing (P1/P2), English-by-default output language with `ml-en` accepted (L5), ALaaS sibling ticket S-1…S-5 (A1/A2). Merged, gated once, RED verified, worktrees destroyed, pushed `9e8db9d91` (pipeline #1304). |
| 2026-09-22 | Implemented in four parallel worktree lanes, merged to `dev-2.2`, gated once (`640762e55`). OD-7 answered (keep E2B). OD-10 opened: the decode-time penalties are inert on this platform, so the dedup is the only defence. OD-11 resolved against the ticket's own §A2. Worktrees and branches destroyed after the merge and the green gate. |
| 2026-09-22 | Four parallel read-only investigation lanes (HOPE stream contract · ALaaS consumer · cluster log forensics · stored-data truth). **Part B confirmed by decryption**: the duplication is in HOPE's stored note, in three exact-repeat shapes, none a paraphrase — which settles OD-5 toward exact-normalised sentence dedup. Nine secondary findings (S-1…S-9) recorded, including one confirmed-occurred ALaaS double-subscription and an observability bug that inflated the apparent stream-open count from 4 to 58. OD-9 added. |
