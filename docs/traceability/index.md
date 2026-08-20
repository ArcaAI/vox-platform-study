# HOPE Traceability — Index

Per-domain traceability for the HOPE platform: every business capability mapped to the
apps/services, packages/modules, Prisma models, API routes, console features, and tests
that implement it. This index is the at-a-glance roll-up; each domain file carries the
verified capability rows.

**Successor to** the monolithic traceability matrix, now retired to
[`docs/archive/traceability-matrix.md`](../archive/traceability-matrix.md). These per-domain
files replace the single 43-row table that had outgrown maintainability and had gone
stale/omissive (TTS had zero rows, SSO/SAML was missing, the model plane was
under-represented).

Gateway route paths are relative to the global prefix `/api/v1` unless a full path is
shown. Every module path, `@Controller` route, Prisma model, and test reference in a
migrated domain file is **verified to exist against the code** at the file's stamped
`Last verified` date. Absent coverage is written honestly as `—`, never invented.

## Domain roll-up

| Domain | File | Owning apps / services | Legacy rows covered | Status |
|---|---|---|---|---|
| **Authentication & identity** | [`auth-identity.md`](./auth-identity.md) | `apps/api` (`auth`, `api-key`, `rbac`, `tenant-idp-config`); `applications/services/{auth,apiKey,rbac,federated-auth,idp-resolver,tenant-idp-config,directory-sync}`; `applications/authorization`; `apps/admin-console` | 1, 2, 3, 8 (+ SSO/SAML & auth-revocation, new) | **Migrated** |
| **AI models & providers** | [`ai-models-providers.md`](./ai-models-providers.md) | `apps/api` (`ai-model`, `ai-task-default`, `ai-runtime-profile`, `ai-inference`, `ai-provider-connection`, `agent-trajectory`); `applications/services/{stt/model,ai-task-default,ai-runtime-profile,ai-provider-connection}`; `apps/admin-console` | 26 (AiModel registry part), 38, 39 (+ runtime/inference/task-defaults/discovery/ops, new) | **Migrated** |
| **Text-to-speech (TTS)** | [`tts.md`](./tts.md) | `apps/tts`; `apps/api` (`speech`, `tenant-tts-config`); `applications/services/tenant-tts-config`; `apps/admin-console` | — (P0 gap — no legacy rows) | **Migrated** |
| **Tenancy, provisioning, entitlements & settings control plane** | [`tenancy-provisioning.md`](./tenancy-provisioning.md) | `apps/api` (`tenant`, `tenant-frontend-config`, `entitlements`, `user`, `department`, `settings-catalog`, `internal` effective-config); `applications/services/{tenant,tenant-frontend-config,entitlements,metering,department,user,settings-registry,effective-config,config-resolver}`; `apps/admin-console` | 4, 5, 6, 7 (+ settings control plane, new; disambiguates row-30) | **Migrated** |
| **Consultations & clinical context** | [`consultation.md`](./consultation.md) | `apps/api` (`consultation`, `internal` STT callbacks); `applications/services/consultation/{consultation,context,timeline,highlight,live-documentation,jobs}`; MinIO | 9, 12, 16 | **Migrated** |
| **Transcription (live, batch, voice profiles, pipelines)** | [`transcription.md`](./transcription.md) | `apps/api` (`streaming`, `voice-profile`, `pipeline`, `tenant` resync); `applications/services/stt/{streaming,realtime,job,pipeline}`; `apps/stt` | 10, 11, 13, 26 (ASR pipeline part) | **Migrated** |
| **Summarization, generation & prompt/DNA management** | [`summarization.md`](./summarization.md) | `apps/api` (`consultation` summary, `streaming` TEXT proxy, `prompt-management`, `dna-writing-style`); `applications/services/{consultation/summary,text,prompt-management,dna-writing-style}`; `apps/text`, `apps/guardrail` | 14, 15, 24, 25, 34b | **Migrated** |
| **Clinical documentation harness & agentic loop** | [`harness.md`](./harness.md) | `apps/harness`, Temporal; `apps/api` (`harness-admin`, `pipeline-policy-admin`, `mcp-admin`, `consultation` harness-internal); `applications/services/{consultation/harness,harness-policy,harness-observability,harness-audit,pipeline-policy,knowledge,eval,mcp-server,agentic-instructions}`; `apps/admin-console` | 19, 20, 21, 22, 23, 34c, 34d (MCP part) | **Migrated** |
| **Object storage & tenant buckets** | [`storage.md`](./storage.md) | `apps/api` (`storage`, `tenant-bucket`, `tenant-storage-config`, `storage-access-key`); `applications/services/{tenant-bucket,tenant-storage-config,storage-access-key,baseServices/storage}`; MinIO; `apps/admin-console` | 27 (+ `storage-browser` console feature) | **Migrated** |
| **Platform operations** | [`platform-ops.md`](./platform-ops.md) | `apps/api` (`audit-log`, `global-setting`, `throttle`, `admin-rate-limit`, `monitoring`, `platform-metrics`, `health`, `queue-admin`, `pstudio`, `notification`, `resource-subscription`, `webhook`, `ai-service-admin`, `agentic-admin`); `apps/admin-console` | 28, 30, 31, 32, 33, 34, 34a + **29 (split into notifications/webhooks/subscriptions — legacy "no controller" note corrected)** (34c → `harness.md`; 34d: MCP → `harness.md`, agent-trajectory → `ai-models-providers.md`; settings control plane → `tenancy-provisioning.md`) | **Migrated** |
| **Admin console** | [`admin-console.md`](./admin-console.md) | `apps/admin-console`, `packages/ui` | 37 (+ the full console-feature inventory: every `features/*` mapped to its owning domain file) | **Migrated** |
| **Browser SDK & audio packages** | [`sdk.md`](./sdk.md) | `packages/agentic-sdk-v2` (+ `room`, `vad`, `noise-filter`, `stt`, `med-ner`, `pipeline`) | 35 | **Migrated** |
| Medical NLP & guardrails (capability services) | in composition — [`summarization.md`](./summarization.md) (G2/G3), [`consultation.md`](./consultation.md) (C5) | `apps/nlp`, `apps/guardrail` | 17, 18 (documented where they compose; no dedicated file per the 12-file plan) | **Folded** |
| Federated learning (schema only) | archived matrix only (row preserved) | — (no app — models only) | 36 (`FedlClient`/`FedlRound`/`FedlUpdate`/`FedlModelVersion`; no implementation to trace) | **Schema only** |
| **Business workflows (cross-cutting)** | [`workflows.md`](./workflows.md) | composes all domains | — (workflow dimension — composes the rows above, adds no new rows) | **New** |

The **workflow dimension** ([`workflows.md`](./workflows.md)) is orthogonal to the domain roll-up: it does not own capability rows, it threads the migrated rows into the 11 end-to-end business flows (consultation lifecycle · live transcription & live documentation · batch transcription · summarization + guardrail · harness gating · tenant provisioning/onboarding · model lifecycle · BYO resolution · TTS synthesis · authN/authZ + revocation · admin governance), citing service + endpoint + model + test per step and the invariants (404-over-403, OCC/If-Match incl. the "0"-create contract, PHI posture) each flow must uphold.

**Migration complete.** Every domain now resolves to a per-domain file above; the monolithic matrix is retired to [`docs/archive/traceability-matrix.md`](../archive/traceability-matrix.md) (its rows superseded). Two entries are deliberate non-files, not gaps: **Medical NLP & guardrails** (rows 17/18) are **Folded** — the `apps/nlp` / `apps/guardrail` capability services are documented where they compose (summarization G2/G3, consultation C5) rather than in a standalone file, per the 12-file plan; **Federated learning** (row 36) is **Schema only** — Prisma models with no consuming app, so there is nothing to trace beyond the model names. Adding a new capability means adding a row to the owning domain file (per the row contract below) and, if it introduces a new console feature, an inventory line in [`admin-console.md`](./admin-console.md).

## How to maintain

### Row contract (every migrated capability row)

Each row states, and each claim must be **verified to exist against the code before it is written**:

1. **Capability** — the business capability, not the code artifact.
2. **App / service** — owning `apps/*` and Python service(s).
3. **Key modules** — gateway module path (`apps/api/src/modules/<x>`) and application service path (`packages/applications/src/services/<x>`).
4. **Prisma models** — exact model names as declared in `packages/database/src/prisma/db_main/*.prisma` (or `—` when the capability is stateless / Redis-only / proxy-only).
5. **Key API endpoints** — `@Controller` base + method routes, relative to `/api/v1`, exactly as decorated in code (including `@ApiEndpoint`-derived routes). WS/SSE paths shown in full.
6. **Console** — owning `apps/admin-console` feature + route (with audience tier), or `—`.
7. **Tests** — distinguishing kind (see shorthand) and flagging unit-only coverage.

### Honesty rules

- **`—` means absent, not "assumed elsewhere".** A missing controller, missing e2e, or stub implementation is written as a gap. Never paper over a gap with a plausible-but-unverified path.
- **The audit description is not the source of truth — the code is.** Where an earlier audit or narrative mis-described a route or model, the verified code wins. (Example: the "test / directory-credentials / sync" routes the audit attributed to `tenant-tts-config` actually live on `tenant-idp-config`; they are recorded there.)
- **Unlanded work is marked `(unlanded)`** until it lands on `fix/2605-review`.
- **Every domain file carries its own `Last verified: <date>` stamp** — a per-file, machine-checkable replacement for the single global date. Re-stamp only after re-verifying the file's rows against code.
- **Owner-decision / imperative-privilege nuances are annotated inline**, not silently normalized (e.g. GLOBAL-ADMIN-only writes gated in the service behind a `read`/`manage` decorator carry an `AUTH-NOTE`).

### Test-location shorthand

- **unit(app)** = `packages/applications/src/services/<svc>/__tests__/`
- **unit(dom)** = `packages/domains/src/**/__tests__/`
- **unit(api)** = `apps/api/src/**/__tests__/`
- **unit(console)** = `apps/admin-console/src/**/__tests__/` (Vitest + jsdom; screen specs include axe + both themes)
- **e2e** = `apps/api/tests/e2e/*.spec.ts` (Playwright, real HTTP against `http://localhost:8868/api/v1`)
- **contract** = `tests/contracts/` · **x-tenant** = `tests/cross-tenant/` + `task-307-*` e2e suite
- **py(stt)** = `apps/stt/tests/` · **py(text)** = `apps/text/src/text/tests/` · **py(grd)** = `apps/guardrail/src/guardrail/tests/` · **py(nlp)** = `apps/nlp/tests/` · **py(hrn)** = `apps/harness/src/harness/tests/` · **py(tts)** = `apps/tts/src/tts/tests/`

Last verified: 2026-07-21
