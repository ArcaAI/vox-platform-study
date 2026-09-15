# HOPE Monorepo — multi-tenant healthcare AI platform

A medical AI platform (clinical consultation transcription, medical NLP, LLM summarization,
guardrails, clinical documentation harness) built as a Turborepo + pnpm monorepo. Node >= 22.12,
pnpm 10, TypeScript 5.9.

## Layout

```
apps/
  api/              NestJS 11 API gateway (8868) — auth, multi-tenancy, REST/WS/SSE
  stt/              FastAPI (8861) — speech-to-text, multi-model ASR, diarization + batch worker
  text/             FastAPI (8862) — multi-provider text generation / summarization
  guardrail/        FastAPI (8863) — content-safety, PII, medical validation
  nlp/              FastAPI (8864) — medical NER, classification, diagnosis suggestions
  harness/          FastAPI (8866) — clinical documentation harness + Temporal worker
  tts/              FastAPI (8865) — text-to-speech, multi-provider (Azure + local Kokoro/Indic Parler)
  admin-console/    Next.js 16 (5176) — operator UI, BFF auth + gateway proxy
  example/          Minimal raw-WebSocket live-transcription demo, not an SDK consumer
  compat-playground/, quick-compat-app/   Local dev-only playgrounds; their unit suites are
                     deliberately excluded from the normal test gate (run only when the change
                     is inside them)

packages/
  # Backend (DDD layers: database -> domains -> applications -> apps/api)
  database/          @arcaai/database — Prisma 7 multi-file schema, client extensions
  domains/           @arcaai/domains — entities, factories, mappers, repositories
  applications/      @arcaai/applications — application services, DTOs, NestJS modules
  exceptions/, logger/, types/, utils/   shared exception hierarchy, logging, types, utilities
  tools/             @arcaai/tools — CLI code generators (entity/mapper/repository/...)

  # Browser SDK family + non-browser server SDK
  agentic-sdk-v2/    @arcaai/vox — browser React SDK for medical consultations
  vox-node/          @arcaai/vox-node — non-browser server SDK, zero runtime deps
  vox-codegen/       @arcaai/vox-codegen — tenant context-schema -> TypeScript CLI
  vox-node-codegen/  private, generates hope.admin.* for @arcaai/vox-node from the gateway route manifest
  room/, vad/, noise-filter/, stt/, med-ner/, pipeline/   browser audio/ML packages (VAD, denoise,
                     local Whisper STT worker, client NER, sequential/parallel processing)

  # Shared cross-language contracts and Python glue
  async-contract/, py-async-contract/     shared async job/webhook contract (TS + Python mirror)
  workflow-contract/, py-workflow-contract/   workflow node/action vocabulary contract (TS + Python mirror)
  py-env/            shared env-file loader Python services import (mirrors the TS env resolver)
  py-otel/           shared OTel trace-propagation package for the Python services
  py-runtime-models/, json-schema-subset/   supporting shared schema/type packages

  # UI & config
  ui/                @arcaai/ui — shared React component library (shadcn/Radix, Tailwind v4)
  config-eslint/, config-rollup/, config-tailwind/, config-ts/   shared build/lint/style configs
  eslint-plugin-arcaai-internal/   custom architecture lint rules

infrastructure/     Local-dev Docker Compose + Vault HA design record (retired) — see infrastructure/README.md
scripts/            Dev/test/CI operational scripts — see scripts/README.md
tests/              Shared test helpers, fixtures, contracts, cross-tenant fixture, SDK E2E, isolated test infra
docs/               Architecture, development guide, ticket documentation — see docs/README.md
```

Cluster (k3s + Argo CD) deployment manifests live in the **separate** `arca/hope-v2-deployment`
repository, not in this one — there is no `deployment/` directory here.

## Commands

```sh
# Prerequisites: Node.js >= 22.12, pnpm 10, Docker, conda + uv (Python services),
# LM Studio on :1234 for local LLM inference

pnpm install         # 1. Install dependencies (+ gitleaks pre-commit hook)
pnpm setup:python    # 2. Create the shared conda env `arcaenv` (Python services)
pnpm setup:dev       # 3. Infra up + DB schema/seed + Vault bootstrap (idempotent)
pnpm build           # 4. Build everything
pnpm stack:dev       # 5. Start the full clinical-workspace stack
pnpm stack:dev:doctor   # 6. Verify all services are green
```

For the full setup guide, daily workflows, testing, and troubleshooting, see
[docs/development-guide.md](docs/development-guide.md).

| Command | Effect |
|---|---|
| `pnpm stack:dev` | Start the default app stack (api, stt, stt-worker, text, guardrail, nlp, harness, worker, admin) |
| `pnpm stack:dev -- text worker` | Start a subset of the stack |
| `pnpm stack:dev:down` | Stop services previously spawned by `stack:dev` (pidfile-based; no-op if none) |
| `DRY_RUN=1 pnpm stack:dev` | Print the launch plan without starting anything |
| `pnpm stack:dev:doctor` | Health-check all services, docker infra, LLM engines, and the STT key |
| `pnpm infra:dev:up` | Start docker infra (Vault + Temporal + rag profiles) |
| `pnpm infra:dev:down` / `infra:dev:status` / `infra:dev:logs` | Stop / inspect / follow docker infra |
| `pnpm api:dev` | Start the API Gateway (development) |
| `pnpm stt:dev` / `text:dev` / `nlp:dev` / `guardrail:dev` / `harness:dev` / `tts:dev` | Start one Python service (each has a `:dev:watch` scoped-reload variant) |
| `pnpm worker:dev` | Start the harness Temporal worker |
| `pnpm stt:worker:dev` | Start the STT Dramatiq batch worker |
| `pnpm admin:dev` | Start the admin console (Next.js dev, port 5176) |
| `pnpm build` | Build all packages and apps |
| `pnpm test:unit` / `test:integration` / `test:e2e` | Run the TypeScript test suites (`.env.test`, isolated infra) |
| `pnpm <svc>:test` | Run a Python service's pytest suite (`stt`, `text`, `nlp`, `guardrail`, `harness`, `tts`) |
| `pnpm db:all && pnpm build` | Full reset: push DB (destructive), seed, build everything |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm gen:token` | Generate a dev JWT token |

Python dev services bind `127.0.0.1` by default; export `HOST=0.0.0.0` to expose one on the LAN
deliberately.

See [scripts/README.md](scripts/README.md) for the complete script reference.

## How it works

| Concern | Where it lives |
|---|---|
| Layer dependency chain for a full-stack change | Database (Prisma) -> Domain (entity/factory/mapper/repo) -> Application services -> API controller — see `.claude/rules/01-development-workflow.md` |
| Ticket workflow, doc locations, monorepo map | `.claude/rules/00-project-context.md` |
| Per-domain coding standards | `.claude/rules/02-*.md` through `13-*.md`, indexed in `.claude/rules/README.md` |

## Documentation

| Resource | Description |
|---|---|
| [docs/README.md](docs/README.md) | Documentation index — start here |
| [docs/development-guide.md](docs/development-guide.md) | Developer guide: setup, daily workflows, testing, troubleshooting |
| [docs/architecture/overview.md](docs/architecture/overview.md) | System topology, ports, data flows, deployment topologies |
| [docs/development-patterns-and-standards.md](docs/development-patterns-and-standards.md) | Coding patterns and layer standards (code-verified) |
| [docs/implementation/](docs/implementation/) | Active ticket-based implementation documentation |

## Tech Stack

| Layer | Technology |
|---|---|
| Monorepo | Turborepo + pnpm workspaces |
| API Gateway | NestJS 11, TypeScript 5.9 |
| Python Services | FastAPI, Python 3.11 (conda `arcaenv` + uv workspace lock) |
| Database | PostgreSQL 18, Prisma 7 |
| Cache/Queue | Redis 8, BullMQ |
| Object Storage | MinIO |
| Vector DB | Qdrant |
| Workflows | Temporal (clinical documentation harness) |
| Speech | TTS (Azure Speech + local Kokoro/Indic Parler); STT (multi-model ASR) |
| Secrets | HashiCorp Vault (Transit PHI encryption, dynamic DB creds) |
| Frontend SDK | React 19, TypeScript |
| Admin Console | Next.js 16 App Router, React 19, Tailwind v4 |
| Testing | Vitest, Playwright, pytest |
| Infrastructure | Docker Compose (local dev); k3s + Argo CD in the separate `arca/hope-v2-deployment` repo |

## Related

- [docs/README.md](docs/README.md) — documentation index
- [scripts/README.md](scripts/README.md) — complete script reference
- [tests/README.md](tests/README.md) — shared test tree and infra
- [infrastructure/README.md](infrastructure/README.md) — local Docker infrastructure
- [.claude/rules/README.md](.claude/rules/README.md) — AI coding-assistant rule index
