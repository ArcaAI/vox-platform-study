# TASK-413: Dependency Audit & Upgrade (Node.js + Python)

| Field | Value |
|---|---|
| **Status** | Review (Phases A+B+C complete 2026-07-04; uncommitted — holds: openid-client 5.7.1, ui pdfjs-dist 5.4.296; Phase D spun off as follow-up tickets) |
| **Classification** | infrastructure |
| **Created** | 2026-07-04 |
| **Owner** | — |
| **Scope** | All Node.js workspace packages (25 `package.json`) + all 5 Python services (uv workspace, conda `arcaenv`, `hope-python-base` image) |

---

## 1. Requirement Analysis

Review every dependency used by the Node.js and Python apps/services and:

1. **Python**: confirm all services resolve against the same base environment — one conda env (`arcaenv`) locally, one `uv.lock` for resolution, one `hope-python-base` Docker image for deployment.
2. **Currency**: bring dependencies to the latest versions that fit the pinned Node.js and Python versions.
3. **Consistency**: eliminate version collisions/conflicts across workspace packages and between manifests, lockfiles, Dockerfiles, and CI images.
4. Produce a phased bump plan with verification gates.

---

## 2. Current State Evaluation

### 2.1 Toolchain matrix (verified 2026-07-04)

| Tool | Declared | Local | Docker / CI | Status |
|---|---|---|---|---|
| Node.js | `engines: >=22.0.0` (root) | v24.12.0 | `node:22-slim/alpine` (api, ui-playground, database, CI); **`node:20-alpine` (apps/example)** | 22 = Maintenance LTS (EOL 2027-04); 24 = Active LTS. Example image below floor. |
| pnpm | `packageManager: pnpm@10.31.0` | 10.31.0 | **`PNPM_VERSION=10.6.5`** in api/ui-playground Dockerfiles | Drift. (pnpm 11.9.0 exists = major.) |
| TypeScript | `^5.9.3` everywhere except **`^5.4.0` in apps/example** | 5.9.3 | — | TS 6.0.3 exists (major). |
| Python | `requires-python >=3.11` (all 5 services), `.python-version` = 3.11 (guardrail missing the file) | conda `arcaenv` = 3.11.15 | `python:3.11-slim-trixie` (base image), `python:3.11-slim` (CI) | ✅ Consistent. 3.11 security-fixes-only, EOL 2027-10. |
| uv | lock `revision = 3` | 0.11.7 | 0.11.7 pinned in base image + stt-v2 GPU stage | ✅ Consistent. |

### 2.2 Python base-environment consistency — ✅ CONFIRMED (with 3 defects)

All five services (`stt-v2`, `smr`, `guardrail`, `nlp`, `harness`) share one base environment on every plane:

- **Local dev/test**: every root `py:*` script and `scripts/dev-service.sh` runs `conda run -n arcaenv`; `scripts/setup-python-env.sh` installs all five services into `arcaenv` (Python 3.11); stt-v2's Makefile uses `CONDA_ENV := arcaenv`.
- **Resolution**: single uv workspace at repo root → one `uv.lock` for all services; the stt-v2 `ml`-vs-`nemo` transformers conflict is handled via declared `[tool.uv] conflicts` (independent install profiles in the same lock).
- **Deployment**: all five Dockerfiles build `FROM hope-python-base` (python:3.11-slim-trixie + uv 0.11.7 + non-root `hope`) and install with `uv sync --frozen --package <svc>` against the root lock. Deliberate exceptions: stt-v2 GPU stages (`nvidia/cuda:12.8.1` + python3.11) and `Dockerfile.apple` (arm64 local variant).

**Defects found:**

| # | Severity | Finding | Evidence |
|---|---|---|---|
| P-1 | **P0 — breaks Docker builds** | `uv.lock` is STALE vs the pyprojects. `uv lock --check` fails ("lockfile needs to be updated"). Missing from lock: `faster-whisper`/`ctranslate2` (stt-v2 `[ml]`), `pymupdf`, `rapidocr-onnxruntime` (+opencv/shapely/pyclipper) (nlp OCR). Any `uv sync --frozen` image build fails today. | `uv lock --check` → exit 1 |
| P-2 | **P0 — guardrail runtime bug** | `apps/guardrail/pyproject.toml` declares `sqlalchemy[asyncpg]>=2.0.0` — **SQLAlchemy has no `asyncpg` extra** (uv warns). Result: `asyncpg` is NOT in guardrail's locked dependency closure, but the service connects via `postgresql+asyncpg://` (`core/config.py`). Works locally only because stt-v2 installs asyncpg into the shared conda env; a guardrail Docker image would crash on tenant-config DB access. Correct form (as in stt-v2): `sqlalchemy[asyncio]` + explicit `asyncpg`. | `uv lock` warning; guardrail block in `uv.lock` lacks asyncpg |
| P-3 | P2 — env drift | conda `arcaenv` has drifted below the lock (fastapi 0.135.3 vs 0.136.3, uvicorn 0.44 vs 0.49, onnxruntime 1.24.4 vs 1.26, openai 2.30 vs 2.41, sqlalchemy 2.0.49 vs 2.0.50, structlog 25.5 vs 26.1). `pip install -e` resolves freshly, so drift is structural — refresh after each re-lock. | `pip list` in arcaenv vs `uv.lock` |

Minor: guardrail is missing `.python-version` (other 4 services have it); guardrail has a stray `[dependency-groups] dev = ["ruff>=0.15.8"]` duplicating its `dev` extra with a different floor.

### 2.3 Python currency (locked → latest on PyPI)

`uv lock --upgrade --dry-run` resolves cleanly (458 packages, **no conflicts**) and would pick up:

| Package | Locked | Latest | Note |
|---|---|---|---|
| fastapi | 0.136.3 | 0.139.0 | in-range |
| uvicorn | 0.49.0 | 0.50.0 | in-range |
| pydantic | 2.13.4 | 2.13.4 | ✅ current |
| dramatiq | 2.1.0 | 2.2.0 | **2.2 allows redis <9** → unblocks R-1 below |
| redis-py | 6.4.0 | 8.0.1 | capped `<7.0` by stt-v2 (stale reason — see R-1) |
| temporalio | 1.28.0 | 1.30.0 | run harness replay-compat tests |
| onnxruntime | 1.26.0 | 1.27.0 | in-range |
| openai | 2.41.0 | 2.44.0 | in-range |
| sqlalchemy | 2.0.50 | 2.0.51 | in-range |
| opentelemetry-* | 1.42.1 / 0.63b1 | 1.43.0 / 0.64b0 | in-range |
| pyannote.audio | 4.0.4 | 4.0.7 | in-range; **4.0.7 relaxes to `torch>=2.8.0`** (no longer `==2.8.0`) |
| pytest / ruff / black | 9.0.3 / 0.15.16 / 26.5.1 | 9.1.1 / 0.15.20 / current | in-range |
| boto3 | 1.43.25 | 1.43.40 | in-range |
| cryptography | 48.0.0 | 46.0.7 | 48.0.0 appears yanked upstream; re-lock will (correctly) downgrade |
| **HOLD** torch/torchaudio | 2.8.0 | 2.12.1 | torch 2.12 needs torchcodec ≥0.10 → FFmpeg 7, but conda env pins FFmpeg 6.x for PyAV/torchcodec 0.7 compat. Separate ML ticket. |
| **HOLD** transformers (stt-v2 `[ml]`) | ==5.5.4 | 5.13.0 | exact pin for Whisper-ONNX/optimum orchestration; nemo profile stays 4.57.x by design |
| **HOLD** optimum | ==2.1.0 | 2.2.0 | paired with transformers pin |
| nemo-toolkit / faster-whisper / spacy / structlog | 2.7.3 / 1.2.1 / 3.8.14 / 26.1.0 | same | ✅ already latest |

Cleanups enabled by re-locking:
- **R-1**: stt-v2 caps `redis[hiredis]>=5.2.0,<7.0` because "dramatiq 2.0.x pins redis<7.0". dramatiq 2.2.0 requires `redis>=4.0,<9.0` → cap can be lifted to `<9.0` (redis-py 8.x). Needs a smoke test of Redis Streams paths (stt-v2 streaming, smr resume).
- **R-2**: stt-v2's `qdrant-client` is documented LEGACY/UNUSED, "retained only because `uv lock` cannot currently re-resolve … drop when fixed". We are re-locking → drop it (verify zero imports first).

### 2.4 Node.js findings

Lockfile is healthy (`pnpm install --frozen-lockfile` clean, "Already up to date"). `pnpm outdated -r` reports ~150 outdated entries — full list via `pnpm outdated -r`; notable items below.

**Collisions / inconsistencies (fix regardless of bumps):**

| # | Finding | Where |
|---|---|---|
| N-1 | **`@types/express` ^4.17.25 while the installed runtime is express 5.2.1** (via `@nestjs/platform-express` 11). Types lie about the runtime. → `^5.x` | `apps/api` |
| N-2 | `@arcaai/config-eslint` still on **ESLint 8.57.1 + typescript-eslint 7.18** while every other package uses ESLint 9.39.4 + typescript-eslint 8.57.1 (two ESLint majors coexist; legacy `ESLINT_USE_FLAT_CONFIG=false` mode everywhere) | `packages/config-eslint` |
| N-3 | `apps/example` frozen in time: Vite ^5, TS ^5.4, plugin-react-swc ^3.5, Dockerfile `node:20-alpine` (below `engines >=22`) | `apps/example` |
| N-4 | `pdfjs-dist` **5.4.296 in `@arcaai/ui` vs ^6.0.227 in ui-playground** — two majors of the same PDF engine | ui / ui-playground |
| N-5 | OTel experimental packages span **three lines in one package**: 0.54.2 (exporter-prometheus, instrumentation, instrumentation-http), 0.60.1 (auto-instrumentations-node), 0.214.0 (api-logs, sdk-node) — duplicate `@opentelemetry/instrumentation` copies in the tree; latest line is 0.220.0 | `packages/applications`, `apps/api` |
| N-6 | `@arcaai/applications` peerDependency floors lag the concrete pins in `apps/api` (`@nestjs/common` ^11.0.13 vs 11.1.17 installed, bullmq ^5.42 vs 5.71, ioredis ^5.4.1 vs 5.10.1, nestjs-cls ^5.4.2 vs 5.4.3) | applications |
| N-7 | `apps/api` ships **two Redis clients**: `redis@^4.7.1` (latest 6.x) AND `ioredis@^5.10.1` | api |
| N-8 | `packages/stt` declares `engines: node >=18` vs root `>=22` | stt |
| N-9 | Dockerfile `PNPM_VERSION=10.6.5` vs `packageManager pnpm@10.31.0` | api, ui-playground Dockerfiles |
| N-10 | CI Playwright image `v1.58.0-noble` must move in lock-step with any `@playwright/test` bump | `.gitlab/ci/test.yml` |
| N-11 | `openid-client` exact-pinned at 5.7.1 (v6 is a ground-up rewrite; auth-critical) | applications |
| N-12 | Root pnpm override pins `class-validator` 0.14.1 (0.15.1 exists) — any bump must move override + api + root together | root |

**Currency (same-major, low risk — the bulk):** NestJS 11.1.17→11.1.27 (+cli/schematics/swagger/config/schedule/event-emitter), Prisma 7.5.0→7.8.0 (client/adapter-pg/generator-helper/internals/instrumentation aligned), vitest 4.1.1→4.1.9, @playwright/test 1.58.2→1.61.1, Tailwind 4.2.2→4.3.2, zod 4.3.6→4.4.3, turbo 2.8.20→2.10.3, axios 1.13.6→1.18.1, bullmq 5.71→5.79, ioredis 5.10.1→5.11.1, TanStack Router/Query minors, all Radix minors, Storybook 10.3.3→10.4.6, react 19.2.4→19.2.7, zustand 5.0.12→5.0.14, sharp, rollup, prettier, es-toolkit, framer-motion, helmet, ws, yaml, pg, tsx, dotenv, …

**Major-version gaps (need deliberate migration):**

| Cluster | From → To | Blast radius |
|---|---|---|
| TypeScript | 5.9.3 → 6.0.3 | every package; typecheck + tooling compat (ts-loader, tsc-alias, NestJS CLI, typescript-eslint) |
| Vite | 7.3.1 → 8.1.3 (+ @vitejs/plugin-react 4→6, plugin-react-swc 3→4) | ui-playground, vox, api dev tooling, Storybook builder |
| ESLint | 9.39.4 → 10.6.0 (flat-config only; config-eslint must first leave ESLint 8 + eslintrc mode) | all lint configs |
| Node runtime | 22 → 24 LTS (images, CI, engines, `@types/node` → ^24 — note current ^25.5.0 tracks an EOL odd major) | Dockerfiles, CI, engines |
| pnpm | 10.31.0 → 11.9.0 | packageManager, Dockerfiles, CI cache keys |
| Backend libs | pino 9→10 (+pino-roll 4), nodemailer 6→9, nestjs-cls 5→6, @casl/ability 6→7 + @casl/prisma 1→2, openid-client 5→6, http-proxy-middleware 3→4, class-validator 0.14→0.15, express-rate-limit 7→8, supertest 6→7, node-vault 0.10→0.12, redis(node) 4→6, pdf-parse 1→2, diff 8→9 | api + applications (auth/proxy/logging paths) |
| UI libs | recharts 2→3, react-resizable-panels 2→4, date-fns 3→4, @hookform/resolvers 3→5, ai 6→7, lexical 0.42→0.46, @elevenlabs/* 0.x→1.x/2.x, marked 17→18, jsdom 28→29, three/cobe | @arcaai/ui, ui-playground |
| Browser ML | @huggingface/transformers 3.8.1→4.2.0, onnxruntime-web/common 1.24.3→1.27.0 | vox, med-ner, stt, vad — local pipeline e2e required |
| LLM SDK | @langchain/core 0.3.80→1.2.1, @langchain/ollama 0.2.4→1.3.0 | applications LLM engine code |
| Codegen CLIs (dev-only) | chalk 4→5, commander 12→15, inquirer 8→14, ora 5→9, glob 10→13, yargs 17→18, ts-morph 21→28 | @arcaai/tools (verify with `generate-*-check`) |

---

## 3. Implementation Plan

Order: correctness first (A), then zero-risk hygiene + in-range sweep (B), then contained majors in tested batches (C). Ecosystem majors are split into follow-up tickets (D) — they are projects, not bumps.

### Phase A — Python: fix the base, re-lock, re-sync (P0)

| Step | Action | Verify |
|---|---|---|
| A1 | `apps/guardrail/pyproject.toml`: `sqlalchemy[asyncpg]>=2.0.0` → `sqlalchemy[asyncio]>=2.0.47` + add `asyncpg>=0.31.0` (mirror stt-v2); fold the stray `[dependency-groups]` ruff into the `dev` extra; add `apps/guardrail/.python-version` = 3.11 | `uv lock` runs with **zero warnings**; guardrail lock block contains asyncpg |
| A2 | `apps/stt-v2/pyproject.toml`: lift `redis[hiredis]>=5.2.0,<7.0` → `<9.0` and update the stale dramatiq comment; drop legacy `qdrant-client` (grep `qdrant` in `apps/stt-v2/src` first — README already declares it unused) | grep shows no runtime imports |
| A3 | `uv lock --upgrade` (single re-resolution; picks up everything in §2.3 incl. fastapi 0.139, temporalio 1.30, dramatiq 2.2, redis-py 8.x, onnxruntime 1.27) | `uv lock --check` passes; dry-run already proved conflict-free |
| A4 | Frozen-sync sanity for every member: `uv sync --frozen --package <svc> --dry-run` for guardrail, nlp, smr, harness, stt-v2 (+ optional real Docker build of `hope-python-base` + one service) | all five succeed — this is what CI/production images run |
| A5 | Refresh conda env: `pnpm py:setup --install` (`--apple` on this machine); keep conda-managed ffmpeg 6.x / av / numpy / scipy untouched | key imports OK (script verifies) |
| A6 | Full Python gate: `pnpm py:{stt-v2,smr-v2,guardrail,nlp,harness}:test` + `:lint` + `:typecheck`. Harness MUST include the Temporal replay-compat tests (temporalio 1.28→1.30) and is not covered by CI — run locally. Smoke Redis Streams paths (stt-v2 streaming, smr SSE resume) against redis-py 8 | paste outputs into §4 |

Holds (documented, not bumped): torch/torchaudio 2.8.x, torchcodec <0.8, transformers==5.5.4, optimum==2.1.0, the `ml`-vs-`nemo` conflict. Revisit in ticket D-6.

### Phase B — Node: hygiene fixes + in-range sweep

| Step | Action | Verify |
|---|---|---|
| B1 | Manifest fixes: N-1 (`@types/express` ^5), N-6 (align applications peerDep floors to api pins), N-8 (stt engines >=22), N-9 (`PNPM_VERSION=10.31.0` in both Dockerfiles) | `pnpm install` clean; no peer warnings |
| B2 | `apps/example` (N-3): TS ^5.9.3, Vite ^7, plugin-react-swc ^4 (stay off Vite 8 with the rest of the repo); Dockerfile `node:20-alpine` → `node:22-alpine` | `pnpm --filter live-transcription-example build` |
| B3 | In-range sweep: `pnpm -r update` (respects `^` ranges → NestJS 11.1.27, vitest 4.1.9, tailwind 4.3.2, zod 4.4.3, radix/tanstack/storybook minors, axios 1.18.1, …), then raise declared floors for the anchors we care about: Prisma → ^7.8.0 (all 5 packages incl. `@prisma/instrumentation`), @nestjs/* → ^11.1.27, @playwright/test → ^1.61.1, turbo → ^2.10.3 | `pnpm install` + `pnpm build` (turbo) green |
| B4 | N-10: bump `.gitlab/ci/test.yml` Playwright images `v1.58.0-noble` → matching `v1.61.x-noble` (2 jobs) | CI file grep |
| B5 | Gate: `pnpm test:unit`, `pnpm lint` (treat only-warn warnings as errors), `pnpm db:generate` + `pnpm build:api`, then `pnpm test:api:up` + `pnpm test:e2e` | paste outputs into §4 |

### Phase C — Contained majors, one batch per PR-sized change (each batch: bump → build → targeted tests → lint)

| Batch | Contents | Extra verification |
|---|---|---|
| C1 dev-only codegen (`@arcaai/tools`) | chalk 5, commander 15, inquirer 14 (+@types 9), ora 9, glob 13, yargs 18, ts-morph 28 | run all `gen:*` and CI `generate-*-check` parity — generated domain layer must not drift |
| C2 backend low-risk | pino 10 + pino-roll 4, nodemailer 9 (+@types 8), node-vault 0.12, supertest 7 (+@types 7), express-rate-limit 8, diff 9, pdf-parse 2, @prisma/studio-core 0.31, sharp minor | api unit + e2e; log-rotation smoke (`pino-roll` majors changed file naming) |
| C3 OTel alignment (N-5) | all experimental → ^0.220.0 (sdk-node, api-logs, exporters, instrumentation, instrumentation-http, auto-instrumentations-node ^0.78, instrumentation-nestjs-core ^0.66, exporter-prometheus ^0.220), resources/sdk-metrics → ^2.9, semantic-conventions ^1.41 | boot api with `pnpm infra:observability:up`; confirm traces + `/metrics` |
| C4 UI batch | date-fns 4, @hookform/resolvers 5, pdfjs-dist → ^6.1 in BOTH ui and ui-playground (N-4), react-resizable-panels 4, lexical 0.46, marked 18, jsdom 29, recharts 3 (chart API rewrite — Storybook visual pass), ai 7, elevenlabs, three/cobe | `pnpm --filter @arcaai/ui test` (Vitest browser + CT), Storybook build, ui-playground build |
| C5 browser ML | @huggingface/transformers 4.2.0 + onnxruntime-web/common 1.27.0 across vox/med-ner/stt/vad | package unit tests + med-ner e2e infra + manual local-pipeline transcription check |
| C6 auth/gateway-critical (each alone, feature-tested) | class-validator 0.15.1 (root override + api together, N-12), nestjs-cls 6 (api/domains/exceptions), @casl/ability 7 + @casl/prisma 2 (authorization engine — full policy test suite + cross-tenant e2e), http-proxy-middleware 4 (SMR/STT proxy paths), openid-client 6 (SSO rewrite; verify OIDC login e2e), redis(node) 4→6 or consolidate onto ioredis (N-7 — needs small code audit of `redis` client usage first), @langchain/core 1.x + @langchain/ollama 1.x | api e2e + cross-tenant suite per item; auth flows manually against dev stack |

### Phase D — Follow-up tickets (not in this task)

| # | Ticket | Content |
|---|---|---|
| D-1 | Node 24 LTS standardization | Dockerfiles + CI `node:22` → `node:24`, engines `>=22`→`>=24` (decide), `@types/node` → ^24 (off the EOL 25.x line) |
| D-2 | pnpm 11 | packageManager, Dockerfiles, CI caches |
| D-3 | TypeScript 6.0 | repo-wide typecheck, ts-loader/tsc-alias/NestJS CLI/typescript-eslint compat |
| D-4 | Vite 8 | + @vitejs/plugin-react 6, plugin-react-swc stays 4, Storybook/vitest browser alignment |
| D-5 | ESLint 10 + flat-config migration | retire `ESLINT_USE_FLAT_CONFIG=false`, rewrite `@arcaai/config-eslint` (drop ESLint 8 + ts-eslint 7, @vercel/style-guide 6 or remove, eslint-plugin-storybook 10, drop unused eslint-config-next?) |
| D-6 | Python ML stack refresh | torch 2.12 + torchcodec 0.10 + FFmpeg 7 (conda), transformers 5.13 + optimum 2.2 revalidation on Whisper-ONNX, revisit ml-vs-nemo conflict |
| D-7 | Python 3.12 evaluation | base image, conda env, wheels availability for full ML matrix |
| D-8 | Runtime-dead dependencies (found during C2/C6) | pino/pino-roll/pino-pretty, nodemailer, express-rate-limit, @langchain/core, @langchain/ollama are declared but have zero runtime imports (hand-rolled fs WriteStream logging, Graph mail, custom throttler; no LangChain usage) — decide adopt vs drop |
| D-9 | Codegen drift + gen:mapper crash (pre-existing, found during C1) | 5 model files + 2 factory columns drift from generator output (fails CI `generate-*-check`); `gen:mapper` crashes — both predate TASK-413 |
| D-10 | openid-client 5.7.1 → 6 migration (HELD in C6) | v6 removes the passport `Strategy`/`Issuer`/`Client` API (separate passport module, `Configuration`, `fetchUserInfo` + `expectedSubject`) — redesign of the OIDC/SSO service, needs an IdP-backed test env; migration sketch in Phase C evidence |
| D-11 | E2E harness race (pre-existing, exposed in C6) | AppSettings 45s cache cron vs `globalSetup` mid-run DB reset poisons the cache and duplicated the `rate-limit.enabled` platform row (TASK-302 boot invariant trip, intermittent 412 flakes) — suggested fixes in Phase C evidence |
| D-12 | ui pdfjs-dist → 6 (partially HELD in C4) | `react-pdf@10.4.1` hard-pins pdfjs-dist 5.4.296 and the timeline renderer bundles its worker from ui's copy; ui-playground already on ^6.1 — revisit when react-pdf supports pdfjs 6 |

### Effort estimate

Phase A ≈ 0.5–1 day · Phase B ≈ 1 day · Phase C ≈ 0.5–1 day per batch (C1–C6) · Phase D sized per ticket.

### Risk register

| Risk | Mitigation |
|---|---|
| temporalio 1.28→1.30 breaks workflow replay | harness replay-compat tests (A6) before merging; harness not in CI — local gate mandatory |
| redis-py 6→8 behavior changes (RESP3 defaults, timeouts) | Redis Streams smoke on stt-v2 + smr SSE resume; fakeredis in tests already >=2.21 |
| Playwright bump without CI image bump | B4 explicitly paired with B3 |
| class-validator 0.15 changes validation defaults | root override moves atomically; api e2e validation suite |
| recharts 3 / @casl 7 / openid-client 6 API rewrites | isolated batches in C4/C6 with dedicated feature verification, easy revert |
| conda env drift recurs | keep A5 (`py:setup --install`) as standard step after every `uv lock` |

---

## 4. Implementation Summary

### Phase A Evidence (Python)

**Status: Complete (2026-07-04).** All five services green on test + lint + typecheck against the re-locked dependency set; `uv lock --check` passes.

#### A1 — guardrail manifest fixes (P-2 + minor defects)

- `sqlalchemy[asyncpg]>=2.0.0` → `sqlalchemy[asyncio]>=2.0.47` **+ explicit `asyncpg>=0.31.0`** (mirrors stt-v2). The guardrail block in `uv.lock` now contains `asyncpg` in both `dependencies` and `metadata.requires-dist`; the bogus-extra warning is gone from `uv lock` output.
- Stray `[dependency-groups] dev = ["ruff>=0.15.8"]` removed; its stricter floor preserved by raising ruff to `>=0.15.8` in the `dev` and `lint` extras.
- Added `apps/guardrail/.python-version` = `3.11` (parity with the other 4 services).

#### A2 — stt-v2 manifest fixes (R-1 + R-2)

- **R-1**: `redis[hiredis]>=5.2.0,<7.0` → `<9.0`; stale dramatiq comment rewritten (dramatiq 2.2.0 declares `redis>=4.0,<9.0`).
- **R-2 (qdrant-client decision): REMOVED.** `rg -i qdrant apps/stt-v2/{src,tests}` shows zero runtime imports — only comments, the guard test `tests/unit/diarization/test_no_qdrant_vectorstore.py` (which asserts qdrant is NOT imported; still passes), and the mypy override. Dependency + comment dropped, `qdrant_client.*` removed from mypy overrides. `qdrant-client` 1.18.0 remains in the lock solely via harness's optional `[rag]` extra.
- torch/torchaudio/torchcodec/transformers/optimum/faster-whisper pins and the `ml`-vs-`nemo` conflict mechanism untouched (deliberate holds → ticket D-6).

#### A3 — `uv lock --upgrade` (single full re-resolution, uv 0.11.7)

Resolved 458 packages, zero warnings. P-1 fixed: previously-unlocked `faster-whisper==1.2.1`/`ctranslate2==4.8.1` (stt-v2 `[ml]`) and `pymupdf==1.28.0`/`rapidocr-onnxruntime==1.4.4` (+opencv 5.0.0.93/shapely 2.1.2/pyclipper 1.4.0, nlp OCR) are now locked. Key movements (locked → locked):

| Package | Before | After |
|---|---|---|
| fastapi | 0.136.3 | 0.139.0 |
| uvicorn | 0.49.0 | 0.50.0 |
| dramatiq | 2.1.0 | 2.2.0 |
| redis | 6.4.0 | **8.0.1** |
| temporalio | 1.28.0 | 1.30.0 |
| onnxruntime | 1.26.0 | 1.27.0 |
| openai | 2.41.0 | 2.44.0 |
| sqlalchemy | 2.0.50 | 2.0.51 |
| pyannote-audio | 4.0.4 | 4.0.7 |
| cryptography | 48.0.0 | 46.0.7 (48.0.0 yanked upstream — expected downgrade) |
| pytest / ruff / black | 9.0.3 / 0.15.16 / 26.3.1 | 9.1.1 / 0.15.20 / 26.5.1 |
| mypy | 1.20.0 | **2.1.0** (new major; caused the workflows.py findings below) |
| opentelemetry | 1.42.1 / 0.63b1 | 1.43.0 / 0.64b0 |

Holds honored: torch/torchaudio 2.8.0, torchcodec 0.7.0, transformers==5.5.4, optimum==2.1.0, nemo profile 4.57.x.

```text
$ uv lock --check
Resolved 458 packages in 11ms   # exit 0 — lock is up to date
```

#### A4 — frozen-sync sanity (what Docker/CI runs)

`uv sync --frozen --package <pkg> --dry-run` from the repo root succeeds for all five members: `guardrail`, `nlp`, `smr-v2` (package name — not `smr`), `harness`, `stt-v2`. No root `.venv` created.

#### A5 — conda `arcaenv` refresh

`./scripts/setup-python-env.sh --install --apple` completed (all key-import verifications OK, MPS available, libomp dedup applied). Because `pip install -e` does not upgrade already-satisfied ranges (the structural P-3 drift), the env was then pinned to the exact lock closure: `uv export --frozen` per service (stt-v2 with `[ml]`) merged into one pin list (markers evaluated for darwin/arm64 py3.11; conda-managed `av`/`numpy`/`scipy` excluded) and applied with `pip install --no-deps -r`. Result: **0 deviations from the lock** across 251 pinned requirements (conda keeps av 13.1.0 / numpy 2.4.3 / scipy 1.17.1 / ffmpeg 6.1.2 by design); sklearn's bundled libomp re-symlinked to conda's. `pip check`: only pre-existing stray `mkdocs-material` (not in any service tree) complains about `babel`.

#### A6 — quality gates (all via root `pnpm py:*` → conda `arcaenv`)

Tests:

```text
py:smr-v2:test      762 passed, 29 deselected, 8 warnings in 144.09s
py:guardrail:test    44 passed in 2.33s
py:nlp:test          48 passed, 30 warnings in 1.90s
py:harness:test     638 passed, 3 warnings in 24.00s   # incl. ALL replay-compat tests:
                    # test_replay_compat.py 5/5 PASSED (pre-task345/task345/post-task348/
                    # post-task355 optimistic + regen histories) + gating-consolidation
                    # replay fixtures byte-identical — temporalio 1.28→1.30 replay-safe
py:stt-v2:test:unit 2080 passed, 13 warnings in 29.36s
py:stt-v2:test      2283 passed, 70 skipped, 3 xfailed in 107.30s  (first run: test infra down,
                    # integration auto-skipped)
py:stt-v2:test:integration  (re-run with pnpm docker:test:up)  32 passed, 1 skipped, 4 errors
                    # PASSED: all Redis (streams/pubsub/hash/queue vs live Redis 8 server),
                    # MinIO storage, chunk storage. ERRORS: 4 test_database.py setups fail with
                    # 'type "core.PromptTemplateCategory" does not exist' — fresh test Postgres
                    # volume has no Prisma schema (needs Node-side `pnpm test:db:reset`);
                    # environment bootstrap issue, NOT dependency breakage. 1 skip = latency
                    # harness (needs live stt-v2 on :8861).
```

Lint (ruff): `All checks passed!` for stt-v2, smr-v2, guardrail, nlp, harness.

Typecheck (mypy 2.1.0): `Success: no issues found` — stt-v2 (103 files), smr-v2 (45), guardrail (22), nlp (36), harness (79).

**redis-py 8 decision: KEPT (no fallback to <8.0).** Canaries all green: stt-v2 streaming unit tests (220 passed), smr fakeredis suite (762 passed, fakeredis 2.36.2), and stt-v2 Redis integration tests against a real Redis server (streams/pubsub/queue paths).

Upgrade-driven code fixes (2 files):

1. `apps/smr/src/smr_v2/tests/unit/test_lifespan.py` — FastAPI 0.139 includes routers lazily (`app.routes` now holds opaque `_IncludedRouter` wrappers instead of flattened `APIRoute`s), so the recursive route walker found no service paths. `collect_route_paths` now walks the OpenAPI schema plus top-level plain routes. Test-only; app code unchanged.
2. `apps/harness/src/harness/temporal/workflows.py` — 4 new mypy 2.1.0 findings: annotated the two TASK-355 Slice-4b nested helpers (`_deliver_early`, `_regen_compute`), dropped a duplicate `inferential_results` annotation, added `assert verdict is not None` narrowing in the legacy persist branch. Annotation/assert-only — no behavior or command-sequence change; full replay-compat suite re-run after the edit (638 passed).

Files changed (full inventory): `apps/guardrail/pyproject.toml`, `apps/guardrail/.python-version` (new), `apps/stt-v2/pyproject.toml`, `uv.lock` (via uv only), plus the two upgrade fixes above.

### Phase B Evidence (Node)

**Completed 2026-07-04.** Hygiene fixes + in-range sweep + listed floor raises only — no new majors introduced (`pnpm update --latest` never used).

**B1 — Manifest hygiene**

- `apps/api`: `@types/express` ^4.17.25 → **^5.0.6** (N-1; runtime is express 5.2.1 via @nestjs/platform-express 11). `nest build` green with **zero type fallout** — no source changes required.
- `packages/stt`: `engines.node` >=18.0.0 → **>=22.0.0** (N-8).
- `apps/api/Dockerfile` + `apps/ui-playground/Dockerfile`: `ARG PNPM_VERSION` 10.6.5 → **10.31.0** (N-9); nothing else touched in either file.
- `packages/applications` peerDependency floors aligned to the post-sweep `apps/api` pins (N-6): `@nestjs/common`+`core` ^11.0.13→**^11.1.27**, `@nestjs/bullmq` ^11.0.2→**^11.0.4**, `@nestjs/schedule` ^6.0.0→**^6.1.3**, `@nestjs/swagger` ^11.0.0→**^11.4.5**, `bullmq` ^5.42.0→**^5.79.2**, `ioredis` ^5.4.1→**^5.11.1**, `nestjs-cls` ^5.4.2→**^5.4.3**. All other peers untouched.

**B2 — apps/example modernization (N-3)**

- `typescript` ^5.4.0→**^5.9.3**, `vite` ^5.0.0→**^7.3.1** (resolves 7.3.6), `@vitejs/plugin-react-swc` ^3.5.0→**^4.3.1**; Dockerfile `node:20-alpine`→**`node:22-alpine`**.
- Gate: `pnpm --filter live-transcription-example build` → `vite v7.3.6 … ✓ built in 398ms` (no tsconfig changes needed).

**B3 — In-range sweep + anchor floors**

`pnpm -r update` (in-range lockfile refresh across all 25 manifests), then declared floors raised for the anchors. Resolved before→after: Prisma family 7.5.0→**7.8.0** (client/adapter-pg/generator-helper/internals/instrumentation, all `^7.8.0` in root, database, domains, applications, tools, api), NestJS 11.1.17→**11.1.27** (`^11.1.27` common/core/microservices/platform-*/websockets/testing; cli **^11.0.23**, schematics **^11.1.0**, swagger **^11.4.5**, config **^4.0.4**, schedule **^6.1.3**, event-emitter **^3.1.0**), `@playwright/test` 1.58.2→**1.61.1** (root + 7 SDK packages; `playwright` + `@playwright/experimental-ct-react` ^1.61.1 in ui), `turbo` 2.8.20→**2.10.3**, vitest 4.1.1→**4.1.9**, tailwind 4.2.2→**4.3.2**, zod 4.3.6→**4.4.3**, axios 1.13.6→**1.18.1**, react 19.2.4→**19.2.7**, storybook 10.3.3→**10.4.6**, bullmq 5.71.0→**5.79.2**, ioredis 5.10.1→**5.11.1**, prettier 3.8.1→**3.9.4**, plus radix/tanstack/aws-sdk/OTel-stable minors.
- `pnpm db:generate` after the Prisma bump: `✔ Generated Prisma Client (7.8.0)` + barrel regenerated.
- Deliberate hold: `packages/vad` devDep `onnxruntime-web` restored to exact **1.24.3** — the sweep moved it to 1.27.0, but the browser-ML line (`ORT_WEB_VERSION` CDN pin + TASK-271 guard test) upgrades as a set in Phase C5.
- New root `pnpm.peerDependencyRules.allowedVersions`: `"bullmq>redis": "4"` (bullmq 5.79 added an optional `redis>=5` peer; api's node-redis stays 4 until C6) and `"@base-ui/react>date-fns": "3"` (base-ui 1.6 optionally peers on date-fns 4; date-fns 4 is C4; @arcaai/ui uses no base-ui date components). Both entries are documented deferrals — remove with C6/C4. With these, `pnpm install` resolves with **zero peer warnings**.

**B4 — CI Playwright images (N-10)**

`pnpm ls @playwright/test --depth 0` → `@playwright/test@1.61.1` ⇒ both `.gitlab/ci/test.yml` jobs (`test-ui-ct`, `test-api-e2e`) moved `mcr.microsoft.com/playwright:v1.58.0-noble` → **`v1.61.1-noble`**.

**B5 — Gates**

- `pnpm build` → `Tasks: 19 successful, 19 total` ✅
- `pnpm lint` → `Tasks: 28 successful, 28 total` ✅
- `pnpm test:unit` → `Test Files 2 failed | 787 passed | 2 skipped (791) · Tests 2 failed | 14996 passed | 4 skipped | 9 todo (15011)`. The 2 failures are **pre-existing at HEAD**, not bump-related (inputs byte-identical to HEAD): `tenant-scope.test.ts` drift guard — `TenantEntitlement`/`TenantUsageMeter` (added in `entitlement.prisma` by the admin-console commit 305a332f) are missing from `TENANT_SCOPED_MODELS`; `seed-global-settings.test.ts` expects 58 seed IDs, seed constants define 57. Both need owner decisions (tenancy allow-list + seed ID), left unfixed by design.
- E2E: `pnpm docker:test:up` (infra healthy), schema loaded onto the empty test DB via plain `db push` (no force-reset needed) + `pnpm test:db:seed`, `pnpm test:api:up` (API healthy on :8868), `pnpm test:e2e` → **`519 passed, 17 skipped (55.2s)`** ✅ (a first pass had 1 transient `read ECONNRESET` on one spec; it passes in isolation and in the clean full rerun).

**Upgrade fallout fixed (all bump-caused)**

- `packages/applications/src/services/queue-admin/queue-admin.service.ts` — bullmq 5.79 narrowed `queue.client` to its adapter-agnostic `IRedisClient` (no `ping`); narrow cast keeps the TASK-403 Redis health probe compiling (ioredis proxy still forwards PING at runtime).
- prettier 3.9 reformats (via each package's `lint --fix`): 1 file in noise-filter, 2 in ui, 12 in apps/api (formatting-only).
- `turbo.json#globalEnv` + `OTEL_SDK_DISABLED` — read by `apps/api/src/instrumentation.ts` (TASK-411) but never declared; eslint-config-turbo 2.10 now flags it (`turbo/no-undeclared-env-vars`).

### Phase C Evidence (Node major batches)

_Executed 2026-07-04 (C1 → C2 → C3, strictly sequential). Gate baseline: 2 pre-existing `test:unit` failures (`tenant-scope.test.ts`, `seed-global-settings.test.ts`) and the existing lint-warning fingerprint (107/71/6/5 warnings across 4 packages via eslint-plugin-only-warn). No items held or reverted in any batch._

#### C1 — dev-only codegen CLIs (`packages/tools`)

Version movements (all in `packages/tools/package.json`):

| Package | Before | After |
|---|---|---|
| chalk | ^4.1.2 | ^5.6.2 |
| commander | ^12.1.0 | ^15.0.0 |
| glob | ^10.5.0 | ^13.0.6 |
| inquirer | ^8.2.7 | ^14.0.2 |
| @types/inquirer | ^8.2.12 | removed (inquirer 14 ships its own types) |
| ora | ^5.4.1 | ^9.4.1 |
| ts-morph | ^21.0.1 | ^28.0.0 |
| yargs | ^17.7.2 | ^18.0.0 |

ESM-only pitfall resolution: `@arcaai/tools` is CJS (`module: commonjs`, run via `ts-node`), but Node 24 (>=22.12) supports native `require()` of ESM modules, and `esModuleInterop` handles the default-export shapes — chalk 5 / ora 9 / inquirer 14 / commander 15 / yargs 18 all load without a package ESM conversion. No holds needed.

Code fixes:
- `packages/tools/src/generate-repository/index.ts` — `import * as inquirer` → `import inquirer` (inquirer 14 default-export shape); removed an unused `import glob from 'glob'` (glob 13 has named exports only; the import was dead code).

Gates:
- Generator parity (the CI `generate-*-check` jobs from `.gitlab/ci/validate.yml`): `generate-data-model:check`, `generate-data-entity:check`, `generate-factory:check` produce **byte-identical output before vs. after the bumps** (verified by diffing captured logs with timestamps stripped: "IDENTICAL after timestamp strip" for all three). Note: model-check (5 drifted files) and factory-check (2 missing columns) fail identically pre- and post-bump — that drift **pre-dates C1** (working-tree state, unrelated to dependencies) and is unchanged by it. `generate-data-entity:check`: `no drift — 59 generated file(s) match` both runs.
- `pnpm gen:prisma generate --all` — regenerated cleanly, `git status` showed no changes to generated files afterward.
- `gen:mapper` — crashes with a **pre-existing** `TypeError: Cannot read properties of undefined (reading 'fields')` identically before and after the bump; it is not one of the CI-gated checks. Formatting side-effects from the crashed run were reverted (`git checkout -- packages/domains/src/mappers`).
- Root `pnpm build` — `Tasks: 19 successful, 19 total` (includes `@arcaai/tools` typecheck; the package has no build step).
- `pnpm lint` — exit 0, warning fingerprint identical to baseline (107/71/6/5).

#### C2 — backend low-risk majors

Version movements:

| Package | Where | Before | After |
|---|---|---|---|
| pino | applications | ^9.14.0 | ^10.3.1 |
| pino-roll | api + applications | ^3.1.0 | ^4.0.0 |
| pino-pretty | api + applications | ^13.1.3 | ^13.1.3 (already the pino-10-compatible major; unchanged) |
| nodemailer | applications | ^6.10.1 | ^9.0.3 |
| @types/nodemailer | applications | ^6.4.23 | ^8.0.1 |
| node-vault | applications (dep) + database (devDep) | ^0.10.10 | ^0.12.0 |
| supertest | api | ^6.3.4 | ^7.2.2 |
| @types/supertest | api | ^6.0.3 | ^7.2.0 |
| express-rate-limit | api | ^7.5.1 | ^8.5.2 |
| diff | applications + ui-playground + vox (agentic-sdk-v2) | ^8.0.4 | ^9.0.0 (all three aligned) |
| pdf-parse | api | ^1.1.1 | ^2.4.5 |
| @types/pdf-parse | api | ^1.1.5 | removed (pdf-parse 2 ships its own types) |
| @prisma/studio-core | applications + ui-playground | ^0.15.0 | ^0.31.2 |

Code fixes:
- `apps/api/src/modules/streaming/smr-proxy.controller.ts` — pdf-parse v2 is a full rewrite: replaced the callable default export with the new `PDFParse` class API (`new PDFParse({ data })` → `getText()` → `destroy()`).
- `apps/api/src/modules/pstudio/pstudio.html.ts` — `STUDIO_VERSION` `'0.15.0'` → `'0.31.2'` so the CDN-served embedded-Studio shell stays in lock-step with the `@prisma/studio-core` BFF executor resolved in `packages/applications` (TASK-038 surface builds and version-matches).

Findings (documented, no action needed):
- pino / pino-roll / pino-pretty are **declared but unused at runtime** in both api and applications — zero `pino` imports in src; the LoggingService `FileTransport` is a hand-rolled `fs.WriteStream` implementation with its own daily rotation. The bumps are manifest-only risk.
- nodemailer has **zero runtime imports** — password-reset mail goes through Microsoft Graph (`msgraph-mailer.ts`). Manifest-only.
- express-rate-limit is unused by the custom `TieredThrottlerGuard`; manifest-only.
- node-vault 0.12 still uses axios internally and preserves the `err.response.statusCode` error shape consumed by `VaultSecretsProvider` (verified against the shipped 0.12 source).
- diff v9 `createPatch` header change (no trailing tabs) does not affect existing assertions (`toContain`-based).

Gates:
- `pnpm build` — `Tasks: 19 successful, 19 total`.
- `pnpm test:unit` — `Test Files 2 failed | 787 passed | 2 skipped (791); Tests 2 failed | 14996 passed` — the 2 failures are exactly the known baseline (`tenant-scope.test.ts`, `seed-global-settings.test.ts`). No new failures.
- `pnpm lint` — exit 0, warning fingerprint identical (107/71/6/5).
- `pnpm test:e2e` — final clean run against the canonical `pnpm test:api:up` instance: **`519 passed, 17 skipped` (exit 0), exactly the Phase B baseline**. Earlier same-day runs on a busy machine showed 1–2 transient `read ECONNRESET` / test-data-contention flakes (same flake class Phase B recorded); each flaky spec passed in the clean rerun.
- pdf-parse v2 runtime smoke — generated a PDF with pdfkit and parsed it through the new class API: `PDF_PARSE_V2_SMOKE text: "task413 c2 pdf-parse smoke OK\n\n-- 1 of 1 --"`.
- Log-rotation smoke — booted the compiled API with `LOG_FILE_ENABLED=true LOG_FILE_PATH=/tmp/task413-c2-logsmoke` (test env): `combined-2026-07-04.log` + `error-2026-07-04.log` created on boot and receive JSON entries on error-level events (`.env.test` sets `LOG_LEVEL=error`), e.g. the failed-login `Request failed` entry landed in both files. Rotation is date-stamped by the in-house FileTransport (pino-roll is not on the runtime path — see Findings).

#### C3 — OpenTelemetry alignment (N-5)

Version movements (stable line `resources` ^2.9.0, `sdk-metrics` ^2.9.0, `semantic-conventions` ^1.41.1 and peer `@opentelemetry/api` ^1.9.1 were already at target from Phase B):

| Package | Where | Before | After |
|---|---|---|---|
| @opentelemetry/sdk-node | api + applications | ^0.214.0 | ^0.220.0 |
| @opentelemetry/sdk-logs | api | ^0.214.0 | ^0.220.0 |
| @opentelemetry/api-logs | applications | ^0.214.0 | ^0.220.0 |
| @opentelemetry/exporter-logs-otlp-grpc | api | ^0.214.0 | ^0.220.0 |
| @opentelemetry/exporter-trace-otlp-grpc | api | ^0.214.0 | ^0.220.0 |
| @opentelemetry/exporter-prometheus | applications | ^0.54.2 | ^0.220.0 |
| @opentelemetry/instrumentation | applications | ^0.54.2 | ^0.220.0 |
| @opentelemetry/instrumentation-http | applications | ^0.54.2 | ^0.220.0 |
| @opentelemetry/instrumentation-nestjs-core | applications | ^0.40.0 | ^0.66.0 |
| @opentelemetry/auto-instrumentations-node | api + applications | ^0.60.1 | ^0.78.0 |

Code fixes:
- `apps/api/src/instrumentation.ts` — sdk-logs 0.220 changed `BatchLogRecordProcessor` to an options-object constructor: `new BatchLogRecordProcessor(exporter)` → `new BatchLogRecordProcessor({ exporter })`. (The file already used `resourceFromAttributes` + `ATTR_*` semconv constants from Phase B, so no further API migration was needed. The 0.54-line packages in applications had no direct runtime imports — only `api-logs` is imported, by the OTel log-bridge transport.)

Gates:
- `pnpm build` — `Tasks: 19 successful, 19 total` (after the one mechanical fix above; the pre-fix failure was exactly that constructor signature).
- `pnpm test:unit` — `2 failed | 14996 passed` — same 2 known baseline failures only.
- `pnpm lint` — exit 0, warning fingerprint identical (107/71/6/5).
- `pnpm test:e2e` — **`519 passed, 17 skipped` (exit 0)** — matches the Phase B baseline exactly.
- Boot smoke (compiled `dist/main.js` with `--import ./dist/instrumentation.js`, test env):
  - Default path (no `OTEL_EXPORTER_OTLP_ENDPOINT`): boots clean, logs `[OTel] Telemetry export disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)`; `/api/v1/health` 200; `GET /metrics` 200 `text/plain; version=0.0.4` with Prometheus counters (served by prom-client via `@willsoto/nestjs-prometheus`, independent of the OTel SDK).
  - Export path with an unreachable collector (`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317`, nothing listening): NodeSDK starts, API boots and stays healthy under traffic for 40+ s — health 200, `/metrics` 200, **no crash and no error spam** (gRPC export failures are swallowed at the default diag level; set `OTEL_DEBUG=true` to surface them). Degrades gracefully.

#### C4 — UI majors (@arcaai/ui + apps/ui-playground + jsdom sweep)

Version movements:

| Package | Where | Before | After |
|---|---|---|---|
| date-fns | ui + ui-playground | ^3.6.0 | ^4.4.0 |
| @hookform/resolvers | ui + ui-playground | ^3.10.0 | ^5.4.0 |
| pdfjs-dist | ui-playground | ^6.0.227 | ^6.1.200 |
| pdfjs-dist | ui | 5.4.296 | **HELD 5.4.296** (see below) |
| react-resizable-panels | ui | ^2.1.9 | ^4.12.1 |
| lexical + @lexical/* (whole family) | ui | 0.42.0 | ^0.46.0 |
| marked | ui | ^17 | ^18.0.5 |
| jsdom | logger, med-ner, ui-playground, vad, vox, root | ^28 | ^29.1.1 |
| three / @types/three | ui | ^0.183 / ^0.183 | ^0.185.1 / ^0.185.0 |
| cobe | ui | ^0.6.5 | ^2.0.1 |
| recharts | ui | ^2.15.4 | ^3.9.2 |
| ai | ui | ^6.0.135 | ^7.0.15 |
| @elevenlabs/elevenlabs-js | ui | ^2.40 | ^2.56.0 (same-major latest) |
| @elevenlabs/client | ui | 0.x | ^1.14.0 |
| @elevenlabs/react | ui | 0.x | ^1.9.0 |

Deferral removed: root `pnpm.peerDependencyRules.allowedVersions["@base-ui/react>date-fns"] = "3"` deleted (date-fns 4 satisfies the peer natively).

Partial hold — **ui `pdfjs-dist` stays exact `5.4.296`**: `react-pdf@10.4.1` (latest 10.x) hard-pins `pdfjs-dist 5.4.296`, and `packages/ui/src/components/timeline/renderers/pdf-document.tsx` bundles the worker from ui's own `pdfjs-dist` so the worker version must byte-match react-pdf's runtime. Bumping ui to ^6.1 would split worker/runtime versions. The N-4 "same range in both" goal is therefore only achievable when react-pdf ships a pdfjs-dist 6 line — flagged for a later ticket. ui-playground (direct pdfjs consumer, no react-pdf) did move to ^6.1.

Code fixes:
- `packages/ui/src/components/registries/elevenlabs/conversation-bar.tsx` — migrated to the @elevenlabs/react 1.x API (provider-based `useConversation` contract).
- `packages/ui/src/components/__tests__/shadcn/accordion.test.tsx` — Radix accordion 1.2.15 only renders `aria-controls` while expanded; test now opens the item first.
- `packages/ui/src/components/__tests__/shadcn/toggle-group.test.tsx` — Radix toggle-group 1.1.14 exposes single-select groups as `role="radiogroup"` (was `group`).
- `packages/ui/src/components/__tests__/shadcn/chart.test.tsx` — Recharts 3 `ResponsiveContainer` renders children inside a 0×0 measurement div; `toBeVisible()` → `toBeAttached()`.
- `packages/ui/.storybook/main.ts` — added the missing `'@/components/ui' → src/components/shadcn` Vite alias (pre-existing gap exposed by the C4 Storybook gate).
- `packages/ui/src/components/shadcn/chart.tsx` — Prettier formatting (restores the 107-warning lint fingerprint).

Gates:
- `pnpm --filter @arcaai/ui build` ✓; ui Vitest browser/Playwright CT suite green after the 4 test/impl fixes above (11 failures pre-fix → 0).
- Storybook production build ✓ (after the alias fix).
- `pnpm --filter @arcaai/ui-playground build` ✓; its Vitest suite has **1 pre-existing failure** (`DOMMatrix is not defined` — pdfjs-dist loaded under jsdom via a bare `@arcaai/ui` import the test stub doesn't intercept). Verified pre-existing by `git stash` + `pnpm install --frozen-lockfile` at the pre-C4 baseline: same failure. Not a C4 regression.
- Root `pnpm build` ✓ (a first failure was an `ENOTEMPTY` race from a stale `nest start --watch` left by an earlier session — killed the watcher, clean rebuild). `pnpm test:unit` = 2 known baseline failures only. `pnpm lint` exit 0, fingerprint 107/71/6/5.

#### C5 — browser ML lock-step (vox, med-ner, stt, vad)

Version movements (one lock-step set):

| Package | Where | Before | After |
|---|---|---|---|
| @huggingface/transformers | stt (exact) | 3.8.1 | 4.2.0 |
| @huggingface/transformers | vox, med-ner | ^3.8.1 | ^4.2.0 |
| onnxruntime-web + onnxruntime-common | stt, vox (exact) | 1.24.3 | 1.27.0 |
| onnxruntime-web (devDep, Phase B hold released) | vad | 1.24.3 | 1.27.0 |

Deferral removed: the Phase B exact-pin hold on vad `onnxruntime-web` 1.24.3.

Code fixes (CDN/wasm pin kept in lock-step, TASK-271 guard):
- `packages/vad/src/constants.ts` — `ORT_WEB_VERSION` `'1.24.3'` → `'1.27.0'` (the TASK-271 guard test asserts this matches the installed package).
- `packages/vad/README.md` — same constant reference updated.

Compatibility check: `@huggingface/transformers@4.2.0` bundles `onnxruntime-web 1.27.x` (verified in its `node_modules` package.json) — consistent with the 1.27.0 pins; no `env.backends`/wasm-path API changes affecting med-ner/stt/vox call sites.

Gates:
- Unit tests green for vox, med-ner, stt, vad, noise-filter, pipeline (scoped `pnpm test:unit` runs).
- med-ner Playwright e2e (TASK-281/289/290): chromium project runs — `12 passed`; 28 failures are missing Firefox/WebKit browser binaries on this machine (environment, not code), and 2 chromium entity-extraction tests return 0 entities — **verified pre-existing** by reverting med-ner to `^3.8.1` + reinstall: identical 0-entity behavior at baseline (local WebGPU/SwiftShader model-output issue). Restored to ^4.2.0.
- Root `pnpm build` ✓ and `pnpm lint` fingerprint unchanged (an intermediate `pnpm install` left broken `@tailwindcss/postcss` symlinks after a stash round-trip; `pnpm install --force` rebuilt the virtual store — no manifest impact).
- NOT verified here (needs a human): an in-browser local-pipeline transcription smoke test (vox/stt with real mic + models). Recommended before release.

#### C6 — auth/gateway-critical majors, one item at a time

Per-item verdicts (each item: bump → install → api-level build → targeted unit tests → API restart → full `pnpm test:e2e`):

| # | Item | Verdict |
|---|---|---|
| 1 | class-validator 0.14.1 → 0.15.1 (root override + root dep + api + applications peer, atomic) | **Landed** |
| 2 | nestjs-cls ^5.4.3 → ^6.2.1 (api, domains, exceptions + applications peer) | **Landed** |
| 3 | @casl/ability ^6.8.1 → ^7.0.0 + @casl/prisma ^1.6.2 → ^2.0.1 (applications) | **Landed** |
| 4 | http-proxy-middleware ^3.0.7 → ^4.1.1 (api) | **Landed** |
| 5 | openid-client 5.7.1 → ^6 (applications) | **HELD at 5.7.1** |
| 6 | node-redis consolidation (N-7) | **Landed — `redis` dep removed entirely** |
| 7 | @langchain/core ^0.3.80 → ^1.2.1 + @langchain/ollama ^0.2.4 → ^1.3.0 (applications) | **Landed** |

Item notes and code fixes:
- **C6.1 class-validator 0.15.1** — no code changes needed; api e2e validation suites green. First e2e run had 2 transient failures (login `ECONNRESET`, one ETag 412); full rerun clean: `519 passed, 17 skipped`.
- **C6.2 nestjs-cls 6.2.1** — no code changes needed; cross-tenant (task-307) e2e green. The first e2e run showed 4 cascading failures that diagnosis proved were a **pre-existing test-infra race, not a cls-v6 regression**: the AppSettings cache cron (`45 * * * * *`) snapshotted the `GlobalSetting` table mid-`test:db:reset` (Playwright `globalSetup` reseeds while the API is up — cron tick at 14:03:45.0xx vs seeded rate-limit row `createdAt` 14:03:45.521). The stale snapshot made `RateLimitAdminService.writeSetting` miss the cached platform row and create a duplicate `rate-limit.enabled` platform row, tripping the TASK-302 boot invariant on every subsequent refresh (cascading 500s: storage, rate-limit PUT, password-policy staleness). cls-v6 tenant scoping verified correct — the invariant counted exactly the seed row + the service-created duplicate; tenant clones were properly excluded. Remediation: soft-deleted the duplicate row (`UPDATE … resourceStatus='DELETED'` — no hard delete), restarted the API, reran e2e: `519 passed, 17 skipped`. **Flagged for coordinator**: the cron-vs-globalSetup-reset race is a latent e2e flake (see final-gate note).
- **C6.3 casl 7 / casl-prisma 2** — mechanical migration in `packages/applications/src/authorization/policy.engine.ts`: `PureAbility` → `Ability` (v7 rename), `AppAbility` conditions type rebuilt as `PrismaQueryOf<PrismaTypeMap<string>>` (v2 derives `PrismaQuery` from `@prisma/client`'s generated TypeMap, which is a stub in this repo — the generated client lives in packages/database), and `accessibleBy` docs updated to the v2 `.ofType('Model')` shape (`getAccessibleBy` has no production callers; guards use `buildAbility`/`can`). Authorization unit tests: `120 passed`. Full e2e: 517 passed + the rate-limit 412 flake (spec ran before the first post-reset cache tick); spec file retried in isolation: `15 passed`. Union = baseline.
- **C6.4 http-proxy-middleware 4.1.1** — v4 is **ESM-only** with engines `^22.15.0 || ^24.0.0 || >=26`; apps/api compiles to CommonJS, so this rides Node's `require(esm)` interop — verified: `require('http-proxy-middleware')` resolves `createProxyMiddleware` + `fixRequestBody` on Node 24 (dev) and is supported on the node:22 Docker base (≥22.15). No API-surface changes needed in `base-proxy.controller.ts` (v4 kept the v3 options/`on.{proxyReq,proxyRes,error}` contract; engine swapped http-proxy → httpxy). Proxy unit tests: `37 passed` (2 files). Full e2e: 512 + 2 transient (login ECONNRESET; rate-limit 412 flake) — both spec files retried: `51 passed`. A `RESET_DB=false` full rerun on the reused DB: 518 passed with 1 failure in task-400 D2 that is a **DB-reuse artifact**, not a regression: the spec's `findFirst` on `security.password.maxAgeDays` picked a tenant-clone row (tenant provisioning clones `__GLOBAL__` rows into tenants created by earlier runs) and the admin PATCH correctly 404'd cross-tenant; the same spec passes on a fresh-seed run (passed in this item's first run and in the final gate).
- **C6.5 openid-client 6 — HELD at exact 5.7.1.** The v6 rewrite is not mechanical for this integration: `packages/applications/src/services/auth/auth.service.module.ts` builds the DI'd `OPENID_CLIENT` via `Issuer.discover()` + `new issuer.Client({...})`, and `oidc.strategy.ts` extends the **passport `Strategy` bundled with openid-client v5** and calls `client.userinfo(tokenset)`. In v6: `Issuer`/`Client` classes are gone (functions + `Configuration` object — `discovery()`), the passport strategy moved to a separate `openid-client/passport` module with a different constructor contract (Configuration + current-URL callback instead of `{ client, params }`), and `userinfo` becomes `fetchUserInfo(config, accessToken, expectedSubject)` where `expectedSubject` is a new required parameter our tokenset flow must source. That is a redesign of the OIDC/SSO wiring, and it is **untestable here**: no live IdP locally, and the test env disables OIDC (the factory returns `null` unless `OIDC_DISCOVERY_URL`/client id/secret are configured), so e2e cannot exercise any of it. Migration sketch documented above for the follow-up ticket.
- **C6.6 node-redis consolidation (N-7)** — audit found **zero** `from 'redis'` / `require('redis')` call sites anywhere in the repo; the apps/api `redis` ^4.7.1 dependency was dead. Removed the dep entirely (preferred path — no migration needed) and removed the root peer rule `"bullmq>redis": "4"` (second documented deferral owned by C6; the whole `peerDependencyRules` block is now gone). Install shows no new peer warnings; `pnpm build:api` green. BullMQ runs on ioredis as before.
- **C6.7 langchain 1.x** — `@langchain/core`/`@langchain/ollama` have **no import sites in any TS source** (dead deps; LLM engine work lives in the Python SMR service). Bumped both majors in lock-step (ollama 1.3.0 peers on core ^1.0.0); applications build green, full applications suite `5789 passed | 4 skipped`. **Flagged for coordinator**: both are candidates for the D-8 runtime-dead-deps removal ticket.

Final C6 gate (after item 7, all landed items in the tree):
- `pnpm build` — `Tasks: 20 successful, 20 total` (now includes the concurrently-added `apps/admin-console`).
- `pnpm lint` — exit 0, warning fingerprint identical: `107/71/6/5`.
- `pnpm test:unit` — `Tests  2 failed | 15003 passed | 4 skipped | 9 todo` — the 2 test-level failures are exactly the known baseline pair (tenant-scope drift guard; seed-global-settings 57 vs 58). Note: 4 additional *file-level* import failures come from `apps/admin-console/**` — an untracked app added to the working tree by concurrent work mid-run (`?? apps/admin-console/`), outside TASK-413 scope (`server-only` import guard + missing `@/shared/auth/ability` module; no dependency overlap with the C6 items).
- `pnpm test:e2e` — 517 passed / 17 skipped with the task-403 rate-limit spec hitting the same 412 flake; the spec file retried immediately (`RESET_DB=false`): `15 passed`. Cumulative result matches the **519 passed / 17 skipped** baseline; task-307 cross-tenant specs green in every run.
- **Test-infra flake, for coordinator** (pre-existing, surfaced repeatedly during C6 gating): Playwright `globalSetup` runs `test:db:reset` while the API is up, racing the AppSettings 45-second cache cron. Window A (cron snapshots mid-seed) can poison the cache and even create a duplicate platform row via the rate-limit admin path; window B (spec runs before the first post-reset tick) yields a stale-version 412 on `PUT /admin/rate-limit/enabled`. Suggested fixes (out of TASK-413 scope): reset the DB before the API boots in the e2e flow, or force `refreshCache()` after globalSetup's reset, or have `writeSetting` re-read the row on 412/miss.

---

## 5. Change History

| Date | Change |
|---|---|
| 2026-07-04 | Initial audit completed (Node + Python inventory, currency, collisions); phased plan drafted; awaiting approval |
| 2026-07-04 | Plan approved. Phase A executed (agent): guardrail asyncpg fix + `.python-version`, stt-v2 redis cap → `<9.0`, qdrant-client removed, `uv lock --upgrade` (fastapi 0.139, redis-py 8.0.1, temporalio 1.30, dramatiq 2.2, onnxruntime 1.27), frozen-sync verified ×5, arcaenv pinned to lock; all 5 services test/lint/typecheck green incl. harness replay-compat. 2 upgrade fixes (smr lifespan test, harness workflows.py annotations). |
| 2026-07-04 | Phase B executed (agent): N-1/N-3/N-6/N-8/N-9/N-10 hygiene, in-range sweep + anchor floors (Prisma 7.8.0, NestJS 11.1.27, Playwright 1.61.1 + `v1.61.1-noble` CI images, turbo 2.10.3). Gates: build 19/19, lint 28/28, e2e 519 passed; test:unit has 2 PRE-EXISTING failures (tenant-scope drift guard: `TenantEntitlement`/`TenantUsageMeter` missing from `TENANT_SCOPED_MODELS`; seed-global-settings 57 vs 58) — owner decisions pending. Deferrals annotated: vad onnxruntime-web held at 1.24.3 (→C5), peer rules `bullmq>redis:4` (→C6) and `@base-ui/react>date-fns:3` (→C4). |
| 2026-07-04 | Phase C batches C1–C3 executed (agent), zero holds/reverts: C1 codegen CLIs (chalk 5, commander 15, inquirer 14, ora 9, glob 13, yargs 18, ts-morph 28 — generator output byte-identical), C2 backend majors (pino 10/pino-roll 4, nodemailer 9, node-vault 0.12, supertest 7, express-rate-limit 8, diff 9, pdf-parse 2, studio-core 0.31.2), C3 OTel 0.220 line alignment. 4 mechanical code fixes; gates: build 19/19, unit = baseline-only failures, e2e 519/17 after C2 and C3. New findings logged as D-8 (runtime-dead deps) and D-9 (pre-existing codegen drift + gen:mapper crash). |
| 2026-07-04 | Phase C batches C4–C6 executed (agent). C4: date-fns 4, resolvers 5, panels 4, lexical 0.46, marked 18, jsdom 29, three 0.185, cobe 2, recharts 3.9.2, ai 7, elevenlabs 1.x — ui pdfjs-dist HELD (react-pdf pin → D-12). C5: transformers 4.2.0 + onnxruntime-web/common 1.27.0 lock-step, vad `ORT_WEB_VERSION` + TASK-271 guard updated. C6 one-at-a-time: class-validator 0.15.1, nestjs-cls 6.2.1, casl 7 + casl-prisma 2, http-proxy-middleware 4.1.1, `redis` dep REMOVED (zero call sites; peer rule dropped), langchain 1.x landed; openid-client HELD at 5.7.1 (→ D-10). Pre-existing e2e cron-vs-reset race root-caused (→ D-11). Final gates: build 20/20, lint fingerprint unchanged, unit 15003 passed (baseline-only failures), e2e 519/17 = baseline. Status → Review. |
