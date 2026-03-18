# HOPE Monorepo

A medical AI platform built as a monorepo with [Turborepo](https://turbo.build/repo) and [pnpm](https://pnpm.io/).

## Project Structure

```
apps/
  api/          NestJS API Gateway — auth, routing, WebSocket proxy
  stt-v2/       FastAPI — speech-to-text, multi-model ASR, diarization
  smr/          FastAPI — medical conversation summarization
  nlp/          FastAPI — medical NLP, classification, NER
  admin/        React admin dashboard
  tts/          Text-to-speech service
  mlflow/       ML experiment tracking

packages/
  agentic-sdk-v2/   @arcaai/vox — React SDK for medical consultations
  applications/     @arcaai/applications — shared NestJS business logic
  database/         @arcaai/database — Prisma ORM, PostgreSQL
  domains/          @arcaai/domains — DDD entities, repositories, mappers
  exceptions/       @arcaai/exceptions — custom exception hierarchy
  logger/           @arcaai/logger — Winston structured logging
  tools/            @arcaai/tools — CLI code generators
  room/             @arcaai/room — audio processing framework
  vad/              @arcaai/vad — voice activity detection (Silero VAD v5)
  noise-filter/     @arcaai/noise-filter — AI noise cancellation (RNNoise)
  med-ner/          @arcaai/med-ner — medical named entity recognition
  pipeline/         @arcaai/pipeline — sequential/parallel processing
  ui/               @arcaai/ui — shared React component library
  config-*/         shared ESLint, TypeScript, Tailwind, Rollup configs

infrastructure/
  docker/           Docker Compose for local dev (PostgreSQL, Redis, MinIO, Vault, Qdrant)
  single-deployment/ Production deployment scripts and configs

knowledge/          Technical documentation and knowledge base
docs/               Implementation ticket documentation
```

## Quick Start

```sh
# Prerequisites: Node.js >= 22, pnpm, Docker, conda (for Python services)

# 1. Install dependencies
pnpm install

# 2. Start dev infrastructure (PostgreSQL, Redis, MinIO)
pnpm docker:dev:up

# 3. Push database schema and seed
pnpm db:all

# 4. Build everything
pnpm build

# 5. Start the API server
pnpm dev:api
```

For the full setup guide including Python services, environment files, and testing, see **[knowledge/SETUP.md](knowledge/SETUP.md)**.

## Key Commands

| Command | Description |
|---------|-------------|
| `pnpm dev:api` | Start API Gateway (development) |
| `pnpm dev:stt-v2` | Start STT-v2 service |
| `pnpm dev:smr-v2` | Start SMR-v2 service |
| `pnpm dev:nlp` | Start NLP service |
| `pnpm build` | Build all packages and apps |
| `pnpm test:unit` | Run TypeScript unit tests |
| `pnpm ok` | Full reset: push DB, seed, build everything |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm gen:token` | Generate a dev JWT token |

See [knowledge/SETUP.md](knowledge/SETUP.md) for the complete script reference.

## Documentation

| Resource | Description |
|----------|-------------|
| [knowledge/](knowledge/README.md) | Technical knowledge base (architecture, services, packages) |
| [knowledge/SETUP.md](knowledge/SETUP.md) | Local development setup, scripts reference, testing guide |
| [docs/implementation/](docs/implementation/) | Ticket-based implementation documentation |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Monorepo | Turborepo + pnpm workspaces |
| API Gateway | NestJS, TypeScript |
| Python Services | FastAPI, conda, uv |
| Database | PostgreSQL 18, Prisma 7 |
| Cache/Queue | Redis 8, BullMQ |
| Object Storage | MinIO |
| Vector DB | Qdrant |
| Frontend SDK | React, TypeScript |
| Testing | Vitest, Playwright, pytest |
| Infrastructure | Docker Compose, systemd |