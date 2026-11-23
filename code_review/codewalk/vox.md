# VOX Platform - Project Hope Microservices Overview

## Architecture Summary

Project Hope is a monorepo containing **9 microservices** in `apps/` and **36 shared packages** in `packages/`, with infrastructure definitions in `infrastructure/`.

## Microservices (apps/)

| Service | Path | Description | Primary Responsibility |
|---------|------|-------------|----------------------|
| **admin-console** | `apps/admin-console` | Admin dashboard & management UI | Tenant management, pipeline configuration, monitoring |
| **api** | `apps/api` | API Gateway (NestJS) | Request routing, auth, rate limiting, agent orchestration |
| **guardrail** | `apps/guardrail` | Content safety & PII detection | Input/output scanning, compliance |
| **harness** | `apps/harness` | Testing & evaluation framework | Automated testing, quality gates |
| **nlp** | `apps/nlp` | Natural Language Processing | Entity extraction, classification, medical NER |
| **smr** | `apps/smr` | Speaker Matching & Recognition | Speaker identification, verification |
| **stt** | `apps/stt` | **Speech-to-Text** | Real-time streaming & batch transcription |
| **text** | `apps/text` | Text processing & transformation | Translation, formatting, text pipelines |
| **tts** | `apps/tts` | Text-to-Speech | Speech synthesis, voice cloning |

## Infrastructure (infrastructure/)

| Component | Description |
|-----------|-------------|
| **docker** | Docker Compose & Dockerfile definitions |
| **gpu-process-exporter** | GPU metrics exporter for Prometheus |
| **grafana** | Dashboards & alerting rules |
| **single-deployment** | Single-node deployment manifests |

## Shared Packages (packages/) - Key Ones

| Package | Purpose |
|---------|---------|
| `database` | Prisma schema, migrations, DB utilities |
| `logger` | Structured logging (structlog) |
| `stt` | STT shared types, schemas, utilities |
| `vad` | Voice Activity Detection shared code |
| `async-contract` | Async message contracts |
| `workflow-contract` | Workflow definitions |
| `domains` | Domain models |
| `exceptions` | Common exception hierarchy |
| `utils` | Utility functions |
| `types` | TypeScript type definitions |
| `ui` | Shared React components |
| `config-*` | ESLint, Tailwind, TypeScript configs |

## Data Flow Overview

```
Client → API Gateway (apps/api) → STT Service (apps/stt)
                                    ↓
                            ┌───────┴───────┐
                            ↓               ↓
                       Streaming         Transcription
                       (WebSocket)       (REST /api/v1/transcribe)
                            ↓               ↓
                       Redis Streams    Batch Service
                       (session mgmt)   (file processing)
                            ↓
                       Model Cache
                       (HuggingFace/MinIO)
```

## Communication Patterns

- **Internal APIs**: Prefixed with `/internal/` - called by API Gateway only
- **Public APIs**: Prefixed with `/api/v1/` - exposed to clients
- **Health**: `/health`, `/health/live`, `/health/ready`, `/health/startup`
- **Service-to-Service**: HTTP + service tokens (X-Service-Token header)
- **Async**: Redis Streams for streaming audio/control/result channels

## Technology Stack

- **Language**: Python 3.11+ (STT, TTS, NLP, Guardrail), TypeScript/Node.js (API, Admin Console)
- **Framework**: FastAPI (Python), NestJS (Node.js)
- **Message Queue**: Redis Streams
- **Cache/Storage**: Redis, MinIO (S3-compatible), PostgreSQL
- **Observability**: OpenTelemetry, Prometheus, Grafana, structured logging
- **ML Models**: HuggingFace, faster-whisper, whisper.cpp, Pyannote, Silero VAD
- **Deployment**: Kubernetes (k3s/EKS), Docker, GitLab CI

## Documentation Structure

Each microservice gets its own markdown file in `review/codewalk/`:
- `vox.md` - This file (common overview)
- `stt.md` - Speech-to-Text service (detailed)
- `tts.md` - Text-to-Speech service
- `api.md` - API Gateway
- `nlp.md` - NLP service
- `guardrail.md` - Guardrail service
- `text.md` - Text processing service
- `smr.md` - Speaker Matching & Recognition
- `harness.md` - Testing harness
- `admin-console.md` - Admin console

Each service file documents:
1. All API endpoints (route, method, handler function)
2. Handler → implementation function mapping
3. Function purpose & behavior
4. Data integration (memory, database, cache, object store, inter-service)
5. Sequence diagrams for key API flows

---

## Sequence Diagrams Reference

All diagrams are in `review/codewalk/diagrams/` (open `.html` files in browser):

### STT (Speech-to-Text) — `stt.md`
| API / Flow | Diagram File |
|------------|--------------|
| POST /internal/streaming/sessions — Session creation | `stt-streaming-session-create.html` |
| Real-time transcription flow (WebSocket → Redis → VAD → Inference) | `stt-streaming-transcription.html` |
| POST /api/v1/transcribe — Batch file transcription | `stt-batch-transcribe.html` |
| POST /internal/voice-profile/extract — Voice profile extraction | `stt-voice-profile-extract.html` |
| POST /internal/streaming/sessions/{id}/switch — Engine failover | `stt-engine-switch.html` |
| Health probes: /health, /live, /ready, /startup | `stt-health-check.html` |

### TTS (Text-to-Speech) — `tts.md`
| API / Flow | Diagram File |
|------------|--------------|
| POST /api/v1/audio/speech — Batch/SSE/Raw audio synthesis | `tts-batch-speech.html` |
| WS /api/v1/audio/stream — Duplex streaming synthesis | `tts-streaming-ws.html` |
| Router failover chain (before-first-byte) | `tts-routing-failover.html` |
| Health/readiness probes (4-state) | `tts-health-readiness.html` |
| Model resolvability check | `tts-model-resolvable.html` |

### NLP — `nlp.md`
| API / Flow | Diagram File |
|------------|--------------|
| POST /api/v1/classify/tokens — Token classification (NER) | `nlp-token-classification.html` |
| POST /api/v1/classify/text — Document classification | `nlp-text-classification.html` |
| POST /api/v1/classify/topic\|intent — LLM delegation to Text | `nlp-topic-intent-delegation.html` |
| POST /api/v1/guard/pii — PII detection with micro-batching | `nlp-guard-pii.html` |
| POST /api/v1/guard/entailment — MiniCheck NLI scoring | `nlp-guard-entailment.html` |
| POST /api/v1/diagnosis/suggestions — NER + disease classifier | `nlp-diagnosis-suggestions.html` |
| Model cache (pin-while-active + TTL sweep) | `nlp-model-cache.html` |
| Health/readiness (lazy-model aware) | `nlp-health-readiness.html` |

### API Gateway — `api.md`
| API / Flow | Diagram File |
|------------|--------------|
| POST /api/v1/speech/synthesize — TTS proxy with agent resolution | `api-speech-synthesize.html` |
| WS /api/v1/streaming/ws — STT WebSocket streaming | `api-stt-streaming.html` |
| GET /internal/agents/resolve — Agent resolution for harness | `api-agent-resolve.html` |
| Health probes: /live, /startup, /ready, /health | `api-health-probes.html` |
| STT batch job lifecycle (internal callbacks) | `api-tts-job-lifecycle.html` |
| POST /api/v1/text/generate — Text LLM proxy | `api-text-proxy.html` |

### Text — `text.md`
| API / Flow | Diagram File |
|------------|--------------|
| POST /api/v1/generate — Blocking + SSE generation | `text-generate.html` |
| GET /generations/{id}/stream — SSE with resumable tail | `text-streaming.html` |
| GET/POST /api/v1/providers — Parallel health probing | `text-providers-probe.html` |
| Input + Output guardrail gates (NLP delegation) | `text-guardrail-gate.html` |
| POST /tasks/{id}/cancel — Task cancellation | `text-task-cancel.html` |
| Health/readiness/startup probes | `text-health-probes.html` |

### Guardrail — `guardrail.md`
| API / Flow | Diagram File |
|------------|--------------|
| POST /api/guardrail/analyze — Real-time analysis via NLP | `guardrail-analyze.html` |
| POST /api/medical/validate — Medical validation via Text LLM | `guardrail-medical-validate.html` |
| POST /api/guardrail/redact — PII redaction with chunking | `guardrail-redact.html` |
| POST /api/guardrail/ground — Groundedness NLI via NLP | `guardrail-groundedness.html` |
| POST /api/guardrail/screen/inbound|outbound — Bidirectional screening | `guardrail-screen.html` |
| POST /realtime/segments + consumption gate | `guardrail-realtime.html` |
| Async jobs: submit + status polling | `guardrail-jobs.html` |
| Health probes (delegated model reporting) | `guardrail-health.html` |

### Harness — `harness.md`
| API / Flow | Diagram File |
|------------|--------------|
| POST /internal/consultations/{id}/document:start — Temporal workflow start | `harness-doc-start.html` |
| POST /internal/workflows/{id}/signal/approve — Clinician approval | `harness-signal-approve.html` |
| POST /internal/workflows/{id}/signal/context-added — Signal-with-start | `harness-signal-context-added.html` |
| POST /internal/eval/run — Golden set eval + PDSQI-9 gate | `harness-eval-gate.html` |
| POST /internal/knowledge/ingest — Chunk → embed → Qdrant upsert | `harness-knowledge-ingest.html` |
| GET /internal/harness/workflows — Temporal visibility + SA degrade | `harness-admin-list.html` |
| Health probes: /live, /startup, /ready (Temporal probe) | `harness-health.html` |

### Admin Console — `admin-console.md`
| API / Flow | Diagram File |
|------------|--------------|
| POST /api/auth/login — Credentials → JWE session cookie | `admin-console-login.html` |
| * /api/hope/* — BFF proxy with auto-refresh on 401 | `admin-console-proxy.html` |
| POST /api/auth/impersonate — 15m token + original recovery | `admin-console-impersonation.html` |
| POST /api/auth/logout — Gateway revocation + cookie clear | `admin-console-logout.html` |

---

## Quick Access

| Service | Markdown | Diagrams |
|---------|----------|----------|
| STT | [stt.md](stt.md) | 6 |
| TTS | [tts.md](tts.md) | 5 |
| NLP | [nlp.md](nlp.md) | 8 |
| API Gateway | [api.md](api.md) | 6 |
| Text | [text.md](text.md) | 6 |
| Guardrail | [guardrail.md](guardrail.md) | 8 |
| Harness | [harness.md](harness.md) | 7 |
| Admin Console | [admin-console.md](admin-console.md) | 4 |
| **Total** | **8 services** | **50 diagrams** |