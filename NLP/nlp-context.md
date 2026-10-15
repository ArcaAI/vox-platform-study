# Context: NLP service (project-hope) — handoff notes

Paste this file into a new Claude session to continue the work. Secrets (service tokens) are deliberately left out — ask the owner for them.

## Who / setup

- I am Josekutty George, new to the ArcaAI team, working on the `nlp` service.
- Machine: macOS, Apple Silicon. Workspace: `/Users/silverfang/arcaai/`.
- Repo: `ArcaAI/project-hope` (private). Clone over SSH with the alias `git@github-arcaai:ArcaAI/project-hope.git` (HTTPS fails).
- Local path: `/Users/silverfang/arcaai/project-hope`. Branch: `dev-2.2` (not `dev2.2`).
- Python env: conda (Miniforge via Homebrew) env `arcaenv`, Python 3.11.
- `opencode` 1.18.35 is installed, but `opencode skill add` does not exist in it. The team's skills (`archify`, `trace`, `infra-inspect`, `test-auditor`) have no known source yet.
- Preferences: keep explanations simple; ask when in doubt; in this team's repos, commit messages are a single conventional-commit title (no body).

## What the NLP service is

- Python 3.11 FastAPI + Uvicorn app at `apps/nlp/` (code in `apps/nlp/src/nlp/`), port **8864**.
- Jobs: classify text, medical NER, vitals, diagnosis suggestions, spelling (en + ml), PDF/image extraction (PyMuPDF + RapidOCR), guard (PII, safety, entailment), topic/intent (via text service LLM).
- **No hardcoded models.** The gateway picks the model per task from the database and sends `model_name` (+ `clinical_taxonomy`) on every request; missing model → 503 (fail closed).
- Startup is lazy: no models load at boot; each loads on first request and is cached (max 3, 10 min idle).

### Key files

| Path | Role |
|---|---|
| `app.py` | builds app: logging, token check, auth middleware, CORS, error handlers, routes |
| `lifespan.py` | startup/shutdown; gateway config client, Redis, text client, background warm/registration |
| `dependencies.py` | per-request model selection, model cache, loaders (most important file) |
| `api/v1/rest/*.py` | routes: classify, correct, diagnosis, extract, guard, models, monitoring |
| `api/middleware/auth.py` | `X-Service-Token` check (empty token = auth off in dev) |
| `core/config.py` | settings (`NLP_*`, `SPELLING_CORRECTOR_*`, …) |
| `core/effective_config.py` | live limits from gateway, 60 s cache, Redis invalidation |
| `services/*.py` | the work: text_corrector, document_extractor, text_classifier, token_classifier, gliner*, medical_suggester, entailment_scorer, assertion, ontology_linker, vitals_extractor, external_text_client |
| `data/dictionaries/{en,ml}/{unigram,bigram}.txt` | SymSpell word lists (Wikipedia-based) |

### Request flow (`/classify/tokens`)
auth (401) → route + tenant check (400) → concurrency limit (503 busy) → find/load model in `dependencies.py` (503 if missing) → run model → enrich (ontology codes, negation, vitals — only if `clinical_taxonomy` is sent) → JSON.

## Default models (from the DB seed)

Defined in `packages/database/src/prisma/db_main/seed/ai-models/nlp.ts` (`NLP_AI_MODELS`) and elected per task in `seed/16-ai-routing-policy.ts` (`SYSTEM_TASK_DEFAULT_ROUTING`, lines ~78–93). Seeded into tables `AiModel` and `AiRoutingPolicy`; the gateway resolves them in `apps/api/src/modules/ai-inference/ai-inference.controller.ts` (`resolveNerModelInjection`).

| Task | Endpoint | Model |
|---|---|---|
| nlp.ner | /classify/tokens | blaze999/Medical-NER (carries `metaData.clinicalTaxonomy`: 40-term code list, vitals ranges, negation triggers) |
| nlp.diagnosis | /diagnosis/suggestions | shanover/symps_disease_bert_v3_c41 (after Medical-NER) |
| guardrail.pii | /guard/pii | fastino/gliner2-privacy-filter-PII-multi |
| guardrail.pii.spans | /guard/pii | fastino/GLiNER2-Guardrails-PII-Multi |
| guardrail.safety | /guard/classify | fastino/gliguard-LLMGuardrails-300M |
| guardrail.groundedness | /guard/entailment | nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF |
| nlp.classification | /classify/text | nlp-doc-type-classifier — retired, so always 503 |
| nlp.sentiment / nlp.toxicity | /classify/text(/multi-label) | none (open owner decision) |
| nlp.topic / nlp.intent | /classify/topic, /intent | text service LLM (gemma-4-e2b-it-qat on LM Studio) |

## Connected services

**Call NLP:** API gateway `apps/api` (`ai-inference.client.ts`: tokens, topic, intent, diagnosis; health), app services in `packages/applications` (live documentation, summary, agent → tokens; OCR processor → /extract; readiness → /internal/models/resolvable), guardrail `apps/guardrail` (`external_nlp_client.py`: /guard/pii, /guard/classify, /guard/entailment), harness `apps/harness` (`services/nlp_client.py`: /classify/tokens, /classify/text). STT, TTS, text do not call NLP.

**NLP calls:** gateway `/internal/effective-config`, `/internal/model-registry-credential`, `/internal/service-releases`; text service `POST /generate` (:8862); Redis channel `arca:config:invalidate`; HuggingFace / S3 (MinIO) for weights; OTel collector.

## Run locally (works without Docker/Postgres/Vault/Redis/gateway/text)

1. `cp .env.sample .env.dev` at repo root (do NOT use `pnpm setup:dev` — on dev-2.2 it starts Docker, Vault, Postgres, migrations).
2. In `.env.dev`: set `INTERNAL_ACCESS_TOKEN` (already set locally) and `HF_HOME=~/.cache/huggingface` (default pointed to a missing `/Volumes/aillusion`).
3. `./scripts/setup-python-env.sh --service nlp --apple` (creates `arcaenv`; `pnpm nlp:setup:apple` fails if the env doesn't exist yet).
4. `pnpm nlp:dev` → http://127.0.0.1:8864 ; docs at /docs ; health at /api/v1/health.
5. Tests: `pnpm nlp:test` (705 pass, 2 metrics tests already fail on dev-2.2), `pnpm nlp:lint`, `pnpm nlp:typecheck` (clean), coverage 88%.

Calls need header `X-Service-Token: <token>`. A real NER call needs `model_name` and, for codes/negation/vitals, the `clinical_taxonomy` object from the seed (gateway normally injects it).

## Uncommitted local changes (on dev-2.2)

1. `apps/nlp/src/nlp/api/v1/rest/correct.py` — route now calls `await service.initialize()` on first use, then 503 only if loading failed.
2. `apps/nlp/src/nlp/services/text_corrector.py` — a dictionary file that fails to load (symspellpy returns False) now raises, so the service is not marked ready.
3. `apps/nlp/tests/test_correct_text.py` — new: first request loads dictionaries (200, `fver`→`fever` with test dicts); missing dictionaries → 503. Imports `nlp.app` first so the route's Depends binds the real getter before conftest patches it.
4. `.env.dev` (gitignored) — token + HF_HOME.

Root cause of the spelling 503: commit `3efe660bd` (2026-07-20) removed eager `initialize()` calls from `lifespan.py`; the spell checker was never given a lazy init.

## Audit findings (dev-2.2)

| # | Issue | Evidence | Severity | Status |
|---|---|---|---|---|
| 1 | /correct/text always 503 | see above | High | Fixed locally, not committed |
| 2 | /correct/text: no length limit, runs on event loop | 2,000 words 15.7 s; 200k chars froze server 100% CPU 10+ min | High | Open |
| 3 | /extract: no upload limit, OCR on event loop | 6.8 KB 40-page PDF blocked all requests 13 s | High | Open |
| 4 | Text classify, NER, diagnosis, entailment `score_pairs`, `from_pretrained` run on event loop (only guard uses `to_thread`) | text_classifier.py:179, token_classifier.py:184, guard.py:451 | High | Open |
| 5 | Auth was off on test server | no-token calls accepted | High | Fixed on server (now 401) |
| 6 | Docker image lacks dictionaries (copies only `apps/nlp/src`) | needs `COPY --chown=hope:hope apps/nlp/data ./data` | Medium | Open |
| 7 | Multi-label returns only top label (`pipeline(text)` without `top_k=None`) | 2-label model, threshold 0 → 1 label | Medium | Open |
| 8 | Long text in /classify/text → 200 "other" conf 0 (no truncation, error swallowed) | 3,000 words | Medium | Open |
| 9 | Spelling bigrams never load (`count_index=1` on 3-column file; should be 2) | 0 of 695,116 | Medium | Open |
| 10 | English dictionary not medical | `fver`→`over`, amoxicillin missing | Medium | Needs decision |
| 11 | Image OCR returns empty, error hidden | local: OpenCV/libiconv load failure in conda env; server cause unknown | Medium | Open |
| 12 | Service name shows `api-gateway` locally (falls back to shared `OTEL_SERVICE_NAME`) | GET /health | Medium | Open |
| 13 | `.env.prod` uses `NLP_SERVICE_TOKEN`; code reads `INTERNAL_ACCESS_TOKEN`; still has retired `LOG_FILE_*`, `NLP_OTEL_ENABLED` | | Medium | Open |
| 14 | Empty text "corrected" to `of` | | Low | Open |
| 15 | /correct/text ignores `type`, `min_confidence`, `include_alternatives` | | Low | Open |
| 16 | /metrics 404 by default; 2 metrics tests fail | test_metrics_endpoint_task636.py | Low | Open |

Model note: Medical-NER splits "chest pain" into "chest" (0.12) + "pain" (0.14), so no code and a 0.5 filter would drop it.

## Test deployment

- URL: `http://192.168.112.6:31765` (devops-deployed NLP; token from devops, not stored here).
- Works: health routes; auth (no/wrong token → 401); Medical-NER (same output as local, ~0.4–0.7 s after first load); PDF with text layer.
- Broken: /correct/text 503; image OCR empty; gateway config refresh fails (`last_refresh_ok: false`); topic/intent 503 (text service unreachable); version shows `dev`.
- Freeze test deliberately NOT run on the shared server.
- Build (base image first):
  `docker build --platform linux/amd64 -t hope-python-base:latest infrastructure/docker/python-base/` then
  `docker build --platform linux/amd64 -f apps/nlp/Dockerfile --build-arg BASE_IMAGE=hope-python-base:latest --build-arg BUILD_SERVICE=nlp --build-arg BUILD_VERSION=<version> ... -t nlp:<version> .`

## Docs

- Walkthrough doc (shared, editable): https://claude.ai/code/artifact/3b76b2e8-a9e0-47f2-8826-8348778ca423
- `~/Downloads/runbook.md` and `~/Downloads/Master_Docs.md` — team docs; partly out of date (setup:dev, /metrics, "all inference uses to_thread" is false, branch name).

## Next steps / open questions

- Commit the spelling fix on a branch off dev-2.2 and open a PR (which branch/PR flow?).
- Fix issues 2–4 (move blocking work to threads, add size limits), tests first; then 6–9.
- Ask devops for pod logs on image OCR.
- Should spelling use a medical dictionary? Who picks models for nlp.classification / sentiment / toxicity?
- Where do the opencode skills come from?
