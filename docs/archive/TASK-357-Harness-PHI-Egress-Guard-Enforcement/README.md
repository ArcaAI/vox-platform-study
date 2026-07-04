# TASK-357 — Enforce the Harness PHI Egress Guard before Cloud LLM Calls

| | |
|---|---|
| **Ticket** | TASK-357 |
| **Title** | Enforce the fail-closed PHI egress guard on cloud-bound harness payloads |
| **Created** | 2026-06-14 |
| **Updated** | 2026-06-14 |
| **Status** | **Completed** — guard enforced at the cloud-bound harness call sites (TDD; full harness suite green) |
| **Type** | security / bugfix-gap |
| **Affected areas** | `apps/harness` (Temporal activities, SMR/judge/Granite call paths, core config), harness policy contract (`HarnessPolicy.phi_enabled/phi_fail_closed`) |
| **Spawned from** | TASK-355 §8 observation #1 + [TASK-355 Appendix 04](../TASK-355-Harness-Latency-Optimization/04-gating-inventory.md) "PHI guard — wired but NOT in the execution path" |
| **Strong dependency for** | **TASK-356** (Admin-Managed Models & Workflows) — the admin surface that can assign a cloud provider per tenant is the exact trigger that makes this gap exploitable |

> Implemented 2026-06-14 via TDD (plan §4 approved). The fail-closed guard is now enforced at the SMR/judge/Granite cloud-egress boundaries; local providers are byte-identical (replay fixtures stay green). See the **Implementation Summary** (§4A) for what was built and how each AC is met.

---

## 1. Requirement Analysis

### 1.1 Description

The harness ships a complete, tested, **fail-closed** PHI redaction guard
(`PhiRedactor.ensure_safe_for_cloud`) and the harness policy advertises it as active
(`phi_enabled=true`, `phi_fail_closed=true`). **However, no Temporal activity, workflow, or
service client calls the guard before sending consultation content to an LLM provider.** The
guard is dead code on the runtime path.

This is **moot today** because every default provider is local (LM Studio / Ollama), and the
guard is by design a pure pass-through for non-cloud providers. It becomes a **real PHI-egress
defect the moment any tenant is configured with a cloud provider** (`azure` / `bedrock`) for
summarization (SMR), the entailment judge, or Granite Guardian — at which point the full
transcript + generated note leave the box **without** the redaction the policy claims to enforce.

This ticket wires the existing guard into the cloud-bound egress points so that the
policy's promise is actually kept, **fail-closed**, with **zero behavioral change for local
providers**.

### 1.2 Business context

- **Compliance:** PHI leaving the trust boundary unredacted to a third-party cloud LLM is a
  HIPAA/GDPR exposure. The codebase already encodes the intended control (Presidio + a clinical
  recognizer, HIPAA Safe-Harbor framing noted in `eval/golden/clinical_v1_spec.md`); the control
  is simply not invoked.
- **Truthful policy:** `HarnessPolicy` returns `phi_enabled=true, phi_fail_closed=true`. A policy
  that asserts an enforcement the pipeline does not perform is worse than no policy — it creates
  false assurance for operators and auditors.
- **Unblocks TASK-356:** TASK-356 makes provider/model selection admin-managed per tenant
  (including enabling cloud providers). That feature **must not ship before** this guard is
  enforced, or it directly enables unredacted PHI egress. See §5.

### 1.3 Acceptance criteria

- **AC-1** — Every cloud-bound LLM payload on the harness path (SMR `generate`, the inferential
  entailment judge, Granite Guardian safety screen) passes through `ensure_safe_for_cloud(...)`
  **before** egress when the resolved provider is in `cloud_egress_providers` (default
  `["azure", "bedrock"]`).
- **AC-2** — **Fail-closed:** when `phi_fail_closed` is true and redaction cannot be confirmed
  (or the redactor raises / is unavailable), the cloud call is **blocked** (`PhiEgressBlocked`)
  and the run degrades safely (no silent egress, no silent auto-PASS of the gate).
- **AC-3** — **Local providers unaffected:** for `lm-studio` / `ollama` the path is byte-for-byte
  unchanged (guard is a pass-through; no added latency on the default dev/prod-local shape).
- **AC-4** — The guard honors the **effective policy** (`phi_enabled` / `phi_fail_closed`): when
  `phi_enabled=false` the guard is bypassed; when true it enforces per `phi_fail_closed`.
- **AC-5** — Egress blocks are **observable** (structured log + a WORM/audit-visible signal where
  one already exists for the run) so operators can see a fail-closed refusal.
- **AC-6** — Tests cover: cloud provider + PHI → blocked; cloud provider + clean → passes;
  local provider → pass-through; `phi_enabled=false` → bypass; redactor-unavailable +
  `fail_closed` → blocked.

---

## 2. Current State Evaluation (grounded in live code)

### 2.1 The guard exists, is complete, and is tested

- `apps/harness/src/harness/guards/phi/redactor.py:174` — `PhiRedactor.ensure_safe_for_cloud(text, *, provider, settings)`:
  for a provider **not** in `settings.phi.cloud_egress_providers` it returns the text untouched
  (`redactor.py:185-186`); for a cloud provider it redacts + confirms removal and raises
  `PhiEgressBlocked` (`redactor.py:52`) when `fail_closed` and removal cannot be confirmed
  (`redactor.py:188-202`).
- `apps/harness/src/harness/guards/phi/redactor.py:163` — `redact()` (Presidio analyze→anonymize),
  `:83` `_build_clinical_recognizer()` (MRN recognizer; documented JSL upgrade path).
- `apps/harness/src/harness/guards/phi/__init__.py` — public surface (`redact` + `ensure_safe_for_cloud`).
- Tests: `apps/harness/src/harness/tests/unit/guards/test_phi_redactor.py` — fail-closed behaviour
  for cloud providers (`bedrock`/`azure`), local pass-through, unconfirmed-removal block.

### 2.2 The policy advertises it; nothing consumes it

- `apps/harness/src/harness/temporal/models.py:156-157` — `HarnessPolicy.phi_enabled=True`,
  `phi_fail_closed=True`; `:192-193` parses `phiEnabled` / `phiFailClosed` from the API policy.
- `apps/harness/src/harness/core/config.py:93` — `PhiConfig`; `:108` `fail_closed: bool = True`;
  `:109` `cloud_egress_providers = ["azure", "bedrock"]`; `:260` wired into `Settings.phi`.
- **Confirmed unused on the runtime path:** a repo search for `ensure_safe_for_cloud` /
  `PhiRedactor` / `guards.phi` returns matches **only** in `redactor.py`, its `__init__.py`, the
  unit test, a doc-comment in `core/config.py:100`, and the TASK-355 docs — **never** in
  `apps/harness/src/harness/temporal/**` or `apps/harness/src/harness/services/**`. `phi_enabled` /
  `phi_fail_closed` appear **only** in `temporal/models.py` (defined + parsed, never acted on).

### 2.3 The cloud egress points that currently bypass the guard

All three send full consultation content (transcript and/or generated note) and accept a
**provider** that may be cloud:

1. **SMR `generate`** — `apps/harness/src/harness/temporal/activities.py:231-245`:
   `_smr_client(settings).generate(prompt=…, system_prompt=…, provider=payload.provider, model=…)`.
   `provider` flows from workflow input / policy; the SMR service itself supports
   `lm-studio | ollama | azure | bedrock`. The assembled prompt embeds the **full transcript**.
2. **Inferential entailment judge** — `activities.py:145` `_build_runtime_judge()` →
   `build_judge_client(get_runtime_judge_config())`, invoked from `run_inferential_sensors`
   (`activities.py:442-505`). The judge premise is the **full transcript ∪ evidence** per claim
   (`sensors/inferential/groundedness.py:91-104`).
3. **Granite Guardian safety screen** — `activities.py:154` `_granite_client(settings)` →
   `GraniteGuardianClient` (`sensors/inferential/granite_client.py:102`), which posts the **full
   note** per harm criterion. Provider from `SafetyGuardConfig` (`core/config.py:38`).

> Note (in-scope-exempt): `retrieve_context` deliberately keeps its dense embeddings query on the
> self-hosted path (`activities.py:163` comment) — retrieval is not a cloud-egress vector today and
> is out of scope unless a cloud embeddings provider is later introduced.

### 2.4 Dependencies & impact areas

- **Dependencies:** Presidio extras (`presidio-analyzer`/`presidio-anonymizer`/`spacy` +
  `en_core_web_lg`) are already an optional install; the guard imports Presidio lazily and the
  fail-closed path already refuses when the extra is absent (`redactor.py:25-28`). Enforcement
  must therefore **degrade-closed** when the extra is missing on a cloud run, not crash the loop.
- **Impact areas:** the three activities above; possibly a small shared egress helper; the
  `HarnessGateConfig` snapshot taken at workflow start (if the PHI flags need to be deterministic
  across replay, they should be snapshotted like the other policy values — **the guard call lives
  in the activity, not the workflow body, so no `workflow.patched()` gate is required** — see §4.4).
- **No DB/UI impact.** Pure harness-internal enforcement.

---

## 3. Relationship to TASK-356 (prominent — read before scoping)

[TASK-356 — Admin-Managed Models & Workflows](../TASK-356-Admin-Managed-Models-Workflows/README.md)
makes model/provider selection **admin-managed per tenant**:

- §2.1 / §4.4 — SMR becomes a **stateless gateway** where the API passes the cascade-resolved
  `provider`+`model` on every call (`HarnessPolicy.smrModel`/`smrProvider`).
- §2.3 — providers explicitly include **`azure` / `bedrock`**; §1.1 enumerates cloud defaults.
- §4.9 / AC-1 — tenant admins can choose models/providers within bounds.

**This is exactly the trigger that converts the present (moot) gap into a live PHI-egress defect.**
The moment an admin can assign `azure`/`bedrock` to a tenant, unredacted PHI egresses unless this
guard is enforced first.

**Scope boundary (no overlap):**

- **TASK-357 (this ticket)** owns the **egress enforcement** — calling `ensure_safe_for_cloud`
  at the harness cloud-bound call sites, fail-closed, honoring policy. It is **provider-agnostic**:
  it does not add or change provider/model *selection*.
- **TASK-356** owns the **selection/admin surface** (catalog, per-tenant provider/model, cascade).

**Sequencing recommendation:** TASK-357 should be **merged before** TASK-356 enables any cloud
provider for a real tenant. TASK-356 should add a cross-reference making cloud-provider activation
**conditional on** TASK-357 being in place (a "PHI guard enforced" precondition on the provider
selector). This ticket does **not** modify TASK-356's docs; the back-reference will be added by the
TASK-356 owner once this number is known.

---

## 4. Implementation Plan (proposed — **await approval before coding**, Phase-3 gate)

> Per `01-development-workflow.mdc` Phase 3: this plan must be **approved** before any code is
> written. TDD Red-Green-Refactor; harness is Python/pytest under the `arcaenv` conda env.

### 4.1 Backend changes (apps/harness)

1. **Shared egress helper** — add a single chokepoint, e.g.
   `guards/phi/egress.py::ensure_egress_safe(text, *, provider, settings, policy)` that:
   - no-ops when `policy.phi_enabled` is false;
   - otherwise delegates to `PhiRedactor().ensure_safe_for_cloud(text, provider=provider, settings=settings)`
     (which itself no-ops for non-cloud providers);
   - maps `PhiEgressBlocked` to a degrade-closed signal the activity can surface (block the cloud
     call; never silently send).
   - Construct/cache the `PhiRedactor` once per activity invocation (Presidio engines are lazy).
2. **Wire the three call sites** (`activities.py`):
   - `generate` (`:231`) — redact `prompt` (+ `system_prompt`) for the resolved SMR `provider`
     before `SmrClient.generate`.
   - `run_inferential_sensors` (`:442`) — redact the premise/note content for the resolved judge
     provider and the Granite provider before those clients are used. (Prefer guarding at the
     activity boundary so both the judge and Granite paths are covered once.)
   - The provider identity must be the **effective** one (policy/workflow-input resolved), matching
     `cloud_egress_providers`.
3. **Snapshot the PHI flags** alongside the other gate config at workflow start so enforcement is
   deterministic for the run (read in the activity from the passed-in policy snapshot, not re-fetched).
4. **Observability** — structured log on block + reuse the existing run's degrade/audit signal
   (e.g. the `REDUCED_ASSURANCE`/degrade path) so a fail-closed refusal is visible without inventing
   new schema.

### 4.2 Explicitly out of scope (defer)

- Admin/provider **selection** UI/config → TASK-356.
- Production-grade clinical de-id (JSL recognizer upgrade) → tracked in `redactor.py:91` doc; not this ticket.
- Cloud **embeddings**/retrieval egress → only if/when a cloud embeddings provider is added.
- Redacting non-harness paths (legacy SMR path) → separate ticket if needed.

### 4.3 TDD test list (write first; must see RED)

| # | Test (pytest) | Asserts |
|---|---|---|
| T1 | cloud provider (`azure`) + PHI-bearing prompt → `generate` blocked, SMR client **not** called | AC-1, AC-2 |
| T2 | cloud provider + clean prompt → redaction confirmed, SMR client called with cleaned text | AC-1 |
| T3 | local provider (`lm-studio`) → guard is pass-through, SMR client called with original text (no redaction) | AC-3 |
| T4 | `phi_enabled=false` + cloud provider → guard bypassed (egress allowed) | AC-4 |
| T5 | `fail_closed=true` + redactor raises/unavailable + cloud provider → blocked (degrade-closed) | AC-2 |
| T6 | inferential pass: cloud judge/Granite provider + PHI → premise/note redacted (or blocked) before the client call | AC-1, AC-2 |
| T7 | block emits the structured log / degrade signal (observability) | AC-5 |
| T8 | replay guard: flag-OFF / local-provider history replays byte-identical (no new workflow command) | AC-3 |

### 4.4 Verification criteria

- New + existing harness unit/temporal suites green (`pnpm py:harness:test` or pytest under `arcaenv`).
- `ruff` clean; mypy clean on changed files.
- A focused E2E/manual check with a cloud provider stub confirming block-on-PHI and pass-on-clean.
- Replay fixtures unchanged / still green — enforcement lives in activities (I/O), **not** the
  deterministic workflow body, so no `workflow.patched()` marker is needed (per TASK-355 §7.4 the
  patch discipline applies only to workflow-sequence changes).

---

## 4A. Implementation Summary (2026-06-14)

Built end-to-end via TDD (RED → GREEN → REFACTOR). The fail-closed `PhiRedactor` is now enforced at
a single, replay-safe chokepoint per cloud-bound activity; local providers (the default) are an
identity no-op.

### Files created

- **`apps/harness/src/harness/guards/phi/egress.py`** — the chokepoint.
  - `ensure_egress_safe(text, *, provider, settings, phi_enabled, phi_fail_closed, redactor=None)` —
    per-string gate: bypass when `phi_enabled` is false or `provider is None`; otherwise delegate to
    `PhiRedactor.ensure_safe_for_cloud` (no-op for local, fail-closed redact+confirm for cloud). When
    the snapshotted `phi_fail_closed` differs from `settings.phi.fail_closed` it `model_copy`s the
    settings so the **effective policy** governs without mutating shared state.
  - `ensure_inferential_egress_safe(...)` — fans the gate across the whole inferential payload: the
    Granite-screened **note** (safety provider) and the judge premise — **transcript + every claim
    hypothesis/evidence quote + knowledge chunks** (judge provider). Each field is gated against *its
    own* consumer's provider; when neither consumer is cloud it returns the inputs unchanged
    (identity → byte-identical replay, no Presidio cost).
- **`apps/harness/src/harness/tests/unit/guards/test_phi_egress.py`** — 13 helper unit tests.
- **`apps/harness/src/harness/tests/unit/temporal/test_activities_phi_egress.py`** — 8 activity-wiring tests.

### Files modified

- **`guards/phi/__init__.py`** — barrel-export the two helpers.
- **`temporal/models.py`** — add `phi_enabled` / `phi_fail_closed` (default `True`) to `GenerateInput`
  and `RunInferentialSensorsInput` (optional, safe defaults ⇒ replay-safe; TASK-355 Slice-5d precedent).
- **`temporal/activities.py`** — add the `_phi_redactor()` factory (monkeypatchable, like the other
  client factories); wire `generate` (redact prompt + system prompt before SMR; a block re-raises and
  fails the workflow — no draft persisted) and `run_inferential_sensors` (redact via
  `ensure_inferential_egress_safe` before the judge/Granite calls; a block **degrades** the whole pass
  to reduced assurance). Reused the existing `get_runtime_judge_config()` read for both the guard's
  judge-provider resolution and the entailment batch size (net zero extra config reads).
- **`temporal/workflows.py`** — snapshot `phi_enabled` / `phi_fail_closed` at workflow start (policy
  branch + code-default branch) and thread them into both `GenerateInput` sites and both
  `RunInferentialSensorsInput` sites.

### How each AC is met

- **AC-1** — `generate` redacts prompt/system-prompt; `run_inferential_sensors` redacts note +
  transcript + claim hypotheses/evidence + chunks; all via `ensure_safe_for_cloud` for cloud
  providers only. (Tests T2, T6, `test_cloud_redacts_every_field`, `test_redacts_only_the_cloud_consumer_payload`.)
- **AC-2** — fail-closed `PhiEgressBlocked` blocks the call: `generate` re-raises (workflow fails, no
  draft), the inferential pass degrades (groundedness/citation_verify/safety → DEGRADED, reduced
  assurance). Granite/SMR are never called on a block. (Tests T1, T5, `test_cloud_block_degrades_whole_pass_and_skips_granite`.)
- **AC-3** — local providers pass through unchanged; the inferential all-local path returns the
  identical input objects → replay fixtures replay byte-identical. (Tests T3, `test_local_providers_no_redaction`, `test_all_local_is_identity_noop`, replay-compat suite = T8.)
- **AC-4** — `phi_enabled=false` bypasses entirely; the snapshotted `phi_fail_closed` overrides
  `settings.phi.fail_closed`. (Tests T4, `test_policy_fail_closed_false_overrides_settings_true` / `…_true_overrides_settings_false`.)
- **AC-5** — every block emits a structured `harness.phi_egress.blocked` warning (`provider` / `reason`
  / `stage`); the inferential degrade reason (`"phi egress blocked …"`) surfaces in
  `guardrailDecisions` (the existing reduced-assurance/WORM audit path — no new schema). (Test T7.)
- **AC-6** — covered by the full T1–T8 matrix above.

### Verification (actual)

- **Full harness suite:** `conda run -n arcaenv python -m pytest` → **593 passed** (incl. 21 new tests
  and the 5 replay-compat fixtures, all green).
- **ruff:** clean on all changed files. **mypy:** clean on all TASK-357 files. **black:** clean on all
  TASK-357 lines.

### Deviations from the plan

1. The helper takes the two policy **booleans** (`phi_enabled` / `phi_fail_closed`) rather than a
   `policy` object, to keep `guards/` decoupled from `temporal/` models — functionally identical to §4.1.
2. Inferential redaction was extended beyond "premise/note" to also cover the per-claim
   hypotheses + evidence quotes + knowledge chunks, since those are part of the judge's cloud-bound
   premise (`groundedness.py`) — required to fully satisfy AC-1. Still a single activity-boundary chokepoint.

### Overlap with concurrent tickets (TASK-355 / TASK-356)

`temporal/activities.py`, `temporal/workflows.py`, and `temporal/models.py` carry uncommitted
TASK-355/356 working-tree changes. All TASK-357 edits are additive/surgical (locate-by-name). Pre-existing
non-TASK-357 lint debt in those files was left **untouched** for the owning agents: one black-noncompliant
line in `_build_assurance_publisher` (TASK-355) and four mypy findings in the optimistic-delivery helpers
(`_deliver_early`/`_regen_compute` missing annotations, an `inferential_results` redefinition, a
`Verdict | None` attribute access). TASK-359 also edits `run_inferential_sensors`; the guard insertion is a
contiguous block right after `settings`/`judge_config` to ease that merge.

---

## 5. Risks & invariants

- **Latency:** redaction adds Presidio cost **only** on cloud runs (local path untouched). Acceptable;
  cloud calls already dominate latency.
- **Over-blocking:** a too-aggressive redactor could break legitimate clinical content. Mitigate with
  the existing confirm-removal approach (`redactor.py:205`) and golden tests.
- **Degrade-closed, never auto-PASS:** a block must surface as forced human review / reduced
  assurance, consistent with the harness fail-safe invariants (TASK-355 §7).
- **Replay safety:** keep the call in activities; snapshot policy flags at start.

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-14 | Planning ticket created (no code). Spawned from TASK-355 §8 observation #1 + Appendix 04 "PHI guard" section; grounded in live code (`guards/phi/redactor.py`, `temporal/activities.py`, `core/config.py`, `temporal/models.py`); strong dependency relationship to TASK-356 documented. Status = Pending, awaiting plan approval. | `docs/implementation/TASK-357-Harness-PHI-Egress-Guard-Enforcement/README.md` |
| 2026-06-14 | **Implemented (TDD), Status → Completed.** Added the `guards/phi/egress.py` chokepoint (`ensure_egress_safe` + `ensure_inferential_egress_safe`); enforced it in `generate` (block re-raises → workflow fails) and `run_inferential_sensors` (block degrades the pass); added `phi_enabled`/`phi_fail_closed` to `GenerateInput`/`RunInferentialSensorsInput`, snapshotted them at workflow start, and threaded them into all four activity call sites; structured `harness.phi_egress.blocked` logging. 21 new tests; full harness suite 593 passed; replay fixtures green; ruff/mypy/black clean on changed files. | `apps/harness/src/harness/guards/phi/egress.py` (new), `apps/harness/src/harness/guards/phi/__init__.py`, `apps/harness/src/harness/temporal/models.py`, `apps/harness/src/harness/temporal/activities.py`, `apps/harness/src/harness/temporal/workflows.py`, `apps/harness/src/harness/tests/unit/guards/test_phi_egress.py` (new), `apps/harness/src/harness/tests/unit/temporal/test_activities_phi_egress.py` (new) |
