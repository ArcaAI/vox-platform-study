# NLP Service — Project Walkthrough

Oct 12, 2026 · @josekutty

## Overview

The NLP service is a Python 3.11 FastAPI app that reads medical text: it finds medical terms, suggests diagnoses, fixes spelling, reads PDFs and runs safety checks. It lives at `apps/nlp/` in the `project-hope` monorepo, listens on port 8864, and this walkthrough reflects branch `dev-2.2`.

| Item | Value |
| --- | --- |
| Repo | `ArcaAI/project-hope` (clone over SSH with the `github-arcaai` alias) |
| Path | `apps/nlp/` (code in `src/nlp/`) |
| Branch reviewed | `dev-2.2` |
| Language / framework | Python 3.11, FastAPI + Uvicorn |
| Port | 8864 |
| Python env | conda env `arcaenv` |
| Test suite | \~60 files in `apps/nlp/tests/`, 707 tests |

It does eight jobs: classify notes, find medical terms (NER), read vitals, suggest diagnoses, fix spelling (English and Malayalam), read PDFs and images, run safety checks (PII, moderation, groundedness), and pick a topic or intent by asking the text service's LLM.

## Where NLP fits

NLP never chooses a model: the gateway reads the task's model from the database and sends `model_name` with every request, and a missing model returns 503 instead of a guess.

_Diagram "NLP and its neighbours" is in the live doc: https://claude.ai/code/artifact/3b76b2e8-a9e0-47f2-8826-8348778ca423_

The gateway also serves live limits and S3 credentials; without it NLP runs on built-in defaults. The text service is needed only for topic and intent, and Redis only makes config changes apply instantly.

## Folder map

All real code is under `apps/nlp/src/nlp/`; `dependencies.py` is the file to learn first, because it picks and loads the model for every request.

| Path | What it does |
| --- | --- |
| `__init__.py`, `torch_runtime.py` | Sets CPU thread counts before torch loads |
| `app.py` | Builds the FastAPI app: logging, token check, middleware, error handlers, routes |
| `lifespan.py` | Startup and shutdown; loads no models (lazy) |
| `dependencies.py` | Per-request model selection, model cache, loaders |
| `api/v1/rest/` | REST routes: classify, correct, diagnosis, extract, guard, models, monitoring |
| `api/v1/ws/` | WebSocket routes for streaming classify |
| `api/middleware/auth.py` | `X-Service-Token` check (HTTP and WebSocket) |
| `api/tenant.py` | Rejects a body tenant that differs from the `X-Tenant-Id` header |
| `core/config.py` | All settings (env prefix `NLP_`, `SPELLING_CORRECTOR_`, etc.) |
| `core/effective_config.py` | Fetches live limits from the gateway, cached 60 s |
| `core/concurrency.py`, `batching.py`, `priority_gate.py` | Limits, micro-batching, fast lane for urgent requests |
| `core/device.py` | Puts models on cpu / mps / cuda |
| `models/source_resolver.py` | Gets weights from a local path, `file://`, S3 or HuggingFace |
| `services/` | The actual work (one file per feature, see Endpoints) |
| `schemas/` | Request and response shapes |
| `data/dictionaries/` | Spelling word lists: `en` and `ml`, unigram + bigram |
| `tests/` | pytest suite; `tests/load/` is an opt-in stress test |
| `Dockerfile` | CPU-only production image |

## Startup and the life of a request

Startup loads no models, so the server is ready in about a second; each model loads on its first request (3.5 min the first time for Medical-NER locally, 41 s on the server).

### Startup

1. `__init__.py` sets torch thread counts from the container CPU limit.
2. `app.py` turns on logging, checks the token (production refuses to start without one), adds auth, CORS and error handlers, and mounts the routes.
3. `lifespan.py` creates the gateway config client, connects to Redis if it is there, creates the text-service client, and starts background jobs to warm models and register the service.

### One request

_Diagram "One /classify/tokens request" is in the live doc: https://claude.ai/code/artifact/3b76b2e8-a9e0-47f2-8826-8348778ca423_

Steps 5 and 6 run on the event loop for NER, text classification and diagnosis, which is why one slow request delays every other request (Known issues 2–4). Enrichment needs the `clinical_taxonomy` the gateway sends.

## Endpoints

All routes sit under `/api/v1` and need `X-Service-Token` except `/`, the health routes, `/metrics` and the docs. Model routes need `model_name` in the body; without it they return 503 by design.

| Endpoint | Service file | Needs a model |
| --- | --- | --- |
| `POST /correct/text` | `text_corrector.py` (SymSpell) | No, uses dictionaries |
| `POST /extract` | `document_extractor.py` (PyMuPDF + RapidOCR) | No |
| `POST /classify/text` | `text_classifier.py` | Yes |
| `POST /classify/text/multi-label` | `text_classifier.py` | Yes |
| `POST /classify/tokens` | `token_classifier.py` or `gliner_token_classifier.py` | Yes |
| `POST /diagnosis/suggestions` | `medical_suggester.py` (NER, then disease model) | Yes, two |
| `POST /guard/pii` | `gliner2_guard.py` + `guard_dispatch.py` | Yes, plus `tenant_id` |
| `POST /guard/classify` | `gliner2_guard.py` + `guard_dispatch.py` | Yes, plus `tenant_id` |
| `POST /guard/entailment` | `entailment_scorer.py` (MiniCheck) | Yes, plus `tenant_id` |
| `POST /classify/topic`, `/classify/intent` | `external_text_client.py` → text service | No; needs the text service |
| `GET/POST /internal/models/resolvable` | `rest/models.py` | No |
| `GET /health`, `/health/live`, `/ready`, `/startup` | `rest/monitoring.py` | No |
| `WS /ws/classify/token/{id}`, `/ws/classify/text/{id}` | `ws/classify.py` | Yes |

## Models

The NLP code holds no model names: the database picks a model per task and the gateway sends it on every request. Defaults are seeded in `packages/database/src/prisma/db_main/seed/ai-models/nlp.ts` (model details) and `seed/16-ai-routing-policy.ts` (task → model).

| Task key | Endpoint | Default model (HuggingFace) |
| --- | --- | --- |
| `nlp.ner` | `/classify/tokens` | `blaze999/Medical-NER` |
| `nlp.diagnosis` | `/diagnosis/suggestions` | `shanover/symps_disease_bert_v3_c41` (41 diseases), after Medical-NER |
| `guardrail.pii` | `/guard/pii` | `fastino/gliner2-privacy-filter-PII-multi` |
| `guardrail.pii.spans` | `/guard/pii` | `fastino/GLiNER2-Guardrails-PII-Multi` (English only on this platform) |
| `guardrail.safety` | `/guard/classify` | `fastino/gliguard-LLMGuardrails-300M` (6 safety tasks) |
| `guardrail.groundedness` | `/guard/entailment` | `nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF` |
| `nlp.classification` | `/classify/text` | `nlp-doc-type-classifier`, retired, so always 503 |
| `nlp.sentiment`, `nlp.toxicity` | `/classify/text`, `/multi-label` | None: open owner decision |
| `nlp.topic`, `nlp.intent` | `/classify/topic`, `/intent` | Text service LLM (`gemma-4-e2b-it-qat` on LM Studio) |

### Clinical taxonomy

The model only finds words. Negation ("denies fever" → ABSENT), medical codes (ICD, SNOMED, RxNorm, UMLS) and vitals come from a `clinical_taxonomy` block that the gateway injects from `AiModel.metaData.clinicalTaxonomy`. Without it those passes are off, so a direct call returns no codes, no vitals and marks everything PRESENT. The seeded code list has 40 terms.

### Tested result

Input: "45 year old man with chest pain and shortness of breath. He denies fever. BP 150/95, HR 102. Started on aspirin 75 mg." With the taxonomy, Medical-NER returned shortness of breath (ICD R06.02), fever marked ABSENT (ICD R50.9), aspirin (RxNorm 1191) and vitals 150/95 and HR 102, in about 0.9 s on CPU. "Chest pain" is split into "chest" + "pain", so it gets no code.

## Run it locally

NLP runs alone on a Mac with only conda and the repo; no Docker, Postgres, Vault, Redis, gateway or text service is needed.

1. Install conda (Miniforge): `brew install --cask miniforge`
2. Clone and switch branch: `git clone git@github-arcaai:ArcaAI/project-hope.git`, then `git checkout dev-2.2`
3. Create the env file: `cp .env.sample .env.dev` at the repo root. Do not use `pnpm setup:dev`; on this branch it also starts Docker, Vault and Postgres.
4. In `.env.dev`, set `INTERNAL_ACCESS_TOKEN` (ask the team) and point `HF_HOME` to a folder that exists, for example `~/.cache/huggingface`.
5. Create the env and install NLP: `./scripts/setup-python-env.sh --service nlp --apple` (about 10 minutes the first time).
6. Start it: `pnpm nlp:dev` → `http://127.0.0.1:8864`
7. Check it: `curl localhost:8864/api/v1/health`; API docs at `http://localhost:8864/docs`.

### Dependencies it can run without

| Dependency | Without it |
| --- | --- |
| Vault, Postgres | Not used by NLP's Python code |
| Redis | Config changes apply after up to 60 s instead of instantly |
| Gateway `:8868` | Built-in default limits; no S3 credentials for model downloads |
| Text service `:8862` | Only `/classify/topic` and `/classify/intent` fail (503) |

### Test and quality commands

- `pnpm nlp:test` — full suite (705 pass, 2 metrics tests already fail on `dev-2.2`)
- `pnpm nlp:lint`, `pnpm nlp:typecheck`, `pnpm nlp:format:check` — all clean
- `pnpm nlp:test:cov` — 88% coverage overall

### Runbook corrections

- `pnpm setup:dev` does far more than copy the env file.
- `/metrics` returns 404 locally; it is off by default.
- `/correct/text` did not work without a fix (see Known issues).

## Deployment

The test deployment at `192.168.112.6:31765` serves Medical-NER correctly with auth on, but spelling and image OCR do not work yet.

### Build

Build the base image first, then NLP, from the repo root:

```bash
docker build --platform linux/amd64 -t hope-python-base:latest infrastructure/docker/python-base/
docker build --platform linux/amd64 -f apps/nlp/Dockerfile --build-arg BASE_IMAGE=hope-python-base:latest --build-arg BUILD_SERVICE=nlp --build-arg BUILD_VERSION=<version> --build-arg BUILD_GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD) --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) --build-arg BUILD_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) -t nlp:<version> .
```

The Dockerfile copies only `apps/nlp/src`, so the spelling dictionaries are missing from the image. Add `COPY --chown=hope:hope apps/nlp/data ./data` to the production stage.

### What the server needs

| Need | Why |
| --- | --- |
| `INTERNAL_ACCESS_TOKEN` | Production refuses to start without it |
| `API_GATEWAY_KEY` | Gateway calls for model credentials |
| Port 8864 reachable by the gateway | Service port |
| Persistent volume for `HF_HOME` (`/app/.cache/huggingface`) | Models download on first use; without a volume they download again after every restart |
| Network access to HuggingFace or S3/MinIO | Models are not in the image |
| 2+ CPU, 4–8 GB RAM | Up to 3 models stay in memory |
| Optional: gateway, text service, Redis, OTel collector | Live limits, topic/intent, instant config, traces |

`.env.prod` sets `NLP_SERVICE_TOKEN`, but the code reads `INTERNAL_ACCESS_TOKEN`. It also still sets `LOG_FILE_*` and `NLP_OTEL_ENABLED`, which the code no longer uses.

### Test server results

| Check | Result |
| --- | --- |
| Health, live, ready, startup | Pass |
| Auth: no token / wrong token | 401 (on after devops set the token) |
| Medical-NER `/classify/tokens` | Pass; same output as local, 0.4–0.7 s after first load |
| PDF with a text layer `/extract` | Pass |
| `/correct/text` | 503: code bug + dictionaries missing from image |
| Image OCR `/extract` (PNG) | Empty text, error hidden |
| Gateway config refresh | Fails (`last_refresh_ok: false`) |
| `/classify/topic`, `/intent` | 503: text service not reachable |
| Version | Shows `dev` (build arg) |

## Known issues

The audit of `dev-2.2` found 16 issues; the most serious is that one large request can freeze the whole service, because heavy work runs on the single event loop. Ruff, black and mypy are clean, so these are runtime and logic problems.

| # | Issue | Evidence | Severity | Status |
| --- | --- | --- | --- | --- |
| 1 | `/correct/text` always returned 503: dictionaries were never loaded after the July lazy-startup refactor (`3efe660bd`) | Fixed with tests in `correct.py` + `text_corrector.py`; not committed | High | Fixed locally |
| 2 | `/correct/text` has no length limit and runs on the event loop | 2,000 words took 15.7 s; 200k chars froze the server at 100% CPU for 10+ min | High | Open |
| 3 | `/extract` has no upload size limit; OCR runs on the event loop | A 6.8 KB, 40-page PDF blocked all requests for 13 s | High | Open |
| 4 | Text classification, NER, diagnosis, entailment and model loading run on the event loop | `text_classifier.py:179`, `token_classifier.py:184`, `guard.py:451` | High | Open |
| 5 | Auth was off on the test server | Calls without a token were accepted | High | Fixed on server |
| 6 | Docker image is missing `apps/nlp/data/dictionaries` | Dockerfile copies only `src` | Medium | Open |
| 7 | Multi-label returns only the top label (no `top_k=None`) | 2-label model, threshold 0 → 1 label | Medium | Open |
| 8 | Long text in `/classify/text` returns 200 "other", confidence 0 (no truncation, error swallowed) | 3,000 words | Medium | Open |
| 9 | Spelling bigrams never load (`count_index=1` on a 3-column file) | 0 of 695,116 loaded | Medium | Open |
| 10 | English dictionary is Wikipedia-based, not medical | `fver` → `over`; `amoxicillin` missing | Medium | Needs decision |
| 11 | Image OCR returns empty text, error hidden | Locally OpenCV fails to load; server cause unknown | Medium | Open |
| 12 | NLP reports itself as `api-gateway` locally (falls back to the shared `OTEL_SERVICE_NAME`) | `GET /health` | Medium | Open |
| 13 | `.env.prod` uses `NLP_SERVICE_TOKEN`; code reads `INTERNAL_ACCESS_TOKEN` | Production would refuse to start | Medium | Open |
| 14 | Empty text is "corrected" to `of` | `{"text":""}` | Low | Open |
| 15 | `/correct/text` ignores `type`, `min_confidence`, `include_alternatives` | Same output for any value | Low | Open |
| 16 | `/metrics` 404 by default; 2 metrics tests fail | `test_metrics_endpoint_task636.py` | Low | Open |

Model quality notes: Medical-NER splits "chest pain" into two low-confidence words (0.12 and 0.14), so it gets no code and a 0.5 confidence filter would drop it.
