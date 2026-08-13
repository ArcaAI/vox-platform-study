# TASK-650 — BUG: Malayalam consultations are never translated; summaries come back mixed-language

| Field | Value |
|---|---|
| **Status** | **Pending** |
| **Type** | bugfix |
| **Priority** | **P1** — clinician-visible: summaries are unusable when the consultation is Malayalam |
| **Surfaces** | `hope-v2` (`apps/api/src/modules/smr-compat/`) + `ALaaSv3.0` (caller) |
| **Tenant in scope** | ArcaAI |
| **Reported** | 2026-08-10 — "the summarization should be generated in English, currently it's mixed" |
| **Related** | TASK-600 (the Sarvam translate capability this bug fails to invoke), TASK-634 (D-11, the earlier language-directive defect), TASK-594 (ml-en code-switch STT — the source of the mixed transcript) |

---

## 1. Requirement

| # | Rule |
|---|---|
| R1 | **Summarization output is English by default, in all cases.** The `language` flag is normally empty. |
| R2 | When the consultation is Malayalam (`language: "ml"`), the transcript is translated **through Sarvam as the medium**, and the summary is still produced in **English**. |
| R3 | Pre-summary follows the same rule. |

English is the output contract. `language` describes the SOURCE, it does not license non-English output.

> ⚠ This is a deliberate **divergence from v1**, which produced conversation-language
> summaries. Recorded here so it is not mistaken for a parity regression later —
> it is a product decision taken knowingly, one commit after TASK-634 restored v1
> parity.

---

## 2. Root Cause — four things stack up (verified 2026-08-10)

### 2.1 Sarvam is built, wired end-to-end in HOPE, and **never invoked**

The capability exists:
- `apps/smr/src/smr/translation/sarvam.py` — the Sarvam provider (TASK-600)
- `translate_to_english` on the compat DTO (`dto/sync-summary.request.ts:111`)
- handled at `smr-compat.controller.ts:186-237`, which translates the transcript **and** forces `session_metadata.language = 'en'` so the prompt orders English output

But the caller never sets it. Repo-wide grep across `ALaaSv3.0`:

```
grep -rn "translate_to_english|translateToEnglish" apps/audio-stream-svc/src apps/web_ui/hooks apps/web_ui/services
→ (no matches)
```

`@arcaai/vox/compat` does forward it (`e.translateToEnglish === true && (_.translate_to_english = true)`), so the wire supports it — nothing in ALaaS ever passes it.

**Consequence: the raw Malayalam / code-switched transcript reaches the LLM untranslated.**

### 2.2 ~~ALaaS asserts `language: 'en'`~~ — **CORRECTED 2026-08-10: it forwards the TRUE language, and that made things worse, not better**

My original reading of `medical-summary.processor.ts:448` (`language: language || 'en'`)
was wrong. That is not a hardcode — it forwards the real STT source language, and
`|| 'en'` only covers a genuinely absent value.

The chain: `useClinicalLogic.js:762` — **`useState("ml-IN")`** — is the same value
that drives the live STT session (`:880`) and is forwarded at `:1240` through
`triggerBackgroundSummary` → `TriggerSdkSummaryDto.language` → job data →
`callAgenticSdkSummarize`. Locales come from `LANGUAGE_MAP`
(`apps/web_ui/src/constants.js`): `ml-IN | en-US | hi-IN | ta-IN`.

**So the browser's default language is Malayalam.** HOPE was therefore told
`ml-IN`, `resolveV1LanguageName` reduced it to the base subtag `ml` → `Malayalam`,
and the old directive read **`Language: Malayalam`**. The model was not merely
drifting toward the transcript's language — **it was explicitly instructed to write
Malayalam**, and the 13 templates' "conversation language" clause agreed with it.
That is a more direct cause than §2.3/§2.4 alone and supersedes them in weight.

The real gap remains the one the grep found: **nothing in ALaaS ever set
`translate_to_english`**, so the Sarvam path never ran and nothing ever forced the
output back to English.

### 2.3 Thirteen department templates instruct the model to write in the conversation language

```
strictly follows these headings (content in conversation language, headings in English)
```

13 occurrences in `packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-content.ts`, byte-identical to v1 (`HOPE/apps/smr/src/smr/models/prompts_medicine_new_referral.py`). Faithfully ported — and directly contrary to R1.

### 2.4 The gateway's counter-signal is a bare label, not an instruction — and it loses

`apps/api/src/modules/smr-compat/summary-prompt.builder.ts:53-54`

```ts
function languageDirective(language?: string): string {
  return `Language: ${resolveV1LanguageName(language)}`;   // → "Language: English"
}
```

Appended as one system line at `:164`. Two aggravating factors:

- the department template is injected as **authoritative** — *"Follow this department's clinical documentation instruction…"* (`:133-135`) — so the specific in-template clause outranks the generic label;
- `system: systemLines.join(' ')` (`:186`) joins every system line with a **space**, so the directive lands mid-paragraph in a run-on block rather than as its own instruction.

**Net:** specific instruction ("conversation language") beats generic label ("Language: English") ⇒ output follows the transcript ⇒ with an ml-en code-switched transcript, output is mixed.

### 2.5 Why pre-summary is NOT affected today

Its v1 template carries eight explicit language instructions plus a self-check
(`Write ALL bullet content in {language_name}`, `Do NOT include English words…`),
so `language: en` genuinely forces English. Only the summary path has the weak
directive. **Do not "simplify" the pre-summary language block** — it is the reason
that path works.

---

## 3. Implementation Plan

Both halves are needed. Sarvam removes Malayalam from the **input**; the
authoritative directive removes it from the **output**. Either alone leaks.

### Phase 1 — hope-v2: make the requested output language authoritative

| # | Task | Agent tier | Effort |
|---|---|---|---|
| 1.1 | **RED**: assert the assembled summary system prompt contains an explicit English instruction that overrides an in-template "conversation language" clause. Use a governed template containing that clause as the fixture. | sonnet-5 | medium |
| 1.2 | Replace the bare `Language: X` label with an explicit directive naming the override, e.g. *"Write ALL summary content in English, regardless of the transcript's language and regardless of any conflicting language instruction in the department instruction above. Section headings stay in English."* Default to **English** when `language` is empty (R1). Mirror the pre-summary template's phrasing so both paths read the same. | sonnet-5 | high |
| 1.3 | Emit the language directive as its own line — change `systemLines.join(' ')` (`:186`) to a newline join, or append the directive last as a distinct block. Verify no golden/contract test depends on the space join before changing it. | sonnet-5 | medium |
| 1.4 | Keep `ml` reachable: when a caller explicitly requests Malayalam output, honour it. R1 sets the DEFAULT, not a hard lock. | sonnet-5 | medium |

**Do NOT edit the 13 seeded templates.** That breaks the v1 checksum fixture
(`v1-clinical-prompt-checksums.fixture.ts`), hardcodes language into stored
content, and forecloses future Malayalam support. Fix at the edge.

### Phase 2 — ALaaS: actually use Sarvam

| # | Task | Agent tier | Effort |
|---|---|---|---|
| 2.1 | Determine the real consultation language at the point the summary job is built — today it is asserted as `'en'` (`:448`). Source it from the STT pipeline / session metadata rather than defaulting. | sonnet-5 | high |
| 2.2 | When the source language is Malayalam, send `translate_to_english: true` (and the true `language: 'ml'`) so the gateway's Sarvam path runs. | sonnet-5 | medium |
| 2.3 | Same for the pre-summary paths once they are consolidated (TASK-652). | sonnet-5 | medium |

### Phase 3 — prove it on dev

| # | Task | Agent tier | Effort |
|---|---|---|---|
| 3.1 | Malayalam consultation → summary is fully English. Capture the Loki log line and the output. | sonnet-5 | medium |
| 3.2 | Confirm Sarvam actually ran (SMR translate logs), not just that output looked English. | sonnet-5 | medium |
| 3.3 | Regression: an English consultation is unchanged. | haiku-4-5 | default |

---

## 4. Verification Criteria

- [ ] Malayalam consultation ⇒ **100% English** summary, headings and content
- [ ] SMR logs show a Sarvam translate call for that request
- [ ] Empty `language` ⇒ English (R1)
- [ ] English consultation ⇒ unchanged output
- [ ] The 13 seeded templates are byte-unchanged; checksum fixture still green
- [ ] `pnpm --filter @arcaai/api test lint` green

---

## 5. Notes for the executing agents

- Phase 1 is independently shippable and fixes most of the symptom on its own —
  do not block it on Phase 2.
- The mixed output is NOT a model failure. The prompt contains two conflicting
  language instructions and the model is following the more specific one.
  Resist "prompt tuning"; remove the conflict.
- Evidence of the failing runs: Loki, `{app="hope-api"}`, `hope-v2-dev`,
  2026-08-10 05:16–05:34 UTC, tenant `50000000-0000-0000-0000-000000000001`.

---

## 6. ⚠ OPEN — R1 is only satisfied for Malayalam

Phase 1 + Phase 2 are implemented, and the combination works for `ml`:
ALaaS sets `translate_to_english: true` ⇒ the gateway translates the transcript
**and** forces `session_metadata.language = 'en'`
(`smr-compat.controller.ts:235`) ⇒ the directive resolves to English.

**But R1 says English in ALL cases, and two paths still produce non-English:**

1. **Hindi / Tamil.** `LANGUAGE_MAP` offers `hi-IN` and `ta-IN`. Neither triggers
   the translate flag (it keys on Malayalam), so the directive resolves to Hindi
   or Tamil and the summary is written in that language.
2. **Any `ml` request where `translate_to_english` is absent** — e.g. a caller
   other than the browser summary path, or the flag being dropped — falls back to
   `Language: Malayalam`.

This is the direct consequence of an ambiguity I introduced: the ticket's **R2**
("honour an explicitly requested non-English output language") is *my* wording,
not the owner's. The owner said **"by default, summarization in English for all
cases"**. R2 as implemented lets a non-English `language` value override that.

### Reproduced locally 2026-08-10 — `ml-en` is the sharpest case

The real client payload sends `session_metadata.language: "ml-en"` — a
**code-switch marker** meaning "Malayalam-English mixed", not a request for
Malayalam output. `resolveV1LanguageName` reduces it to the base subtag
(`'ml-en'.split('-')[0]` → `ml`) → `Malayalam`. Verified against the built
prompt:

| `language` | directive emitted |
|---|---|
| `ml-en` | **Write ALL summary content in Malayalam** … |
| `ml` | Write ALL summary content in Malayalam … |
| `en` | Write ALL summary content in English … |
| *(absent)* | Write ALL summary content in English … |

And the same request logs `translateToEnglish: false`, so Sarvam never runs.

So for the payload the product actually sends today, the pipeline **explicitly
instructs the model to write Malayalam and does not translate the transcript**.
R2-as-implemented is not merely permissive here — it actively converts a
code-switch hint into a non-English output instruction. This is the strongest
argument for option (a) below.

**Decision needed:**
- **(a) English always** — the summary directive is hardcoded to English
  regardless of `language`, which becomes a SOURCE-language hint only. Simplest,
  matches the owner's words literally, and makes Hindi/Tamil safe by construction.
- **(b) Keep R2** — non-English output stays reachable, and the translate trigger
  must then widen from "Malayalam" to "any non-English source", so English remains
  the default for every locale.

Recommendation: **(a)**, with `translate_to_english` still driving Sarvam for
non-English sources so the model reads English input rather than translating in
its head. (b) is only worth the complexity if a customer genuinely wants
vernacular notes.

## 7. Change History

| Date | Change |
|---|---|
| 2026-08-10 | Opened. Root cause established as a four-part stack: Sarvam never invoked (zero callers in ALaaS), `language` asserted as `'en'` against a Malayalam transcript, 13 templates instructing "conversation language", and a bare-label gateway directive that loses to them. Recorded the deliberate v1 divergence. |
