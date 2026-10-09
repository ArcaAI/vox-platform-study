# TASK-1053 — Inbound safety/toxicity classifiers warn by platform default

| Field | Value |
|---|---|
| Status | In Progress |
| Type | bugfix (policy default) |
| Opened | 2026-10-09 |
| Owner decision | 2026-10-09: "go with option 1" — inbound `prompt_safety` / `prompt_toxicity` default `warn` |

## 1. Requirement analysis

Live dev, 7 days: inbound screening decided **1483 block / 185 allow**, almost all `["prompt_safety","prompt_toxicity"]`.
Both checks come from one classifier, `fastino/gliguard-LLMGuardrails-300M` (`guardrail.safety`, seed
`packages/database/src/prisma/db_main/seed/ai-models/nlp.ts`), threshold 0.4. It flags clinical and prompt-authoring
text: `prompt_safety`/unsafe 0.66–0.99 on `governed_prompt`, a fixed 0.994 on every `text.generate` call in one
burst; `prompt_toxicity` mostly `regulated_advice` / `privacy_violation`. 21 of 45 recent blocks raised user-visible
BLOCKED notices; the rest failed governed-prompt authoring.

TASK-1050 (`65c875077`, owner 2026-10-08) already moved the OUTBOUND twins (`response_safety`, `response_toxicity`)
to `warn` for the same reason. This ticket applies the same default to the INBOUND twins.

Scope: catalogue default action only. Warn still screens, records a `GuardrailEvaluation`, and raises a notice; a
platform admin may raise either check back to `block`. `jailbreak_detection`, `medical_validation`, data-region
`ignore`, thresholds and the model are unchanged. An existing SYSTEM availability row that STORES an action keeps it
(admin-owned) — the live dev row stores none for these two checks, so the new default applies there on deploy.

## 2. Current state

`apps/guardrail/src/guardrail/core/availability.py:90-95` (`CATALOGUE_DEFAULTS`, `ACTION_BLOCK`), mirrored in
`packages/applications/src/services/guardrail-availability/policy-catalogue.ts`, the seed
`packages/database/src/prisma/db_main/seed/18-guardrail-availability.ts:86-88`, and the contract fixtures
`apps/guardrail/src/guardrail/tests/contracts/availability-catalogue.json`, `tests/contracts/guardrail-policy.fixture.json`.

## 3. Implementation plan

Mirror commit `65c875077` file for file: flip the two inbound defaults to `warn` in the Python catalogue, the TS
catalogue, the seed and both fixtures; update the tests that pin the old inbound `block` default; add a test that an
inbound instruction-region flag from either check yields a WARN decision with a notice (not BLOCK), and that an
explicit stored `block` still blocks.

## 4. Implementation summary

_Pending._

## 5. Change history

| Date | Change |
|---|---|
| 2026-10-09 | Opened from the post-deploy e2e of `1042ba78`; owner chose option 1. |
