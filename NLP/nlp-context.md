# Context: NLP service (project-hope) — handoff notes

Paste this file into a new Claude session to continue the work. Secrets (service tokens) are deliberately left out — ask the owner for them.

**Last updated 2026-10-22** — re-checked against `dev-2.2` at commit `8cb2e5e8` (the first study was at `dacdc311`, 7,410 commits earlier).

## Who / setup

- I am Josekutty George, new to the ArcaAI team, working on the `nlp` service.
- Machine: macOS, Apple Silicon. Workspace: `/Users/silverfang/arcaai/`.
- Repo: `ArcaAI/project-hope` (private). Clone over SSH with the alias `git@github-arcaai:ArcaAI/project-hope.git` (the alias points to github.com).
- Local path: `/Users/silverfang/arcaai/project-hope`. Branch: `dev-2.2` (not `dev2.2`). The local checkout is still at `dacdc311` with the uncommitted spelling fix; latest `dev-2.2` is `8cb2e5e8`.
- Python env: conda (Miniforge via Homebrew) env `arcaenv`, Python 3.11. Dependencies did not change between the two commits.
- Archify skill installed at `~/.agents/skills/archify` (from `tt-a1i/archify` via `npx skills add tt-a1i/archify -g`); linked into Claude Code and opencode. `opencode skill add` does not exist; the other team skills (`trace`, `infra-inspect`, `test-auditor`) have no known source yet.
- Preferences: keep explanations simple; ask when in doubt.

## What the NLP service is

- Python 3.11 FastAPI + Uvicorn app at `apps/nlp/` (code in `apps/nlp/src/nlp/`), port **8864**.
- Jobs: classify text, medical NER, vitals, diagnosis suggestions, spelling (en + ml), PDF/image extraction (PyMuPDF + RapidOCR), guard (PII, safety, entailment), topic/intent (via text service LLM).
- **No hardcoded models.** The gateway picks the model per task from the database and sends `model_name` (+ `clinical_taxonomy`) on every request; missing model → 503 (fail closed).
- Startup is lazy: no models load at boot; each loads on first request and is cached (max 3, 10 min idle).
- New on `8cb2e5e8`: input caps (`core/bounds.py`, 8,192 chars default → 413 `INPUT_EXCEEDS_WINDOW`; NER up to 200,000 chars, split into 2,000-char windows), `RecycleMiddleware` (restarts the worker after many requests or high memory), a residency router.

### Key files

| Path | Role |
|---|---|
| `app.py` | builds app: logging, token check, auth + recycle middleware, CORS, error handlers, routes |
| `lifespan.py` | startup/shutdown; gateway config client, Redis, text client, background warm/registration |
| `dependencies.py` | per-request model selection, model cache, loaders (most important file) |
| `api/v1/rest/*.py` | routes: classify, correct, diagnosis, extract, guard, models, monitoring |
| `api/middleware/auth.py` | `X-Service-Token` check (empty token = auth off in dev) |
| `core/config.py` | settings (`NLP_*`, `SPELLING_CORRECTOR_*`, …) |
| `core/bounds.py` | input caps and NER windowing |
| `core/effective_config.py` | live limits from gateway, 60 s cache, Redis invalidation |
| `services/*.py` | the work: text_corrector, document_extractor, text_classifier, token_classifier, gliner*, medical_suggester, entailment_scorer, assertion, ontology_linker, vitals_extractor, external_text_client |
| `data/dictionaries/{en,ml}/{unigram,bigram}.txt` | SymSpell word lists (Wikipedia-based) |

### Request flow (`/classify/tokens`)
auth (401) → input cap (413) → route + tenant check (400) → concurrency limit (503 busy) → find/load model in `dependencies.py` (503 if missing) → run model (windowed for long text) → enrich (ontology codes, negation, vitals — only if `clinical_taxonomy` is sent) → JSON.

## Default models (from the DB seed)

Defined in `packages/database/src/prisma/db_main/seed/ai-models/nlp.ts` (`NLP_AI_MODELS`, line 1106; Medical-NER at 109, `clinicalTaxonomy` at 148) and elected per task in `seed/16-ai-routing-policy.ts` (`SYSTEM_TASK_DEFAULT_ROUTING`, lines 95–120). The gateway resolves them in `apps/api/src/modules/ai-inference/ai-inference.controller.ts` (`resolveDefaultModelSelection`, `resolveTextSelection` at 509–531).

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
| nlp.topic / nlp.intent | /classify/topic, /intent | lms-gemma-4-e2b-it-qat on LM Studio; gateway sends `text_provider`, `text_model`, `text_provider_overrides` |

## Connected services

**Call NLP:** API gateway `apps/api` (`ai-inference.client.ts`: tokens, topic, intent, diagnosis; health), app services in `packages/applications` (live documentation, summary, agent → tokens; OCR processor → /extract; readiness → /internal/models/resolvable), guardrail `apps/guardrail` (`external_nlp_client.py`: /guard/pii, /guard/classify, /guard/entailment), harness `apps/harness` (`services/nlp_client.py`: /classify/tokens, /classify/text). STT, TTS, text do not call NLP.

**NLP calls:** gateway `/internal/effective-config`, `/internal/model-registry-credential`, `/internal/service-releases`; text service `POST /api/v1/generate` (:8862); Redis channel `arca:config:invalidate`; HuggingFace / S3 (MinIO) for weights; OTel collector. The text service screens prompts via guardrail `POST /api/v1/guardrail/screen/inbound` before calling the LLM.

## Run locally (works without Docker/Postgres/Vault/Redis/gateway/text)

1. `cp .env.sample .env.dev` at repo root (do NOT use `pnpm setup:dev` — it starts Docker, Vault, Postgres, migrations).
2. In `.env.dev`: set `INTERNAL_ACCESS_TOKEN` (already set locally) and `HF_HOME=~/.cache/huggingface` (default pointed to a missing `/Volumes/aillusion`).
3. `./scripts/setup-python-env.sh --service nlp --apple` (creates `arcaenv`; `pnpm nlp:setup:apple` fails if the env doesn't exist yet). Text service: `./scripts/setup-python-env.sh --install --service text`.
4. `pnpm nlp:dev` → http://127.0.0.1:8864 ; docs at /docs ; health at /api/v1/health. Use `NLP_PORT=8874 ./scripts/dev-service.sh nlp` for a second copy.
5. Tests on `8cb2e5e8`: 1,214 pass, 6 skipped. `test_task1049_bench_memory.py` can stop the whole run on a laptop low on memory — run it separately or `--ignore` it.

Calls need header `X-Service-Token: <token>`. A real NER call needs `model_name` and, for codes/negation/vitals, the `clinical_taxonomy` object from the seed (gateway normally injects it). Demo bodies: `~/arcaai/doc/demo/`.

## Uncommitted local changes (on the local `dacdc311` checkout)

1. `apps/nlp/src/nlp/api/v1/rest/correct.py` — route now calls `await service.initialize()` on first use, then 503 only if loading failed.
2. `apps/nlp/src/nlp/services/text_corrector.py` — a dictionary file that fails to load (symspellpy returns False) now raises, so the service is not marked ready.
3. `apps/nlp/tests/test_correct_text.py` — new: first request loads dictionaries (200); missing dictionaries → 503. Imports `nlp.app` first so the route's Depends binds the real getter before conftest patches it.
4. `.env.dev` (gitignored) — token + HF_HOME.

Root cause of the spelling 503: commit `3efe660bd` (2026-07-20) removed eager `initialize()` calls from `lifespan.py`. **Still broken on `8cb2e5e8`**; the fix needs re-applying to the new `correct.py` (lines 14–20) after pulling.

## Audit findings — status at `8cb2e5e8`

| # | Issue | Status at 8cb2e5e8 |
|---|---|---|
| 1 | /correct/text always 503 | Open (local fix not merged) |
| 2 | /correct/text: no length limit, on event loop | Open (code unchanged; unreachable while 1 is broken) |
| 3 | /extract: no upload limit, OCR on event loop | Open (code unchanged) |
| 4 | Inference on the event loop (text classify, NER, diagnosis, entailment) | Open, worse for NER: 49,280-char request blocked /health/live 25 s |
| 5 | Auth off on test server | Fixed on server |
| 6 | Docker image lacks dictionaries | Open (Dockerfile changed, still copies only src) |
| 7 | Multi-label only top label (`top_k` missing) | Open |
| 8 | Long text → 200 "other" | Partly fixed: >8,192 chars → 413; shorter text over the model limit still "other" |
| 9 | Spelling bigrams never load (`count_index=1`) | Open |
| 10 | Dictionary not medical (`amoxcillin`→ampicillin, `no fever`→to fever) | Needs decision |
| 11 | Image OCR empty, error hidden | Open (local: OpenCV/libiconv) |
| 12 | Service name `api-gateway` locally | Open |
| 13 | `.env.prod` uses `NLP_SERVICE_TOKEN` | Open |
| 14 | Empty text → "of" | Open (unreachable while 1 is broken) |
| 15 | /correct/text ignores `type`, `min_confidence`, `include_alternatives` | Open |
| 16 | /metrics 404 by default | Tests now pass; endpoint still off by default |
| — | Topic/intent LLM path | **Fixed (TASK-1016)**; still open: answer not checked against list, patient text in prompt |
| — | Diagnosis always empty (filter uses `B-`/`I-` tags, `set()` order, no `top_k`, no negation) | Open, reconfirmed with real models |

Model note: Medical-NER splits "chest pain" into "chest" (0.12) + "pain" (0.14), so no code and a 0.5 filter would drop it.

## Test deployment

- URL: `http://192.168.112.6:31765` (devops-deployed NLP; token from devops, not stored here). Last tested before `8cb2e5e8`.
- Works: health routes; auth (no/wrong token → 401); Medical-NER; PDF with text layer.
- Broken then: /correct/text 503; image OCR empty; gateway config refresh fails; topic/intent 503; version shows `dev`.

## Docs and diagrams

- Project walkthrough: https://claude.ai/code/artifact/3b76b2e8-a9e0-47f2-8826-8348778ca423
- Code walkthrough guide (presenter script): https://claude.ai/code/artifact/a212c8d8-548b-4c7e-aefe-aa97ae3e0583
- Hardcoded domain values: https://claude.ai/code/artifact/80319b0e-86ba-4917-8973-9f6f17e7621b
- Archify diagrams (code links to GitHub at `8cb2e5e8`): `~/arcaai/doc/diagrams/` — `architecture-nlp-service-connections-20261022-132531` and `sequence-nlp-llm-flow-20261022-132531`. Rebuilding needs `--repo-root` pointing at a checkout whose origin is `https://github.com/ArcaAI/project-hope.git`.
- GitHub copy: `ArcaAI/vox-platform-study`, branch `nlp-study`, folder `NLP/`.
- Team docs (`runbook.md`, `Master_Docs.md`) in `~/arcaai/doc/team-docs/`; partly out of date.

## Next steps / open questions

- Pull latest dev-2.2, re-apply the spelling fix, open a PR (which branch/PR flow?).
- Fix event-loop blocking (issues 2–4), tests first; then diagnosis filter, 6, 7, 9.
- Ask devops for pod logs on image OCR; re-test the deployment on the new build.
- Should spelling use a medical dictionary? Who picks models for nlp.classification / sentiment / toxicity?
