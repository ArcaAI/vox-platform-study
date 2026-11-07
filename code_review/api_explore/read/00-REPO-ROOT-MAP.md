# Repository Root Map — VOX Workspace & `project-hope`

**Scope:** Top-level files and folders of `/Users/apple/repos/VOX` (workspace) and `/Users/apple/repos/VOX/project-hope` (the git repo), with the purpose of each.
**Repo state:** `project-hope` on branch `dev-2.2`, HEAD `8cb2e5e8e` (2026-10-22), 3 local modifications + 1 untracked file.
**Written:** 2026-11-04 · read-only inspection, no changes made to `project-hope`.

---

## Orientation

`/Users/apple/repos/VOX` is **not** a git repo — it is a workspace/scratch folder holding several checkouts, snapshots, reviews, and experiments around the HOPE/VOX healthcare-AI platform.

The actual live repo is **`project-hope/`**. Both levels are covered below.

---

# 1. Workspace root — `/Users/apple/repos/VOX`

## Folders

| Folder | Purpose |
|---|---|
| `project-hope/` | **The main repo.** HOPE monorepo — multi-tenant healthcare AI platform (4.6 GB with `node_modules`). See section 2. |
| `project-hope-sks/` | A second, older snapshot/fork of the same HOPE monorepo (4.2 GB). Has `archify_diagrams/`, `deployment/`, `AWS_Cluster_START_STOP.md`. Likely a personal/staging copy. |
| `ALaaSv3.0/` | "Medical Ambient Listening as a Service v3" — older standalone product (docker-compose, apps, enums, grafana, data-masking docs). Predecessor/adjacent to HOPE. |
| `Arca-AgenticSDK/` | Standalone Agentic SDK package (TypeScript/JS SDK for medical conversation apps, real-time speech). Earlier extraction of what became `packages/agentic-sdk-v2`. |
| `Arca-AgenticSystemDeployment/` | Deployment assets: Helm, Kustomize/base, AWS, architecture + deployment guides. |
| `arca-deployment-template/` | `hope-v2-deployment` — Kustomize + Argo CD GitOps manifests for the HOPE platform (the separate deployment repo referenced by project-hope's README). |
| `arca-deploy-next-steps/` | Docs-only folder with follow-up deployment notes. |
| `arca-tuner-lite/` | Whisper `large-v3-turbo` fine-tuning scripts (`finetune_medical_en.py`, `hope_whisper_train`, prune scripts) + configs. |
| `asr-tuner/` | Malayalam/English code-switch ASR dataset prep + NVIDIA Parakeet-TDT fine-tuning pipeline (`arca/`, `configs/`, `data/`). |
| `client1/` | Python Streamlit test client that drives the consultation stream end-to-end (record → live transcript → SOAP note). |
| `dashboards/` | Single Grafana test dashboard JSON (`dashboards/dashboards/test-dashboard.json`). |
| `docs/` | Cross-project documentation hub: one `.md` per component (`ALaaSv3.0.md`, `Arca-AgenticSDK.md`, `Deployment-Plan.md`, `Repositories.md`, `Admin_Console_APIs/`, `vox_deploy/`), plus matching PDFs. |
| `docs_rijna/` | Large personal documentation collection from a team member: workflows, API functional docs, Azure notes, feature designs, architecture plans. |
| `git_related/` | Saved git history dump (`project-hope_20261031.txt`). |
| `nitik_test_scripts/` | Ad-hoc test scripts, samples, ASR fixture JSON, docker history notes. |
| `pdf/` | PDF exports of the `docs/*.md` component documents. |
| `review/` | Review/audit workspace (278 MB): `api_explore/`, `api_explore_2/`, `codewalk/`, `commits/`, `database/`, `cloudflared/` — API catalogs, sequence diagrams, code walkthroughs. **This document lives here.** |
| `sara/` | **SARA** — separate "Smart Automated Radiology Assistant" app (apps, nginx config, docker-compose, certs, deployment docs). |
| `simple-ui-voxnode/` | Tiny Node + plain-HTML tester UI for the `@arcaai/vox-node` 5.0.1 SDK (single page, no build step). |
| `stt_v3/` | Lightweight standalone STT service (FastAPI, YAML config, WS streaming + REST file API) designed to sit outside the monorepo. |
| `stt_v3_client/` | Zero-dependency static HTML test client for `stt_v3`. |
| `VoX_UI_Crawl/` | Beginner documentation/crawl of the HOPE Admin Console UI, plus a `project-hope-copy` and crawl scripts. |

## Files

| File | Purpose |
|---|---|
| `.agents/rules/changes.md` | Agent rule: *"do not change files in existing repos with git; only make changes in `./review`"*. |
| `.cf_token_details.txt` | Cloudflare token details — **contains credentials; do not share/commit**. |
| `.DS_Store` | macOS Finder metadata (junk). |
| `dev-2.2_commit_history.txt` | Dump of `dev-2.2` commit history (~90 KB). |
| `git_log_output.txt` | Output of an all-branch `git log --name-only` over 48h (~93 KB). |
| `helpful_commands.txt` | The one-liner used to produce `git_log_output.txt`. |
| `project_hope_change_log_2026` | Effectively junk — contains stray vim commands (`:w`, `:q!`) instead of a changelog. |
| `report` | Short report on fixing the API sequence-diagram catalog (`review/api_explore/Diagrams/catalog.md`): 818 APIs, 817 diagrams. |
| `VOX_pdfs.zip` | Zipped PDF bundle (1.1 MB). |
| `VoX_UI_Crawl.zip` | Zipped copy of the UI crawl repo (73 MB). |

---

# 2. Repo root — `/Users/apple/repos/VOX/project-hope`

`README.md` is the authoritative map: a **Turborepo + pnpm monorepo** for a medical AI platform (consultation transcription, medical NLP, LLM summarization, guardrails, clinical docs). Node ≥ 22.12, pnpm 10, TS 5.9, Python 3.11 via conda `arcaenv` + `uv`.

## Folders

| Folder | Purpose |
|---|---|
| `apps/` | Deployable services. `api` (NestJS 11 gateway, :8868), `stt` (FastAPI :8861 + Dramatiq batch worker), `text` (:8862), `guardrail` (:8863), `nlp` (:8864), `tts` (:8865), `harness` (:8866 + Temporal worker), `admin-console` (Next.js 16, :5176), `vllm` (vLLM inference container, not listed in README layout). |
| `packages/` | Shared libraries. Backend DDD layers (`database`, `domains`, `applications`), `exceptions`, `logger`, `types`, `utils`, `tools` (CLI generators); SDKs (`agentic-sdk-v2`, `vox-node`, `vox-codegen`, `vox-node-codegen`, `room`, `stt`, `pipeline`); cross-language contracts (`async-contract`, `py-async-contract`, `workflow-contract`, `py-workflow-contract`, `json-schema-subset`); Python glue (`py-env`, `py-otel`, `py-obs`, `py-runtime-models`); UI/config (`ui`, `config-eslint`, `config-rollup`, `config-tailwind`, `config-ts`, `eslint-plugin-arcaai-internal`). |
| `docs/` | Documentation: `architecture/`, `guides/`, `implementation/` (per-ticket BUG-*/TASK-* folders), `operations/`, `research/`, `programs/`, `traceability/`, `backlog/`, `archive/`, `test-result/`, plus `development-guide.md`, `development-patterns-and-standards.md`, `consultation-context-schema-integration-guide.md`, `section-syntax.md`. |
| `infrastructure/` | Local Docker infra: `docker/` (lmstudio, qdrant-init, vllm, minio, python-base, configs, scripts), `grafana/` (provisioning + dashboards), `gpu-process-exporter/`, `single-deployment/vault/`, plus `README.md` and `SECURITY_DEPLOYMENT_GUIDE.md`. Cluster manifests live in a **separate** repo. |
| `scripts/` | ~56 dev/test/CI operational scripts: `dev-*.sh`, `stack`, `setup-python-env.sh`, `test-*.sh`, `env-sync.mts`, `gate.sh`, `gen-*`, `vault-*`, `chaos/`, `perf/`, `generated/`, `lib/`, `pytest-support/`. See `scripts/README.md`. |
| `tests/` | Shared test infrastructure: `contracts/` (cross-service parity + fixtures), `cross-tenant/`, `e2e/sdk/`, `fixtures/`, `helpers/`, `load/`, `setup/`, `docker-compose.test.yml`, `README.md`. |
| `.github/` | GitHub Actions: `workflows/` (build, test, deploy, publish, scan, vault, harness-eval, …) + `services.json`. |
| `.gitlab/` | GitLab CI fragments (`ci/`, `corepack/`) used alongside `.gitlab-ci.yml`. |
| `.changeset/` | Changesets config for versioning/releasing workspace packages. |
| `.vscode/` | Shared editor config: `launch.json`, `settings.json`. |
| `.turbo/` | Turborepo local cache (generated). |
| `.git/` | Git metadata (branch `dev-2.2`). |
| `node_modules/` | Installed dependencies (generated). |

## Files

| File | Purpose |
|---|---|
| `README.md` | Monorepo overview, layout, commands, tech stack, doc index. |
| `package.json` | Root workspace manifest; ~390 scripts grouped by area (setup, `api:*`, `admin:*`, `ui:*`, `stt:*`, `db:*`, `test:*`, `stack:*`, `env:*`, `gen:*`). |
| `pnpm-workspace.yaml` | Workspace globs (`apps/*`, `packages/*`, `packages/agentic-sdk-v2/examples/*`), `onlyBuiltDependencies`, and security `overrides` (pinned advisory floors). |
| `pnpm-lock.yaml` | pnpm lockfile (~1 MB). |
| `turbo.json` | Turborepo pipeline: 26 tasks (build, lint, typecheck, dev, test/e2e/cov, db:generate/push/migrate/studio, clean) + `globalEnv`. |
| `pyproject.toml` | Root **uv workspace** definition — single lockfile covering all Python services + shared `py-*` packages, so versions cannot drift. |
| `uv.lock` | Unified Python dependency lock (~1.4 MB). |
| `tsconfig.json` | Root TypeScript config (thin, extends shared config). |
| `vitest.config.ts` | Unit/integration test config. |
| `vitest.integration.config.ts` | Integration-specific Vitest config (isolated infra). |
| `playwright.config.ts` | Browser/E2E test config for the SDK/admin console. |
| `prisma.config.ts` | Prisma 7+ CLI config (db push/migrate/seed), loads `DATABASE_URL` via the shared `planEnvFileLoad()`. |
| `ecosystem.config.js` | PM2 process definition for the API only. |
| `.env.sample` | **Generated** consolidated env template (2,475 lines) for all TS + Python services; source for `.env.dev`/`.env.test`. |
| `env-surface.generated.md` | **Generated** catalog of every declared env var (547 lines); `pnpm env:sync --check` enforces no drift in CI. |
| `.gitignore` | Ignore rules (deps, coverage, build output, `.env.dev`/`.env.test`, etc.). |
| `.gitattributes` | Line-ending / binary handling. |
| `.dockerignore` | Docker build context exclusions. |
| `.cursorignore` | Files hidden from Cursor's indexer. |
| `.prettierrc.js` | Shared Prettier config. |
| `.gitleaks.toml` / `.gitleaksignore` | Secret-scanning rules and known-safe allowances (pre-commit hook). |
| `.gitlab-ci.yml` | Root GitLab pipeline (~12 KB). |
| `25-end-to-end-data-flows.md` | Untracked doc: concrete request/data flows through the gateway (auth, tenancy, proxying, errors). |
| `stt-loss-report.json` | Generated STT quality/loss metrics report. |
| `stt-quality-scorecard.json` | Generated STT quality scorecard (~41 KB). |

---

## Notes worth flagging

- **`README.md` references `.claude/rules/*.md`** (dev workflow, project context, coding standards), but there is **no `.claude/` folder in this checkout** — those rules are missing or were never committed. The nearest equivalent present is `/Users/apple/repos/VOX/.agents/rules/changes.md`.
- **`apps/vllm`** exists in `apps/` but is absent from the README layout table (README still says 8 apps).
- **`project-hope` has 3 local modifications** (`infrastructure/grafana/dashboards/harness-temporal.json`, `hope-platform-metrics.json`) and one untracked file (`25-end-to-end-data-flows.md`).
- **Generated files — never hand-edit:** `.env.sample`, `env-surface.generated.md`, `stt-loss-report.json`, `stt-quality-scorecard.json`.
- **Secrets:** `.cf_token_details.txt` at the workspace root appears to hold credentials. Avoid copying it into any repo.

---

## Suggested next reads

| Topic | Where to go |
|---|---|
| API gateway internals | `review/api_explore/codebase/ARCHITECTURE.md`, `review/api_explore/inventory/routes-by-module.md` |
| System topology & ports | `project-hope/docs/architecture/overview.md` |
| Developer setup | `project-hope/docs/development-guide.md` |
| Layer rules (DB → domain → app → controller) | `project-hope/docs/development-patterns-and-standards.md` |
| Dev/test scripts | `project-hope/scripts/README.md` |
| Deployment (separate repo) | `arca-deployment-template/` |
