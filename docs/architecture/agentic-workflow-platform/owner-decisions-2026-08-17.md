# Owner Decisions — 2026-08-17

| | |
|---|---|
| **Status** | Authoritative. Supersedes the decision queue in [backlog.md](./backlog.md) §Decision queue and the blocking items in [execution-log.md](./execution-log.md) §1 wherever they conflict. |
| **Given by** | Owner, 2026-08-17 |
| **Applies to** | Every ticket in `docs/implementation/TASK-7XX-*` |

---

## 1. Standing directives (apply to EVERY ticket, no exceptions)

### D-A — There is no production data yet. Build for day-1 production quality.

The platform has not gone live. There are no real tenants, no real consultation traffic, no
production rows to migrate or protect. Two consequences, and both matter:

1. **Migration/backfill caution is no longer the constraint.** Agents may run migrations, shadow-DB
   proofs, seed resets and destructive local operations against the LOCAL dev and test databases
   without further consent.
2. **"Ship it half-enabled and decide later" is no longer acceptable.** The reason many tickets shipped
   with enforcement switched off was fear of bricking existing charts. That fear is void. Anything
   the owner has now approved is to be finished **completely and properly, enabled, for day-1** —
   not left behind a flag for a later decision.

### D-B — Configuration lives in the database; secrets live in Vault. Env vars are a last resort.

Restates and hardens `.claude/rules/00-project-context.md` §Configuration Principles. An engine name,
model id, endpoint, threshold, prompt, taxonomy, label set or tenant setting is **never** an env var
and **never** a literal in code. It belongs in `db-config` / `global-kv` / `vault-kv` per the tier
table in `09-infrastructure-devops.md`.

The ONLY sanctioned env vars are the bootstrap floor: what is needed to reach the database or
authenticate to Vault, plus **the internal service access token** (see D-D). If an agent believes a
new env var is unavoidable, it must say so explicitly in the ticket README with the reason — it does
not get to add one silently.

Resolution order is always **tenant → SYSTEM**. Never a customer tenant as a fallback.

### D-C — The Figma design gate is waived.

Approved to skip Figma frames and design approval for every ticket that would otherwise need them.
Build directly against `ScreenTemplate` + `@arcaai/ui` per rules 07/10/11/13. The downstream
implementation gates still stand and are NOT waived: semantic tokens only, both themes verified,
WCAG 2.2 AA with a 0-violation axe scan per screen.

### D-D — One internal access token for all internal service communication.

Internal service-to-service auth uses a **single shared access token**, set by the DevOps engineer,
identical across all services, internal use only. Do not design per-service tokens, per-pair tokens,
or a rotation scheme per service. This token is a sanctioned env var (bootstrap floor / D-B
exception) and is delivered from Vault in deployed environments.

### D-E — Integration must be seamless across all three surfaces.

Wherever a ticket touches a feature surface, it is not done until **SDK · Admin-Console · Backend
(REST / WebSocket / SSE)** all agree. A backend capability with no SDK support and no console
surface is an unfinished ticket, not a completed one.

### D-F — Local infrastructure is UP and is to be used.

Verified 2026-08-17: dev Postgres :5432, Redis :6379, Vault :8200, Temporal :7233, MinIO, Qdrant,
the isolated test stack (Postgres :5433, Redis :6380, Vault :8201, MinIO :9002, Qdrant :6335), and
LM Studio on :1234. The "could not verify, infra was down" exemption used by earlier waves **no
longer applies**. Migration shadow-DB proofs, integration suites, e2e suites and the eval gate are
all expected to be RUN, with real pasted output.

---

## 2. Per-ticket decisions

| Ticket | Decision |
|---|---|
| **700** dna-phi | No production data — free to review and complete the work fully, including running the scan locally. |
| **702** icd10 | **Allow all current prompt versions.** v3 becomes the default at go-live. The v1 sign-off blocker is dissolved. |
| **704** seam | **Do NOT touch legacy pre-summarization and summarization** — they are STANDALONE features, kept deliberately. They serve SDK-compat and API-compat consumers. Work them through the summarization agent with pre-defined instruction prompt templates selected by context. The sync short-circuit question is closed: no short-circuit. |
| **705** loop-status | The harness agentic loop is **core business**. Treat it as a **feature in the subscription plan** (entitlement-gated), not an environment kill-switch. |
| **707** naming | **SUPER_ADMIN is the supreme platform-managing user.** Global admins are consolidated into SUPER_ADMIN. That is the only term used anywhere. |
| **710** phi-redactor | Finish properly and completely. Internal service auth uses the single shared access token (D-D). |
| **712** consent-abac | No production data → follow best practices and finish **completely and properly, enabled for day-1**. The legacy-consent posture question is dissolved. |
| **713** eval-gate | Finish completely and properly for day-1. LM Studio is up on :1234 — run it. |
| **714** legacy-floor | Add a note recording that TASK-732 deleted the mechanism by design, then update the ticket status. |
| **716** validator | **AI-prepared rule set is approved** — there is no production environment, and a team of doctors will review. Approved to finish the ticket completely and properly, including rules-as-data governance. |
| **717** async-contract | Finish completely and properly for day-1 — including a real reference producer. |
| **719** studio | **Big task; follow-up tickets are authorized.** The schema must align with the backend implementation. The platform must let tenant admins and privileged end-users manage agents, workflows, rules and related objects. Critically: **a tenant admin must be able to define the context schema**, so a developer can integrate against a specific tenant's shape to build features. The **SDK must be updated/upgraded** accordingly. |
| **720** palette-summarization | Finish completely and properly for day-1. |
| **721** workbench | Finish completely and properly for day-1, with seamless SDK ↔ Admin-Console ↔ Backend (REST/WS/SSE) integration. |
| **724** palette-stt | Finish completely and properly for day-1, with seamless SDK ↔ Admin-Console ↔ Backend integration. |
| **730** harness-infra | **Pending until all implementation and local e2e are finished.** Fulfil all requirements, commit all expectations, solve all user stories and use cases first. Cluster/deployment-repo work comes after. |
| **731** palette-consultation | Finish completely and properly for day-1, with seamless SDK ↔ Admin-Console ↔ Backend integration. |
| **733** dept-personalization | Finish completely and properly for day-1, with seamless SDK ↔ Admin-Console ↔ Backend integration. |
| **735** guardrail-config | Finish completely and properly for day-1, with seamless integration. Hardcoded engine/model defaults must move to `AiTaskDefault` and fail closed. |
| **736** ollama | **REVISED — Ollama provider LOGIC must remain available.** Only the Ollama-related **model catalog rows** are removed. This reverses the ticket's original R1 ("Ollama is removed completely"). |
| **737** tenant-header | Finish completely and properly for day-1, with seamless integration. |
| **738** peer-auth | Finish completely and properly for day-1, with seamless integration. Uses the single shared internal token (D-D). |

---

## 3. What this changes about previously "blocked" work

These items were recorded as blocking and are now RESOLVED — do not re-raise them:

- Legacy-consent posture (queue #1) → dissolved by D-A; enable for day-1.
- DNA decrypt-and-scan authorization (queue #2) → granted, local.
- Clinical review of the validator rule set (queue #3) → approved to proceed; doctors review later.
- Eval-gate judge backend (queue #5) → local LM Studio, and it is running.
- Migration go/no-go and "legacy deleted" scope (queue #7, #8) → 704's decision settles the boundary:
  pre-summarization and summarization survive as standalone features.
- `harness.loop.enabled` posture (queue #9) → becomes a subscription entitlement, not an env switch.
- `ChangelogAudience` rename (queue #14) → already shipped 2026-08-17.
- Figma approvals (queue #15) → waived by D-C.

Still genuinely open: API-key scope narrowing detail (#10), public-workflow cloud-LLM selection (#6),
egress rollout comms (#13), and cluster/deployment-repo access for 730 — which D-2 defers anyway.

---

## 3b. Second round of owner decisions (2026-08-17, later)

| # | Decision | Consequence |
|---|---|---|
| **1. Eval judge** | **SUPERSEDED — see below.** Original reading was "move to a reasoning-capable judge". | — |
| **1b. Eval judge (final)** | **Keep `gemma-4-e4b-it-qat` for local development**, and pair it with an **AI-generated, clinician-reviewed golden set built to best practice**. | The judge is not replaced; the REFERENCE SET is rebuilt. Supported by the measurement: the judge discriminates at 4096 context (`synthesized` mean 3.92) and collapses to a flat 5.00 at 131072 — so the ICC failure tracks context length and an undiscriminating reference set, not model capability. Thresholds are still NOT to be relaxed. |
| **2. Tenant authoring boundary** | **APPROVED as proposed** in [tenant-authoring-boundary.md](./tenant-authoring-boundary.md) §4: tenant admins may define **context schemas and workflows**; they may **NOT** author clinical safety rules. | Unblocks 715, 716, 719, 731. Rules stay platform-authored + clinician-reviewed. |
| **3. TASK-740 — `smr` → `text`, no exceptions** | **APPROVED, and the scope is WIDER than the findings doc assumed.** The owner: *"`smr` was renamed to `text`. Do NOT use `smr` anymore!"* | **This REVERSES the "frozen identifiers" position of TASK-707.** DB-persisted task keys (`smr.live`/`smr.finalize`/`smr.test` + fallbacks) and the `HarnessPolicy.smrProvider`/`smrModel` columns are now IN scope, together with the Python `smr_*` fields, `SmrClient`, structlog event names, Prometheus metric names and Redis key prefixes. Requires a migration + data migration + seed updates + ~50 call sites. |
| **5. STARTER tier** | Loop is **ON for STARTER, but capped at 5 consultation sessions per day.** | `agenticLoop` is therefore **not a boolean** — it is a boolean plus a per-day quantity quota. See the note below. |

### The one carve-out to decision 3, flagged for confirmation

The frozen **external wire route** `@Controller('api/smr/api/v1')` and vox-node's matching v1-compat
paths are a PUBLISHED API contract, and decision **704** deliberately preserved exactly these
surfaces ("do not touch the legacy pre-summarization and summarization — those are standalone
features … related to SDK Compat, and APIs Compat"). Renaming that path breaks every existing SDK
consumer, which is the opposite of what 704 protects.

**Therefore: rename every INTERNAL identifier; keep the `api/smr/api/v1` wire path** until the owner
says otherwise. Everything else — code symbols, DB values, columns, metrics, log events, Redis
prefixes — goes to `text`.

### STARTER's quota changes the entitlement shape

A background task is adding `featureAgenticLoop` **boolean** columns. That is now **insufficient on
its own**: STARTER needs `loop ON + max 5 consultation sessions/day`. The entitlement therefore needs
a companion quantity quota (e.g. `quotaAgenticLoopSessionsPerDay`, `NULL` = unlimited), enforced
through the existing `assertQuantityQuota` → `QuotaExceededException` (HTTP 409) path in
`04-application-services.md`, with a per-day reset window. Per D-B the limit is DB-resident, never
an env var, and resolves tenant → SYSTEM.

## 4. Non-negotiable working standard for every agent

1. **TDD.** Failing test first, observed RED, then GREEN. If RED was not observed, say so plainly.
2. **No fabricated verification.** This program has already had two fabricated verification reports.
   Every claim of "done" must cite a real path or real pasted command output. Claiming a command
   passed without running it is the single worst outcome available.
3. **Run the gates** (infra is up): affected package build + `test:unit`, `typecheck`, `lint`, plus
   migration shadow-DB empty-diff proof per rule 02 where schema changed.
4. **Never run `pnpm gen:mapper`** — it is destructive (rule 03).
5. **Update the ticket README** — Implementation Summary, files changed, Change History entry, status.
6. **Report honestly what was not done**, and why, rather than narrowing scope silently.
