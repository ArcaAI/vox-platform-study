# TASK-537 — Technical Documentation Rebuild

| | |
|---|---|
| **Status** | Review |
| **Type** | docs |
| **Program** | Release Readiness (TASK-536 comments · TASK-537 docs · TASK-538 traceability · TASK-539 quality) |
| **Execution agents** | Opus 4.8, reasoning effort **high** |
| **Created** | 2026-07-21 |
| **Ticket number** | Provisional — next after TASK-535; confirm before merge |

## Requirement Analysis

Hundreds of incremental tickets have outpaced the documentation. Before first release, every technical document must reflect the **current** state of the system — verified against code. Wave 1 confirmed the shape of the problem precisely: the authoritative docs are a coordinated **2026-07-04 snapshot** (the TASK-412 realignment) and **~124 tickets have landed since** (TASK-413..536), including every majorly-changed surface.

**In scope:** docs/architecture, top-level docs (development-guide, development-patterns-and-standards, docs/README, root README), app/package READMEs, scripts/tests/infrastructure/deployment READMEs, docs/operations, docs/backlog hygiene, implementation→archive hygiene.
**Out of scope:** `docs/traceability-matrix.md` (TASK-538); `.claude/rules` (separately governed); `docs/research/*` (point-in-time records — inventory only); `docs/section-syntax.md` (verified CURRENT, no action).

### Governing principles

- **Verification-first**: every load-bearing claim checked against code/config before written.
- **One authoritative doc per topic**; duplicates merge into pointers.
- **Standard freshness header** (adopt the `operations/inference/model-retention.md` pattern): `{Owner · Introduced · Completed by · Last updated}` — Wave 1 caught docs committed 2026-07-20 still reading "Last updated: 2026-07-04", so a header-date/commit-date consistency check joins the tooling.
- **Docs describe the present**: history lives in ticket READMEs and git.

## Current State Evaluation — Wave-1 audit findings (2026-07-21, workflow `wf_e0632a48-a69`)

**Classification of the 6 authoritative docs:** 4 MAJOR-DRIFT · 1 MINOR-DRIFT · 1 CURRENT · 0 OBSOLETE/MISSING. All app READMEs exist except `apps/ui-playground` (deprecated — acceptable); all 22 package READMEs exist.

| Doc | Class | Sharpest verified gaps |
|---|---|---|
| `docs/architecture/overview.md` | **MAJOR** | admin-console entirely absent from topology; diarization still "wespeaker/512-dim" after TASK-505 ECAPA/Sortformer cutover; zero coverage of config plane, model discovery hub, lifecycle/retention, BYO creds, pipeline template governance |
| `docs/development-guide.md` | **MAJOR** | tts-v2 (port 8865) and admin-console (5176) absent from dev-commands/ports/testing sections; "latest ticket: TASK-412" |
| `docs/architecture/data-and-domain-model.md` | **MAJOR** | No AiProviderConnection/AiRuntimeProfile/tenant-AI-config/BYO models; stale wespeaker Qdrant row; entity tables predate 31-file schema |
| Root `README.md` | **MAJOR** | tts-v2 + admin-console missing from structure/stack; deprecated ui-playground still captioned as "admin console" |
| `docs/development-patterns-and-standards.md` | MINOR | Substantially current (admin-console patterns covered); stale header; thin on config-plane/tts-v2/lifecycle service patterns |
| `docs/section-syntax.md` | CURRENT | No action |

**Other verified findings:** `apps/tts-v2/README.md` still describes a "Phase 1 scaffold" though TASK-488..496 all shipped (P1). `docs/README.md` says "latest ticket: TASK-416", misnames backlog files, omits 3 newer operations runbooks, links a nonexistent `research/security/` (P1). `apps/stt-v2/README.md` predates the TASK-505 restructure (P2). `apps/admin-console/README.md` predates TASK-532 IA and cites `.cursor/rules` paths (P2). scripts/tests/infrastructure/deployment READMEs: likely MINOR — light verify pass only (P3). The newer operations runbooks (`operations/inference` model-retention, dated 2026-07-20) are CURRENT — the freshness exemplar.

**Hygiene:** 14 active ticket folders + SOTA-Track. TASK-523 and TASK-525 are archive-eligible (Completed) but the program closeout gate TASK-534 is still Pending — **hold the moves until TASK-534 closes**, don't auto-archive.

## Implementation Plan

### Wave 1 — Audit ✅ COMPLETE (2026-07-21)
Findings above; full report in workflow `wf_e0632a48-a69` output.

### Wave 2 — Rebuild by cluster (Opus 4.8, effort high; one writer agent per cluster + independent verifier agent per cluster)

Priority order now follows the audit rather than the original default:

| # | Cluster | Contents | Effort | Priority |
|---|---|---|---|---|
| C1 | Architecture core | `overview.md` + `data-and-domain-model.md` + **new** `docs/architecture/model-and-config-plane.md` (structural rec: the TASK-523..535 config-plane/model-lifecycle material is large enough to stand alone rather than bloat the other two) | L | P0 |
| C2 | Dev entry points | `development-guide.md` (add tts-v2 + admin-console throughout), root `README.md`, `docs/README.md` (fix ticket pointer, backlog filenames, ops runbook list, dead research/security link) | M | P0/P1 |
| C3 | Stale app READMEs | `apps/tts-v2` (scaffold→shipped rewrite), `apps/stt-v2` (TASK-505 restructure), `apps/admin-console` (TASK-532 IA + rules path fix) | M | P1/P2 |
| C4 | Patterns & standards | `development-patterns-and-standards.md`: header, config-plane service patterns, BYO credential encryption, tts-v2, model-lifecycle/retention conventions | M | P2 |
| C5 | Ops surfaces | Light **verify pass** (not rebuild) on scripts/tests/infrastructure/deployment READMEs + docs/operations; bump headers; confirm config-plane env vars and lifecycle scripts covered | S | P3 |
| C6 | Hygiene | Backlog triage; archive moves for TASK-523/525 **gated on TASK-534 closing**; package-README sweep only where drift is reported | S | P2 |
| C7 | **Knowledge absorption (owner directive 2026-07-21)** | Runs after TASK-536 batch 4: mine the cleanup batches' "substantive content condensed/removed" reports + the TASK-5xx README corpus for load-bearing knowledge not yet in the authoritative docs, and write it into the right home — platform contracts (OCC incl. `If-Match: "0"`, 404-over-403, sys-events, settings planes, service auth) into `development-patterns-and-standards.md`; subsystem internals (STT pipeline schema v2/processor registry, harness agentic loop + Temporal determinism, TTS provider resolution, model lifecycle/retention) into `docs/architecture/` deep-dive sections or per-app READMEs; operational gotchas into `docs/operations/`. Goal: an engineer can answer "why is this like this / how does this subsystem work" from docs alone, without git archaeology. Each absorbed item cites the code it documents; verifier pass + claim-checker run afterwards | M/L | **P0 (owner priority)** |

**Writer/verifier pairing:** every rewritten doc gets an independent opus-high verifier that re-checks each path/command/port claim against the repo and bounces failures back. No doc lands unverified.

### Wave 3 — Consistency + tooling
1. Cross-doc consistency agent: ports table, monorepo map, stack versions identical everywhere; single source `overview.md`, others link.
2. **Scripted claim checker** (committed to `scripts/`, optional CI validate job): extract backtick path refs + `pnpm` command refs from `docs/**/*.md` and all READMEs → assert existence in tree / `package.json`. Include the **header-date vs git-commit-date consistency check** from the audit's process recommendation.
3. Markdown link check across `docs/`.

### Wave 4 — Sign-off
Per-cluster MR review; confirm `CLAUDE.md`/rules cross-references resolve; adopt the standard freshness header everywhere touched.

### Verification criteria (definition of done)
- [ ] All 4 MAJOR-DRIFT docs rebuilt and verifier-approved; MINOR docs refreshed; `model-and-config-plane.md` exists
- [ ] Every rebuilt doc carries the standard freshness header
- [ ] Scripted claim checker green over the full docs tree; available as CI job
- [ ] No duplicate authority; dead links fixed (incl. `research/security/`)
- [ ] Archive moves executed when TASK-534 closes (tracked, not blocked on)
- [ ] `CLAUDE.md` index still resolves

### Risks
| Risk | Mitigation |
|---|---|
| Rewrite introduces new wrong claims | Writer/verifier pairing + scripted checker |
| Docs describe unlanded branch work as current | Rebuild AFTER `fix/2605-review` lands (shared Wave-0 gate with TASK-536), or mark sections `(unlanded)` explicitly |
| Header dates masquerade as verification | Date-consistency check in CI |
| Config-plane doc goes stale immediately (TASK-533 still In Progress) | `model-and-config-plane.md` notes open tails explicitly; TASK-539 findings loop back here |

## Implementation Summary

**Wave 2, clusters C1+C2 ✅ (2026-07-21, workflow `wf_81525326-b65`, writer+verifier pairs):**
- **C1:** `docs/architecture/overview.md` and `data-and-domain-model.md` rebuilt; `docs/architecture/model-and-config-plane.md` created. Independent verifier checked ~40 claim categories and fixed 5 factual errors (dead TASK-412 path ×2, missing `smr` in the effective-config service list, 31→29 domain-file count, stale k3s kustomization list + section renumbering). **Open flag: Redis DB-index assignments (BullMQ 0 / cache 1 / STT 2 / SMR 3 / Celery 4 / Dramatiq 5) could not be verified from code and `.env` samples contradict them (Celery + Dramatiq both DB 0) — owner to confirm the authoritative routing.**
- **C2:** `development-guide.md` rebuilt (tts-v2 + admin-console added throughout), root `README.md` and `docs/README.md` updated. Verifier checked 33 doc links + 34 code paths + every command: **zero factual errors found**. Minor flag: root README carries no freshness header (convention decision left to owner).

**Wave 2, clusters C3–C7 ✅ (2026-07-21/22) — closing verification pass, re-checked against the working tree:**
- **C3 (stale app READMEs):** `apps/tts-v2/README.md` rewritten from "Phase 1 scaffold" to the shipped TASK-488..496 state (provider abstraction, gateway proxy contract, en+ml fallback chains); `apps/stt-v2/README.md` rewritten for the TASK-505 restructure (`(kind, name)` processor registry — Whisper/NeMo Parakeet/Azure); `apps/admin-console/README.md` rewritten for the TASK-532 governance-console IA (43-route nav inventory across 4 tiers) and no longer cites `.cursor/rules` paths. All three carry the standard freshness header, `Last verified: 2026-07-21` — confirmed present on disk.
- **C4 (patterns & standards):** `docs/development-patterns-and-standards.md` carries the freshness header (config-plane/model-lifecycle material stamped `Last verified 2026-07-21` against TASK-504/523/524/525/529/532/534 code); new §1.8 (config-plane service patterns: settings registry, effective-config, BYO credentials), §2.7 (Temporal/harness), §2.8 (tts-v2 stateless gateway-resolved config), §2.9 (`hope-runtime-models` shared model-lifecycle contract) — confirmed present.
- **C5 (ops surfaces verify pass):** `scripts/README.md`, `tests/README.md`, `infrastructure/README.md`, `deployment/README.md` all confirmed carrying `Last verified: 2026-07-21` headers. `docs/operations/` inventory confirmed: `inference/README.md` + `inference/model-retention.md` (TASK-529) + `retrieval-corpus-ingestion/README.md` + `tts-model-mirror/README.md` + `vault/README.md` — matches the audit's "3 newer runbooks" gap closed.
- **C6 (hygiene):** Backlog/package-README sweep done where drift was reported (C3 above). **Archive moves for TASK-523/TASK-525 remain gated and NOT executed** — both are still under `docs/implementation/` (confirmed via `git ls-files`), consistent with the plan's "hold until TASK-534 closes"; TASK-534 is still Status Pending as of this pass, so the gate has not opened. This is expected, not a miss.
- **C7 (knowledge absorption):** Landed inside C4/C1 rather than as a separate doc — config-plane contracts (OCC incl. `If-Match: "0"` create-intent, 404-over-403, sys-events, settings planes, service auth) are in `development-patterns-and-standards.md` §1.8/§6; subsystem internals (STT `(kind,name)` processor registry, harness Temporal determinism rules, tts-v2 provider resolution, the shared `hope-runtime-models` lifecycle/retention contract) are in `docs/architecture/model-and-config-plane.md` + the rewritten `apps/{stt-v2,tts-v2}/README.md` + patterns-doc §2.7–2.9; operational gotchas (Vault dev bootstrap, model-retention clamp) are in `docs/operations/`.
- **Wave 3 tooling — partially landed, verified this pass:** `scripts/verify-doc-claims.mjs` exists and runs (`node scripts/verify-doc-claims.mjs`): **1,865 claims checked, 12 failures**, all pre-existing drift confined to `docs/research/**` (dead ticket-doc links from archived/renamed tickets, e.g. `TASK-330-Clinical-Documentation-Harness/`, `TASK-301-System-Config-Multi-Tenancy-Assessment/README.md`) — none in the C1–C6 rebuilt surfaces. **Not yet built**: the header-date-vs-git-commit-date consistency check and the markdown link checker (Wave 3 items 1 and 3) — no such script exists in `scripts/` as of this pass; carried forward as open scope. **CI wiring not yet added** — `.gitlab/ci/validate.yml` does not reference either checker script (confirmed via grep); TOOLING.md documents the proposed job block as "not yet added."
- **Net assessment:** all 4 MAJOR-DRIFT docs + the MINOR patterns doc are rebuilt and carry freshness headers; the new `model-and-config-plane.md` exists; the doc-claims checker is green against every cluster this ticket touched (residual failures are pre-existing `docs/research/**` drift, out of this ticket's rebuild scope). Moving to **Review**: open tails are the two Wave-3 tooling items (date-consistency check, link checker), CI wiring for both checkers, and the TASK-523/525 archive moves (correctly gated, not a defect).

## Change History

- 2026-07-21 — Ticket created; Wave-1 drift audit launched.
- 2026-07-21 — Wave 1 complete. Priorities re-ordered per audit (4 MAJOR-DRIFT core docs first); new `model-and-config-plane.md` doc adopted; freshness-header standard + date-consistency check added; archive moves gated on TASK-534.
- 2026-07-22 — **Closing verification pass — Status → Review.** Re-checked C3–C7 against the working tree (all Status/verification claims re-derived from disk, not carried forward unverified): C3 app-README rewrites (tts-v2/stt-v2/admin-console) confirmed landed with `Last verified: 2026-07-21` headers; C4 patterns-doc config-plane/tts-v2/Temporal/model-lifecycle sections confirmed present; C5 ops-surface README headers confirmed refreshed; C6 archive moves confirmed still correctly gated on TASK-534 (Pending); C7 knowledge absorption confirmed folded into C1/C4 rather than shipped as a standalone doc. `scripts/verify-doc-claims.mjs` run fresh: 1,865 claims / 12 failures, all pre-existing `docs/research/**` drift outside this ticket's rebuild scope. Open tails carried forward honestly: header-date/git-commit-date consistency check, markdown link checker, and CI wiring for both existing checker scripts were never built — not claimed done.
