# TASK-802 — Platform Release Notes (`dev-2.2` vs `dev-2.1`)

| Field | Value |
|---|---|
| **Status** | Pending (draft for owner review — **not published**) |
| **Type** | docs |
| **Proposed ticket** | `TASK-802` (highest existing `docs/implementation/` number was `TASK-801`; `docs/archive/` has older `TASK-700`–`TASK-706` under a **different** meaning — dependency upgrades. Confirm numbering before treating this as assigned.) |
| **Branch compared** | `dev-2.2` (`HEAD` `45cc4ddbc`) vs `origin/dev-2.1` (`81195848d`) |
| **As of** | 2026-08-25 |
| **Audience** | Product / platform owners, integrators, operators |
| **Related published draft** | [`docs/operations/release-notes/ALL-3.0.0.md`](../../operations/release-notes/ALL-3.0.0.md) covers the API-plane hardening slice (TASK-754…768). This document is the **full branch delta**. |

---

## Requirement Analysis

Produce a user-facing Platform Release Note / Changelog for HOPE `dev-2.2` compared with `dev-2.1`, grounded in git history and ticket READMEs — not speculation.

## Current State Evaluation

- Current branch: `dev-2.2`, tracking `origin/dev-2.2`.
- Comparison base: `origin/dev-2.1` (same SHA as local `dev-2.1`).
- Existing convention: `docs/operations/release-notes/ALL-3.0.0.md` + `docs/operations/release-runbook.md` (Changesets for npm; git tag for services).
- `docs/implementation/` on `dev-2.1` had almost no TASK folders; this line introduced the TASK-700…801 agentic-workflow / platform program.

## Implementation Plan

Owner reviews this draft, confirms TASK number and any **needs confirmation** items, then publishes (or feeds CI `ChangelogEntry` per versioning.md).

## Implementation Summary

Draft written 2026-08-25 from `git log` / `git diff --stat` / ticket headers. No code changes.

## Change History

| Date | Change |
|---|---|
| 2026-08-25 | Initial draft from `origin/dev-2.1..dev-2.2`. |

---

# HOPE Platform Release — `dev-2.2` (vs `dev-2.1`)

**As of:** Tuesday, 25 August 2026  
**Status:** Draft — not a git tag; services version from the tag when you cut it.  
**Comparison:** `origin/dev-2.1` (`81195848d`) → `dev-2.2` (`45cc4ddbc`)

### Scope

`dev-2.2` is the **Agentic Workflow Platform** line plus a full **API / identity / safety / admin-console** hardening pass. Relative to `dev-2.1` this is a major platform release, not a patch train: 417 commits over ~10 days (15–25 Aug 2026), ~4,221 files, **+519k / −65k** lines.

A narrower integrator note already exists as `ALL-3.0.0` (18 Aug 2026). Use that for the four API-plane breakages; use **this** document for the whole 2.2 line (workflow studio, clinician loop, config plane, design system, Python services).

---

## Highlights

1. **Workflow Studio and a durable interpreter** — Graph definitions, compiler/validator, Temporal interpreter, sandbox workbench, run observability, and public exposure of workflows. Clinicians and tenant admins can author and run consultation / summarization / STT graphs instead of a single hard-coded generator. *(TASK-715…724, 718, 719, 731, 790, 795)*
2. **The live consultation path is a workflow, not a sidecar** — Realtime short summaries, SOAP autofill, suggestions, and spelling/medical-term correction are brokered through the interpreter; substrate dispatch is exclusive (legacy signable generator removed). *(TASK-732, 791, 793, 795–798)*
3. **Administration is JWT- or service-account only** — Tenant API keys can no longer call `/api/v1/admin/*`. A new **service account** credential (`svc:*`) is the machine path. *(TASK-757, 762, 767)*
4. **Business-plane URIs are capability-shaped** — Retired paths answer **308** for one release. Downstream transport failure is **503** / **502**, not 400 with internal hosts. *(TASK-759, 760, 768)*
5. **Naming: `smr` → `text`, `GLOBAL_ADMIN` → `SUPER_ADMIN`** — App `apps/smr` is `apps/text`; Changelog audience enum renamed. Integrators and seeds must use the new identifiers. *(TASK-707, 740)*
6. **Configuration moved into the database** — Python services dropped most env knobs onto the control plane (provider connections, task defaults, harness/STT/TTS/NLP/guardrail tunables). Super-admin vs tenant BYO is explicit. *(TASK-799, 735, 785, 786)*
7. **PHI and session safety** — DNA-style PHI containment, working PHI redactor before NLP, fail-closed cloud egress, live STT session ownership (same-tenant hijack closed), TTS WebSocket Origin check. *(TASK-700, 706, 710, 754, 755)*
8. **Admin console is a real product surface** — Tatva/Sarvam geometry and tokens, domain-rail navigation, memory/assignment screens, developer API docs portal, clinician playground wired to the SDK. *(TASK-719, 728, 733, 765, 769, 774, 775, 783, 787, 788, 793, 797)*
9. **Day-one bootstrap works** — Seeded roles/catalog, env-driven first super-admin / tenant-admin, `pnpm setup:dev` completeness, standalone feature credentials. *(TASK-763, 766, 770)*
10. **Safety engines scaled** — Guardrail is a policy/delegation plane (judgement on `text`/`nlp`); NLP hosts a three-model safety plane with throughput work toward 100 concurrent sessions. *(TASK-735, 777, 778, 782)*

---

## Breaking changes / migration notes

Treat these as **loud**. Several match `ALL-3.0.0`.

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

Changesets is now initialized. SDK family was already at **3.0.0** (hand-versioned with ALL-3.0.0). `@arcaai/vox-node` has a **patch** changeset for admin-plane access (owner: keep family lockstep). Do not run a second accidental major.

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

### Data / domain / application

- Day-one seed data + completeness (generic care settings replacing BCMCH-derived catalog; `Role.tenantId` so tenant admins own custom roles) (TASK-763, 766).
- Consent & ABAC plumbing (shadow on real routes; **enforce list empty by owner decision**) (TASK-712, 781).
- Generator **entry-point seam** (TASK-704).

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

---

## Infrastructure / DevOps / CI

- Migration **squash to one baseline** (breaking for migrate-from-history).
- GitLab CI updates; harness eval gate comment/threshold aligned to measured ICC.
- `promote-dev` overlay now includes **`hope-v2/text`**.
- Temporal hosting decision: self-hosted k3s (TASK-730) — **patch authored in deployment repo, not merged/applied to cluster**.
- Worker pool productionization for STT/TTS/text.
- Changesets config added; do not use `scripts/publish-sdk.sh` for a normal SDK release.

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

**CASL instance enforcement is not on.** Owner closed the rollout: `CASL_ENFORCED_PAIRS` stays empty (TASK-712 / 781). Shadow metrics exist; do not claim row-level ABAC is enforced in production.

---

## Known issues / incomplete work

Ticket statuses below are from README headers as of 2026-08-25 — several say **Review** while code is merged; treat Review as “owner has not formally closed.”

| Topic | Status | Notes |
|---|---|---|
| TASK-730 Harness Temporal on cluster | **Blocked** | Decision made; kustomize patch on `task-730-harness-temporal` in deployment repo **not pushed/merged/applied**. |
| TASK-733 Department assignment personalization | **In Progress** | Backend + Studio matrix done; **Phase B HARD-GATED**. |
| TASK-735 Guardrail delegation | **In Progress** | TS/LLM plane landed; Python half of Phase 4 blocked on G-01. |
| TASK-712 Consent/ABAC | Partial | Enforce list empty by owner ruling. |
| TASK-780 Harness Eval ICC restore | **Pending** | Restore ICC bar 0.73 → 0.80. **Number collision** with TASK-780 API contract corrections. |
| TASK-791 W5/W6/W7 | Deferred | Harness capability completion incomplete. |
| TASK-716 | Review | Rule-set CRUD, re-validation sweep, seed, E2E remaining. |
| TASK-731 Phase F | Open | Seeded platform-default consultation definition + e2e. |
| TASK-721 Task 1 | Human-gated | Workbench design gate. |
| TASK-740 | Review | Deployment-repo `smr` identity leftover. |
| TASK-762 | Review | D1 unscoped registration + D3 deferred boot audit still need owner. |
| TASK-799 | Review | TTS ConfigMap `TTS_KOKORO_ENABLED` still in deployment repo. |
| Live STT WebSocket | By design | Service accounts cannot drive the live stream (4401). |
| Compat `smr` paths | Frozen | v1 compat still uses historical names. |
| Many e2e specs | Authored, not always executed | Prisma `db push --force-reset` blocked for AI agents in this environment. |
| TASK-742 | — | Mentioned in one commit subject; **no ticket folder**. Needs confirmation. |

---

## Stats

| Metric | Value |
|---|---|
| Commits | **417** (`origin/dev-2.1..dev-2.2`) |
| Date range | **2026-08-15** → **2026-08-25** |
| Files changed (approx.) | **4,221** |
| Line delta (approx.) | **+519,415 / −65,410** |
| Conventional `feat` / `fix` | 120 / 101 |
| Tickets named in commit subjects | TASK-700 … TASK-801 (sparse 741–753) |
| Merge style | Heavy worktree merges into `dev-2.2` (not GitHub PRs) |

### Top areas by change volume

| Area | Files (approx.) | Role |
|---|---:|---|
| `apps/admin-console` | 622 | Studio, Tatva, clinician surfaces |
| `packages/applications` | 792 | Services, config plane, authz |
| `apps/api` | 548 | Gateway, planes, workflow APIs |
| `docs` | 274 | Tickets + architecture |
| `packages/database` | 243 | Schema, seeds, squash |
| `apps/harness` | 181 | Interpreter, eval, capabilities |
| `packages/workflow-contract` | 135 | New contract package |
| `packages/ui` | 213 | Tatva / shadcn |
| `apps/guardrail` / `nlp` / `text` / `stt` / `tts` | 70–80 each | Config plane + safety |
| `packages/vox-node` | 85 | Admin plane + context |

Also: `apps/smr` removed/renamed to `apps/text`; new `packages/async-contract`, `packages/vox-node-codegen`.

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
| TASK-802 | These release notes | Docs | P (this file) |

Tickets **741–753** are unused in `docs/implementation/` (gap). TASK-795 also has a folder `TASK-795-798-Close-The-Seven` (program umbrella).

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

---

## Needs confirmation (owner)

1. **Ticket number TASK-802** — confirm or reassign.
2. **Whether this draft supersedes or sits beside `ALL-3.0.0`** when tagging (tag grammar is `ALL-x.y.z`, not `dev-2.2`).
3. **v1 compat `smr` URLs** — keep frozen vs announce deprecation date.
4. **TASK-705** commercial packaging of the agentic loop.
5. **TASK-742** commit mention with no folder.
6. **Duplicate TASK-780** — rename ICC-restore ticket to a free number (e.g. 803) to avoid ops confusion.
7. **Exact migrate-from-2.1 SQL/runbook** for the squash — not fully inlined here.
8. **ICC 0.73 vs 0.80** — shipping bar vs debt (TASK-713 vs pending ICC restore).
9. **CASL** — confirm external language: “not enforced at instance level.”
10. **Service-account + vox-node**: changeset claims admin HTTP works; live STT WS still human-only — confirm marketing copy.

---

## Evidence summary (for editors)

- Commands: `git rev-list --count origin/dev-2.1..HEAD` → 417; `git log --format=%ci` first/last → 2026-08-15 / 2026-08-25; `git diff --numstat origin/dev-2.1...HEAD`.
- Merge commits are local worktree merges (`merge(TASK-xxx): …`), not GitLab MR titles.
- Highlights trace to ticket READMEs listed above plus `docs/operations/release-notes/ALL-3.0.0.md`.
- Do not invent features in 741–753 or uncommitted deployment-repo work.
