# TASK-1001 — Tenant-managed summary language, and note repetition

| | |
|---|---|
| **Status** | Review — implemented and merged to `dev-2.2`, gate green; OD-10 open |
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
| **OD-4** | Reject a code-switch tag at `/consultations/open`? | (a) 400; (b) accept and normalise; (c) accept as today | **(a)** — plus the caller-side fix in ALaaS |
| **OD-5** | Dedup strength | (a) exact-normalised sentence dedup; (b) add similarity/paraphrase dropping; (c) similarity flagging only | **(a) now, (c) later — settled by evidence.** Every observed duplicate is an exact-sentence repeat modulo whitespace, punctuation or ordering. **No paraphrase dropping is needed to fix this report**, and similarity dropping risks silently losing clinical content |
| **OD-6** | Promote repetition pressure to a degrade code + metric? | (a) yes; (b) log only | **(a)** — 11 of 13 flushes carried refusals and nothing surfaced it |
| **OD-7** | Model tier for the summary agents | (a) keep 2B; (b) evaluate larger | **ANSWERED 2026-09-22: (a) keep `gemma-4-e2b-it-qat`.** Consequence: the sentence dedup is the ONLY structural defence against repetition |
| **OD-8** | Ship the English-only policy as a SYSTEM reference-set default? | (a) yes; (b) tenant opt-in only | **(a)**, noting content is cloned — existing tenants need an edit or a reference-set sync |
| **OD-10** | **NEW — Phase 6 is a no-op as specified.** `frequencyPenalty` / `presencePenalty` exist in `AGENT_PARAMETER_SCHEMAS` but **never reach a provider**: `resolve_request_defaults` (`apps/text/src/text/core/defaults.py`) returns exactly `{temperature, max_tokens, top_p}`, `grep` for the penalties across `apps/text/src` returns zero hits, the LM Studio adapter's only `extra_body` passthrough is a retention `ttl`, and `TEXT_PLANE_GENERATION_PARAMS` declares the honest set with a publish gate behind it | (a) accept dedup-only; (b) plumb the penalties through `apps/text` (`GenerateRequest`, `defaults.py`, the adapters, `AiRuntimeProfile` columns, the contract's param list) | **(a) accept dedup-only.** Every observed duplicate was an exact repeat, and Phase 4 covers all three shapes. Open (b) as its own scoped ticket only if repetition survives — do not bundle a Python/Prisma/contract change here on speculation |
| **OD-11** | ~~Does the frozen v1-compat surface keep its `'English'` default?~~ | — | **RESOLVED during integration: yes.** §A2 first called it drift; that was wrong. The compat PRE-SUMMARY template renders `{language_name}` into a live instruction and is pinned by byte-identical golden fixtures, so `null` there would emit *"Write ALL bullet content in ."* The default stays; the shared grammar now rejects `ml-en` first, so it lands on v1's unknown→English rule. The native path keeps absent ⇒ `null`. Two surfaces, two contracts |
| **OD-9** | Do the ALaaS defects (S-1…S-5) ship in this ticket or a sibling? | (a) sibling ticket in `ALaaSv3.0`, this ticket owns HOPE; (b) one ticket across both repos | **(a)** — different repo, different release train. S-1 is confirmed-occurred and should be expedited |

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

### Phase 6 — decoding pressure — **BLOCKED, see OD-10**

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

### Not done

- **Phase 6** — blocked on OD-10.
- **Phase 7 partial** — S-9 (the late-join gap) left out; it is a design question, not a defect fix.
- **Phase 8 / ALaaS (S-1…S-5)** — untouched, pending OD-9. **S-1 is confirmed to have occurred**
  and is close to a one-line fix; it should be expedited.
- **OD-8 half done** — the policy is ArcaAI-tenant content; the SYSTEM reference-set agents would
  need their own SYSTEM-tenant policy row.
- **No cluster verification yet** — the fix is merged, not deployed. The scenario must be re-run
  across **resumed recording sessions**, which is the trigger.

---

## Change History

| Date | Change |
|---|---|
| 2026-09-22 | Ticket opened. Both defects root-caused against `hope-v2-dev`. Design drafted; OD-1…OD-8 pending. |
| 2026-09-22 | Implemented in four parallel worktree lanes, merged to `dev-2.2`, gated once (`640762e55`). OD-7 answered (keep E2B). OD-10 opened: the decode-time penalties are inert on this platform, so the dedup is the only defence. OD-11 resolved against the ticket's own §A2. Worktrees and branches destroyed after the merge and the green gate. |
| 2026-09-22 | Four parallel read-only investigation lanes (HOPE stream contract · ALaaS consumer · cluster log forensics · stored-data truth). **Part B confirmed by decryption**: the duplication is in HOPE's stored note, in three exact-repeat shapes, none a paraphrase — which settles OD-5 toward exact-normalised sentence dedup. Nine secondary findings (S-1…S-9) recorded, including one confirmed-occurred ALaaS double-subscription and an observability bug that inflated the apparent stream-open count from 4 to 58. OD-9 added. |
