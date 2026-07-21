# HOPE Traceability — Index

Per-domain traceability for the HOPE platform: every business capability mapped to the
apps/services, packages/modules, Prisma models, API routes, console features, and tests
that implement it. This index is the at-a-glance roll-up; each domain file carries the
verified capability rows.

**Successor to** the monolithic `docs/traceability-matrix.md` (kept as a legacy source
until every domain is migrated here — see the migration status column below). This is the
TASK-538 rebuild: per-domain files replace the single 43-row table that had outgrown
maintainability and had gone stale/omissive (TTS had zero rows, SSO/SAML was missing, the
model plane was under-represented).

Gateway route paths are relative to the global prefix `/api/v1` unless a full path is
shown. Every module path, `@Controller` route, Prisma model, and test reference in a
migrated domain file is **verified to exist against the code** at the file's stamped
`Last verified` date. Absent coverage is written honestly as `—`, never invented.

## Domain roll-up

| Domain | File | Owning apps / services | Legacy rows covered | Status |
|---|---|---|---|---|
| **Authentication & identity** | [`auth-identity.md`](./auth-identity.md) | `apps/api` (`auth`, `api-key`, `rbac`, `tenant-idp-config`); `applications/services/{auth,apiKey,rbac,federated-auth,idp-resolver,tenant-idp-config,directory-sync}`; `applications/authorization`; `apps/admin-console` | 1, 2, 3, 8 (+ SSO/SAML & auth-revocation, new) | **Migrated** |
| **AI models & providers** | [`ai-models-providers.md`](./ai-models-providers.md) | `apps/api` (`ai-model`, `ai-task-default`, `ai-runtime-profile`, `ai-inference`, `ai-provider-connection`, `agent-trajectory`); `applications/services/{stt/model,ai-task-default,ai-runtime-profile,ai-provider-connection}`; `apps/admin-console` | 26 (AiModel registry part), 38, 39 (+ runtime/inference/task-defaults/discovery/ops, new) | **Migrated** |
| **Text-to-speech (TTS)** | [`tts.md`](./tts.md) | `apps/tts-v2`; `apps/api` (`speech`, `tenant-tts-config`); `applications/services/tenant-tts-config`; `apps/admin-console` | — (P0 gap — no legacy rows) | **Migrated** |
| Tenancy, provisioning & entitlements | `docs/traceability-matrix.md` | `apps/api` (`tenant`, `tenant-frontend-config`, `entitlements`, `user`, `department`) | 4, 5, 6, 7 | Legacy |
| Consultations & clinical context | `docs/traceability-matrix.md` | `apps/api` (`consultation`) | 9 | Legacy |
| Transcription (live, batch, recording, voice profiles) | `docs/traceability-matrix.md` | `apps/api` (`streaming`, `voice-profile`, `pipeline`), `apps/stt-v2` | 10, 11, 12, 13, 26 (ASR pipeline part) | Legacy |
| Summarization & live documentation | `docs/traceability-matrix.md` | `apps/api` (`consultation` summary, `streaming` SMR proxy), `apps/smr` | 14, 15, 16 | Legacy |
| Medical NLP & guardrails (capability services) | `docs/traceability-matrix.md` | `apps/nlp`, `apps/guardrail` | 17, 18 | Legacy |
| Clinical documentation harness | `docs/traceability-matrix.md` | `apps/harness`, `apps/api` (`harness-admin`, `pipeline-policy-admin`), Temporal | 19, 20, 21, 22, 23 | Legacy |
| Prompt management & DNA writing style | `docs/traceability-matrix.md` | `apps/api` (`prompt-management`, `dna-writing-style`) | 24, 25, 34b | Legacy |
| Object storage & tenant buckets | `docs/traceability-matrix.md` | `apps/api` (`storage`, `tenant-bucket`, `tenant-storage-config`, `storage-access-key`), MinIO | 27 | Legacy |
| Platform ops (audit, settings, rate limit, metrics, queues, MCP) | `docs/traceability-matrix.md` | `apps/api` (`audit-log`, `global-setting`, `settings-catalog`, `throttle`, `admin-rate-limit`, `monitoring`, `platform-metrics`, `health`, `queue-admin`, `pstudio`, `mcp-admin`, `notification`, `resource-subscription`, `webhook`, `ai-service-admin`, `agentic-admin`) | 28, 29, 30, 31, 32, 33, 34, 34a, 34c, 34d | Legacy |
| Admin console (data grids, screens) | `docs/traceability-matrix.md` | `apps/admin-console`, `packages/ui` | 37 | Legacy |
| Browser SDK | `docs/traceability-matrix.md` | `packages/agentic-sdk-v2` (+ `room`, `vad`, `noise-filter`, `stt`, `med-ner`, `pipeline`) | 35 | Legacy |
| Federated learning (schema only) | `docs/traceability-matrix.md` | — (no app) | 36 | Legacy |

Legacy rows not yet re-verified here retain the `docs/traceability-matrix.md` `Last updated: 2026-07-06` provenance. Migrating a legacy domain means: build its `docs/traceability/<domain>.md` per the row contract below, move its rows out of the legacy file (leave the migrated-marker in place), and flip its Status here to **Migrated**.

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
- **The audit description is not the source of truth — the code is.** Where the TASK-538 Wave-1 audit or a ticket README mis-described a route or model, the verified code wins. (Example: the "test / directory-credentials / sync" routes the audit attributed to `tenant-tts-config` actually live on `tenant-idp-config`; they are recorded there.)
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
- **py(stt)** = `apps/stt-v2/tests/` · **py(smr)** = `apps/smr/src/smr_v2/tests/` · **py(grd)** = `apps/guardrail/src/guardrail/tests/` · **py(nlp)** = `apps/nlp/tests/` · **py(hrn)** = `apps/harness/src/harness/tests/` · **py(tts)** = `apps/tts-v2/src/tts_v2/tests/`

Last verified: 2026-07-21
