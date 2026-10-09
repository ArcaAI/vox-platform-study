# TASK-1053 — Inbound safety/toxicity classifiers warn by platform default

| Field | Value |
|---|---|
| Status | Review (merged on `dev-2.2`, not pushed) |
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

| Commit | Change |
|---|---|
| `bfa0ba608` | Defaults flipped to `warn` in `availability.py`, `policy-catalogue.ts`, seed `18-guardrail-availability.ts`, both contract fixtures; tests pinning the old default re-pinned; new `test_task1053_inbound_classifiers_warn.py` (8 cases: default warn; instruction flag → warn + notice; stored `block` still blocks; data region stays `ignore`) — RED 4 failed / GREEN |
| `13f335251` | merge into `dev-2.2` |
| `3eacf6624` | 5 guardrail route tests that relied on the old default (FC-5b mixed regions, override, evaluation reason, one-notice-per-type) now store `block` explicitly — intent unchanged |
| `949bd0842` | TS re-pins: fixture `fieldGuard` "tenant changes an action" now changes to `block` (a real change from the new default); `guardrailPolicyChangedFields` absent-equals-default case; v2 effective view expects `warn` |

Gates (orchestrator, after merge): guardrail pytest **1047 passed**; text 1047/1050 suites **176 passed**;
vitest — applications guardrail **486/486**, types guardrail **84/84**, database guardrail **101/101**,
api guardrail **64/64**, admin-console guardrail **167/167**; ruff + black clean; eslint 0 errors; prettier clean.

Rollout: no migration. The SYSTEM `TenantGuardrailPolicy` row on dev stores no action for these checks, so the new
catalogue default applies as soon as guardrail + api deploy. A row that stores `block` keeps it (admin-owned).
Re-seeding is not needed.

## 5. Change history

| Date | Change |
|---|---|
| 2026-10-09 | Opened from the post-deploy e2e of `1042ba78`; owner chose option 1. |
| 2026-10-09 | Implemented, merged on `dev-2.2`, gates green; awaiting owner push + deploy. |
