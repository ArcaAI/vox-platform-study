# Agentic Workflow Platform — Autonomous Execution Log

| | |
|---|---|
| **Started** | 2026-08-16 |
| **Branch** | `feat/loop` |
| **Operator** | Claude (autonomous session; user away ~7h from start) |
| **Instruction** | Execute waves sequentially. Commit each wave once complete. Escalate every human-gated step, question, or doubt here instead of guessing. |

---

## 1. FOR YOU — decisions and questions waiting

> This is the section to read first. Nothing below has been guessed at or worked around.
> Where a ticket was blocked on one of these, the unblocked portion was still delivered
> and the blocked portion is named explicitly.

### 1.1 Blocking now

#### From Wave 0 — 8 items need you

| # | Item | Ticket | What I did instead | What I need |
|---|---|---|---|---|
| W0-1 | **Run the DNA decrypt-and-scan.** Decides latent-gap vs live-incident for existing `DnaWritingStyleReport.styleText` rows. (= queue #2) | 700 | Script `packages/database/scripts/dna-phi-scan.ts` authored + 44 unit tests green. Never executed. Forward-going path is now closed regardless. | Go-ahead + a named target env/DB. Vault creds come from you or an operator, never from me. |
| W0-2 | **API-key scope narrowing.** ~50 `/admin/*` routes are reachable by any active API key today. (= queue #10) | 708 | Full (a)/(b)/(c) classification of all 92 controllers written to README §7. Contract tests lock in *current* behavior so the change is measurable. Nothing narrowed. | Approve/adjust the classification. It is a **breaking change** for existing keys. |
| W0-3 | **NEW — `stt-internal.controller.ts` is reachable by any tenant API key.** Not `@Public()`, no `@RequiredScopes`. Its own AUTH-NOTE already calls this a known gap. | 708 | Flagged HIGH PRIORITY in the Task 3 table. Not changed. | Confirm this should be closed in the 708 follow-up — I'd treat it as higher urgency than the `/admin/*` sweep. |
| W0-4 | **NEW — ArcaAI v1 clinical prompts still carry the ICD-10 wording.** `v1-clinical-prompt-checksums.fixture.ts` pins v1 against the running production pod and its own header demands clinical/product sign-off before hashes change. | 702 | v2 + v3 fixed (v3 is what's actually served — `ARCAAI_CLINICAL_APPROVED_VERSION = 3`). v1 edit was made, then **reverted** to zero diff. The 10 new sha256 hashes are computed and ready to hand over. | Clinical/product sign-off to update the fixture. Residual risk: rolling the approved version back to 1 re-exposes the old wording. |
| W0-5 | **Sync `POST :id/summary` short-circuit.** Making sync `generateSummary` route to harness when `harnessEnabled=true`. (relates to queue #8) | 704 | Seam calls `resolveConfig()` and **logs only**; the legacy SMR call always still runs. Calling `generate()` unconditionally would have started a live harness workflow *on top of* the legacy body — duplicate generation. | Product decision on whether sync regeneration should move to harness. |
| W0-6 | **`harness.loop.enabled` per-environment intent.** (= queue #9) | 705 | Read-only `scripts/report-loop-status.sh` + written Temporal query procedure. No value set anywhere. | The intended value per environment. See W0-7 — this is now more urgent than it looked. |
| W0-7 | **NEW — re-triage: the loop is probably LIVE in `hope-v2-dev`, not gated off.** `hope-db-migrate` runs `RUN_SEED="none"` (owner decision 2026-08-09, DB no longer disposable), so the loop-enabled row is **not** re-seeded on syncs — whatever bootstrap left it at persists. Prior assessment assumed GATED-OFF. | 705 | Upgraded to "LIKELY LIVE, pending confirmation". Confirming requires querying the live cluster's Temporal — deliberately not done. | Authorize the Temporal query, or tell me to treat it as live. |
| W0-8 | **Egress rollout comms.** Tenants on openai/anthropic/vertex now pay Presidio redact-and-confirm on every cloud call, and get `PhiEgressBlocked` if the optional `guardrails` extra isn't installed. (= queue #13) | 706 | Code shipped fail-closed. No comms sent. | Confirm operators are told before this reaches an environment with real tenants. |

#### Smaller things I noted but did not act on

| Item | Ticket | Note |
|---|---|---|
| Second forgery write path | 701 | `getOrCreate`/`createRevisit` also accept unvalidated `metadata`, so a forged `metadata.status:'SIGNED'` can still be *written*. Already neutralized on read by the mapper's `CONSULTATION_STATUS_VALUES` validation, so nothing forged can reach a response. Candidate to fold into TASK-711. |
| No DNA reset/delete route | 700 | INV-240. Out of 700's scope by its own text; no route exists for a clinician to erase their profile. |
| v4-corpus vs in-place edit | 702 | §2.3 said "new v4 file", Task 3's steps said edit v2/v3 in place. I did the latter (invariants verified). Say the word and I'll port to v4. |
| `deployment/` doc corrections | 705 | Agent corrected stale `hope-deployments` → `arca/hope-v2-deployment` references in 5 files. Factually right per rule 09, but it is scope creep beyond the ticket. Easy to revert if you'd rather keep the diff clean. |
| Possible doc drift: Temporal | 705 | Rules 09 + `04-target-architecture.md` describe Temporal as "an unmanaged VM with a dead in-cluster copy". The deployment repo's current `base/temporal.yaml` defines an **active** in-cluster `hope-temporal` Deployment+Service. Not confirmed against live pods. **Bears directly on queue #4 (Temporal hosting).** |

#### Your local machine — 2 env issues (not code, not committed)

1. **4 harness tests fail on this box.** `.env.dev` and `.env.test` set `HARNESS_OTEL_DEPLOYMENT_ENVIRONMENT=` and `HARNESS_RETRIEVAL_QDRANT_API_KEY=` to *empty string*. Under pydantic-settings an empty string is a **set** value, so it overrides the code default the tests assert. I proved this is unrelated to Wave 0: neither test file was touched, and 706's `config.py` diff is entirely inside `PhiConfig`. Fix: delete those two lines (don't set them empty).
2. **Stale var after 706's rename.** Both files still carry `HARNESS_PHI_CLOUD_EGRESS_PROVIDERS`, which is now dead. The new `HARNESS_PHI_LOCAL_PROVIDERS` correctly falls back to its safe code default, so behavior is fine — but the line will mislead. I did not edit your local env files.

### 1.2 Known from the program's own decision queue (backlog.md §Decision queue)

These were already flagged at authoring time. Listed here with the wave that hits them, so
you can answer them in priority order.

| # | Decision | Hits at | Blocks |
|---|---|---|---|
| 2 | Run the DNA decrypt-and-scan: authorize + name the target environment/DB | Wave 0 · 700 | Latent-gap vs live-incident verdict; 733's per-tenant re-enable |
| 13 | Rollout comms for tenants whose cloud providers become newly gated by fail-closed egress | Wave 0 · 706 | Egress flip |
| 9 | Per-environment intent for `harness.loop.enabled` | Wave 0 · 705 | Loop posture |
| 10 | API-key scope narrowing for currently-unscoped routes (breaking change for existing keys) | Wave 0 · 708 | Exposure precondition (722) |
| 14 | `ChangelogAudience` rename vs a possibly-frozen external contract | Wave 0 · 707 | Rename completeness |
| 1 | Legacy-consent posture (legacy-grant backfill vs cutover exemption vs re-consent) — fail-closed day one would brick every existing chart | Wave 1 · 712 | Consent seed posture; program schedule risk |
| 12 | Pseudonymization mechanism per artifact class (needs NLP entity-linking input) | Wave 1 · 710 | Redactor build |
| 5 | Eval-gate judge backend (local CI model vs cloud spend vs scheduled-only) | Wave 1 · 713 | CI clinical-quality gate |
| 3 | Clinical review of the initial validator rule set (AI-authored, not clinician-reviewed; 22 substrate + 19 consultation rules) | Wave 1 · 716, Wave 4 · 731 | Validator build; tenant full-build-power safety |
| ~~15~~ | ~~Design-gate Figma approvals for Studio/Workbench/runs screens~~ | ~~Wave 2 · 719, 721, 723, Wave 3 · 728~~ | **RESOLVED 2026-08-16 — user waived the Figma design gate: "you are approved to go ahead without any figma design/figma approval". Console screens build directly against `ScreenTemplate` + `@arcaai/ui` per rules 07/10/11/13.** |
| 11 | `/agentic-policy` fold-in is a privilege change (tier 10–19 `manage:all` → tenant Studio) | Wave 2 · 719 | Studio consolidation scope |
| 6 | May a publicly-invoked workflow select a cloud LLM? (interacts with 706 egress) | Wave 2 · 722 | Exposure flag flip |
| 4 | Temporal hosting (self-hosted k3s vs Temporal Cloud) | Wave 3 · 730 | Wave 4 migration gate |
| 7 | Migration go/no-go thresholds — define BEFORE reading 730's data | Wave 4 · 732 | Legacy deletion |
| 8 | Scope of "legacy deleted": 3 of 7 entry points have no harness equivalent | Wave 4 · 732, 704 | Deletion scope |

### 1.3 Structural note on how far autonomy can reach

1. ~~**The design gate**~~ — **waived by the user on 2026-08-16.** Console screens (719, 721, 723, 728)
   are built directly, no Figma frame required. They still owe the rest of rule 12's downstream gates:
   `ScreenTemplate` region contract, `@arcaai/ui` primitives only, semantic tokens, both themes,
   WCAG 2.2 AA with a 0-violation axe scan per screen (rule 11 §11 — an implementation gate, not a
   design-approval one, so it stands).
2. **Human-gated executions** remain the one hard stop — anything that runs against a real database,
   cluster, or deployed environment, or that enters credentials. Scripts are authored and
   unit-tested; they are never run.

---

## 2. Wave progress

| Wave | Tickets | Status | Commit |
|---|---|---|---|
| 0 | 700, 701, 702, 703, 704, 705, 706, 708 | **Complete — committed** | see below |
| 0 (barrier) | 707 `naming-alignment` | Not started — gated on 700–706 landing | — |
| 1 | 709–717 | Not started | — |
| 2 | 718–723 | Not started | — |
| 3 | 724–730 | Not started | — |
| 4 | 731–733 | Not started | — |

---

## 3. Per-wave record

### Wave 0 — Containment

**Launched** 2026-08-16. Seven tickets in parallel (700, 701, 703, 704, 705, 706, 708);
702 serialized after 700 because both edit `packages/database/src/prisma/db_main/seed/07-prompt-template.ts`.
Then a cross-ticket verification sweep. 9 agents, 0 errors, ~80 min wall clock, 2.77M tokens.

| Ticket | Agent status | Substance |
|---|---|---|
| 700 dna-phi | Completed | Closed-vocabulary `DNA_OUTPUT_SCHEMA` (6 enums + 1 length-capped string); `styleText` is now **rendered deterministically from validated fields**, never the model's raw JSON; parser hard-fails instead of persisting raw output; opt-out gate hoisted above the `textSamples` bypass; smr-proxy routed through the gated accessor. Schema applied to the ArcaAI tenant's own template copy too — the default-tenant-only fix would have missed live generations. |
| 701 forgery | Completed | `metadata.status` rejected as a reserved key (`BadRequestException`); mapper validates against `CONSULTATION_STATUS_VALUES` on read. |
| 702 icd10 | Review | v2 + v3 prompt content fixed; golden test added. v1 blocked on sign-off (W0-4). |
| 703 empty-note | Review→**green** | Degradation marker through service → DTO → SDK types → console badge, with `aria-live="polite"` added to both badges. Its `Review` status was only "couldn't verify the shared tree"; the sweep's 9016-test green run resolves that. |
| 704 seam | Review | New `NoteGenerationService` seam; all generator entry points routed through it; grep-gate test prevents a silent third `harnessEnabled` reader. Sync short-circuit deliberately not applied (W0-5). |
| 705 loop-status | Review | Read-only report script + Temporal query procedure + RUN_SEED finding (W0-7). Investigation ticket — its deliverable is the decision, which is yours. |
| 706 egress | Completed | **Default-deny inversion**: `cloud_egress_providers` (allowlist of unsafe) → `local_providers` (allowlist of known-safe). An unrecognized/new provider now redacts instead of passing through. Boot-time validator refuses an empty/duplicate/blank list. |
| 708 apikey | Review | Findings doc + contract tests locking current behavior + full 92-controller classification. Nothing narrowed (W0-2, W0-3). |

**Verification (actual, by the sweep agent):** `@arcaai/applications` typecheck clean, 480 files / 9016 tests pass · `@arcaai/database` typecheck clean, 51 files / 1237 tests pass · `pnpm api:build` 10/10 tasks · `pnpm test:unit` root 1006 files / 17037 tests pass · `@arcaai/vox` + `@arcaai/admin-console` typecheck clean · `harness:lint` clean · `pnpm lint` 34/34 tasks, **zero** `arcaai-internal` / `no-restricted-syntax` / `no-controller-direct-prisma` / `no-direct-downstream-url-env` hits. No cross-ticket collisions, no half-applied edits, no duplicate symbols. No fixes were needed.

**Not verified:** e2e suites (`task-704-generator-seam.spec.ts`, `task-708-apikey-scope-contract.spec.ts`) need live API + Postgres + Redis; 704's full-loop block additionally needs harness + Temporal + SMR + NLP. Not run, not claimed. `harness:test` 4 failures = local env, see §1.

**TDD honesty note:** 706's agent physically reverted its own source edits to observe genuine RED rather than assume it. 702's agent wrote its golden test *after* the content edits and said so plainly, reconstructing RED afterwards via an isolated revert — a real deviation from strict red-green, reported rather than hidden.

---

## 4. Change history

| Date | Entry |
|---|---|
| 2026-08-16 | Log created; wave-0 workflow launched |
