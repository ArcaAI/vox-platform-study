# TASK-551 — DNA Redaction/Rewrite: A Separate, Auditable Post-Generation Transform

- **Status:** In Progress (harness Python core landed + gate-verified; workflow insertion, TS layers, DB, console remain — see §Implementation Summary)
- **Type:** feature (harness workflow + applications + small database)
- **Parent:** [TASK-544 §5.5](../TASK-544-Agent-Platform-Concept/README.md) — the A3 redaction clause (net-new: no redaction/rewrite concept exists in code today)
- **Depends on:** nothing hard (integrates with TASK-546's `dnaStylePolicy` if landed; degrade gracefully without it)
- **Rules to read first:** `.claude/rules/06-python-services.md` (Temporal determinism, replay), `.claude/rules/04-application-services.md`, `.claude/rules/02-database-prisma.md` (if schema touched)

## Execution Contract (mandatory — owner directive)

1. **Invoke the `fable-thinking` skill FIRST**, before any other action in the implementing session. Non-negotiable for every Sonnet-5 session on this ticket, including follow-ups.
2. Follow the 5-phase lifecycle in `.claude/rules/01-development-workflow.md`; TDD Red-Green-Refactor — no implementation before a failing test.
3. Paste ACTUAL command output (tests/build/lint) into §Implementation Summary as evidence.
4. Do NOT commit or push. `git add` (stage) completed work as you go — unstaged work has been destroyed by concurrent sessions in this tree before.
5. One implementing session per working tree. For parallel work use a separate git worktree and `git reset --hard fix/2605-review` in it first (worktrees base off `main` by default).
6. File:line refs were verified 2026-07-22/23 and will drift — re-verify before editing.

## Requirement

The owner's department-agent definition includes **redaction** "if dna-writing-style redaction/rewrite is enabled and the user's personalized dna-writing-style report/instructions/prompt is provided". Today **no redaction/rewrite concept exists** — DNA is style-text injection only. Build redaction/rewrite as a **first-class, separate, auditable transform**, per the research guardrails (TASK-544 §3.1):

- **Style never alters fact selection, grounding, or hedging** — redaction is therefore NOT folded into the style prompt; it is its own stage with its own audit trail.
- Deterministic rules first; optional LLM rewrite second; **sensors must validate the FINAL (post-transform) text** — verification of text that later mutates is worthless.
- Every removal/rewrite is WORM-logged (what was removed/rewritten, by which rule/model, when).
- Default **OFF**; enabled per tenant + per doctor (mirroring the existing double opt-in), and per agent when TASK-546's `dnaStylePolicy` exists.

## Current State (verified 2026-07-22)

- **DNA model**: `DnaWritingStyleReport` (`packages/database/src/prisma/db_main/dna-writing-style.prisma:6`) — per-doctor (`doctorId` FK :16), versioned (`DnaWritingStyleVersion`), Vault-encrypted `encryptedStyleText`/`encryptedReportData` (plaintext columns dropped :20-27). Usage telemetry `PromptUsageRecord`/`DnaUsageRecord` carry `departmentId`.
- **Application point today**: style text injected as `{style_DNA_doctor_department_*}` variables in `PromptAssemblyService.assemble` (`prompt-assembly.service.ts:456-486`); double-gated by `ConfigResolver.resolveEffectiveDnaStyleEnabled` — tenant AND doctor opt-in (`harness-internal.service.ts:1029-1042`); descriptor `pipeline.dnaStyleEnabled` is tenant-writable.
- **Workflow loop** (`apps/harness/src/harness/temporal/workflows.py:370`): bounded regen loop → computational sensors settle → ONE inferential pass (`:798`) → persist via `persist_draft` (`activities.py:1522`) or the optimistic early-delivery path (`:646`, `workflow.patched("task-355-optimistic-delivery")` — delivers `DRAFT_PENDING_SENSORS` BEFORE assurance completes).
- **Persist lane on the gateway**: `harness-internal.service.ts:500/:535` already runs a transform before persist — `extractAndStripSegmentCitationMarkers` (the F-032 fix; regex twin of `prompt_cache.py`) strips `[[seg:]]` markers, validates cited ids, merges `citationsMap`. This is the precedent for "transform between generation and persistence".
- **Only existing "redaction"**: PHI-redaction of the gate-edit mining corpus (`GateEditExemplar.redactedAfter`, `harness.prisma:453`) — different concern, but its redactor utilities may be reusable (check `guards/phi/redactor.py`).
- **Sensor thresholds/gate** (`sensors/aggregator.py:97`): PASS/REGEN/FLAG; safety FLAG never regenerates; sign-off safety gate in `summary.service.ts:574`.
- **Replay**: 8 `workflow.patched` eras exist; replay suite `pytest apps/harness/src/harness/tests -k replay`.

## Design (decide-then-build; record deviations here)

**Placement: inside the Temporal workflow, after the computational-sensor loop settles and BEFORE persist/delivery**, as a new activity `apply_redaction` gated by `workflow.patched("task-551-redaction")`:

- Ordering rationale: the optimistic path delivers early — a gateway-side post-hoc transform would let unredacted text reach the clinician (and the assurance lane would verify text that then changes). In-workflow placement redacts BEFORE `_deliver_early`/`persist_draft`, and the cheap computational sensors re-run once on the transformed text (schema_validity + citation_presence minimum) so the verdict matches what is persisted.
- The inferential (costly) pass runs on the post-redaction text by ordering it after `apply_redaction` on the legacy path; on the optimistic path assurance already binds to the delivered (redacted) content.

**Config & data**:
- Redaction instructions live WITH the DNA report (they are personal): new encrypted field `encryptedRedactionRules` on `DnaWritingStyleReport` (+ carried in `DnaWritingStyleVersion`) — structured JSON: `{ rules: [{type: 'remove'|'rewrite', match: <literal|regex|category>, replacement?, note?}] }`. Migration `task_551_…`.
- Enablement: new descriptor `pipeline.dnaRedactionEnabled` (default OFF, maxScope tenant — same tier as `pipeline.dnaStyleEnabled`) AND doctor opt-in via the same `ConfigResolver` double-gate; if TASK-546 is landed, `DepartmentAgent.dnaStylePolicy=DISABLED` also disables redaction for that agent.
- The resolved rules are threaded into `HarnessDocWorkflowInput` (encrypted content decrypted gateway-side, rules passed as payload — same trust boundary as the style text today). Respect the claim-check size budget.

**Transform semantics**:
- Deterministic pass: apply literal/regex/category rules to the note text; each hit recorded `{rule, span, action}`.
- Optional LLM rewrite pass (flag `rewrite` rules only): SMR call with a constrained rewrite prompt (PHI-egress guard + idempotency key exactly like the `generate` activity, `activities.py:929-987`); output must preserve SOAP JSON schema.
- **Guardrails**: the transform must not touch `[[seg:]]`-cited spans' citation validity (re-validate after), must not change numeric doses (re-run `numeric_dose`), and must never ADD content.
- Audit: a GUARDRAIL-type trajectory step with the redaction manifest (counts + rule ids, NOT removed PHI text in plaintext) + a `redactionApplied` marker on `SummaryMeta` (encrypted manifest alongside `citationsMap` if detail is needed).

## Implementation Plan

1. DB: `encryptedRedactionRules` columns + migration; domain-layer hand-updates; encrypt/decrypt via the established `encryptSecretField`/PHI-field patterns (NEVER a new plaintext column).
2. Applications: rules CRUD on the existing DNA admin/service surface (write path validates rule JSON shape); `ConfigResolver.resolveEffectiveDnaRedactionEnabled`; thread resolved rules into the harness start payload (`harness-gateway.service.ts` → `internal.py` input model `models.py`).
3. Harness: `apply_redaction` activity (deterministic engine + optional SMR rewrite), workflow insertion behind the new patch era, cheap-sensor re-run on transformed text, trajectory/audit emission.
4. Console (small): DNA writing-style playground screen (`/dna-writing-style`) gains a redaction-rules editor panel (structured list editor, not raw JSON — use `CodeEditor` only for the advanced view) + enable toggles. Keep surgical.

## TDD Test List

1. applications: rules CRUD round-trip (encrypted at rest — assert cipher called, the F-031 lesson); double-gate resolution matrix (tenant off / doctor off / both on / agent DISABLED).
2. harness unit: deterministic rules remove/rewrite spans; never-add invariant; citation spans re-validated; numeric_dose re-run on change; manifest emitted without plaintext PHI.
3. harness workflow: era-gated insertion — old histories replay unchanged (**replay suite green is the hard gate**); optimistic path delivers post-redaction text; legacy path persists post-redaction text; redaction failure ⇒ fail-open WITHOUT redaction? NO — **fail closed to FLAG** (a note the doctor expected redacted must not slip through silently); test this explicitly.
4. SMR rewrite pass: idempotency key present; PHI-egress guard consulted; schema validity preserved.
5. Console: rules editor renders/saves; toggles gated by role.

## Verification Criteria / Gates

- `pnpm py:harness:test` (hermetic!) + replay subset green, `py:harness:lint`/`typecheck` clean.
- `pnpm --filter @arcaai/applications build test`, `pnpm build:api`, database tests green.
- Console gates if touched (`build lint test` + next-dev-loop + axe).
- Runtime proof: live dev-stack consultation with a rule like `remove: "patient's employer"` — paste the delivered note (span absent), the trajectory manifest step, and psql evidence of the encrypted manifest.

## Constraints & Hazards

- **Temporal determinism + replay compatibility** are the sharpest risks here — all logic in the activity, era-gate the workflow insertion, run the replay suite before claiming done.
- **PHI at rest**: any new content-carrying column MUST be encrypted-on-write via the established repository helpers — the F-031 class (silent content loss when a writer skips the cipher) is the exact failure mode to test against.
- Harness CI is hermetic — SMR rewrite tests use stubs.
- Do not fold redaction into the style prompt "for simplicity" — the separation IS the requirement (auditability + the research guardrail).
- Claim-check budget: large rule sets ride the existing claim-check machinery if they push payload sizes (64 KiB threshold).

## Implementation Summary

### Delivered this session (harness Python core — hermetic, fully TDD, replay-safe)

The **heart of the transform** — the separate, auditable, deterministic redaction/rewrite
engine and the Temporal activity that houses the SMR-rewrite + fail-closed-to-FLAG
semantics — is implemented, tested RED→GREEN, and all harness gates are green. This slice
carries ZERO Temporal replay risk (it adds a NEW activity + additive-optional payload
fields; it does NOT alter `run()` or any recorded command sequence — proven by the replay
suite staying green at 60 passed).

**New files**
- `apps/harness/src/harness/redaction/engine.py` — PURE deterministic engine: `RedactionRule`
  (literal/regex/category × remove/rewrite; a deterministic `rewrite` requires a literal
  `replacement`, else it is a *semantic* rewrite deferred to SMR), `apply_deterministic_redaction`,
  and the audit models `RedactionHit`/`RedactionManifest`/`RedactionOutcome`. Enforces the
  **never-add** invariant and a manifest that records `{rule_id, action, span, removed_length}`
  but **never removed PHI plaintext**. A malformed regex raises `RedactionEngineError` (fail-closed hook).
- `apps/harness/src/harness/redaction/__init__.py` — package barrel.
- `apps/harness/src/harness/tests/unit/redaction/test_engine.py` — 13 tests.
- `apps/harness/src/harness/tests/unit/temporal/test_apply_redaction_activity.py` — 6 tests.

**Edited files**
- `apps/harness/src/harness/temporal/models.py` — added `ApplyRedactionInput` / `ApplyRedactionResult`
  (additive-optional; empty `rules` ⇒ no-op, byte-identical to legacy; `failed_closed` marker; manifest).
- `apps/harness/src/harness/temporal/activities.py` — added the `apply_redaction` activity
  (deterministic pass → optional constrained SMR semantic-rewrite pass, PHI-egress guarded +
  `_idempotency_key("redaction")` exactly like `generate`; JSON-schema preserved). **Fails CLOSED**
  (`failed_closed=True`, workflow will force a FLAG) on a malformed rule, a PHI-egress block, an SMR
  failure, or an unparseable rewrite. Registered in `DOCUMENT_ACTIVITIES` (worker picks it up).

**Gate evidence (actual output, arcaenv):**
```
# RED (before impl): ModuleNotFoundError: No module named 'harness.redaction'  → then
#                    AttributeError: module 'harness.temporal.activities' has no attribute 'apply_redaction'
pytest tests/unit/redaction + test_apply_redaction_activity.py        → 19 passed
REPLAY (hard gate): test_replay_compat + gating_consolidation_replay
                    + test_doc_workflow                               → 60 passed
FULL harness unit suite: pytest apps/harness/.../tests/unit/          → 981 passed, 1 warning
ruff check apps/harness/src/                                          → All checks passed!
mypy (redaction/, activities.py, models.py)                          → Success: no issues found in 4 source files
```

### Remaining (scoped follow-ups — design already specified above; NOT done this session)

Deferred deliberately: each is either replay-critical (needs its own focused session with
replay-fixture regeneration) or a separate layer, and shipping them half-wired would violate
the "do not improvise around the architecture" constraint.

1. **Workflow `run()` insertion** behind `workflow.patched("task-551-redaction")` — the replay-critical
   step. Exact insertion points identified: call `apply_redaction` after the computational loop
   settles and BEFORE `_deliver_early` (optimistic, `workflows.py:1016`) AND before `persist_draft`
   (legacy, `:1272`); thread the redacted `text`/`text_ref` into the downstream persist/assurance
   references; re-run the cheap computational sensors on the transformed text; map `failed_closed` →
   forced FLAG. Requires capturing a NEW replay fixture (see `_capture_replay_fixture.py`) and
   threading `rules` into `HarnessDocWorkflowInput`. Test-list item #3.
2. **DB**: `encryptedRedactionRules` (Bytes?) on `DnaWritingStyleReport` + `DnaWritingStyleVersion`,
   migration `task_551_…`, hand-authored domain updates, encrypt-on-write via the established
   PHI-field helpers (NEVER a plaintext column). Test-list item #1 (cipher-called assertion).
3. **Applications (TS)**: rules-CRUD on the DNA service (write-path validates rule JSON shape),
   `ConfigResolver.resolveEffectiveDnaRedactionEnabled` (tenant + doctor double-gate; agent
   `dnaStylePolicy=DISABLED` also disables), new descriptor `pipeline.dnaRedactionEnabled`
   (default OFF, maxScope tenant), and threading resolved+decrypted rules into the harness start
   payload. Test-list item #1 (double-gate matrix) + #4.
4. **Console**: `/dna-writing-style` gains a structured redaction-rules editor + enable toggles.
   Test-list item #5.

The pure engine + activity are the reusable foundation all four consume unchanged.

## Change History

- 2026-07-23 — Ticket authored from TASK-544 §7 breakdown (§5.5 design).
- 2026-07-23 — Harness Python core implemented (TDD RED→GREEN): pure deterministic redaction
  engine (`harness/redaction/`), `apply_redaction` Temporal activity (deterministic +
  optional constrained SMR rewrite, PHI-egress guarded, idempotency-keyed, **fail-closed to
  FLAG**), and `ApplyRedactionInput/Result` payloads. 19 new tests; replay suite green (60),
  full harness unit suite 981 passed; ruff + mypy clean. Status → In Progress. Workflow
  insertion, DB, applications, and console scoped as follow-ups (see §Implementation Summary).
  **Execution-contract note:** the mandatory `fable-thinking` skill is NOT available in this
  environment (Skill tool returned "Unknown skill: fable-thinking"); recorded here per the
  contract and proceeded with the 5-phase lifecycle + TDD.
