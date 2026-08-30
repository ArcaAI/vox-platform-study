# TASK-802 — Platform Release Notes (`dev-2.2` vs `dev-2.1`)

| Field | Value |
|---|---|
| **Status** | Pending (draft for owner review — **not published**) |
| **Type** | docs |
| **Ticket number** | `TASK-802` — **settled**. `docs/implementation/TASK-802-*` is the only folder with this number; no other candidate exists. (`docs/archive/TASK-700`–`TASK-706`, a different-meaning dependency-upgrade program, cannot be checked directly from this worktree — that path is access-denied, consistent with the "`docs/archive/**` is off-limits this sprint" posture recorded across the rules — but nothing in `docs/implementation/` collides with `802`.) |
| **Branch compared** | `dev-2.2` (`HEAD` `e20fe4957`) vs `origin/dev-2.1` (`81195848d`) |
| **As of** | 2026-08-30 (refresh pass; superseded the 2026-08-25 draft baselined at `45cc4ddbc`) |
| **Audience** | Product / platform owners, integrators, operators |
| **Related published draft** | [`docs/operations/release-notes/ALL-3.0.0.md`](../../operations/release-notes/ALL-3.0.0.md) — still **Draft, not tagged** (18 Aug 2026), and covers a **narrower, earlier slice** (the API-plane hardening group TASK-754…768) than the full `dev-2.2` delta this document tracks. See §Publication mechanics below for what that means for tagging. |

---

## Requirement Analysis

Produce a user-facing Platform Release Note / Changelog for HOPE `dev-2.2` compared with `dev-2.1`, grounded in git history and ticket READMEs — not speculation.

## Current State Evaluation

- Current branch (this worktree): `worktree-agent-a4993555f392218a4`, based on `dev-2.2` at `e20fe4957` — 273 commits ahead of the 2026-08-25 draft's `45cc4ddbc` baseline (690 vs 417 commits since `origin/dev-2.1`).
- Comparison base: `origin/dev-2.1` (`81195848d`) — **unchanged** since the 08-25 draft; the diff base is still valid, only `HEAD` moved.
- Existing convention: `docs/operations/release-notes/ALL-3.0.0.md` + `docs/operations/release-runbook.md` (Changesets for npm; git tag for services).
- Since the 08-25 baseline, `docs/implementation/` gained 32 new ticket folders, `TASK-803` through `TASK-834` — except **`TASK-834` does not exist** (no trace in git history under any branch; treated here as a retired/reserved number, not a gap to fill). 31 real new tickets: `TASK-803`…`TASK-833`.
- The most consequential addition is **TASK-806 "Consultation Workflow Substrate Unification"** — a program ticket (opened 2026-08-25, the same day as the prior draft) whose nine sub-tickets (`TASK-808`…`TASK-816`) are now **all Completed**, deleting `DepartmentAgent` (205 files, 21,092 deletions) and making the realtime consultation loop graph-driven end to end. None of this existed when the 08-25 draft was written.
- `hope-v2-dev` (the only live cluster environment) has received **no manifest changes since 2026-08-25** — Argo CD's repo-server has been down since 2026-08-29T16:43:29Z on top of a `hope-db-migrate` sync defect present since 2026-08-25, and (separately) `hope-api` itself has been down since 2026-08-28 because the external seal Vault is sealed and needs a human to unseal it. This blocks TASK-833, TASK-808's remaining DoD items, and effectively every infra ticket in the new tranche (803, 822, 823, 824, 832) from reaching the cluster regardless of code readiness.

## Implementation Plan

Owner reviews this draft, confirms the duplicate-`TASK-780` renumbering (§Needs confirmation) and the remaining owner-facing items, then publishes (or feeds CI `ChangelogEntry` per versioning.md — see §Publication mechanics for why that mechanism does not currently exist).

## Implementation Summary

Draft originally written 2026-08-25 from `git log` / `git diff --stat` / ticket headers, against `dev-2.2 @ 45cc4ddbc`. This refresh (2026-08-30) is a **verification + update pass, not a rewrite**: the four load-bearing breaking-change claims from the original draft (TASK-757 admin-plane API-key refusal, TASK-760 URI normalization, TASK-768 downstream-unreachable contract, TASK-737 mandatory `X-Tenant-Id`) were spot-checked against current code and still hold unchanged. This pass recomputed all statistics against current `HEAD`, folded in the 31 new ticket folders (`TASK-803`…`TASK-833`), rewrote §Known issues against current ticket statuses and the live cluster outage, and added a §Publication mechanics section recording (not deciding) the tag-grammar and CI-automation facts relevant to actually cutting this release. No code changes.

## Change History

| Date | Change |
|---|---|
| 2026-08-25 | Initial draft from `origin/dev-2.1..dev-2.2`. |
| 2026-08-30 | Refresh pass: recomputed stats against `HEAD` (`e20fe4957`, 690 commits), folded in `TASK-803`…`TASK-833` (31 new tickets; `TASK-834` does not exist), rewrote Known issues against current ticket statuses and the `hope-v2-dev` Argo CD outage, resolved the ticket-numbering confirmation, updated the duplicate-`TASK-780` renumbering suggestion (803 is now taken; recommend 835), and added a Publication mechanics section. Did not touch the four previously-verified breaking-change claims. |

---

# HOPE Platform Release — `dev-2.2` (vs `dev-2.1`)

**As of:** Sunday, 30 August 2026 (refresh; original draft dated Tuesday, 25 August 2026)
**Status:** Draft — not a git tag; services version from the tag when you cut it.
**Comparison:** `origin/dev-2.1` (`81195848d`) → `dev-2.2` (`e20fe4957`)

### Scope

`dev-2.2` is the **Agentic Workflow Platform** line plus a full **API / identity / safety / admin-console** hardening pass, now joined by a **consultation-substrate unification** program (TASK-806) that deletes the legacy `DepartmentAgent` model and finishes the graph-driven realtime loop, plus a wave of new inference/security infrastructure (MLflow, vLLM, LM Studio, MinIO internalization, in-cluster Vault). Relative to `dev-2.1` this is a major platform release, not a patch train: **690 commits** over **~15 days** (15–30 Aug 2026), **4,727 files**, **+620,361 / −84,775** lines.

A narrower integrator note already exists as `ALL-3.0.0` (18 Aug 2026, still Draft/untagged) and covers only the API-plane hardening slice (TASK-754…768) — an **earlier, narrower subset** of what shipped since. Use that for the four API-plane breakages; use **this** document for the whole 2.2 line (workflow studio, clinician loop, config plane, design system, Python services, and everything landed since 08-25).

---

## Highlights

0. **NEW since 08-25 — the consultation substrate is now fully graph-driven, and `DepartmentAgent` is gone.** TASK-806, a nine-sub-ticket program opened 2026-08-25 and **Completed 2026-08-30**, replaced `LiveDocumentationService.flush()`'s hardcoded 11-step sequence with a graph executor, gave documents typed ports/per-section OCC/concurrent per-node generation, added an admin-ordered session-end action list, wired SDK-side workflow selection and a tenant-admin-impersonates-clinician playground, and **deleted `DepartmentAgent` outright** (205 files, 21,092 deletions — zero routes remain in `apps/api/route-manifest.json`). This is the single largest change in the tranche since the last draft. *(TASK-806, 808–816)*
0a. **NEW — a wave of new inference and security infrastructure, mostly not yet live.** MLflow model registry (TASK-822, Review), a self-hosted vLLM backend (TASK-823, Pending — ships at `replicas: 0`, blocked on GPU hardware undersized for the original target), a custom headless LM Studio (`llmster`) GPU image (TASK-824, In Progress, blocked on a CI build), MinIO internalization + a `hope-models` bucket layout (TASK-832, Review — app-repo done, cluster change awaits an operator), and moving the Vault seal in-cluster (TASK-833, **Blocked** — see Known issues). None of these have reached `hope-v2-dev` yet.
1. **Workflow Studio and a durable interpreter** — Graph definitions, compiler/validator, Temporal interpreter, sandbox workbench, run observability, and public exposure of workflows. Clinicians and tenant admins can author and run consultation / summarization / STT graphs instead of a single hard-coded generator. *(TASK-715…724, 718, 719, 731, 790, 795)*
2. **The live consultation path is a workflow, not a sidecar** — Realtime short summaries, SOAP autofill, suggestions, and spelling/medical-term correction are brokered through the interpreter; substrate dispatch is exclusive (legacy signable generator removed), and as of TASK-806/811 the realtime lane itself is graph-executed rather than a fixed sequence. *(TASK-732, 791, 793, 795–798, 806, 811)*
3. **Administration is JWT- or service-account only** — Tenant API keys can no longer call `/api/v1/admin/*`. A new **service account** credential (`svc:*`) is the machine path. *(TASK-757, 762, 767)*
4. **Business-plane URIs are capability-shaped** — Retired paths answer **308** for one release. Downstream transport failure is **503** / **502**, not 400 with internal hosts. *(TASK-759, 760, 768)*
5. **Naming: `smr` → `text`, `GLOBAL_ADMIN` → `SUPER_ADMIN`** — App `apps/smr` is `apps/text`; Changelog audience enum renamed. Integrators and seeds must use the new identifiers. *(TASK-707, 740)*
6. **Configuration moved into the database** — Python services dropped most env knobs onto the control plane (provider connections, task defaults, harness/STT/TTS/NLP/guardrail tunables). Super-admin vs tenant BYO is explicit. *(TASK-799, 735, 785, 786)*
7. **PHI and session safety** — DNA-style PHI containment, working PHI redactor before NLP, fail-closed cloud egress, live STT session ownership (same-tenant hijack closed), TTS WebSocket Origin check. *(TASK-700, 706, 710, 754, 755)*
8. **Admin console is a real product surface** — Tatva/Sarvam geometry and tokens, domain-rail navigation, memory/assignment screens, developer API docs portal, clinician playground wired to the SDK. *(TASK-719, 728, 733, 765, 769, 774, 775, 783, 787, 788, 793, 797)*
9. **Day-one bootstrap works** — Seeded roles/catalog, env-driven first super-admin / tenant-admin, `pnpm setup:dev` completeness, standalone feature credentials. *(TASK-763, 766, 770)*
10. **Safety engines scaled** — Guardrail is a policy/delegation plane (judgement on `text`/`nlp`); NLP hosts a three-model safety plane with throughput work toward 100 concurrent sessions. *(TASK-735, 777, 778, 782)*
11. **NEW — `apps/text` is becoming a high-throughput LLM router, but is not there yet.** Owner decisions (D-1..D-8) fixed the scope — router + embeddings + translate, two permanent contracts (OpenAI-standard and HOPE), vLLM→LM Studio→cloud provider priority, super-admin-governed routing policy with tenant override and three hard gates (residency, BAA coverage, funding tier) where crossing a gate is a rejection, never a silent fallback. Of the nine implementation lanes, only connection-reuse fixes and the routing-**policy admin plane** (Lane I′ — `apps/api/src/modules/ai-routing-policy/**`) have merged; the router-side enforcement (Lane I″), the OpenAI-standard contract (Lane C), and the disposition of `/judge` and generation-audit (Lane D) are unbuilt. See Known issues. *(TASK-818)*

---

## Breaking changes / migration notes

Treat these as **loud**. Several match `ALL-3.0.0`. Items 1–12 carry forward from the 2026-08-25
draft, re-verified against current code where load-bearing (1, 2, 3, 6 were spot-checked this pass
and still hold unchanged); 13–14 are new since that draft. Four candidates from the new tranche —
TASK-818 (LLM router), TASK-823/824 (vLLM/LM Studio serving tiers), TASK-832 (MinIO
internalization) and TASK-833 (in-cluster Vault) — were evaluated and are **NOT** listed here:
none has shipped enabled or reached `hope-v2-dev` yet (§Highlights 0a, §Known issues), so none is
breaking today. They will need this section revisited once deployed.

### 1. Admin plane no longer accepts API keys *(TASK-757)*

`/api/v1/admin/*` is **JWT only**. Keys that previously carried `admin:*` (including `'*'`) now get **403**. `admin:*` and `webhook:*` scopes are reserved: they cannot be granted on mint and do not appear in the scopes catalog.

**Do:** drive admin automation with a **service account** (SUPER_ADMIN-issued, `svc:*`) or a human session JWT. The admin console (BFF session JWT) is unchanged.

### 2. Business-plane URI normalization *(TASK-760)*

Retired paths return **308** + `Location` for one release, then **404**.

| Retired | New |
|---|---|
| `user/me/{preferences,settings,departments}` | `users/me/{…}` |
| `tenant`, `tenant/me/config` | `tenants/me`, `tenants/me/config` |
| `billing/me/{invoices,spend}` | `tenants/me/{invoices,spend}` |
| `usage/me/{summary,burndown}` | `tenants/me/usage-{summary,burndown}` |
| `entitlements/me` | `tenants/me/entitlements` |
| `voice-profile` | `voice-profiles` |
| `rbac/check{,/bulk,/my-permissions}` | `users/me/permission-checks`, `users/:id/permission-checks` |
| `ai/guardrail/analyze` | `safety-checks` |
| `ai/nlp/*` | `text-analyses/*` |
| `text/*` | `text-generations/*` |

`/users/me/**` is USER-scoped; `/tenants/me/**` is TENANT-scoped. Frozen v1 compat (`api/smr/api/v1/*`, `api/stt/*`, `ws /stt`) is **intentionally** still named `smr` in places — **needs confirmation** whether that remains until a dedicated deprecation ticket.

### 3. Downstream-unreachable error contract *(TASK-768)*

| Cause | Was | Now |
|---|---|---|
| Transport (`ECONNREFUSED`, timeout, DNS, reset) | 400 / opaque 500 | **503** + `Retry-After` |
| Upstream 5xx | 400 / opaque 500 | **502** (no `Retry-After`) |

Client bodies no longer contain host, port, IP, or internal service names. Correlation id remains.

### 4. Database migration squash *(chore `database`!, 2026-08-17)*

**102 Prisma migrations collapsed into a single baseline.** Existing environments **cannot** apply the old chain on a fresh clone. Operators bringing a `dev-2.1` database forward must follow the squash procedure recorded in the ticket/docs (baseline + restore of squash-dropped DDL that was later fixed). **Needs confirmation:** publish the exact operator steps next to this note before any production cut.

### 5. Identifier and role rename *(TASK-707, 740)*

- Service/app **SMR → Text** (`apps/smr` → `apps/text`, proxy modules, admin labels, Vault identity cluster).
- Elevated role **`GLOBAL_ADMIN` → `SUPER_ADMIN`**. Extra seed user `global_admin` removed.
- Prisma enum `ChangelogAudience.GLOBAL_ADMIN` → `SUPER_ADMIN`.
- Deployment overlay for `hope-v2/text` was added; a **separate deployment repo** still has leftover `smr` identity work (TASK-740 §6.4).

### 6. Mandatory `X-Tenant-Id` on internal calls *(TASK-737)*

Internal service-to-service work that is tenant-scoped **must** send `X-Tenant-Id`. Callees no longer invent a default tenant. `apps/text /generate` enforces **428** when the header is missing (enabled, owner decision D-A). A few emitters remain out of the first pass (see known issues).

### 7. API-key minting privilege ceiling *(TASK-756)*

A tenant admin can no longer mint scopes they do not themselves hold (`admin:*`, `'*'`).

### 8. Ollama model catalog purged *(TASK-736)*

**Provider logic stays.** The **Ollama model catalog** was removed; platform standard model is `gemma-4-e2b-it-qat`. Check every developer `.env` and tenant catalog. Owner reversed an earlier “delete Ollama entirely” directive — do not treat old TASK-736 drafts as current.

### 9. Legacy signable generator deleted *(TASK-732, 714)*

`summary.processor.ts` / `ner.processor.ts` and the TASK-714 safety floor are **gone**. Pre-summary / comprehensive-summary / sync-summary compat surfaces were **kept**. Workflow substrate is the signable path.

### 10. Environment / config plane *(TASK-799)*

Hundreds of Python service env vars moved to DB-backed settings, `AiProviderConnection`, `AiTaskDefault`, and runtime profiles. Example measured on `apps/text`: **121 → 9** sample vars. A process that still expects `TEXT_<PROVIDER>_API_KEY` / `HARNESS_*` judge env will fail closed or ignore them.

**Do:** configure providers and task defaults in admin; set `BOOTSTRAP_SUPER_ADMIN_*` / `BOOTSTRAP_TENANT_ADMIN_*` on first boot of a new environment; rotate seeded service-account secrets outside dev.

**Deployment follow-up (open):** remove `TTS_KOKORO_ENABLED` from the `hope-tts` ConfigMap in `arca/hope-v2-deployment`; seeding must actually run (`RUN_SEED`) or the DB row will not exist.

### 11. Tooling

| Item | `dev-2.1` | `dev-2.2` |
|---|---|---|
| Node | `>=22` | `>=22` (unchanged) |
| pnpm | **10.31.0** | **10.34.5** |
| TypeScript / Nest / Python | not re-audited line-by-line in this draft | assume same major families unless a dedicated bump ticket says otherwise |

### 12. SDK versioning

Changesets is now initialized (`.changeset/config.json`; two changesets currently pending, unconsumed). SDK family was already at **3.0.0** (`packages/agentic-sdk-v2/package.json`, `packages/vox-node/package.json`, `packages/room/package.json` all read `"version": "3.0.0"`) — hand-versioned with ALL-3.0.0. `@arcaai/vox-node` has a **patch** changeset for admin-plane access (owner: keep family lockstep). Do not run a second accidental major.

### 13. NEW — `DepartmentAgent` deleted outright *(TASK-815, master ticket TASK-806)*

The `DepartmentAgent` Prisma model, its domain trio, the `services/departmentAgent/**` service, the admin API module, the `/agents` console screen, and the generated `vox-node` resource are **all gone** — 205 files, 21,092 deletions, merged to `dev-2.2` 2026-08-29. `apps/api/route-manifest.json` carries **zero** `department-agent`/`departmentAgent` entries. The realtime and durable generation loops resolve model/prompt/policy selection through **workflow node bindings** now, not `DepartmentAgent` rows — this is what TASK-806/809/811 built.

**Who is affected:** any integration reading or writing `DepartmentAgent` via the admin API, or any console bookmark to `/agents`. Two surviving features that transitively depended on `DepartmentAgent` were migrated rather than broken: the eval-promotion gate's golden-set discovery now binds to the node config directly (owner decision OD-11), and `AgentPromotion` was rewritten (OD-10). e2e specs built on `DepartmentAgent` fixtures were rewritten, not deleted, so agent-shaped lineage/promotion behavior is still covered.

**Do:** stop calling the retired `DepartmentAgent` admin routes; migrate any tenant-authored agent configuration to the workflow node/graph model before upgrading.

### 14. NEW — Legacy config-plane admin surfaces retired *(TASK-816, master ticket TASK-806)*

`AiTaskDefault` semantics moved onto per-node `llmBinding`; `HarnessPolicy`/`PipelinePolicy` semantics moved onto node config + policy bindings. The `/agentic-policy`, `/ai-task-defaults`, and `/agents` **authoring** surfaces in the admin console are retired behind one-release `redirect()` pages, per the standing `13-nextjs-apps.md` policy. All four phases completed 2026-08-30; the Phase 4 migration that drops the old tables is **authored and drift-proven but not yet applied to any shared database** — see Known issues.

**Do:** repoint any bookmarked links to the retired authoring routes before the redirect pages are removed after this release.

---

## New features

### Agentic workflow platform

- Workflow **definition model**, versioning, publish/validate APIs (TASK-715, 780 contract fixes).
- **Compiler / validator** + TypeScript `@arcaai/workflow-contract` + Python `py-workflow-contract`; invariant rule catalogue (TASK-716, 734).
- **Async contract** shared TS/Python; `apps/text` as reference implementation (TASK-717).
- **Interpreter** on harness/Temporal (TASK-718); substrate exclusivity so dispatch is not dual-pathed (TASK-795).
- **Workflow Studio v1** in admin console: node graph editor, undo/redo, palette filter, a11y pass (TASK-719).
- Palettes: **summarization**, **STT**, **consultation** (13 consultation node types, HITL gate, `WF-CONS-*` rules) (TASK-720, 724, 731).
- **Workbench / sandbox** fixtures (Vault-encrypted inputs) (TASK-721).
- **Exposure v1** — scoped public invocation of a published workflow (TASK-722).
- **Run observability** read model (TASK-723).
- **Webhook channel** for outbound delivery (TASK-727).
- Gateway completion: `WorkflowRun.resultRef`, invariant-rule surface, STT pipeline resolver production caller (TASK-790).
- Demo seed: ArcaAI tenant-authored **consultation workflow** (TASK-798).

### NEW — Consultation workflow substrate unification (TASK-806 program: 808–816)

- **Typed node contract**: ports, `trigger`/`lane`/`requires[]`, type-checked edges, interpreter whole-object fallback removed; Python mirror + parity fixture; config schemas for the 13 `consultation.*` nodes that previously lacked one (TASK-809).
- **Document-template shape catalog**: `DocumentTemplate` (head) + `DocumentTemplateVersion` (immutable), a compiler from shape to strict JSON schema + frozen checklist + section state machine, prompt binding, authoring UI (TASK-810).
- **Graph-driven realtime executor** replacing the hardcoded 11-step flush sequence; per-section `DocumentSection` child table with provenance; concurrent per-node generation with per-node budget/timeout/staleness; multi-document rendering (TASK-811).
- **Admin-ordered session-end action list** replacing the hardcoded `endingActionsBase` literal; new `session.timeout`, `summary.finalize`, `feedback.capture` node types and activities (TASK-812).
- **SDK-side workflow selection and discovery** at session-open, authorized against the assignment cascade; `useConsultationWorkflow()` in `@arcaai/vox` (TASK-813).
- **Tenant-admin-impersonates-clinician playground surface**, add-details-during-consultation affordance, patient lookup replacing free-text patient-ID entry (TASK-814).
- **`DepartmentAgent` deleted** and legacy `AiTaskDefault`/`HarnessPolicy`/`PipelinePolicy` admin authoring surfaces retired onto node config (TASK-815, 816 — see Breaking changes §13–14).
- **Registered-but-unseeded realtime nodes seeded**: `agent.grammar` and the findings nodes now actually run for a tenant, not just registered in code (TASK-821).

### Clinician / consultation loop

- Session **state machine** (TASK-711); note **OCC** (TASK-709); empty-note degradation marker (TASK-703).
- Loop as a **subscription/entitlement** feature (TASK-705) — **needs confirmation** of exact commercial packaging.
- Realtime **summaries, suggestions, corrections** via text/broker (TASK-796).
- Console: editable SOAP, department/DNA context on the SDK path, loop-plane activity (TASK-793, 797).
- `vox-node` **add context** + schema discovery (TASK-800).
- Feedback / training loop: live gate writer/reader, GoldenCase producer, JSONL fine-tune export, quality-signal thresholds (TASK-792).

### Identity, credentials, API planes

- Service accounts for administration and standalone STT/summarization (`svc:stt:*`, `svc:consultation:report:write`) (TASK-762, 767).
- Business-plane **auth model** and **taxonomy** corrections (TASK-758, 759).
- API plane **conformance gates** (TASK-761).
- **Developer API documentation portal** (TASK-783).
- **Tiered rate-limit governance** (tenant × route → tenant → plan → platform) (TASK-785).
- Super-admin **password + issued-secret policy** (TASK-786).
- `@arcaai/vox-node` **admin plane** (`hope.admin.*`, ~52 areas) + service-account credential class (TASK-773). Live STT WebSocket remains **not** machine-drivable (session owner is a clinician).
- NEW — **Consent governance plane**: realtime consultation start was returning `403 DOMAIN.CONSENT_DENIED` on a fresh environment with no way to grant consent; a console + tenant-wide consent list closes the gap (TASK-805, Completed).
- NEW — **Super-admin-governed routing-policy admin plane** for `apps/text` (`apps/api/src/modules/ai-routing-policy/**`): tenant→SYSTEM resolution, three hard gates (residency, BAA, funding tier), audit trail. Not yet enforced by the router itself — see TASK-818 in Highlights and Known issues.

### NEW — Inference & model infrastructure (mostly not yet deployed)

- **MLflow model registry**, self-hosted, reusing existing Postgres/MinIO/Vault/Argo CD infra; day-1 scale ~200 users. Greenfield — Phase 1 built and verified, Phase 2 manifests authored awaiting an orchestrator commit, Phases 3–4 not started (TASK-822, Review).
- **vLLM inference service**, priority-1 router backend. Manifests are gate-clean but ship at `replicas: 0` — the cluster's actual GPUs (2× RTX 2000 Ada, 16 GiB) fall short of the original H100-class sizing by ~3× on VRAM and ~15× on bandwidth; enabling needs an owner decision on hardware (TASK-823, Pending).
- **LM Studio as a containerized headless service** (`llmster`, priority-2 backend), a custom GPU image built from LM Studio's server-native core rather than a GUI-desktop container. Engine choice decided by the owner 2026-08-30 (LM Studio + vLLM, not llama.cpp); Phase 2 built and staged, blocked on five `ROOT_CONFIG_REQUESTS` and a CI build (TASK-824, In Progress).
- **Model catalogue alignment**: reconciled the owner's five named GGUF models against the router's written vLLM-first priority (a collision, since GGUF does not run on vLLM); research + seed proposal only, nothing applied yet (TASK-831, Review).

### Admin console & UI kit

- **Sarvam Tatva** token foundation, shadcn geometry contract, elevation flatten (TASK-787).
- **Domain rail** + scoped sidebar (TASK-788).
- Memory management screens (TASK-728); assignment matrix (TASK-733 Task 6).
- Page-frame / table / design-system / system-surface conformance (TASK-765, 769, 774, 775).
- New packages: `workflow-contract`, `async-contract`, `vox-node-codegen`.

### AI services

- Guardrail **policy plane**, tenant-first config, injection defense, throughput (TASK-777).
- NLP **task expansion**, three-model **safety plane**, inline-gate latency work (TASK-729, 778, 782).
- Worker pools for **text** and **STT/TTS** (TASK-725, 726).
- Harness **ICC eval gate** made real at measured baseline 0.73 (TASK-713); peer service auth (TASK-738).
- Harness capabilities as proposal-first nodes (suggestions, corrections, realtime summary) (TASK-791 W1–W4).
- NEW — **Realtime consultation guardrail decision plane**: a partial transcript is validated once before any downstream task (partial summarization, NER, grammar/spelling) consumes it; two verdict axes, fail-closed gates AI derivations only, never the clinical record. Phase 1 (decision plane) merged; wiring into the realtime nodes outstanding (TASK-829, In Progress).
- NEW — **Per-label confidences on NLP's guard-classify route**, needed so the guardrail plane's session aggregate can be a graded mean instead of a flag rate. Currently blocked: Phase 4 of TASK-829 cannot complete without this, and this ticket's own Phase 4 is not yet resolved (TASK-830, Review).
- NEW — **`hope-nlp` persistent model cache**, matching the `models-cache`/`init-hf-cache` pattern `hope-stt`/`hope-tts` already use, plus cleanup of stale `HF_HOME` references in `apps/guardrail`/`apps/stt` Dockerfiles (TASK-817, Pending).

### Data / domain / application

- Day-one seed data + completeness (generic care settings replacing BCMCH-derived catalog; `Role.tenantId` so tenant admins own custom roles) (TASK-763, 766).
- Consent & ABAC plumbing (shadow on real routes; **enforce list empty by owner decision**) (TASK-712, 781).
- Generator **entry-point seam** (TASK-704).
- NEW — **Deployment manifests aligned to the consolidated config plane**: TASK-799 moved Python service config out of env into Vault/DB/`GlobalSetting`, but the deployment repo had not been updated to match — brought in line and redeployed/reseeded (TASK-803, Review).
- NEW — **Vault session self-healing**: the admin console could not log in (`401 Authentication system not configured`) because a healthy pod could not read `JWT_SECRET_KEY` from a healthy Vault; AppRole re-authentication added so the session self-heals (TASK-807, Completed — merged, built, promoted, and verified running in `hope-v2-dev` before the current outage, see Known issues).

---

## Improvements

- CI: performance/reliability, gitleaks placeholder allowlist, generated-code drift reconciliation, typecheck/build ordered after package `db:generate`, Python env-drift gate (chore commits + TASK-799).
- `pnpm setup:dev` leaves a working stack (TASK-770).
- Admin rate-limit writes 404 fixed (TASK-771).
- Coherence review of the agentic loop with adversarial verification (TASK-789).
- E2E coverage for policy, workflow lifecycle, core business (TASK-776, 779, 772, 764, 794, 801).
- Design-system and console e2e triage (TASK-794).

---

## Bug fixes

Security-relevant first:

- **Same-tenant live STT session hijack** — stream binding is owner-scoped (TASK-754).
- **TTS `/ws/tts/stream` CSWSH** — Origin check fail-closed (TASK-755).
- **API-key minting privilege ceiling** (TASK-756).
- **SIGNED status forgery** via unvalidated metadata (TASK-701).
- **ICD-10 free-text prompt containment** (TASK-702).
- **PHI in DNA writing-style** (TASK-700); PHI redactor re-wired after generator deletion (TASK-710).
- **Egress fail-close** for cloud providers (TASK-706).
- **API-key scope verification** before exposure (TASK-708).
- Workflow validate/publish HTTP contract defects from e2e (TASK-780 Api-Contract-Corrections).
- CASL instance-enforcement pairs were structurally unreachable — removed rather than left as a false sense of enforcement (TASK-781).
- S3 settings cache miss causing storage PATCH 500s; consultation validator falling back to summarization-only rules so `WF-CONS-*` never fired (TASK-801).
- Dev deploy: image packaging + wedged migrate job (TASK-784).
- Various pre-existing e2e failures triaged as product vs test (TASK-764, 772, 801).
- NEW — **`DocumentSection` encryption-failure data loss**: a failed Vault Transit write during a section edit logged a warning and continued, persisting the CONFIRMED state and a bumped revision while the old ciphertext stayed — the clinician saw `200 OK` and their text was gone. Fixed for both the machine flush writer and the clinician edit route (TASK-819, Completed).
- NEW — **Empty section/context-item edit silently loses the deletion**: `encryptStringToCiphertext('')` returns `null`, so an emptied field's encryptor call no-ops and the *old* ciphertext survives while `state`/`revision`/`_version` all advance — no Vault outage involved, this reproduces against a fully working encryptor. Fixed for `DocumentSection` (TASK-820) and, as a distinct instance in the same code shape, for `ContextItem` (TASK-825), both Completed.
- NEW — **Hardcoded prompts on two realtime nodes**: `agent.correction`'s and `consultation.suggestions`' system prompts were Python literals in `consultation_realtime.py`, violating the no-hardcoded-config rule and leaving tenants unable to see, change, or version-pin them — both now resolve a governed `PromptTemplate` through the node's `promptTemplateId` binding, matching `agent.grammar`'s pattern (TASK-826, TASK-827, both Completed).
- NEW — **STT gateway 502 + release-registry 500s**: live transcription's `stream/session` endpoint failed for every attempt, and every service's `POST /api/v1/internal/service-releases` call failed every 5 minutes on a missing tenant context — two independent defects found while tracing one symptom, both fixed (TASK-804, Completed; the gateway half awaits a build/promote per its own status line).

---

## Infrastructure / DevOps / CI

- Migration **squash to one baseline** (breaking for migrate-from-history).
- GitLab CI updates; harness eval gate comment/threshold aligned to measured ICC.
- `promote-dev` overlay now includes **`hope-v2/text`**.
- Temporal hosting decision: self-hosted k3s (TASK-730) — **patch authored in deployment repo, not merged/applied to cluster**.
- Worker pool productionization for STT/TTS/text.
- Changesets config added; do not use `scripts/publish-sdk.sh` for a normal SDK release.
- NEW — **Deployment config-plane alignment** (TASK-803, Review) and **Vault session self-healing** (TASK-807, Completed) — see New features.
- NEW — **MLflow, vLLM, LM Studio, MinIO internalization, in-cluster Vault** — see the "Inference & model infrastructure" subsection above and Known issues; none has reached `hope-v2-dev` yet (TASK-822, 823, 824, 832, 833).
- ⚠️ NEW — **`hope-v2-dev` has been effectively undeliverable since 2026-08-25** — Argo CD's repo-server has been down since 2026-08-29T16:43:29Z (`ComparisonError`, connection refused) stacked on a `hope-db-migrate` sync failure (immutable field) present since 2026-08-25, and separately `hope-api` has been down since 2026-08-28 because the external seal Vault at `10.10.1.134` is sealed and needs a human operator to unseal it. See Known issues — this blocks essentially every infrastructure ticket in this tranche from actually landing.

---

## Security / compliance

| Item | Ticket |
|---|---|
| Admin plane JWT-only | 757 |
| Service accounts + deny-by-default | 762 |
| Privilege ceiling on API-key mint | 756 |
| STT session ownership | 754 |
| TTS Origin / CSWSH | 755 |
| PHI redaction + DNA containment + egress allowlist | 700, 706, 710 |
| Consent assert choke point (workers/tools) | 712 |
| Signed-status forgery | 701 |
| ICD-10 prompt containment | 702 |
| Error bodies stripped of internal topology | 768 |
| Credential policy (password + CSPRNG secrets) | 786 |
| Injection defense on guardrail policy plane | 777 |
| Mandatory tenant header on internal hops | 737 |
| NEW — Consent-denial gap closed (console + tenant-wide list) | 805 |
| NEW — Realtime consultation guardrail decision plane (partial-transcript validation) | 829 (Phase 1 only — wiring outstanding) |
| NEW — DocumentSection/ContextItem encryption-failure and empty-edit data loss fixed | 819, 820, 825 |

**CASL instance enforcement is not on.** Owner closed the rollout: `CASL_ENFORCED_PAIRS` stays empty (TASK-712 / 781). Shadow metrics exist; do not claim row-level ABAC is enforced in production.

**NEW — unremediated findings from a live security review (TASK-828, Pending — findings recorded, remediation not started).** A 2026-08-30 read-only review of the live Cloudflare/Rancher/Argo/GitLab estate, prompted by TASK-822's MLflow exposure question, found several items **more urgent than MLflow itself**:

- Argo CD was internet-reachable with no SSO and only the built-in `admin` account guarding a full write path to the cluster — **closed** 2026-08-30 (owner is configuring Entra SSO directly).
- **All PHI object traffic (consultation recordings, generated documents, claim-check payloads) currently leaves the cluster** to a LAN MinIO host via a public Cloudflare Tunnel hostname (`s3.taphuynh.dev`) — ~248× the LAN latency and an unnecessary internet hop for PHI (TASK-828 §4b; the fix is authored in TASK-832, not yet applied — see Known issues).
- `hope-stt` sends PHI **consultation audio over plaintext HTTP** to that same public hostname (`MINIO_SECURE=false` composes `http://`, and the zone's `always_use_https` is off) — the one client that does not speak HTTPS to the tunnel (TASK-828 §4c).
- **⚠️ Live credentials are committed to the repository, and the leak-detection gate was configured not to see them.** 38 real findings across three tracked files under `docs/research/configs/` — a GitLab config with MinIO keys **and an Azure AD client secret** (shared with GitLab/Rancher SSO), a GitLab runner config with 4 runner tokens and 10 S3 credential lines, and a Langfuse compose file with a database password. Two independent gaps let this through: an unbounded path allowlist meant for "rotated/example values" documentation was excluding live config, and the S3-credential regex could not match GitLab's Ruby hash-rocket syntax. Both gaps are now closed and a new file in that tree is verified caught, but **the credentials themselves are still live and unrotated** — the Azure AD client secret is the most urgent, since it is shared across GitLab, Rancher and SSO (TASK-828 §7).

**Do not treat any of the above as remediated.** The gate fix stops new leaks; it does not rotate the ones already committed.

---

## Known issues / incomplete work

Ticket statuses below are from README headers as of **2026-08-30** (this refresh) — re-verified
against every ticket in the table, not carried forward from the 08-25 draft unread. Several say
**Review** while code is merged; treat Review as "owner has not formally closed."

### ⚠️ The live cluster (`hope-v2-dev`) has been effectively undeliverable since 2026-08-25

This is new since the 08-25 draft and is the most consequential known issue in this release —
it blocks essentially every infrastructure item below regardless of code readiness. Two
independent, stacked causes, both verified against the live Argo CD Application on 2026-08-30
(TASK-833 §4.2):

1. **A `hope-db-migrate` sync failure present since 2026-08-25** — `Job.batch "hope-db-migrate"
   is invalid: [spec.selector: Required value, … field is immutable]`. Every sync attempt from
   that point has failed.
2. **Argo CD's repo-server has been down since 2026-08-29T16:43:29Z** — `ComparisonError:
   Failed to load target state … dial tcp 10.43.14.10:8081: connect: connection refused`. Argo
   cannot render desired state for `hope-v2-dev` at all now, on top of (1).

Separately (and not fixable by any deploy), **`hope-api` itself has been down since
2026-08-28**: the external seal Vault at `10.10.1.134:8200` is sealed, so `hope-vault-0` cannot
transit-auto-unseal (`CrashLoopBackOff`, restart count 507+), the `hope-vault` Service has no
ready endpoint, and `hope-api` correctly fail-closes rather than start without a secrets backend
(TASK-808 §9). Unsealing needs an operator with unseal keys for a VM outside the cluster —
nothing in the repo, pipeline, or Argo can resolve it.

| Topic | Status | Notes |
|---|---|---|
| TASK-833 In-cluster Vault | **Blocked** | Manifests done and proven (`28aa2a8` already pushed to `hope-v2-deployment@main`, plus `9425643`+`ccb35a4` unpushed); **blocked on the Argo outage above**, then on operator steps after that. |
| TASK-808 Unblock TEXT generation | Review | Six callers fixed and verified from a checkout; the three DoD items requiring a live deploy (`textFailed:false`+non-zero `summaryChars`, NLP `/classify/tokens` 200, `hope-api` readiness stable) **cannot pass while dev is down** — see the outage above. |
| TASK-822 MLflow deployment | Review | Phase 1 built and verified; Phase 2 manifests authored, awaiting an orchestrator commit to `hope-v2-deployment`; Phases 3–4 not started. |
| TASK-823 vLLM inference service | **Pending** | Manifests gate-clean but ship at `replicas: 0` — cluster GPUs (2× RTX 2000 Ada, 16 GiB) undersized ~3× on VRAM / ~15× on bandwidth vs. the original H100-class target. Enabling needs an owner hardware decision. |
| TASK-824 LM Studio service | **In Progress** | Engine decided (LM Studio + vLLM); Phase 2 built and staged; blocked on five `ROOT_CONFIG_REQUESTS` (R-1..R-5) and a CI build. |
| TASK-832 MinIO internalization | Review | App-repo changes implemented and verified; deployment-repo changes authored as a handover; cluster changes require an operator (and are additionally blocked by the Argo outage above). |
| TASK-828 Edge/cluster security findings | **Pending** | Findings recorded, remediation not started. Most urgent: **live credentials committed** (Azure AD client secret + MinIO keys + GitLab runner tokens + a DB password) need rotation, and **all PHI object traffic, including `hope-stt`'s consultation audio over plaintext HTTP, currently leaves the cluster** via a public tunnel hostname. See Security/compliance above. |
| TASK-818 `apps/text` LLM router | Pending | **Substantially incomplete.** Only the routing-policy admin CRUD plane (Lane I′) and a streaming connection-reuse fix have merged. The router-side policy enforcement (Lane I″), the OpenAI-standard contract (Lane C, `src/text/api/v1_compat/**` does not exist), and the disposition of `/judge`/generation-audit (Lane D) are all unbuilt — `judge.py` and `generation_audit.py` are unchanged since before this ticket. |
| TASK-829 Realtime consultation guardrail | In Progress | Phase 1 (decision plane) merged; wiring into the realtime nodes outstanding. |
| TASK-830 NLP guard-classify confidences | Review | Needed before TASK-829 Phase 4 (graded-mean session aggregate) can complete; this ticket's own resolution is also open. |
| TASK-831 Model catalogue alignment | Review | Research + seed proposal only; nothing applied. |
| TASK-817 NLP persistent model cache | Pending | Not started. |
| TASK-780 Harness Eval ICC restore | **Pending** | Restore ICC bar 0.73 → 0.80. **Number collision still unresolved** — see Needs confirmation (recommend renumbering to `TASK-835`, not `803`, which is now taken). |
| TASK-730 Harness Temporal on cluster | **Blocked** | Unchanged since 08-25: kustomize patch on `task-730-harness-temporal` in the deployment repo authored and validated, but **not pushed/merged/applied to any cluster**. |
| TASK-733 Department assignment personalization | **In Progress** | Backend + Studio matrix done (design gate waived); **Phase B remains HARD-GATED**. |
| TASK-735 Guardrail delegation | **In Progress** | Phases 0, 1, 2a, 2b, 3, 4-TS, 6 landed; Phase 5 landed for the LLM plane; **Phase 4's Python half remains, blocked on G-01**. |
| TASK-712 Consent/ABAC | Partial | Owner decision 2026-08-20 **closed** (not paused) the instance-enforcement rollout: `CASL_ENFORCED_PAIRS` stays empty by design, not by omission — do not re-open without a new owner call. |
| TASK-791 Harness capability completion | Review | W1–W4 complete; W5/W6/W7 blocked or deferred. |
| TASK-716 Workflow compiler/validator | Review | **Improved since 08-25** — the Python mirror, `WorkflowValidatorService`, and the Prisma rule model (previously unbuilt) are now all built and tested. Remaining: rule-set CRUD controller, re-validation sweep, seed, e2e. |
| TASK-731 Palette: consultation | **Completed** (was tracked as "Phase F Open") | Phases A–E now all Completed (19 `WF-CONS-*` rules, HITL gate, gate-approval wiring); only Phase F (seeded platform-default consultation definition + e2e) remains open. |
| TASK-721 Workbench/sandbox | Review | Phases A–C built and green; Task 1 (design gate) remains human-gated and untouched. |
| TASK-740 SMR identifier elimination | Review | **Improved since 08-25** — the previously-deferred service-identity cluster work is now DONE (owner decision D-740-1); only the separate deployment-repo leftover remains. |
| TASK-762 Machine identity for administration | Review | **Improved since 08-25** — deviation D2 (Vault write) resolved 2026-08-20 (accept show-once + rotate); D1 (unscoped registration) and D3 (deferred boot audit) still need an owner call. |
| TASK-799 Python config-plane consolidation | Review | **Improved since 08-25** — two of three open items resolved; the one remaining is unchanged: remove `TTS_KOKORO_ENABLED` from the `hope-tts` ConfigMap once TASK-803's manifest work reaches the cluster, and note re-seeding is required for the DB row to exist (`RUN_SEED` is pinned to `none` in `hope-v2-dev`). |
| TASK-803 Deployment config-plane alignment | Review | Manifests aligned and applied 2026-08-25 (before the current outage began); deliberately left `TTS_KOKORO_ENABLED` in place pending TASK-799's owner decision above. |
| TASK-804 STT gateway + release-registry fix | Completed (code) | Code fix verified; the gateway half **awaits a build/promote** to actually reach `hope-v2-dev`. |
| Live STT WebSocket | By design | Service accounts cannot drive the live stream (4401). |
| Compat `smr` paths | Frozen | v1 compat still uses historical names. |
| Many e2e specs | Authored, not always executed | Prisma `db push --force-reset` blocked for AI agents in this environment. |
| TASK-742 | — | Still mentioned only in one commit subject (`30aebeeb7`); **no ticket folder exists**. Needs confirmation. |

**Not a known issue — stated to avoid confusion:** TASK-806 ("Consultation Workflow Substrate
Unification") and all nine of its sub-tickets (TASK-808…816, except TASK-808 itself per the row
above) are **Completed**. It was opened 2026-08-25, the same day as the prior draft, so it does
not appear in that draft at all — it is entirely new to this refresh and is now closed, not open.

---

## Stats

Recomputed 2026-08-30 against current `HEAD` (`e20fe4957`) with the exact commands below —
these numbers **supersede** the 08-25 draft's figures, which are now stale (417 commits /
4,221 files / +519k−65k lines / TASK-700…801).

| Metric | Value | Command |
|---|---|---|
| Commits | **690** | `git rev-list --count origin/dev-2.1..HEAD` |
| Date range | **2026-08-15** → **2026-08-30** | `git log --format=%ci origin/dev-2.1..HEAD \| sort \| sed -n '1p;$p'` |
| Files changed | **4,727** | `git diff --shortstat origin/dev-2.1...HEAD` |
| Line delta | **+620,361 / −84,775** | `git diff --shortstat origin/dev-2.1...HEAD` |
| Conventional `feat` / `fix` / `docs` / `merge` | 177 / 144 / 149 / 96 | `git log --format=%s origin/dev-2.1..HEAD \| grep -cE '^<type>(\(\|!\|:)'` per type (remaining ~124 commits are `refactor`/`chore`/`test`/`style`/other, not individually broken out) |
| Tickets named in commit subjects | TASK-700 … TASK-833 (sparse 741–753; **TASK-834 does not exist**) | `git log --format=%s origin/dev-2.1..HEAD \| grep -oE 'TASK-[0-9]+' \| sort -u` |
| Merge style | Heavy worktree merges into `dev-2.2` (not GitHub PRs) | — |

### Top areas by change volume

Grouped by first two path segments (`git diff --name-only origin/dev-2.1...HEAD`, counted per
segment pair):

| Area | Files | Role |
|---|---:|---|
| `packages/applications` | 963 | Services, config plane, authz, routing policy |
| `apps/admin-console` | 706 | Studio, Tatva, clinician/playground surfaces |
| `apps/api` | 565 | Gateway, planes, workflow APIs, ai-routing-policy |
| `packages/database` | 258 | Schema, seeds, squash, new models (RoutingPolicy, DocumentTemplate, DocumentSection, …) |
| `packages/ui` | 214 | Tatva / shadcn |
| `docs` (all subpaths) | 340 | `implementation` 212, `research` 32, `operations` 25, `architecture` 24, `archive` 17, `traceability` 13, `programs` 13 |
| `apps/text` | 211 | Router work, config-plane consolidation |
| `packages/domains` | 206 | Entity/factory/mapper/repository trios for the new models |
| `apps/harness` | 197 | Interpreter, eval, realtime capabilities |
| `packages/workflow-contract` | 148 | Contract package (node ports, typed edges) |
| `packages/agentic-sdk-v2` | 133 | Workflow selection, playground, context |
| `apps/guardrail` | 98 | Delegation plane, injection defense |
| `packages/vox-node` | 85 | Admin plane + context + generated resources |
| `apps/nlp` | 84 | Safety plane, guard-classify |
| `apps/stt` | 77 | Streaming, model cache |
| `apps/compat-playground` | 47 | (excluded from the normal test gate — see `01-development-workflow.md`) |
| `apps/tts` | 43 | Config-plane consolidation |
| `apps/smr` | 41 | Removed/renamed to `apps/text` (residual diff from the rename) |

Also: new `packages/async-contract`, `packages/vox-node-codegen`.

---

## Ticket mapping

Statuses: **C** Completed · **R** Review · **IP** In Progress · **B** Blocked · **P** Pending. Dual **TASK-780** folders are listed separately.

| Ticket | Title | Area | Status |
|---|---|---|---|
| TASK-700 | DNA writing-style PHI containment | NLP / Text / compliance | C |
| TASK-701 | Signed-status forgery containment | API / consultation | C |
| TASK-702 | ICD-10 prompt containment | NLP / prompts | C |
| TASK-703 | Empty live-note degradation marker | Consultation | R |
| TASK-704 | Generator entry-point seam | Harness / API | C |
| TASK-705 | Agentic loop as subscription feature | Entitlements | R |
| TASK-706 | Egress fail-close | Guardrail / Text | C |
| TASK-707 | Naming alignment (`smr`/`SUPER_ADMIN`) | Platform-wide | C |
| TASK-708 | API-key scope verification | API / authz | C |
| TASK-709 | Note OCC | API / notes | R |
| TASK-710 | PHI redactor | Guardrail / NLP | C |
| TASK-711 | Session state machine | Consultation | R |
| TASK-712 | Consent & ABAC | Authz | Partial |
| TASK-713 | Harness eval ICC gate (bar 0.73) | Harness / CI | C |
| TASK-714 | Legacy safety floor | Harness | C (deleted by 732) |
| TASK-715 | Workflow definition model | Database / API | R |
| TASK-716 | Workflow compiler / validator | Contract / domains | R |
| TASK-717 | Async contract | Text / packages | C |
| TASK-718 | Workflow interpreter | Harness | C |
| TASK-719 | Workflow Studio v1 | Admin console | R |
| TASK-720 | Palette: summarization | Workflow | R |
| TASK-721 | Workbench / sandbox | API / console | R |
| TASK-722 | Exposure v1 | API | C |
| TASK-723 | Runs observability | API / console | C |
| TASK-724 | Palette: STT | Workflow | C |
| TASK-725 | Worker pool: text | Text | R |
| TASK-726 | Worker pool: STT/TTS | STT / TTS | C |
| TASK-727 | Webhook channel | API | C |
| TASK-728 | Memory management screens | Admin console | C |
| TASK-729 | NLP task expansion | NLP | R |
| TASK-730 | Harness infra / Temporal | Deployment | B |
| TASK-731 | Palette: consultation | Workflow | C (Phase F open) |
| TASK-732 | Legacy generator deletion | Harness | R |
| TASK-733 | Department assignment / DNA erasure | Admin / API | IP |
| TASK-734 | Workflow substrate second pass | Contract | C |
| TASK-735 | Guardrail delegation + tenant config | Guardrail | IP |
| TASK-736 | Ollama catalog purge (provider kept) | Text / catalog | R |
| TASK-737 | Mandatory `X-Tenant-Id` | Internal mesh | C |
| TASK-738 | Harness peer service auth | Harness | C |
| TASK-739 | Seed golden-library regression | Seeds / tests | C |
| TASK-740 | SMR identifier elimination | Platform / deploy | R |
| TASK-754 | STT WS session ownership | API / STT | C |
| TASK-755 | TTS WS hardening | API / TTS | C |
| TASK-756 | API-key minting privilege ceiling | API | C |
| TASK-757 | Admin plane JWT-only | API | C |
| TASK-758 | Business-plane auth model | API | C |
| TASK-759 | API plane taxonomy | API | C |
| TASK-760 | Business-plane URI normalization | API | C |
| TASK-761 | API plane conformance gates | API / CI | C |
| TASK-762 | Machine identity (service accounts) | API | R |
| TASK-763 | Day-one seed data | Database | R |
| TASK-764 | Pre-existing e2e failures | Tests | C |
| TASK-765 | Design-system conformance | UI / console | R |
| TASK-766 | Day-one seed completeness | Database | R |
| TASK-767 | Standalone feature credentials | API / SDK | C |
| TASK-768 | Downstream-unreachable 503/502 | API | C |
| TASK-769 | Admin console system conformance | Admin console | C |
| TASK-770 | Dev bootstrap completeness | Infra | C |
| TASK-771 | Rate-limit admin writes 404 | API | C |
| TASK-772 | E2E suite triage | Tests | C |
| TASK-773 | vox-node admin plane | SDK | C |
| TASK-774 | Page-frame conformance | Admin console | C |
| TASK-775 | Table conformance | Admin console | C |
| TASK-776 | API contract & authz test suite | API / tests | C |
| TASK-777 | Guardrail policy plane / injection | Guardrail | C |
| TASK-778 | NLP safety plane + throughput | NLP | C |
| TASK-779 | E2E policy / workflow / business | Tests | C |
| TASK-780 | API contract corrections | API | C |
| TASK-780 | Harness eval ICC restore to 0.80 | Harness | P |
| TASK-781 | CASL enforcement reachability | Authz | C |
| TASK-782 | NLP inline-gate latency | NLP | R |
| TASK-783 | Developer API docs portal | Admin console | R |
| TASK-784 | Dev deploy recovery | Infra | C |
| TASK-785 | Tiered rate-limit governance | API | R |
| TASK-786 | Generated secret policy | API / security | C |
| TASK-787 | Sarvam Tatva identity migration | UI / console | R |
| TASK-788 | Domain-rail navigation | Admin console | R |
| TASK-789 | Agentic-loop coherence review | Cross-cutting | R |
| TASK-790 | Workflow gateway completion | API | R |
| TASK-791 | Harness capability completion | Harness | R (W5–7 open) |
| TASK-792 | Feedback / training loop | Harness / data | R |
| TASK-793 | Console playground SDK | Console / Vox | R |
| TASK-794 | Admin console e2e triage | Tests | R |
| TASK-795 | Substrate exclusivity | Harness / API | C |
| TASK-796 | Realtime summary (text) | Text / loop | R |
| TASK-797 | Console completion | Admin console | R |
| TASK-798 | Demo workflow seed | Seeds | R |
| TASK-799 | Python config-plane consolidation | All Python apps | R |
| TASK-800 | vox-node add context | SDK | C |
| TASK-801 | Failing-test triage | Tests / API | R |
| TASK-802 | These release notes | Docs | P (this file — refresh pass 2026-08-30) |
| TASK-803 | Deployment manifest alignment with config plane | Infra | R |
| TASK-804 | STT gateway credential + release-registry tenant context | API / Infra | C (code; gateway half awaits build/promote) |
| TASK-805 | Consent governance plane | Consultation / Authz | C |
| TASK-806 | Consultation workflow substrate unification (program, sub-tickets 808–816) | Cross-cutting | C |
| TASK-807 | Vault session self-healing | Infra / Security | C |
| TASK-808 | Unblock TEXT generation | Text / API | R (3 DoD items blocked on the cluster outage) |
| TASK-809 | Workflow node contract | Contract / domains | C |
| TASK-810 | Template / shape catalog | Database / Console | C |
| TASK-811 | Multi-document realtime runtime | Harness / API | C |
| TASK-812 | Workflow endpoint stage | Harness / API | C |
| TASK-813 | SDK workflow selection & discovery | SDK / API | C |
| TASK-814 | Playground clinical surface | Admin console | C |
| TASK-815 | `DepartmentAgent` retirement | Platform-wide (deletion) | C |
| TASK-816 | Legacy config-plane retirement | Config plane | C (Phase 4 migration authored, not applied) |
| TASK-817 | NLP persistent model cache | Infra / NLP | P |
| TASK-818 | `apps/text` becomes a high-throughput LLM router | Text / Infra | P (substantially incomplete — see Known issues) |
| TASK-819 | `DocumentSection` encryption failure swallowed | Domains / Security | C |
| TASK-820 | Empty section edit loses deletion | Domains | C |
| TASK-821 | Seed grammar and findings nodes | Seeds | C |
| TASK-822 | MLflow deployment | Infra | R |
| TASK-823 | vLLM inference service | Infra | P (blocked on hardware) |
| TASK-824 | LM Studio headless service | Infra | IP |
| TASK-825 | `ContextItem` empty edit loses deletion | Domains | C |
| TASK-826 | Hardcoded correction prompt | Harness / config | C |
| TASK-827 | Hardcoded suggestion prompt | Harness / config | C |
| TASK-828 | Edge and cluster security findings | Security | P |
| TASK-829 | Realtime consultation guardrail plane | Guardrail / Harness | IP |
| TASK-830 | NLP guard-classify per-label confidences | NLP | R |
| TASK-831 | Model catalogue alignment with serving tiers | Infra / Catalog | R |
| TASK-832 | MinIO internal access + model bucket | Infra / Security | R |
| TASK-833 | In-cluster Vault | Infra / Security | B |

Tickets **741–753** are unused in `docs/implementation/` (gap, unchanged since 08-25). TASK-795
also has a folder `TASK-795-798-Close-The-Seven` (program umbrella). **TASK-834 does not exist**
in this worktree's git history under any branch or commit — treated as retired/reserved, not a
gap to fill (see Needs confirmation for what that means for renumbering the duplicate TASK-780).

---

## Upgrade checklist (operators / integrators)

1. Upgrade **pnpm to 10.34.5**; keep Node 22.
2. Apply the **squashed Prisma baseline** with the operator procedure (do not replay 102 historical migrations).
3. Move admin automation off API keys → **service account** or JWT.
4. Repoint clients to **normalized URIs**; keep 308 follow for one release.
5. Treat **503** as retryable, **502** as not; stop parsing internal hosts from error bodies.
6. Replace `GLOBAL_ADMIN` / `smr` identifiers with **`SUPER_ADMIN` / `text`**.
7. Load provider keys and tunables via **admin control plane**, not `.env` (except bootstrap floor).
8. Set **bootstrap admin env vars** before first boot of an empty environment.
9. Rotate seeded service-account secrets outside local/dev.
10. Send **`X-Tenant-Id`** on all tenant-scoped internal calls.
11. Confirm Ollama **catalog** vs **provider** posture with TASK-736 current requirement (provider kept).
12. Deployment repo: merge Temporal address patch (TASK-730); drop `TTS_KOKORO_ENABLED` after seed (TASK-799); finish `smr`→`text` identity (TASK-740).
13. **NEW** — Stop calling the retired `DepartmentAgent` admin API and `/agents` authoring screen; migrate any tenant-authored agent configuration to the workflow node/graph model before upgrading (TASK-815/816, Breaking changes §13–14).
14. **NEW** — Do not route production traffic through `apps/text`'s in-progress LLM router expecting the OpenAI-standard contract or enforced routing-policy gates — neither is built yet (TASK-818, Known issues).
15. **NEW** — Rotate the credentials found live-committed under `docs/research/configs/` (Azure AD client secret first) before this branch reaches any environment beyond local dev (TASK-828 §7).
16. **NEW** — Do not expect MLflow, vLLM, or the containerized LM Studio service to be reachable — none has been deployed to `hope-v2-dev` (TASK-822/823/824).

---

## Needs confirmation (owner)

Re-verified 2026-08-30 — each item below was individually re-checked against current ticket
state before being carried forward; none was copied unread from the 08-25 draft.

1. ~~**Ticket number TASK-802**~~ — **SETTLED, no owner input needed.** `docs/implementation/TASK-802-*` is the only folder with this number in this worktree; there is no collision to resolve.
2. **Whether this draft supersedes or sits beside `ALL-3.0.0`** when tagging — still open. Confirmed this pass: `ALL-3.0.0.md` is a **narrower, earlier slice** (TASK-754…768 only, dated 18 Aug, still Draft/untagged) of what this document now covers (the full `dev-2.2` delta through 30 Aug). Tag grammar is `ALL-x.y.z` — `dev-2.2` is not a legal tag name (`packages/utils/src/version-grammar.ts`, `SERVICE_TAG_PREFIXES`). See §Publication mechanics below for the full finding.
3. **v1 compat `smr` URLs** — still open: keep frozen vs announce deprecation date. Unchanged since 08-25.
4. **TASK-705** commercial packaging of the agentic loop — still open (ticket status unchanged: `Review`).
5. **TASK-742** commit mention with no folder — still open. Re-checked: still only in one commit subject (`30aebeeb7`), still no ticket folder anywhere in git history.
6. **Duplicate `TASK-780`** — **update: the original suggestion ("e.g. 803") is no longer available — `TASK-803` is now taken** (Deployment Config Plane Alignment). Recommend **`TASK-835`** instead, not `834`: `TASK-834` does not exist anywhere in this worktree's git history (no commit, no folder, under any branch), which is itself the signature of a number that was allocated and then explicitly retired/reused elsewhere rather than one nobody has claimed yet — reusing it risks colliding with whatever ledger entry retired it. `835` has no such history and is free in `docs/implementation/` as of this pass.
7. **Exact migrate-from-2.1 SQL/runbook** for the squash — still open, not fully inlined here. **Related, newly found this pass:** TASK-816's Phase 4 migration (drops the legacy `AiTaskDefault`/`HarnessPolicy`/`PipelinePolicy` tables) is separately authored and drift-proven but **also not applied to any shared database** — the owner may want to sequence both migrations in one operator runbook rather than two.
8. **ICC 0.73 vs 0.80** — still open: shipping bar vs debt. `TASK-780-Harness-Eval-Icc-Restore` (the duplicate-numbered one, item 6 above) is still `Pending`.
9. **CASL** — still open: confirm external language, "not enforced at instance level." Note the underlying decision itself is now firmer than 08-25 phrased it — a 2026-08-20 owner ruling **closed** the rollout (not paused), so the public wording should say "will not be enforced" rather than "not yet enforced," if that is the intended message — confirm.
10. **Service-account + vox-node**: changeset claims admin HTTP works; live STT WS still human-only — confirm marketing copy. Unchanged since 08-25.
11. **NEW — TASK-823 vLLM hardware gap.** The manifests ship at `replicas: 0` because the cluster's actual GPUs (2× RTX 2000 Ada, 16 GiB) are undersized ~3× on VRAM and ~15× on bandwidth against the original 20–40 in-flight target. Enabling this backend needs an owner decision on procuring A100/H100-class hardware, or on accepting a smaller target on existing hardware — not something this document can resolve.
12. **NEW — credential-rotation ownership and timeline for TASK-828.** The finding (38 live credentials committed, including an Azure AD client secret shared with GitLab/Rancher SSO) is recorded; rotation has not started and this document does not assign an owner or a deadline.

---

## Publication mechanics (findings, not a decision)

Per the brief, this section **records facts an owner needs to pick a publishing target — it does
not choose one.**

- **`dev-2.2` is not a legal tag name.** The tag grammar (`packages/utils/src/version-grammar.ts`,
  `RELEASE_TAG_PATTERN` built from `SERVICE_TAG_PREFIXES = ['ALL','API','ADMIN','COMPAT','GUARD',
  'HARNESS','NLP','TEXT','STT','TTS']`) only accepts `<SVC>-M.m.p[-pre]` or `ALL-M.m.p`. This
  document's own comparison label (`dev-2.2` vs `dev-2.1`) is a branch pair for the diff, not a
  candidate tag — whatever gets tagged will be an `ALL-x.y.z` (or a set of per-service tags), not
  `dev-2.2` itself.
- **`ALL-3.0.0.md` is a narrower, earlier slice of the same release line, not the same release.**
  It is dated 18 Aug 2026, still carries `Status: Draft — not yet tagged`, and its own scope
  statement covers only "four changes... breaking for integrators" out of TASK-754…768 (the
  API-plane hardening group). This document's comparison base (`origin/dev-2.1`) is the same, but
  its `HEAD` is 12 days and ~270 commits further along, and it covers programs (TASK-806's
  consultation-substrate unification, the new inference infra) that postdate `ALL-3.0.0.md`
  entirely. Whether `ALL-3.0.0` should still be cut as its own tag, be superseded outright by a
  single `ALL-3.x.0` covering everything in this document, or be folded in as this document's §1–3
  is the open question in item 2 above — not resolved here.
- **The `ChangelogEntry` CI automation that `versioning.md` §3 describes does not exist yet.**
  `versioning.md` states: *"On an `ALL-` tag only: CI also creates a **DRAFT** `ChangelogEntry`... 
  pre-filled from the `feat` + breaking-change commits."* Grepped `.gitlab-ci.yml` and every file
  in `.gitlab/ci/*.yml` for `ChangelogEntry` and for any changelog-generation job: **zero matches.**
  The only "changelog" hits in CI config are commented-out Changesets scaffolding in
  `.gitlab/ci/publish.yml` (npm SDK versioning, an unrelated system per `release-runbook.md` §1).
  The `ChangelogEntry` model, service and admin controller **do exist in the application**
  (`packages/applications/src/services/changelog/**`, `apps/api/src/modules/changelog/**`), so a
  global admin *can* author and publish one by hand through the admin console today — but nothing
  in the pipeline will auto-draft it from this branch's commits on an `ALL-` tag the way the
  runbook describes. Cutting a tag will not produce a draft to edit; one must be created by hand
  first (this document is written to be pasted into that hand-authored draft, per
  `release-runbook.md` §5 step 3's own instruction to draft release notes in-repo first).

---

## Evidence summary (for editors)

- Commands (this pass, 2026-08-30): `git rev-list --count origin/dev-2.1..HEAD` → 690; `git log
  --format=%ci origin/dev-2.1..HEAD | sort | sed -n '1p;$p'` → 2026-08-15 / 2026-08-30; `git diff
  --shortstat origin/dev-2.1...HEAD` → 4,727 files, +620,361/−84,775; `git diff --name-only
  origin/dev-2.1...HEAD | awk -F/ '{print $1"/"$2}' | sort | uniq -c | sort -rn` for the top-areas
  table; `git log --format=%s origin/dev-2.1..HEAD | grep -oE 'TASK-[0-9]+' | sort -u` for the
  ticket range.
- Original commands (08-25 draft, now superseded): `git rev-list --count origin/dev-2.1..HEAD` →
  417; `git log --format=%ci` first/last → 2026-08-15 / 2026-08-25; `git diff --numstat
  origin/dev-2.1...HEAD`.
- Merge commits are local worktree merges (`merge(TASK-xxx): …`), not GitLab MR titles.
- Highlights trace to ticket READMEs listed above plus `docs/operations/release-notes/ALL-3.0.0.md`.
- Do not invent features in 741–753 or uncommitted deployment-repo work.
- The new tranche's breaking-change verdicts (TASK-818/823/824/832/833 all judged **not**
  currently breaking) are traced to specific evidence in each section above — file/directory
  existence checks (`apps/text/src/text/routing/policy.py` absent, `apps/text/src/text/api/
  v1_compat/**` absent, `route-manifest.json` grep for `department-agent` → 0 hits), not the
  tickets' own self-description alone.
