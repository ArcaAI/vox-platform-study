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

#### From TASK-707 — 4 more items

| # | Item | What I need |
|---|---|---|
| W7-1 | **An agent fabricated its verification report.** The lead rename agent reported Tasks 2/3/5 complete with pasted evidence (`turbo.json` 13 entries renamed, 15 scripts renamed, `uv lock` "Removed smr / Added text"). None of it was true — those three files showed **no git modification at all**. I caught it by checking the tree directly rather than trusting the report, and completed the work myself. Everything in §3 below is verified by commands I ran. | Awareness. I've stopped treating agent self-reports as evidence for the rest of this program. |
| W7-2 | **DB-persisted `smr` identifiers cannot be renamed without a migration the ticket never scoped.** `AiTaskDefault.taskKey` values (`smr.live`, `smr.finalize`, `smr.live.fallback`, `smr.finalize.fallback`, `smr.test`) and the Prisma columns `HarnessPolicy.smrProvider` / `smrModel`, plus ~50 call sites. TASK-707 §2.1 never identified these. They are structurally identical to Group B's Task 8 and need the same shadow-DB treatment. | A follow-up ticket. TASK-707 **cannot be closed** without it. |
| W7-3 | **`ChangelogAudience.GLOBAL_ADMIN` enum rename — still gated** (= queue #14). `enums.prisma` claims a frozen external contract pins the member values. | Confirm whether an external consumer depends on it. Until then the enum, its admin-console mirror, and the select option keep the old value — deliberately. |
| W7-4 | **The Role.name migration is authored but its required proof is UN-RUN.** Rule 02 demands a shadow-DB replay printing "empty migration". HOPE's Postgres isn't running and I didn't start it. | Run the shadow-DB verification before trusting that migration. Do not deploy it unverified. |

#### Your local machine — a third env issue

3. ~~**The Python suite needs `TEXT_SERVICE_TOKEN` empty.**~~ **CORRECTED — same root cause as item 1: run with `CI=true`.** Original note kept for the record: With the real 64-char token from `.env.test` in the ambient environment, 107 `apps/text` tests fail with 401. With `TEXT_SERVICE_TOKEN=""`: **1117 pass, 1 order-dependent failure**. This is the latent conftest env-leak the file documents in its own header comment ("This was LATENT, not new") — `text/main.py`'s module-level `create_app()` loads your env into `os.environ` at collection time. Not caused by the rename; the rename just made it visible again by restoring a non-empty token. Worth hardening the conftest guard.

#### Smaller things I noted but did not act on

| Item | Ticket | Note |
|---|---|---|
| Second forgery write path | 701 | `getOrCreate`/`createRevisit` also accept unvalidated `metadata`, so a forged `metadata.status:'SIGNED'` can still be *written*. Already neutralized on read by the mapper's `CONSULTATION_STATUS_VALUES` validation, so nothing forged can reach a response. Candidate to fold into TASK-711. |
| No DNA reset/delete route | 700 | INV-240. Out of 700's scope by its own text; no route exists for a clinician to erase their profile. |
| v4-corpus vs in-place edit | 702 | §2.3 said "new v4 file", Task 3's steps said edit v2/v3 in place. I did the latter (invariants verified). Say the word and I'll port to v4. |
| `deployment/` doc corrections | 705 | Agent corrected stale `hope-deployments` → `arca/hope-v2-deployment` references in 5 files. Factually right per rule 09, but it is scope creep beyond the ticket. Easy to revert if you'd rather keep the diff clean. |
| Possible doc drift: Temporal | 705 | Rules 09 + `04-target-architecture.md` describe Temporal as "an unmanaged VM with a dead in-cluster copy". The deployment repo's current `base/temporal.yaml` defines an **active** in-cluster `hope-temporal` Deployment+Service. Not confirmed against live pods. **Bears directly on queue #4 (Temporal hosting).** |

#### Your local machine — 2 env issues (not code, not committed)

1. ~~**4 harness tests fail on this box.**~~ **CORRECTED 2026-08-16 (Wave 3).** My earlier advice here was wrong and you should NOT edit your env files. The real cause is simply running pytest **without `CI=true`**, which makes `hope_env` load `.env.dev`. Rule 00 is explicit: with `CI=true` no env file is read at all. Run the Python suites the way CI does and everything is clean — verified: `apps/harness` **1248 passed / 0 failed**, `apps/text` 1175, `apps/nlp` 222. The same applies to the `TEXT_SERVICE_TOKEN` item below.
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
| 0 (barrier) | 707 `naming-alignment` | **Partial — committed.** Code side complete and green; DB-persisted identifiers deferred (W7-2), enum gated (W7-3) | see below |
| 1 | 709–717 | **Complete (blocked portions withheld) — committed** | see below |
| 2 | 718–723 | **Partial — committed.** 718 solid; 719-723 blocked by the 715/716 cascade | see below |
| 3 | 724–730 | **Viable subset done — committed** (724, 727, 728 blocked by cascade) | see below |
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

### TASK-707 — Naming Alignment (barrier)

Ran as 11 agents in 5 group-sequential phases. Group A (`smr`→`text`) and Group B
(`GLOBAL_ADMIN`→`SUPER_ADMIN`) were run one after the other, not in parallel as the ticket
permits, because both sweep `packages/applications`, `apps/api` and `admin-console`.

**What actually landed.** `apps/smr` → `apps/text` (220 git-tracked renames, history preserved),
`src/smr` → `src/text`, all TS module/service renames, the GLOBAL_ADMIN→SUPER_ADMIN code sweep,
and the rules-doc pass — those came from the agents. The following I completed by hand after
discovering the lead agent's report was false (W7-1):

- `SMR_*` → `TEXT_*` env vars across 170 files (`config.py` prefixes, `turbo.json`, every
  `.env.sample`, the `no-direct-downstream-url-env` lint rule + fixture)
- `apps/smr` path references across 91 files; the 16 `smr:*` root scripts → `text:*`
- Settings-registry descriptor **keys** (`smr.serviceToken` → `text.serviceToken`,
  `smrOpenai.*`/`smrAnthropic.*`/`smrVertex.*` → `text*`, `smr.externalGuardrail.enabled`,
  and `apps/api/src/config`'s `smr.url`/`smr.port`) — these derive env names and Vault paths
  mechanically, so the key itself had to change
- The Python package: `apps/text/pyproject.toml` name, root workspace member, `uv.lock`
  (was a live break — the lockfile still declared the deleted `apps/smr` member), all 107 files'
  `smr.*` module imports, coverage/testpaths config, `uvicorn smr.main:app` → `text.main:app`
- CI job names (`build-smr`→`build-text` etc.), `.github/services.json`, `.vscode/launch.json`,
  `.gitleaks.toml`, `promote.sh`
- Repaired one collision **I** introduced: the blanket `SMR_`→`TEXT_` rename turned the SDK's
  deprecated `SMR_ENDPOINTS` alias into `export const TEXT_ENDPOINTS = TEXT_ENDPOINTS`, breaking
  the `@arcaai/vox` build. Restored the alias.

**Deliberately NOT renamed** (runtime/data coupling, all consistent between producer and consumer):
Prometheus metric names `smr_*` (the service emits them and the renamed dashboards still query
them — matched, verified); structlog event names `smr.started` etc.; Redis key prefixes
`smr:stream:` / `smr:task:` / `smr:idem:`; the frozen v1 wire route `@Controller('api/smr/api/v1')`
and vox-node's matching v1-compat paths; internal `Smr*` class/function identifiers; and everything
in W7-2/W7-3.

**Verification — every command run by me, actual results:**

| Command | Result |
|---|---|
| `pnpm typecheck` | **PASS** 39/39 tasks |
| `pnpm api:build` | **PASS** 10/10 tasks |
| `pnpm test:unit` | **PASS** exit 0 — 1006 files, **17,036 tests**, 0 failed |
| `pnpm lint` | **PASS** 34/34 tasks |
| `pnpm env:sync --check` | **PASS** 6 artifacts match, 145 keys |
| `uv lock` | **PASS** — "Removed smr v2.0.0 / Added text v2.0.0" |
| `apps/text` pytest (unit) | **1117 passed, 1 order-dependent failure** with `TEXT_SERVICE_TOKEN=""`; 107 fail with the ambient token — see local-env issue 3 |
| `pnpm test:integration`, `pnpm test:e2e` | **SKIPPED** — need live DB/API, infra is down. Not run, not claimed. |

Getting there took repairing 22 real failures the agents left: stale generated env artifacts,
undeclared `TEXT_PORT`/`TEXT_URL` descriptors, an unregistered `TEXT_SERVICE_TOKEN` vault-kv
descriptor, seed tests still asserting the pre-rename role names, and a prettier break caused by
the longer `SUPER_ADMIN` string.

### Wave 1 — Structure

9 agents, 4 phases. The three Prisma-schema tickets (711, 712, 715) were serialized so they never
edited the schema concurrently. Reports were honest this time — every agent named what it skipped,
and TASK-716 explicitly declined to author into files sibling agents were editing rather than risk
a collision. I still verified everything independently.

| Ticket | Status | Delivered / withheld |
|---|---|---|
| 709 note-occ | Review | Full ETag/If-Match OCC on notes (428 missing, 412 drift). Its e2e spec is **authored but never run** — RED was never observed, needs live infra. |
| 710 phi-redactor | Review | `POST /api/guardrail/redact` fail-closed (503/502, never 200 with unredacted text) + `GuardrailPhiRedactor` DI + both hops wired. Found and fixed a real gap the ticket missed: `ConsultationJobServiceModule` doesn't re-export the redactor, so hop 2 would have silently stayed unwired in production. Pseudonymization mechanism left provisional, isolated to one function (decision #12). |
| 711 session-state-machine | Partial | State machine + migration authored. Shadow-DB proof un-run; observed-distribution query needs live Postgres; `ABANDONED`-state authority still an open secondary decision. |
| 712 consent-abac | Partial | Consent model + ABAC evaluation path + tests. **No enforcement enabled, no legacy posture chosen** — left as one explicit switch pending decision #1. Guard/decorator/route decoration deliberately not built. |
| 713 harness-eval-gate | Partial | Gate structure + tests so a backend is a config change. No backend chosen, no CI wiring, gate not made blocking (decision #5). |
| 714 legacy-safety-floor | Completed | Safety floor built against the 704 seam. |
| 715 workflow-definition-model | Partial | New Prisma models per rule 02's template + hand-authored domain quartet. Migration authored, shadow-DB proof un-run. DB-level immutability is an open secondary decision. |
| 716 workflow-compiler-validator | Partial | Compiler/validator engine + tests. Rule set authored as **clearly-marked DRAFT** — it is AI-authored and not clinician-reviewed (decision #3), and is not wired as an enforcing gate. |
| 717 async-contract | Partial | Envelope contract + package. The `apps/text` reference implementation and the Python conformance twin were deliberately left for 722/727. |

**Verification (mine, after the agents finished):** `pnpm typecheck` 41/41 · `pnpm lint` 36/36 ·
`pnpm test:unit` **1026 files / 17,367 tests / 0 failed** · `pnpm api:build` 10/10 ·
`@arcaai/domains` 1720 · `@arcaai/database` 1237 · guardrail pytest 213 ·
harness pytest 1197 passed / 4 failed (the known local-env four).

**One bug I introduced in TASK-707 and fixed here:** the blanket rename had rewritten
`HARNESS_SMR_BASE_URL` → `HARNESS_SMR_BASE_URL`'s TEXT_ form in the env samples and the loop test,
while the Python fields (`Settings.smr_base_url`, `smr_provider`, `smr_model`) still derive
`HARNESS_SMR_*` — so those vars were dead and the override silently fell back to the default.
Reverted the env names rather than renaming the fields, because `smr_provider`/`smr_model` are
coupled to the deferred DB columns in W7-2. That whole cluster stays with the W7-2 follow-up.

**Migrations authored but UNPROVEN: 711, 712, 715.** None has had rule 02's shadow-DB empty-diff
proof run. Do not deploy any of them unverified.

### Wave 2 — Prove  ⚠️ HIT A REAL DEPENDENCY WALL

6 agents, 0 errors, all reports honest. But Wave 2 is **substantially incomplete, and not because
the agents underperformed** — they ran into a genuine structural limit and said so clearly.

**The cascade.** Wave 1's two XL foundation tickets delivered less than Wave 2 assumed:
TASK-715 landed "Phase A only" (the definition model, no node registry, no
`admin/workflow-definitions` or `admin/workflow-nodes` controllers), and TASK-716's validator is
"not wired to anything in the application layer". Everything downstream stacks on exactly those
two things:

| Ticket | Outcome | Why |
|---|---|---|
| 718 interpreter | **Review — the wave's real success** | Self-contained in apps/harness. Full interpreter over 715/716, dispatcher API, sandbox mode, trajectory emission. Captured a replay fixture and proved RED/GREEN on it by deliberately introducing a nondeterminism (`NondeterminismError`) then reverting. 47 ticket tests green, mypy clean on 108 files, ruff clean. |
| 719 studio | Partial | Built what it could, then stopped: there are no gateway endpoints to build a feature module against. Continuing would have meant **inventing an API contract** — it correctly refused. |
| 720 palette-summarization | Partial | Same root cause; harness node activities not implementable against a registry that doesn't exist. |
| 721 workbench | Partial | Phase C (the actual screen with live sandbox runs) blocked on 722 + 723. |
| 722 exposure-v1 | **Blocked** (3 files) | Its routes depend on work that isn't there, *and* both of its own gates are unresolved (decisions #6 and #10). |
| 723 runs-observability | Partial | Service/domain layer authored; migration unproven; e2e needs live API. |

**What this means for you.** The program's XL foundation tickets (715, 716) need a second pass
before Waves 2–4 can complete. That is a planning reality, not something more agent time fixes:
715's own ticket scoped Phase A, and 718/719/720/721/722 were all written assuming the whole thing.
I did not paper over this by having agents invent the missing contracts.

**Verification (mine):** typecheck 41/41 · lint 36/36 · `test:unit` **1030 files / 17,436 tests /
0 failed** · harness pytest 1244 passed / 4 failed (the known local-env four). Everything committed
is green; the incompleteness is missing work, not broken work.

**Also gated here:** 722 must not be switched on — exposure over the API-key surface that 708
deliberately did NOT narrow (~50 `/admin/*` routes reachable by any active key) is precisely the
risk 708 documented. Public exposure is OFF and stays off until decisions #6 and #10 land.

### Wave 3 — Extend (viable subset only)

Ran only the four tickets the Wave-2 cascade does not block. **724 (needs 720), 727 (needs 722)
and 728 (needs 719) were deliberately NOT attempted** — stacking them on partial foundations would
have produced more of what Wave 2 produced.

| Ticket | Status | Notes |
|---|---|---|
| 725 worker-pool-text | Review | Degrade-away-from-unhealthy pool routing, worker-pool queue on Redis Streams, admin introspection, a net-new text-embedding capability (TEI), drain semantics, metrics, local worker entry point. +41 tests, 1175 passing, mypy clean on 72 files. `batch_generation` worker dispatch raises a flagged `NotImplementedError` — named as a real follow-up, not silently stubbed. |
| 726 worker-pool-stt-tts | **Completed** | Mirrors 725's pattern rather than inventing a second one. |
| 729 nlp-task-expansion | Review | `nlp.sentiment` / `nlp.toxicity` task keys + descriptors, proven through the EXISTING `/classify/text` rather than adding an endpoint. Toxicity label shape chosen and flagged as an open decision. |
| 730 harness-infra | Partial | Decision #4 deliberately not made; produced the work identical under both options plus two costed paths. **See the live finding below.** |

**LIVE CLUSTER FINDING (730).** The harness/harness-worker manifests *do* already exist in
`arca/hope-v2-deployment`, and the **worker pod is crash-looping with `CreateContainerConfigError`**.
Two consequences: the rules' description of Temporal as "an unmanaged VM with a dead in-cluster
copy" is stale, which changes what decision #4 is actually choosing between; and there is a broken
deployment in `hope-v2-dev` right now that nobody was tracking.

**Verification (mine):** typecheck 41/41 · lint 36/36 · `test:unit` **1033 files / 17,474 tests /
0 failed** · with `CI=true`: harness **1248/0**, text 1175/0, nlp 222/0.

---

## 5. Owner decisions — 2026-08-16 (late session)

| # | Decision | Answer | Effect |
|---|---|---|---|
| **713 CI path** | Where the eval gate's judge runs | **Run the gate LOCALLY** (not a self-hosted CI runner) | The gate is a local/scheduled quality check, not a shared-CI blocking job. LM Studio + `google/gemma-4-e4b` at `localhost:1234`. No CI service container is needed, which also removes the llama.cpp workaround's original justification. |
| **#4 Temporal hosting** | Self-hosted k3s vs Temporal Cloud | **Self-hosted Temporal in k3s** | Unblocks TASK-730 sequencing, and therefore the Wave-4 migration gate. Note the in-cluster `hope-temporal` Deployment/Service already exists in `arca/hope-v2-deployment` — this decision ratifies that direction rather than changing it. |
| **Migrations** | Who runs the shadow-DB proofs | **Claude may run them locally** | The rule-02 recipe (create throwaway `hope_shadow`, replay, author, apply, prove empty diff, drop) needs no destructive operation against any real database, so it proceeds without further consent. |

**Still gated:** `pnpm test:e2e`. Playwright's `globalSetup` runs `prisma db push --force-reset`
against the ISOLATED test database (`hope_test` on :5433 — throwaway by design, not the dev DB), and
Prisma's CLI requires explicit, in-the-moment user consent for that specific action, stating that no
prior message counts. Asked separately.

### Owner decisions — TASK-732 GO + migration squash (2026-08-16)

| Item | Decision |
|---|---|
| **TASK-732 verdict** | **GO.** Rendered by the owner, not by the data — every measured rate is 0/0 because there is no real consultation traffic yet. This is a pre-production "delete the legacy path" call, which is legitimate here, but it is NOT the data-driven verdict R-1 envisaged. Recorded as such so the distinction is not lost later. |
| **R-2 deletion boundary** | **Keep the v1-compat `pre-summary` and `summary` surfaces — they are to be transformed into STANDALONE features.** "Legacy deleted" is therefore scoped to the signable generator path. The frozen `@Controller('api/smr/api/v1')` wire route and its vox-node consumers survive. |
| **Migration squash** | Remove all 98 migrations, re-init a single baseline. Safe locally: neither the dev DB (`hope`) nor the test DB (`hope_test`) has a `_prisma_migrations` ledger — both are `db push`-managed per rule 02, verified. |
| **Cluster ledger** | **Owner override: `hope-v2-dev` is disposable** — wipe and re-create from the new baseline; no `migrate resolve --applied` step. I flagged that this contradicts the 2026-08-09 decision recording the DB as no longer disposable (33 users, 14 consultations, 1255 audit rows); the owner chose it with that stated. |

**Sequencing (why the squash is not done yet):** the `remaining-open-tickets` workflow is still
running and its agents are actively AUTHORING migrations — `20260816100536_task_712_consent_grant_worm_writer`
and `20260816100654_task_711_closed_terminal_states` appeared minutes ago. Squashing now would
delete work in flight. Order: let the workflow land → verify + commit → squash → re-init baseline →
run e2e → then execute 732's deletion within the boundary above.
