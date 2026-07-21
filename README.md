# HOPE Monorepo

A medical AI platform built as a monorepo with [Turborepo](https://turbo.build/repo) and [pnpm](https://pnpm.io/).

## Project Structure

```
apps/
  api/          NestJS API Gateway (8868) — auth, multi-tenancy, REST/WS/SSE, system of record
  stt-v2/       FastAPI (8861) — speech-to-text, multi-model ASR, diarization + batch worker
  smr/          FastAPI (8862) — LLM summarization / text generation
  guardrail/    FastAPI (8863) — content-safety, PII, medical validation
  nlp/          FastAPI (8864) — medical NER, classification, diagnosis suggestions
  harness/      FastAPI (8866) — clinical documentation harness + Temporal worker
  tts-v2/       FastAPI (8865) — text-to-speech, multi-provider (Azure + local Kokoro/Indic Parler)
  admin-console/ Next.js 16 (5176) — operator UI, BFF auth + gateway proxy
  ui-playground/ React SDK playground (5175) — DEPRECATED
  example/      Minimal live-transcription demo (5173)

packages/
  # Backend (DDD layers: database → domains → applications → apps/api)
  database/         @arcaai/database — Prisma 7 multi-file schema, client extensions
  domains/          @arcaai/domains — entities, factories, mappers, repositories
  applications/     @arcaai/applications — application services, DTOs, NestJS modules
  exceptions/       @arcaai/exceptions — custom exception hierarchy
  logger/           @arcaai/logger — Winston structured logging
  types/ utils/     @arcaai/types, @arcaai/utils — shared types and utilities
  tools/            @arcaai/tools — CLI code generators (entity/mapper/repo/...)

  # Browser SDK
  agentic-sdk-v2/   @arcaai/vox — React SDK for medical consultations
  room/             @arcaai/room — audio processing framework
  vad/              @arcaai/vad — voice activity detection (Silero VAD v5)
  noise-filter/     @arcaai/noise-filter — AI noise cancellation (RNNoise)
  stt/              @arcaai/stt — local Whisper STT WebWorker
  med-ner/          @arcaai/med-ner — client-side medical NER
  pipeline/         @arcaai/pipeline — sequential/parallel processing

  # UI & config
  ui/               @arcaai/ui — shared React component library (shadcn/Radix)
  config-*/         shared ESLint, TypeScript, Tailwind, Rollup configs
  eslint-plugin-arcaai-internal/  custom architecture lint rules

infrastructure/     Docker Compose (local dev), Grafana dashboards, Vault HA blueprint
deployment/         k3s + ArgoCD GitOps manifests (cluster deployment)
scripts/            Dev/test/CI operational scripts
tests/              Shared test helpers, contracts, SDK E2E, isolated test infra
docs/               Architecture, development guide, ticket documentation
```

## Quick Start

```sh
# Prerequisites: Node.js >= 22, pnpm 10, Docker, conda + uv (Python services),
# LM Studio on :1234 for local LLM inference

pnpm install       # 1. Install dependencies (+ gitleaks pre-commit hook)
pnpm py:setup      # 2. Create the shared conda env `arcaenv` (Python services)
pnpm dev:setup     # 3. Infra up + DB schema/seed + Vault bootstrap (idempotent)
pnpm build         # 4. Build everything
pnpm dev:stack     # 5. Start the full clinical-workspace stack
pnpm dev:doctor    # 6. Verify all services are green
```

For the full setup guide, daily workflows, testing, and troubleshooting, see **[docs/development-guide.md](docs/development-guide.md)**.

## Key Commands

| Command | Description |
|---------|-------------|
| `pnpm dev:stack` | Start the default stack (API, STT, SMR, guardrail, NLP, harness + worker, admin console) |
| `pnpm dev:stack -- smr worker` | Start a subset of the stack (any of: api, stt, smr, guardrail, nlp, harness, worker, ui, tts) |
| `pnpm dev:stack down` | Stop services previously spawned by `dev:stack` (pidfile-based; no-op if none) |
| `DRY_RUN=1 pnpm dev:stack` | Print the launch plan without starting anything |
| `pnpm dev:doctor` | Health-check all services, docker infra, LLM engines, and the STT key |
| `pnpm infra:up` | Start docker infra incl. Vault + Temporal profiles |
| `pnpm infra:down` / `infra:status` / `infra:logs` | Stop / inspect / follow docker infra |
| `pnpm dev:api` | Start API Gateway (development) |
| `pnpm dev:stt-v2` | Start STT-v2 service (no reload; `:watch` for scoped reload) |
| `pnpm dev:smr-v2` | Start SMR-v2 service with the LM Studio provider registered |
| `pnpm dev:nlp` / `dev:guardrail` / `dev:harness` | Start NLP / Guardrail / harness API service |
| `pnpm dev:harness:worker` | Start the harness Temporal worker |
| `pnpm dev:tts-v2` | Start TTS-v2 service (`:watch` for scoped reload) |
| `pnpm dev:admin` | Start the admin console (Next.js dev, port 5176) |
| `pnpm dev:<service>:watch` | Scoped-reload variant (stt-v2, smr-v2, guardrail, nlp, harness, tts-v2) |
| `pnpm build` | Build all packages and apps |
| `pnpm test:unit` / `test:integration` / `test:e2e` | Run the TypeScript test suites (`.env.test`, isolated infra) |
| `pnpm py:<svc>:test` | Run a Python service's pytest suite (stt-v2, smr-v2, nlp, guardrail, harness, tts-v2) |
| `pnpm ok` | Full reset: push DB (destructive), seed, build everything |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm gen:token` | Generate a dev JWT token |

Python dev services bind `127.0.0.1` by default; export `HOST=0.0.0.0` to expose one on the LAN deliberately.

See [scripts/README.md](scripts/README.md) for the complete script reference, and
[docs/archive/TASK-346-Local-Dev-Service-Scripts/README.md](docs/archive/TASK-346-Local-Dev-Service-Scripts/README.md)
for the dev-script design (defaults, env precedence, preflight checks).

## Documentation

| Resource | Description |
|----------|-------------|
| [docs/README.md](docs/README.md) | Documentation index — start here |
| [docs/development-guide.md](docs/development-guide.md) | Developer guide: setup, daily workflows, testing, troubleshooting |
| [docs/architecture/overview.md](docs/architecture/overview.md) | System topology, ports, data flows, deployment topologies |
| [docs/development-patterns-and-standards.md](docs/development-patterns-and-standards.md) | Coding patterns and layer standards (code-verified) |
| [docs/implementation/](docs/implementation/) | Active ticket-based implementation documentation |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Monorepo | Turborepo + pnpm workspaces |
| API Gateway | NestJS 11, TypeScript 5.9 |
| Python Services | FastAPI, Python 3.11 (conda `arcaenv` + uv workspace lock) |
| Database | PostgreSQL 18, Prisma 7 |
| Cache/Queue | Redis 8, BullMQ |
| Object Storage | MinIO |
| Vector DB | Qdrant |
| Workflows | Temporal (clinical documentation harness) |
| Speech | TTS-v2 (Azure Speech + local Kokoro/Indic Parler); STT-v2 (multi-model ASR) |
| Secrets | HashiCorp Vault (Transit PHI encryption, dynamic DB creds) |
| Frontend SDK | React 19, TypeScript |
| Admin Console | Next.js 16 App Router, React 19, Tailwind v4 |
| Testing | Vitest, Playwright, pytest |
| Infrastructure | Docker Compose (local), k3s + ArgoCD (cluster) |
