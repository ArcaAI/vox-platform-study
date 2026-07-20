# TASK-527 — Model Source & Path Resolution (HF / local / S3)

- **Status**: Review
- **Type**: feature
- **Program**: Phase 2 of the [2026-07-20 agentic platform program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) (§3 **AD-3** frozen design, §4 Phase 2, §8 **OD-4**) · findings basis: [2026-07-20 review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) §3-E5 (transformer row), §4.B **D-12**, §7 **GAP-C3**
- **Suggested number**: TASK-527 per the program plan's TASK-523…534 allocation (highest committed number was TASK-522 when the plan was authored) — confirm at open time per the CLAUDE.md ticket workflow.
- **Size**: M · **Lanes**: A (database) + D (stt-v2) + E (guardrail/nlp/harness), with one small lane-B touchpoint (`apps/api/src/modules/ai-inference/` DTO/injection — recorded in the ownership manifest §4.7 so no lane collision occurs)
- **Dependencies**: **TASK-523** (P0 defect clearance; starts only after the owner commits the current ~330-file tree, plan §2.3/OD-7). **Coordination (not a hard block)**: TASK-525's effective-config client is the recommended weight-path transport for **harness** (§3.6); the env-fallback design lets every other stage land before 525 does. TASK-529 owns the MiniCheck *cache* structure — this ticket only changes the *path fed into it* (boundary in §4.7).
- **Owner decision recorded (OD-4, plan §8)**: **`s3://` only this program** (MinIO-compatible endpoints). `azure-blob://` is explicitly out of scope; the scheme-dispatch design leaves room for it later.
- **Closes**: GAP-C3 (no S3 source; `localPath` honored only by stt-v2) and D-12 (`AiModel.localPath` dead for guardrail/NLP/harness weights).

---

## 1. Requirement Analysis

Owner expectation **E5** (findings §"Owner requirements assessed", verbatim): *"Provider-specific model management: **transformer→HF path default + admin-declarable path (local/S3)**; lmstudio/ollama→server-managed …; llama.cpp/whisper.cpp→stt-v2 owns the binding …; azure/cloud→…"* — this ticket implements the bolded transformer clause across all four weight-loading services, plus the D-12 closure so an admin editing an `AiModel` row actually changes what loads.

| ID | Requirement | Source |
|---|---|---|
| R1 | `AiModelSource` gains `S3`; Prisma↔Python enum mirrors stay in sync (test-locked) | GAP-C3; plan AD-3 |
| R2 | `sourceUri` scheme conventions documented where admins see them (schema comment + `admin/ai-models` Swagger): `hf:<org>/<repo>` or bare HF id · `file:///abs/path` · `s3://bucket/prefix` | plan AD-3 |
| R3 | One `resolve_model_dir(identity) -> Path` contract per service-family (stt-v2 extends, guardrail/nlp/harness adopt): `local_path` first (exists-check) → scheme dispatch (HF `snapshot_download` honoring `HF_HUB_OFFLINE` · `s3://` download-once with single-flight + checksum · `file://` verify+use) | plan AD-3 |
| R4 | D-12: guardrail read model gains `local_path`; gateway NLP DTO gains `modelPath?` next to `model_name`; both MiniCheck GGUF weight paths (guardrail groundedness, harness atomic-fact) resolve DB-first with env fallback — the `AiModel` row is `minicheck-flan-t5-large` | findings D-12 |
| R5 | House constraints: additive migration; lazy imports for optional S3 clients; `asyncio.to_thread` for blocking downloads; structlog dotted events; harness weight resolution inside activities only (workflow determinism untouched) | plan §2.3; rules 02/06 |

## 2. Current State Evaluation (code-verified 2026-07-20; line numbers will drift with the working tree)

### 2.1 Enum & schema today

- `AiModelSource` = `HUGGINGFACE | GITHUB | MLFLOW | LOCAL` — `packages/database/src/prisma/db_main/enums.prisma:282-289`. **No S3/cloud value.**
- `AiModel` already has every field the resolver needs: `source` (`stt.prisma:121`, comment still says "HUGGINGFACE, GITHUB, MLFLOW, LOCAL"), `sourceUri` (`:122`, comment gives no scheme grammar), `sourceRevision` (`:123`), `downloadStatus` (`:138`), `localPath` (`:139`, comment "Local cache path after download" — understates its operator-override role), `checksum` (`:142`, "SHA256 for verification").
- Python mirrors (stt-v2):
  - SQLAlchemy pg-enum mirror `AiModelSourceType` = exactly the 4 Prisma values (`apps/stt-v2/src/stt_v2/core/database/models.py:34-42`, `create_type=False` — Postgres owns the type).
  - Pipeline StrEnum `AiModelSource` (`apps/stt-v2/src/stt_v2/pipeline/dto.py:21-28`) is a **superset**: adds reserved `KSERVE` (not in Prisma; pre-existing, deliberate).
  - **The TASK-505/506-era enum-sync test** is `apps/stt-v2/tests/unit/test_db_enum_mirrors.py` — it locks format/category/task-type mirrors against `enums.prisma` (`:13-28` expected sets, `:90-99` asserts) but has **no `AiModelSource` assertion** (only the columns test `:102-104` touches `AiModelRead`). StrEnum values are separately asserted in `tests/unit/test_pipeline_dto_updates.py:322-353`.

### 2.2 Per-service model-path resolution (re-verified findings §3-E5 table)

| Service | Honors `localPath` | Scheme support | Evidence |
|---|---|---|---|
| **stt-v2** | ✅ every loader prefers `local_path` | HF id only (`snapshot_download`); no `s3://`, no `file://` parsing, no explicit `HF_HUB_OFFLINE` handling | `config_reader.py:334-353` maps `local_path` (`:348`); loaders: `faster_whisper_loader.py:59-60`, `huggingface_loader.py:46` (`local_path or source_uri`), `parakeet_cpp_loader.py:54`, `nemo_loader.py:44-49`, `whisper_cpp_loader.py:54-58` (falls to `_fetch_gguf_file` → `snapshot_download`, `:100-108`), `onnx_loader.py:70,334`. HF cache/token settings exist: `core/config/settings.py:148-155` |
| **guardrail** | ❌ read model doesn't even select it | GLiNER loads by HF id (`providers/gliner.py:87-91` `GLiNER2ONNXRuntime.from_pretrained(model_id)`); MiniCheck path 100 % env | `AiModelRead` selects only `id/tenantId/slug/provider/sourceUri/_metadata/resourceStatus` (`core/tenant_config.py:110-122`); `_load_from_db` returns provider/`sourceUri`/azureDeployment only (`:255-304`); groundedness scorer refuses to start without env `GUARDRAIL_V2_GROUNDEDNESS_MODEL_PATH` (`core/config.py:186` via prefix `:175`; hard raise `services/groundedness_scorer_minicheck.py:187-192` — "no network pull in the clinical gate") |
| **nlp** | ❌ path never reaches it | Gateway injects `AiModel.sourceUri` as `model_name` only; loaders `from_pretrained(model_name)` | gateway `ai-inference.controller.ts:68-89` (inject sites), `:105-128` (override validated → returns `sourceUri`), `:130-155` (default → `sourceUri`); NLP schemas carry only `model_name` (`schemas/classification.py` TextClassification/TokenClassification requests, `schemas/diagnosis.py` DiagnosisSuggestionRequest; endpoint guards `api/v1/rest/classify.py:27,58`, `rest/diagnosis.py:18`); loaders `services/token_classifier.py:81-82`, `text_classifier.py:75-76`, `medical_suggester.py:36-37`. Note: `_MODEL_IDENTITY_FIELDS` **already includes `model_path`** in the env-block filter (`core/config.py:19`) — request-injection is the sanctioned identity lane |
| **harness** | ❌ env-only | MiniCheck atomic-fact path from `HARNESS_ATOMIC_FACT_MODEL_PATH` | `core/config.py:342-360` (`atomic_fact_model_path` `:350`); consumed by `_atomic_fact_entailer` (`temporal/activities.py:375-403` — falls back to `DeterministicOverlapEntailer` when unset); loaded via module-level per-path cache `sensors/inferential/minicheck_entailer.py:164-202`. Harness has **no DB access** (no sqlalchemy in `apps/harness/pyproject.toml`; verified) — it reaches the gateway via `_api_client` (`fetch_policy`, `activities.py:524-545`) |

### 2.3 The MiniCheck registry row (R4 target)

- SYSTEM `AiModel` row `minicheck-flan-t5-large` exists: `packages/database/src/prisma/db_main/seed/ai-models/nlp.ts:85-104` (`source: HUGGINGFACE`, `sourceUri: 'nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF'`, `format: GGUF`, no seeded `localPath`/`checksum`).
- `AiTaskDefault` `guardrail.groundedness` → that slug (`seed/16-ai-task-default.ts:99`; count-locked by `seed/__tests__/task-506-ai-model-consolidation.test.ts:117,557`). Harness's atomic-fact use has **no task key** (not one of the 9) — harness must resolve **by slug**.
- Guardrail's resolver already accepts the `guardrail.groundedness` task key (`tenant_config.py:52-55,188-189`) with a 60 s TTL cache (`config.py:262` `config_cache_ttl_s`) and negative-cache env fallback — the proven delivery mechanism; it just doesn't carry a path.

### 2.4 S3 client inventory (decides `uv lock`)

| Service | S3-capable client today | Evidence |
|---|---|---|
| stt-v2 | ✅ `minio>=7.2.20` (comment: "backs both the `minio` and `aws_s3` providers") | `apps/stt-v2/pyproject.toml:48-49`; `core/storage/minio_client.py`, `core/storage/providers/s3_provider.py` |
| harness | ✅ `boto3>=1.34.0`; lazy-import precedent in claim-check | `apps/harness/pyproject.toml:49`; `temporal/claim_check.py:124-149` (`S3BlobStore`, "boto3 is imported LAZILY", `asyncio.to_thread` offload) |
| smr | `boto3>=1.42.0` (Bedrock) — out of scope (server-managed engines) | `apps/smr/pyproject.toml:39` |
| **guardrail** | ❌ none (httpx/sqlalchemy/transformers only) | `apps/guardrail/pyproject.toml:30,38,42` |
| **nlp** | ❌ none | `apps/nlp/pyproject.toml:35,48` |

→ **Adding `minio` to guardrail + nlp requires editing their `pyproject.toml` and re-running `uv lock` at the repo root** (one workspace lock; rule 06). stt-v2 and harness need **no new dependency**.

### 2.5 Admin surface & gateway DTO

- `admin/ai-models` controller is global-admin (`manage:all`) — `apps/api/src/modules/ai-model/ai-model-admin.controller.ts:20-24`; DTOs: `packages/applications/src/services/stt/model/dto/` — `create-model.request.ts:65-79` / `update-model.request.ts:62-75` (`source`, `sourceUri` `@ApiProperty` descriptions carry **no scheme conventions**), `model.response.ts:26-30,54,63` (`localPath`, `checksum` exposed read-side).
- Gateway NLP DTOs: `extract-entities.request.ts:34` has `modelName?` only; no `modelPath` anywhere in `apps/api/src/modules/ai-inference/dto/`.
- `HF_HUB_OFFLINE` precedent already documented for tts-v2 mirrors: `.env.example:511-516`.
- The internal `GET /api/v1/internal/effective-config` route **does not exist yet** (TASK-525 builds it; re-verified — no such route in `apps/api/src`).

### 2.6 What this ticket does NOT depend on (verified)

- **No Phase-1 tables**: the resolver reads only the existing `AiModel` columns (§2.1) — no `AiProviderConnection`/`AiRuntimeProfile` reads, so TASK-524 is not a dependency (unlike TASK-525/529 which are gated on it).
- **No seed changes**: the `minicheck-flan-t5-large` row and its `guardrail.groundedness` task default already exist (§2.3); this ticket writes no seed data, so the count-locked `task-506-ai-model-consolidation.test.ts` assertions stay untouched.
- **No new domain trio**: no new Prisma model — only an enum value — so the hand-authoring constraint for new artifacts does not bite (only `gen:model` scaffolds; `gen:entity`/`gen:factory` are barrel reconcilers that never create files, `gen:mapper` is destructive and must never be run, `gen:repository` is broken — see `.claude/rules/03-domain-layer.md`). `pnpm db:generate` regenerates the client enum and the existing `AiModel` trio is unchanged.
- **No console work**: the `/ai-models` screen (nav-hidden today) is TASK-528's; the Swagger text in §4.2 is the only admin-facing surface this ticket touches.
- **No allow-list changes**: `TENANT_SCOPED_MODELS` / `SYSTEM_SHARED_READ_MODELS` / `MODELS_WITHOUT_SOFT_DELETE` are keyed by model, not enum value — untouched.

## 3. Architecture, Patterns & Best Practices (implements plan AD-3)

### 3.1 The resolver contract (one contract, mirrored per service-family)

```python
def resolve_model_dir(identity: ModelWeightIdentity) -> Path:  # async in async services
    # 1. local_path set AND exists          -> return it (operator override, HIGHEST precedence everywhere)
    # 2. sourceUri scheme dispatch:
    #    hf:<org>/<repo> | bare HF id       -> snapshot_download(cache_dir=..., revision=sourceRevision)
    #                                          honoring HF_HUB_OFFLINE (offline + uncached = clean error)
    #    s3://bucket/prefix                 -> download-once into <service cache dir>/s3/<sha1(uri)>/
    #                                          single-flight lock; checksum verify when AiModel.checksum set
    #    file:///abs/path                   -> verify exists (+ checksum when set), use in place
    # 3. anything else                      -> ModelSourceError (never a silent fallback)
```

`ModelWeightIdentity` is a small frozen dataclass `{slug, source, source_uri, source_revision, local_path, checksum}` — a strict subset of what stt-v2's `AiModelConfig` already carries (`config_reader.py:334-353`), so stt-v2's resolver is an *extraction* of its existing precedence, not new behavior.

- **`localPath`-first rationale**: it is the admin/operator escape hatch (air-gapped hosts, pre-staged NFS mounts, the tts-v2 mirror pattern) and it is what stt-v2 already does at 6 loader sites (§2.2) — the contract codifies the incumbent behavior instead of inventing a new one. A set-but-missing `local_path` **falls through with a structlog warning** (`<svc>.model_source.local_path_missing`) rather than failing, matching `whisper_cpp_loader.py:54-58`.
- **Checksum verify (supply-chain: weight substitution)**: when `AiModel.checksum` is set, single-file artifacts (GGUF, ONNX files) are SHA256-verified after download and on first use of a pre-existing cache entry (then a `.verified` marker skips re-hashing). Mismatch = **hard error, model never served** — a poisoned bucket or swapped weight file must not reach a clinical gate. Directory snapshots (HF) rely on the hub's own per-file ETag verification; checksum on a directory URI is a documented no-op with a warning.
- **Single-flight download**: in-process `asyncio.Lock` per URI + cross-process safety via download-to-`<target>.tmp-<pid>` + atomic `os.replace` — concurrent workers never interleave partial files, and a crashed download leaves only a temp dir to sweep. All blocking I/O (minio/boto3 SDK calls, hashing) runs under `asyncio.to_thread` (claim-check precedent, `claim_check.py:88`).
- **HF offline mode**: `snapshot_download` natively honors `HF_HUB_OFFLINE=1`; the resolver surfaces it explicitly — offline + not-in-cache raises `ModelSourceError` naming the env var (no hanging network retries in air-gapped deploys). `.env.example:511-516` already establishes the pattern.
- **`s3://` via the MinIO-compatible client**: every HOPE deployment ships MinIO (`infrastructure/` core compose; k3s external MinIO), so `s3://` gives admins an in-deployment, PHI-posture-compatible weight store without any cloud dependency. Per service the *existing* client is reused: stt-v2 → `minio` SDK, harness → lazy `boto3` (claim-check pattern); guardrail/nlp add `minio` (small, pure-Python) as a **lazily imported** dependency — a deployment that never uses `s3://` never imports it (mypy: add `minio` to the per-service `ignore_missing_imports` module lists, mirroring `apps/stt-v2/pyproject.toml:238`).
- **Guardrail clinical posture preserved**: the groundedness call site invokes the resolver with `allow_network=False` for HF sources — the scorer's documented "a clinical gate never auto-downloads weights" contract (`groundedness_scorer_minicheck.py:182-192`) stays true for hub pulls; `s3://` (in-deployment MinIO, checksum-verified, admin-declared) and `local_path`/`file://` are permitted. *(Flagged as a decision row in §4.4 — default: keep hub pulls blocked for the clinical gate.)*
- **Why NOT a central download service**: a gateway-side downloader would (a) put multi-GB blob traffic through the NestJS process, (b) create a shared mutable cache with cross-service permission/versioning problems, and (c) duplicate what each Python service's runtime (HF hub cache, existing loaders) already does well. The DB row is the shared *source of truth*; the *bytes* stay a per-service concern with a per-service cache dir — same reasoning the program used to reject a cross-process VRAM arbiter (plan AD-4).

### 3.2 Weight-path transport per service (D-12 closure; analyzed → recommendation)

| Service | Has DB read today | Recommended transport | Rationale |
|---|---|---|---|
| stt-v2 | ✅ pipeline/registry SQLAlchemy reader | Keep (already delivers `local_path`) | Nothing to change in transport |
| guardrail | ✅ `TenantConfigResolver` (60 s TTL, fail-safe) | **Extend the existing SQLAlchemy read**: `AiModelRead` gains `local_path` (+ `checksum`, `source`, `source_revision`); `_load_from_db` select + returned key-map gain them | Proven path (findings §2), zero new moving parts, TTL gives the "DB row edit picked up ≤ 60 s" behavior for free |
| nlp | ❌ (deliberately stateless) | **Gateway injection**: `resolveDefaultModelName`/`resolveValidatedModelOverride` return `{modelName, modelPath}` (from `sourceUri` + `localPath`); payload gains `model_path` next to `model_name` | Preserves the stateless-NLP contract; `_MODEL_IDENTITY_FIELDS` already blocks env from setting `model_path` (`nlp/core/config.py:19`) — the request lane is the sanctioned one |
| harness | ❌ (no sqlalchemy; gateway-client only) | **TASK-525 effective-config client**: `service=harness` response includes a `modelWeights` map `{<slug>: {localPath, sourceUri, checksum}}` for the slugs harness consumes (`minicheck-flan-t5-large`); resolved **inside `_atomic_fact_entailer`** with env fallback | Adding a DB dependency to harness contradicts AD-1 ("services never read GlobalSetting/DB directly" except the two grandfathered readers); the fetch-with-TTL client is 525's deliverable. Env fallback = today's behavior, so all other stages land without waiting |

Contract note for TASK-525 (frozen here so lanes can build one batch apart): the effective-config response schema gains an optional `modelWeights` object as above; absent key ⇒ harness env fallback. No workflow-code change — `fetch_policy` and the sensors' activity bodies are the only touchpoints (Temporal determinism untouched, additive activity behavior only).

### 3.3 Enum-sync discipline

Prisma is the source of truth; three Python literals mirror it (stt-v2 SQLAlchemy pg-enum mirror, stt-v2 StrEnum, and — after this ticket — nothing new elsewhere: guardrail/nlp/harness consume the *string* value, never enumerate it). The mirror test gains the missing `AiModelSource` assertion (§5.1) so the next value addition cannot drift, exactly like the TASK-505/506 format-mirror precedent (`test_db_enum_mirrors.py:1-9` module docstring records why). The StrEnum's extra `KSERVE` (reserved, `dto.py:27`) is asserted as a *known, deliberate* superset member — the sync test allows documented supersets, never subsets.

## 4. Implementation Plan (ordered; layer chain DB → services; each stage independently green)

Stage order with per-stage verification (rule 01 layer gates):

```
1. enum + migration          → verify: db:generate clean, database build+test green, psql apply logged
2. schema/Swagger docs       → verify: applications build green, Swagger renders the grammar (manual check)
3. stt-v2 extension          → verify: py:stt-v2 triple green incl. new resolver + enum-sync tests
4. guardrail adoption        → verify: py:guardrail triple green incl. TTL-pickup + posture tests; uv lock diff
5. nlp + gateway DTO         → verify: py:nlp triple + pnpm test:unit (gateway) green; payload snapshot unchanged when localPath absent
6. harness adoption          → verify: py:harness triple green; replay fixtures green; env fallback proven
```

Stages 3–6 are mutually independent after stage 1 lands (different lanes may parallelize); stage 6 alone benefits from TASK-525 but does not block on it (§3.2).

### 4.1 Stage 1 — enum + migration (lane A)

| File | Change |
|---|---|
| `packages/database/src/prisma/db_main/enums.prisma:282-289` | UPDATE — add `S3 // S3/MinIO-compatible object storage (s3://bucket/prefix; OD-4: s3:// only this program)` |
| `packages/database/src/prisma/db_main/migrations/<ts>_task_527_ai_model_source_s3/migration.sql` | NEW — `ALTER TYPE "core"."AiModelSource" ADD VALUE 'S3';` (additive; reviewed) |

Workflow per rule 02 + repo memory: `pnpm db:migrate:create` → review → commit SQL; **local dev/test DBs are `db push`-managed and behind migration history — apply the `ALTER TYPE` via `psql` (never `migrate reset`)**. Then `pnpm db:generate` and **rebuild `@arcaai/database` + `@arcaai/domains`** (vitest reads dist). Generator drift gates (`generate-*-check`) re-run model/entity/factory — an enum value flows through the generated client; verify no trio diff.

### 4.2 Stage 2 — schema comment + Swagger scheme conventions (lanes A + B touchpoint)

| File | Change |
|---|---|
| `packages/database/src/prisma/db_main/stt.prisma:120-123,138-142` | UPDATE comments — `source` value list gains S3; `sourceUri` documents the grammar (`hf:<org>/<repo>` **or bare HF id** · `file:///abs/path` · `s3://bucket/prefix`); **`localPath` comment gains the precedence contract** ("operator/admin override — HIGHEST precedence in every service's `resolve_model_dir`; set-but-missing falls through with a warning") |
| `packages/applications/src/services/stt/model/dto/create-model.request.ts:65-79`, `update-model.request.ts:62-75`, `model.response.ts:26-30,54,63` | UPDATE — `@ApiProperty` descriptions for `source`/`sourceUri` (scheme grammar, OD-4 note) and `localPath` (precedence contract) so `admin/ai-models` Swagger tells admins exactly what to enter |

### 4.3 Stage 3 — stt-v2 extension (lane D)

| File | Change |
|---|---|
| `apps/stt-v2/src/stt_v2/models/source_resolver.py` | NEW — `resolve_model_dir` per §3.1; reuses `minio` SDK (lazy import) + `settings.huggingface_cache_dir/token` (`settings.py:148-155`); new S3 settings block (§4.6); structlog events `stt_v2.model_source.*` |
| `apps/stt-v2/src/stt_v2/models/{whisper_cpp_loader,faster_whisper_loader,huggingface_loader,nemo_loader,onnx_loader,parakeet_cpp_loader}.py` | UPDATE — replace per-loader `local_path`-or-download branches with the resolver (whisper-cpp keeps its `.gguf`-selection tail from `whisper_cpp_loader.py:114-127` applied to the resolved dir). **Stale-comment delta**: `whisper_cpp_loader.py:12-15` module docstring ("must be fetched via huggingface_hub first") rewritten to name the resolver |
| `apps/stt-v2/src/stt_v2/pipeline/dto.py:21-28` | UPDATE — StrEnum gains `S3 = "S3"` |
| `apps/stt-v2/src/stt_v2/core/database/models.py:34-42` | UPDATE — pg-enum mirror gains `"S3"` |

### 4.4 Stage 4 — guardrail adoption (lane E)

| File | Change |
|---|---|
| `apps/guardrail/src/guardrail/core/tenant_config.py:110-122` | UPDATE — `AiModelRead` adds `local_path`/`checksum`/`source`/`source_revision` columns; `_load_from_db` (`:255-304`) selects + returns them (new keys in the map); a by-slug variant serves non-task-key lookups |
| `apps/guardrail/src/guardrail/core/model_source.py` | NEW — resolver (mirrors §3.1; lazy `minio` import; `guardrail.model_source.*` events) |
| `apps/guardrail/src/guardrail/services/groundedness_scorer_minicheck.py:179-215` | UPDATE — `load_minicheck_scorer` takes the DB-resolved path (task key `guardrail.groundedness` → `AiModel.localPath`, else resolver with `allow_network=False` for HF), **env `GUARDRAIL_V2_GROUNDEDNESS_MODEL_PATH` demoted to fallback**; error message updated (currently instructs env-only). GLiNER (`providers/gliner.py:87-91`) prefers a resolved local dir when the safety row carries one |
| `apps/guardrail/src/guardrail/core/config.py:179-193` | UPDATE — field comments annotated "bootstrap fallback — runtime value comes from the AiModel registry" (AD-1 wording) |
| `apps/guardrail/pyproject.toml` | UPDATE — add `minio>=7.2.20` + mypy `ignore_missing_imports` entry → **root `uv lock`** |

*Decision row (default adopted, flag to owner in review): the clinical groundedness gate keeps HF hub pulls blocked (`allow_network=False`); `s3://`/`file://`/`localPath` allowed.*

### 4.5 Stage 5 — nlp + gateway DTO (lanes E + B touchpoint)

| File | Change |
|---|---|
| `apps/api/src/modules/ai-inference/ai-inference.controller.ts:68-89,105-155` | UPDATE — resolvers return `{modelName: sourceUri, modelPath: localPath ?? null}`; inject `model_path` next to `model_name` in NER/diagnosis payloads (fail-open: absent `localPath` ⇒ field omitted, today's behavior byte-for-byte) |
| `apps/api/src/modules/ai-inference/dto/extract-entities.request.ts:34` | UPDATE — optional `modelPath?` `@ApiPropertyOptional` beside `modelName` (validated same fail-closed registry check: must equal the matched row's `localPath`) |
| `apps/nlp/src/nlp/schemas/classification.py`, `schemas/diagnosis.py` | UPDATE — requests gain `model_path: str | None` next to `model_name` |
| `apps/nlp/src/nlp/services/{token_classifier,text_classifier,medical_suggester}.py`, `dependencies.py:98-118` | UPDATE — `from_pretrained` receives resolver output (path preferred, exists-checked); `ModelCache` keys become `(model_name, model_path)` so a path flip is a cache miss, not a stale hit |
| `apps/nlp/src/nlp/core/model_source.py` | NEW — resolver (lazy `minio`; `nlp.model_source.*` events) |
| `apps/nlp/pyproject.toml` | UPDATE — add `minio>=7.2.20` + mypy override → **root `uv lock`** (shared run with §4.4) |

### 4.6 Stage 6 — harness adoption (lane E; activities only)

| File | Change |
|---|---|
| `apps/harness/src/harness/temporal/activities.py:375-403` | UPDATE — `_atomic_fact_entailer` resolves the weight path **DB-first**: effective-config `modelWeights['minicheck-flan-t5-large'].localPath` (TASK-525 client, cached, fail-safe) → resolver for `sourceUri` schemes (boto3 lazy, claim-check pattern) → env `HARNESS_ATOMIC_FACT_MODEL_PATH` fallback → deterministic entailer (unchanged safe floor). No workflow-code change; the per-path entailer cache (`minicheck_entailer.py:164-202`) is untouched (TASK-529 owns its lifecycle) |
| `apps/harness/src/harness/models/source_resolver.py` | NEW — resolver (boto3 lazy import; `harness.model_source.*` events) |
| `apps/harness/src/harness/core/config.py:342-360` | UPDATE — `atomic_fact_model_path` docstring: "bootstrap fallback — runtime value comes from the control plane" |

### 4.7 Ownership manifest (exclusive; plan §2.3)

- **This ticket owns**: the files listed in §4.1–§4.6 only. Barrel/`index.ts` edits: none expected (no new TS exports).
- **Explicit non-ownership**: `minicheck_entailer.py` cache structure + `services/model_cache.py` ×3 (TASK-529); `internal/effective-config` route + Python fetch client (TASK-525 — this ticket only *consumes* the frozen `modelWeights` contract, §3.2); `/ai-models` console screen + discovery (TASK-528); seeds (no data change — the minicheck row already exists).
- **New env vars** (bootstrap-only S3 credentials per service, all optional — unset ⇒ `s3://` URIs error cleanly): `STT_V2_MODEL_S3_ENDPOINT/_ACCESS_KEY/_SECRET_KEY`, `GUARDRAIL_V2_MODEL_S3_*`, `NLP_MODEL_S3_*`, `HARNESS_MODEL_S3_*` (pydantic `SecretStr` keys; per-concern `env_prefix` per rule 06) → added to `.env.example` (+ `.env.dev` where used) and — per house rule — `turbo.json#globalEnv` for any var a TS task reads (none expected; verify before closing).
- **Out of scope**: model *discovery*/console hub (TASK-528), download-progress UI, retention/eviction (TASK-529), `azure-blob://` (OD-4), `downloadStatus`/`downloadedAt` write-back automation (registry bookkeeping stays manual this program — note in Swagger text).

## 5. TDD Plan (RED first — paste failing runs in this README before implementing)

### 5.1 Enum sync (stt-v2, Stage 1/3 gate)

- `apps/stt-v2/tests/unit/test_db_enum_mirrors.py` — NEW `PRISMA_AI_MODEL_SOURCE = {"HUGGINGFACE","GITHUB","MLFLOW","LOCAL","S3"}` + `test_ai_model_source_mirror_matches_prisma` (RED until `models.py` mirror updated) + `test_ai_model_source_strenum_superset` (StrEnum ⊇ Prisma set; `KSERVE` documented as the only extra).
- `apps/stt-v2/tests/unit/test_pipeline_dto_updates.py:322-353` — extend `TestAiModelSource` with `S3` (RED until `dto.py` updated).

### 5.2 Resolver conformance (same suite, mirrored per service)

New files: `apps/stt-v2/tests/unit/test_model_source_resolver.py` · `apps/guardrail/src/guardrail/tests/test_model_source_resolver.py` · `apps/nlp/tests/test_model_source_resolver.py` · `apps/harness/src/harness/tests/unit/test_model_source_resolver.py` (locations follow each app's convention, rule 06). Named cases (identical across the four files — the mirrored-implementation conformance discipline from plan AD-3/AD-4):

| Test | Asserts | RED because |
|---|---|---|
| `test_local_path_wins_without_network` | `local_path` set + exists → returned; **no client constructed, zero download calls** (stub asserts) | resolver module does not exist |
| `test_local_path_missing_falls_through_with_warning` | set-but-missing path → scheme dispatch + `<svc>.model_source.local_path_missing` warning (matches `whisper_cpp_loader.py:54-58` incumbent behavior) | ditto |
| `test_s3_downloads_once_then_cache_hits` | first call downloads (count 1), second call hits the cache dir (count still 1); single-flight: two concurrent resolves → one download | ditto |
| `test_s3_checksum_mismatch_hard_error` | wrong SHA256 → `ModelSourceError`, target dir removed, model never served | ditto |
| `test_partial_download_leaves_no_final_dir` | crash mid-download (stub raises) → only `*.tmp-*` debris, no final dir; next resolve retries cleanly (temp + atomic `os.replace`) | ditto |
| `test_file_scheme_verify_and_use` | `file:///abs/path` → exists-check (+ checksum when set), used in place, never copied | ditto |
| `test_hf_offline_uncached_raises_cleanly` | `HF_HUB_OFFLINE=1` + uncached `hf:` → error naming the env var (`snapshot_download` stubbed, env monkeypatched) | ditto |
| `test_unknown_scheme_rejected` | `azure-blob://…` → `ModelSourceError` naming OD-4 (no silent fallback) | ditto |

S3 double = a **stubbed client object injected at the lazy-import seam** — matching each service's hermetic posture (no `moto` anywhere in the workspace, verified across all `pyproject.toml`s; harness claim-check precedent: "hermetic suite never imports boto3", `claim_check.py:127-145`). stt-v2 additionally gets one integration-lane test against the real test MinIO (`tests/docker-compose.test.yml`, port 9002) — authored now, executed in the local/integration lane, never unit CI. Determinism note (repo memory): any randomized fixture data seeds inside the test body — pytest-randomly reseeds numpy after fixtures.

### 5.3 D-12 closure tests

- **guardrail** — extend `apps/guardrail/src/guardrail/tests/test_tenant_config.py`:
  - `test_load_from_db_returns_local_path_and_checksum` (RED: `AiModelRead` has no such columns today, `tenant_config.py:110-122`);
  - `test_db_row_edit_picked_up_within_ttl` — fake `_time`, resolve → mutate stubbed row's `local_path` → advance past `config_cache_ttl_s` (60 s, `config.py:262`) → new path returned; within-TTL read still serves the cached path (both directions asserted).
  - Extend `test_groundedness_scorer_minicheck.py`: `test_db_path_beats_env` · `test_env_fallback_when_db_empty` (today's behavior byte-for-byte) · `test_neither_set_keeps_fail_closed_raise` (`:187-192` contract unchanged) · `test_hub_pull_blocked_for_clinical_gate` (`allow_network=False` — an `hf:`-only row without cache raises rather than downloading).
- **nlp + gateway** — `apps/api/src/modules/ai-inference/__tests__/`: `test_injects_model_path_when_local_path_set` · `test_omits_model_path_when_row_has_none` (existing-payload snapshot — the "defaults reproduce today's behavior" program rule) · DTO whitelist round-trip for `modelPath` (global pipe `forbidNonWhitelisted` rejects undeclared fields) · override validation stays fail-closed (`:105-128` contract). NLP: extend `apps/nlp/tests/test_model_override_routes.py` — `model_path` round-trip reaches `from_pretrained`; `ModelCache` re-keys on path change (path flip = miss, not stale hit); `_MODEL_IDENTITY_FIELDS` regression — env still cannot set `model_path` (`core/config.py:19`).
- **harness** — extend `apps/harness/src/harness/tests/unit/temporal/test_activities_inferential.py`: `test_effective_config_path_beats_env` · `test_env_fallback_on_unreachable_or_absent_key` (today's behavior) · `test_neither_set_uses_deterministic_entailer` (safe floor unchanged, `activities.py:387-388`). Hermetic (effective-config client stubbed; no Temporal/DB/Redis — the harness CI suite must stay hermetic, rule 06). Replay-compat fixtures re-asserted green — no workflow command-sequence change (`workflows.py` untouched by this ticket).

### 5.4 Gate commands (paste actual output per stage)

| Layer | Commands |
|---|---|
| Database | `pnpm db:generate` · migration SQL reviewed · `pnpm --filter @arcaai/database build test` · psql apply recorded for dev/test DBs |
| Domains/Applications/API | `pnpm --filter @arcaai/domains build test` · `pnpm --filter @arcaai/applications build test` · `pnpm build:api` · `pnpm test:unit` (gateway controller tests) |
| Python lanes | `pnpm py:stt-v2:test` + `py:stt-v2:lint` + `py:stt-v2:typecheck` · same triple for `py:guardrail`, `py:nlp`, `py:harness` |
| Workspace | root `uv lock` diff committed in the same MR as the guardrail/nlp `pyproject.toml` edits · `pnpm lint` (only-warn warnings in `packages/*` treated as errors) |
| E2E | specs (admin PATCHes `localPath` on `minicheck-flan-t5-large` → guardrail/nlp inference reflects it; `s3://` row → downloaded + served) **authored here** under `apps/api/tests/e2e/`, **executed in TASK-534** per the program's e2e-last discipline |

## 6. Acceptance & Definition of Done

- [ ] `AiModelSource.S3` in Prisma + migration SQL reviewed/committed; dev DB patched via psql; mirrors + sync tests green
- [ ] Scheme grammar visible in `stt.prisma` comments AND `admin/ai-models` Swagger; `localPath` precedence contract documented at both sites
- [ ] `resolve_model_dir` live in all four services with the §5.2 conformance quartet green per service (RED runs pasted)
- [ ] D-12 closed: editing `AiModel.localPath` on `minicheck-flan-t5-large` (or any NLP/guardrail model row) changes what loads — guardrail ≤ 60 s TTL, nlp next request, harness next activity (with 525) — with env fallback intact
- [ ] No workflow-code change in harness (replay fixtures green); downloads via `asyncio.to_thread`; structlog dotted events; lazy S3-client imports
- [ ] `uv lock` regenerated once for guardrail+nlp `minio`; new env vars in `.env.example` (+ `turbo.json#globalEnv` check recorded); all §5.4 gates pasted; comment deltas (§4.3/4.4/4.6) applied

## 7. Risks & Rollback

| Risk | Mitigation |
|---|---|
| First-request download latency (multi-GB weights) on a cold cache | Document pre-warm: operators pre-stage via `localPath` (highest precedence) or run a warm-first-request after deploy; TASK-529's warmup flag is the systematic answer — noted, not duplicated here |
| Partial/corrupt downloads under crash or concurrent workers | Temp-dir + atomic `os.replace` + per-URI single-flight lock (§3.1); a crashed download is invisible to readers |
| Poisoned cache / weight substitution | SHA256 verify on download AND first use of a pre-existing entry when `checksum` set; mismatch = hard error, dir removed (§3.1) |
| Postgres enum values are effectively irreversible | Rollback = stop writing `S3` rows (query for `source='S3'` count first); the value itself stays dormant — additive-only posture per rule 02 |
| Behavior drift on the guardrail clinical gate | `allow_network=False` for HF at the groundedness site; env fallback preserves today's staged-file posture byte-for-byte when the DB row has no path |
| TASK-525 slip strands the harness lane | Harness stage is last and env-fallback-complete — ships as "env-first until 525 lands", flipped by one config read |
| `minio` add breaks mypy/CI extras lanes | Lazy import + per-module `ignore_missing_imports` (the `apps/stt-v2/pyproject.toml:238` pattern); D-05's lesson applied up front |
| NLP cache re-key `(model_name, model_path)` doubles resident models during a path rollover | Old key ages out via the existing `ModelCache` TTL (`nlp/services/model_cache.py`); acceptable transient — TASK-529's retention lane owns systematic eviction |
| Gateway sends `model_path` to an older NLP build (deploy skew) | Pydantic ignores unknown request fields only if declared — NLP DTO change ships in the same MR wave; until both sides deploy, the gateway's omit-when-absent default keeps payloads identical to today |

## 8. References

- Program: plan §3 **AD-3** (frozen contract), §8 **OD-4**; findings §3-E5, D-12 (`§4.B`), GAP-C3 (`§7`)
- Rules: `.claude/rules/02-database-prisma.md` (additive migrations, `task_<nnn>_<desc>` naming, allow-lists untouched — no new model), `.claude/rules/06-python-services.md` (env_prefix, uv workspace/`uv lock`, lazy imports, structlog, test placement)
- Repo memory: dev/test DB is db-push-managed — apply enum SQL via psql; rebuild database/domains dist after enum changes
- TASK-505/506 enum-sync precedent: `apps/stt-v2/tests/unit/test_db_enum_mirrors.py` (module docstring `:1-9` records the drift incident this pattern prevents)
- HF offline env vars: `HF_HUB_OFFLINE` / `TRANSFORMERS_OFFLINE` — hub honors them natively; in-repo precedent `.env.example:511-516` (tts-v2 mirror runbook `docs/operations/tts-model-mirror/`)
- Lazy-S3 + `to_thread` precedent: `apps/harness/src/harness/temporal/claim_check.py:124-160`
- Sibling tickets (cross-reference only, never edited here): TASK-524/525/526 (Phase 1), TASK-528 (discovery hub), TASK-529 (lifecycle/retention), TASK-531, TASK-534

## 9. Implementation Summary

**Status: all six stages implemented, each independently green. Strict RED-first TDD throughout — every RED run below was actually executed and observed before implementation.**

### 9.1 Stage 1 — enum + migration (lane A)

| File | Change |
|---|---|
| `packages/database/src/prisma/db_main/enums.prisma` | `AiModelSource` gains `S3` |
| `packages/database/src/prisma/db_main/migrations/20260720120000_task_527_ai_model_source_s3/migration.sql` | NEW — `ALTER TYPE "core"."AiModelSource" ADD VALUE IF NOT EXISTS 'S3';` |
| `apps/stt-v2/src/stt_v2/core/database/models.py` | pg-enum mirror gains `"S3"` |
| `apps/stt-v2/src/stt_v2/pipeline/dto.py` | StrEnum gains `S3 = "S3"` |
| `apps/stt-v2/tests/unit/test_db_enum_mirrors.py` | NEW `PRISMA_AI_MODEL_SOURCE` + mirror/superset assertions (the §5.1 gap) |
| `apps/stt-v2/tests/unit/test_pipeline_dto_updates.py` | `TestAiModelSource` gains `test_s3_enum_value_exists` |

**RED observed** (before the mirror/enum edits):

```
FAILED tests/unit/test_db_enum_mirrors.py::test_ai_model_source_mirror_matches_prisma
  AssertionError: assert {'GITHUB','HUGGINGFACE','LOCAL','MLFLOW'} == {...,'S3'}
  Extra items in the right set: 'S3'
FAILED tests/unit/test_db_enum_mirrors.py::test_ai_model_source_strenum_superset
FAILED tests/unit/test_pipeline_dto_updates.py::TestAiModelSource::test_s3_enum_value_exists
  AssertionError: assert False +  where False = hasattr(AiModelSource, 'S3')
3 failed, 5 passed, 55 deselected in 0.32s
```

GREEN: `8 passed, 55 deselected in 0.45s`.

**DECISION ROW — migration hand-authored (deviation from §4.1's `pnpm db:migrate:create`).** The documented command was attempted and refused, exactly as repo memory predicted:

```
$ pnpm db:migrate:create
[*] Changed the `clients` table … [+] Added unique index on columns (client_id)
We need to reset the following schemas: "core, public" at "localhost:5432"
You may use prisma migrate reset to drop the development database. All data will be lost.
Exit status 130
```

The dev DB is `db push`-managed and behind migration history, so `migrate diff` produced a full-reset plan. **No reset was run and no migration folder was created by the tool.** The single-statement migration was hand-authored instead, matching the hand-authored convention of every recent migration (round-number timestamps). `ADD VALUE IF NOT EXISTS` makes it idempotent against DBs patched by hand ahead of history.

**psql apply record (§5.4 evidence):**

| DB | Result |
|---|---|
| dev — `postgres://postgres@localhost:5432/hope` | ✅ APPLIED. `ALTER TYPE` → verify: `HUGGINGFACE,GITHUB,MLFLOW,LOCAL,S3` |
| test — `postgresql://test@localhost:5433/hope_test` | ⚠️ NOT APPLIED — server not running (`Connection refused`, test infra down this session). Harmless: the test stack is `db push`-managed and throwaway, so `pnpm docker:test:up` + `pnpm test:db:reset` creates the type with `S3` already present. Re-run the same `ALTER TYPE … IF NOT EXISTS` against a long-lived test DB. |

Gates: `pnpm db:generate` clean · `@arcaai/database` build + **819 tests passed** · `@arcaai/domains` build + **1368 passed / 2 skipped / 9 todo**. No generated-trio drift (an enum value flows through the client only).

### 9.2 Stage 2 — schema comments + Swagger grammar (lanes A + B touchpoint)

`stt.prisma` documents the full scheme grammar on `source`/`sourceUri`, the precedence contract on `localPath` ("operator/admin override — HIGHEST precedence; set-but-missing falls through with a warning"), the checksum semantics, and the manual-bookkeeping note on `downloadStatus`. The three `stt/model/dto/*` files carry the same grammar in `@ApiProperty` descriptions so `admin/ai-models` Swagger tells admins exactly what to enter.

**DEFECT FOUND AND CLOSED (beyond §4.2, required for this ticket's own DoD).** `UpdateModelRequest` had **no `localPath` or `checksum` field**. With the global pipe's `forbidNonWhitelisted`, an admin PATCH carrying `localPath` was **rejected with 400** — so the D-12 acceptance criterion ("editing `AiModel.localPath` changes what loads") was *unreachable through the admin API*. Per the §2.5 Completion & Cleanup Doctrine (partial implementations are finished end-to-end) both fields were added to the update DTO and the service's change-apply block, with an empty string clearing the override.

**RED observed:**

```
FAILED aiModel.service.test.ts > update() carries localPath + checksum onto the entity and response (D-12)
  expected null to be '/opt/hope/models/minicheck'
FAILED aiModel.service.test.ts > update() allows clearing localPath back to empty (D-12)
  TypeError: Cannot set property localPath of #<Object> which has only a getter
2 failed | 6514 passed
```

The second failure exposed a *fidelity gap in the test double*: the real `AiModelEntity` exposes `localPath`/`checksum` setters routed through `setProperty` (`AiModelEntity.ts:218,242`), but `createBehavioralModelEntity` modelled them read-only. Setters were added to the double to match the real entity.

GREEN: `@arcaai/applications` build + **6516 passed / 4 skipped**.

### 9.3 Stage 3 — stt-v2 resolver (lane D)

`apps/stt-v2/src/stt_v2/models/source_resolver.py` (NEW) is the **canonical** implementation of the §3.1 contract: `local_path` → `hf:`/bare-id → `file://` → `s3://` → `ModelSourceError`. Single-flight `asyncio.Lock` per URI, temp-dir + atomic `os.replace`, SHA256 verify on download AND first use of a warm cache entry (`.verified` marker), all blocking I/O under `asyncio.to_thread`, lazy `minio` import behind `_make_s3_client`, structlog `stt_v2.model_source.*` events.

`ModelSourceError` on unknown schemes names OD-4 explicitly. `allow_network=False` blocks HF hub pulls while permitting `s3://`/`file://`/`localPath`.

**RED observed:** `ModuleNotFoundError: No module named 'stt_v2.models.source_resolver'` (collection error, 0 tests run). **GREEN: 16 passed** — the full §5.2 quartet plus single-flight, checksum-match, missing-`file://`, bare-HF-id, allow_network, empty-URI and missing-credentials cases.

Loaders wired: `whisper_cpp_loader` and `parakeet_cpp_loader` use the full resolver (they need a real directory; whisper-cpp keeps its `.gguf` selection tail, now `_select_gguf_file`, and its stale module docstring was rewritten). `faster_whisper`, `huggingface`, `nemo` and `onnx` use a new `resolve_weights_or_hf_id` passthrough.

**DECISION ROW — `resolve_weights_or_hf_id` passthrough (refinement of §4.3).** §4.3 said "replace per-loader branches with the resolver". Done literally, that would force `snapshot_download` for loaders whose runtime does its own hub fetch (`WhisperModel`, `from_pretrained`, NeMo `from_pretrained`) — **changing the fetch mechanism for every existing HuggingFace row**, and in ONNX's case discarding `_download_onnx_model`'s `allow_patterns` selective fetch that "can save tens of GB of bandwidth". So the resolver materialises only what the runtime cannot fetch itself (`localPath`, `file://`, `s3://`) and passes a bare hub id through. Today's HF behaviour is preserved byte-for-byte; the new schemes work everywhere.

New settings: `model_s3_endpoint/_access_key/_secret_key/_secure`. **DECISION ROW:** stt-v2's `Settings` carries no `env_prefix` (its env vars are bare uppercase field names), so the documented `STT_V2_MODEL_S3_*` names are wired via explicit `validation_alias`. Un-prefixed names would collide — all services share one env file.

Gates: `py:stt-v2:lint` **All checks passed** · `py:stt-v2:typecheck` **no issues in 123 source files** · tests **2629 passed / 35 skipped / 3 xfailed, 1 failed**.

⚠️ **The 1 failure is NOT this ticket's** — `test_health_endpoints_comprehensive.py::test_health_returns_200_with_complete_schema`, failing on an extra `effective_config` key in the `/health` payload. That key comes from TASK-525's concurrent edit to `apps/stt-v2/.../health/api/routes.py` (a sibling-owned file). Verified against a clean tree: passes at HEAD, fails with the combined working tree. **Left for TASK-525 to update its own schema test** — not touched here.

### 9.4 Stage 4 — guardrail adoption (lane E)

`AiModelRead` gains `localPath`/`checksum`/`source`/`sourceRevision`; `_load_from_db` selects and returns them; `GuardrailTenantConfig` carries them; a `slug::<slug>` pseudo-task-key lane (`_load_model_by_slug` + `resolve_model_source_by_slug`) serves consumers with no `AiTaskDefault` row. `core/model_source.py` (NEW) mirrors the canonical resolver.

**RED observed:** 4 failed (`test_load_from_db_returns_local_path_and_checksum`, `test_absent_local_path_stays_none`, `test_db_row_edit_picked_up_within_ttl`, `test_resolve_model_source_by_slug_serves_non_task_key_lookups`), then 6 more for the groundedness lane (`ImportError: cannot import name 'resolve_groundedness_model_path'`). GREEN in both cases.

`resolve_groundedness_model_path` + the scorer-cache factory close D-12 for the clinical gate: registry `localPath` → resolvable `file://`/`s3://` → env. `GUARDRAIL_V2_GROUNDEDNESS_MODEL_PATH` demoted to a documented bootstrap fallback. **Every** failure mode degrades to the env path, so weight resolution can never cost a scorer that would otherwise have loaded.

**DECISION ROW (§4.4, default adopted — flagged for owner):** the clinical groundedness gate **keeps HF hub pulls BLOCKED** (`allow_network=False`). `s3://`, `file://` and `localPath` are permitted; an `hf:`-only row degrades to env/`unverified` rather than auto-downloading. `test_hub_pull_blocked_for_clinical_gate` locks this.

**Sibling boundary marker inverted.** TASK-525 shipped `test_tenant_config_runtime_profile.py::TestLocalPathStaysOutOfScope::test_no_local_path_field_is_introduced`, asserting `local_path` does **not** exist and citing "explicitly deferred to TASK-527". That condition is now met, so the marker was inverted (not deleted) to `TestLocalPathScope::test_local_path_landed_with_task_527`, asserting the field exists and defaults to `None`. Leaving it would have been a knowingly false red.

`minio>=7.2.20` added to `apps/guardrail/pyproject.toml` + mypy `ignore_missing_imports`. Gates: **163 passed** · lint **All checks passed** · typecheck **no issues in 30 source files**.

### 9.5 Stage 5 — nlp + gateway DTO (lanes E + B touchpoint)

Gateway: `resolveDefaultModelSelection` and `resolveValidatedModelOverride` now return `localPath`; both NER and diagnosis payloads gain `model_path`, **omitted when absent**. NLP: the three request schemas gain `model_path`; `dependencies.py` gains `_model_cache_key`/`_split_cache_key`/`_weights_source` so the cache slot is keyed on the full `(model_name, model_path)` identity — a path flip is a MISS, not a stale hit — and a set-but-missing path falls through to the hub id with a warning. `core/model_source.py` (NEW) mirrors the resolver.

**RED observed (gateway):** `3 failed | 4 passed` — the 3 injection cases failed; notably the 4 *omission* cases passed from the start, which is the point: they are the byte-for-byte regression guard. **RED (nlp):** `6 failed, 1 passed`.

GREEN: ai-inference **62 passed**; `py:nlp:test` **164 passed**; lint **All checks passed**; typecheck **no issues in 44 source files**.

**DECISION ROW — no caller-supplied `modelPath` on the DTO (deviation from §4.5).** §4.5 proposed an optional `modelPath?` on `ExtractEntitiesRequest`, validated to equal the matched row's `localPath`. Implemented instead as **registry-derived only**: the path always comes from the matched `AiModel` row, on both the default and override lanes. A field the caller must set to exactly the value the server already knows adds attack surface (a filesystem path into a clinical service) for zero capability. Documented in place at the DTO. D-12 is fully satisfied — admins change the path by PATCHing the row.

`minio>=7.2.20` added to `apps/nlp/pyproject.toml` + mypy override.

### 9.6 Stage 6 — harness adoption (lane E; activities only)

**TASK-525 re-verified as instructed:** its effective-config client shipped for nlp/smr/stt-v2, but **the `modelWeights` contract does NOT exist**, and harness has **no** effective-config client at all (`grep -rln effective_config apps/harness/src/` → no matches). So §3.2's env-fallback-first path was implemented exactly as specified, and this is recorded as the expected deviation: the control-plane lane is built and tested against a stub, and degrades to `HARNESS_ATOMIC_FACT_MODEL_PATH` whenever the key or client is absent — which is every deployment today. Flipping it later is one key appearing in the response; no code change.

`apps/harness/src/harness/models/source_resolver.py` (NEW) mirrors the resolver over harness's **existing `boto3`** (no new dependency) via a small `_Boto3MinioAdapter` that presents the same client surface, keeping the resolver body identical across all four services. `resolve_atomic_fact_model_path` resolves by SLUG (harness has no task key). Resolution happens **inside the activity** — `workflows.py` is untouched, so replay compatibility is unaffected; `minicheck_entailer.py`'s cache is untouched (TASK-529 owns it).

**RED observed:** `ModuleNotFoundError: No module named 'harness.models'`. GREEN: 8 passed.

One existing test broke and was fixed **without editing the test**: `test_enabled_adds_deterministic_atomic_fact_signal` patches `_atomic_fact_entailer` with a **one-arg** lambda, so the new two-arg call raised → caught → `DEGRADED`. The call site now uses the incumbent single-arg form unless a path was actually resolved, so the no-registry path is byte-for-byte the pre-527 call.

Gates: `py:harness:test` **886 passed** · lint **All checks passed** · typecheck **no issues in 90 source files**. Hermetic throughout (no Temporal/DB/Redis/network).

### 9.7 Workspace gates

| Gate | Result |
|---|---|
| `pnpm db:generate` | ✅ clean |
| `@arcaai/database` build + test | ✅ 819 passed |
| `@arcaai/domains` build + test | ✅ 1368 passed / 2 skipped / 9 todo |
| `@arcaai/applications` build + test | ✅ 6516 passed / 4 skipped |
| `pnpm build:api` | ✅ 8 tasks successful |
| `pnpm test:unit` | ✅ **16666 passed / 4 skipped / 9 todo (947 files)** |
| `pnpm lint` | ✅ 29 tasks successful, **0 errors**; my files produce zero warnings (prettier-formatted) |
| root `uv lock` | ✅ minimal 4-line diff — `minio` for guardrail + nlp only |
| `py:stt-v2` test/lint/typecheck | ✅ / ✅ / ✅ (1 pre-existing sibling failure, §9.3) |
| `py:guardrail` test/lint/typecheck | ✅ 163 / ✅ / ✅ |
| `py:nlp` test/lint/typecheck | ✅ 164 / ✅ / ✅ |
| `py:harness` test/lint/typecheck | ✅ 886 / ✅ / ✅ |

`.env.example` gained a TASK-527 block (appended only — never rewritten, a sibling appends concurrently). **`turbo.json` needs no change**: the §4.7 check was performed and no TS task reads any of the new vars (all are Python-side).

### 9.8 Open / not done

- **Test DB `ALTER TYPE` not applied** — server down this session (§9.1). Re-run when the test stack is up, or let `db push` recreate it.
- **stt-v2 integration-lane MinIO test not authored** (§5.2 mentions one against the real test MinIO on :9002). The test infra was down, so an unrunnable test would have been unverifiable — deliberately not written blind. The hermetic stub-seam suite covers the logic.
- **E2E specs under `apps/api/tests/e2e/` not authored** (§5.4 marks them "executed in TASK-534"); they were not written this pass.
- **`modelWeights` contract** remains TASK-525's to deliver (§9.6).
- **The `/health` schema test** is TASK-525's to update (§9.3).

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket README authored (execution-ready): code-verified current state (enum + per-service resolution + S3-client inventory), AD-3 resolver contract with per-service transport analysis (guardrail = extend SQL read; harness = TASK-525 effective-config; nlp = gateway injection), 6-stage plan with exclusive ownership manifest, RED-first TDD plan, OD-4 recorded (`s3://` only). |
| 2026-07-20 | **All six stages implemented (status → Review).** RED-first TDD with real failing runs captured per stage (§9). Stage 1 enum + hand-authored migration (`db:migrate:create` refused — dev DB drift; psql apply recorded, test DB down). Stage 2 documented the grammar AND closed a blocking defect: `localPath`/`checksum` were unwritable through `UpdateModelRequest`, so `forbidNonWhitelisted` rejected the very PATCH D-12 requires. Stage 3 canonical resolver + 6 loaders (passthrough refinement preserves HF fetch + ONNX selective download). Stage 4 guardrail DB read + clinical-gate DB-first path, hub pulls still blocked. Stage 5 gateway `model_path` (registry-derived only — DTO field deliberately not added) + NLP cache re-keyed on full weight identity. Stage 6 harness env-fallback-first (TASK-525's `modelWeights` verified absent), resolved inside the activity, `workflows.py` untouched. Gates: 16666 unit tests, 4 Python triples, lint 0 errors, minimal `uv lock` diff. Deviations recorded as decision rows in §9; open items in §9.8. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
