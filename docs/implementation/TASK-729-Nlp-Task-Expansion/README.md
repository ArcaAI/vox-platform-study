# TASK-729 — NLP Task Type Expansion

| | |
|---|---|
| **Status** | Pending |
| **Wave** | 3 · **Size** | M |
| **Epic slug** | `nlp-task-expansion` |
| **Depends on** | TASK-707 (`naming-alignment`, soft — `smr` → `text` rename; **not yet landed as of this writing**, see the naming note below) |
| **Design refs** | Services program (`nlp` row: "Adds sentiment / topic / intent / toxicity task types; may delegate generative NLP to `text`; per-tenant instructions"), `text` row ("Control-plane proxy for text-generation… across engines… Standard APIs + SSE + async contract") |
| **Findings closed** | — (net-new Wave-3 extension; not adjudicated in the consultation assessment) |

**Naming note (D8 / TASK-707):** the codebase on disk today still has the service at `apps/text`
(package `smr`, env prefix `TEXT_`) — TASK-707's `smr` → `text` rename has not landed. Every citation
below uses the REAL, on-disk path (`apps/text/...`) since that is what exists to verify against; every
place this ticket's own prose refers to the service by name, it uses the post-rename name `text` per
the assignment's instruction. If TASK-707 lands before this ticket executes, Task 1 below re-verifies
paths against `apps/text` and updates them — do not silently mix the two.

## 1. Requirement Analysis

`apps/nlp` today serves five task types, all as separately hardcoded routes over locally-loaded
`transformers` models, with zero outbound calls to any peer HOPE service and zero per-tenant
configuration of any kind (§2.1–2.5). This ticket adds four new task types — sentiment, topic
labeling, intent detection, toxicity — split across two genuinely different implementation shapes,
justified by what each task actually needs:

- **Sentiment and toxicity** are FIXED-taxonomy classification tasks (a small, stable label set that
  doesn't vary per tenant). They are already exactly what `apps/nlp`'s existing generic `POST
  /classify/text` endpoint does — it is model-agnostic, taking `model_name`/`model_path` as
  gateway-injected fields and returning `predicted_label`/`probabilities` (§2.2). These two task
  types need **no new endpoint** — only a new `AiTaskDefault` task key each (`nlp.sentiment`,
  `nlp.toxicity`) and, per §6, a decision on whether toxicity needs multi-label output (the current
  response shape is single-label).
- **Topic labeling and intent detection** are OPEN-taxonomy tasks — a tenant's topic list or intent
  list is exactly the kind of thing a fixed local classifier cannot serve (a classifier's label set
  is baked into training). This is the genuine "generative-backed" case the assignment names: these
  two delegate to `text` (a real LLM call, with the tenant's topic/intent list injected into the
  prompt as **per-tenant instructions**). Building this delegation is real new work — confirmed
  `apps/nlp` makes zero peer-service HTTP calls today (§2.3); this ticket adds `apps/nlp`'s first one,
  following the exact peer-to-peer client pattern `apps/text` already uses to call `guardrail`
  (`ExternalGuardrailClient`, §2.3) rather than inventing a new integration style.

Per-tenant instructions (topic list / intent list) are governed by a **new**, tenant-writable config
surface, deliberately kept separate from `AiTaskDefault`'s existing MODEL-SELECTION governance
(§2.6 explains why the two cannot share a table without breaking an existing, deliberate security
posture).

**Out of scope:**
- The `smr` → `text` rename itself (TASK-707).
- A shared cross-service peer-client package. `ExternalGuardrailClient` is itself per-service
  (`apps/text/src/text/services/external_guardrail.py`), matching rule 06's explicit note that
  per-service `core/effective_config.py` duplication "is a settled decision — do not preempt it";
  this ticket's new `apps/nlp` → `text` client follows the same per-service posture, not a shared
  package.
- Building the multi-label classification response variant unless Task 2 confirms it's needed for
  toxicity (§6, HUMAN-GATED).
- Workflow-palette node-registry entries beyond naming the pattern to imitate (§2.9) — the actual
  registry doesn't exist yet (TASK-715/720 not landed); this ticket ships task types that a future
  registry-authoring ticket can wrap, not registry code itself.

## 2. Current State Evaluation

Re-derived directly against `feat/loop`, excluding `.claude/worktrees/**`, `**/dist/**`,
`**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`.

### 2.1 `apps/nlp` today — five task types, no dispatch abstraction

`apps/nlp/src/nlp/` — `main.py` (uvicorn entry), `app.py` (`get_app()` factory), `api/middleware/auth.py`,
`api/v1/rest/*.py`, `api/v1/ws/*.py`, `services/*.py`, `core/config.py`, `core/effective_config.py`,
`core/model_source.py`, `services/model_cache.py`, `schemas/*.py`. Routers compose as `/api/v1` +
per-file prefix (`api/v1/__init__.py:11,20`; `api/__init__.py:5-8`). Existing task types:

| Task type | Route | Handler |
|---|---|---|
| Text classification (document type) | `POST /api/v1/classify/text` | `api/v1/rest/classify.py:20` |
| Token classification (medical NER) | `POST /api/v1/classify/tokens` | `api/v1/rest/classify.py:62` |
| Spelling correction | `POST /api/v1/correct/text` | `api/v1/rest/correct.py:14` |
| Diagnosis suggestions | `POST /api/v1/diagnosis/suggestions` | `api/v1/rest/diagnosis.py:15` |
| Document extraction (vitals/entities) | `POST /api/v1/extract` | `api/v1/rest/extract.py:14` |

Plus WS mirrors of token/text classification (`api/v1/ws/classify.py:35,55`). Rule
`00-project-context.md`'s one-line "NER, classification, diagnosis suggestions" is accurate but
incomplete — correction and extraction also exist. **No generic `task_type → handler` dispatch
abstraction exists** — each is a separate `APIRouter` + endpoint file; grepping for
`task_type|TaskType|dispatch|registry` returns only unrelated hits (Prometheus registry, an
unrelated docstring).

### 2.2 `/classify/text` is already model-agnostic — the reuse target for sentiment/toxicity

`apps/nlp/src/nlp/api/v1/rest/classify.py:20-56` (`classify_text`): the handler contains **zero
task-specific logic**. `request.model_name` (comment `:31`: "gateway-injected `AiModel.sourceUri`…
required; a missing/unloadable model fails closed with HTTP 503") selects which model runs via
`pinned_text_classifier(request.model_name, request.model_path)` (`:35`) — the SAME code path
already serves "document category" classification today and would serve sentiment/toxicity
tomorrow purely by pointing a different `AiModel`/`AiTaskDefault` row at it. `schemas/classification.py:9-25`
— `TextClassificationRequest` (`text`, `language`, `model_name`, `model_path`) and
`TextClassificationResponse:27-31` (`predicted_label`, `confidence`, `probabilities: dict[str,
float]`, `model_version`) are already generic single-label classification I/O — no document-type-specific
field exists anywhere in the schema. Model loading is local `transformers`
(`services/text_classifier.py:75-76` — `AutoModelForSequenceClassification`, `AutoTokenizer`,
`pipeline`), weight resolution via `core/model_source.py` (mirrors `apps/stt`'s scheme-dispatch
resolver: `local_path` → `hf:`/bare id → `s3://` → `file://`), per-model-slot caching via
`services/model_cache.py` (wraps shared `hope_runtime_models.ModelCache`).

### 2.3 Peer-service calls — confirmed zero today; the exemplar to imitate lives in `apps/text`

Grepping `apps/nlp/src/nlp/` for `httpx` returns exactly two call sites, BOTH pointed at the
**gateway**, never a peer AI service: `lifespan.py:46` (fire-and-forget service self-registration)
and `core/effective_config.py:157` (control-plane config pull, TTL-cached). Grepping for
`TEXT_URL|GUARDRAIL_URL|STT_URL|HARNESS_URL|TTS_URL` in `apps/nlp/src/nlp/`: **zero matches**. `apps/nlp`
has never called another AI service directly.

The pattern to imitate already exists, one service over: `apps/text/src/text/services/external_guardrail.py`
— `ExternalGuardrailClient` (`:21`), constructed with an `httpx.AsyncClient` (`:36`), calling
`f"{self.base_url}/api/medical/validate"` (`:81`) with `headers["X-Service-Token"] = service_token`
(`:60`) attached — a direct peer-to-peer call, not routed through the gateway (matching rule
`06-python-services.md`'s documented rationale for guardrail's callers: "SMR posts to it directly,
forwarding only `X-Tenant-Id`… there is no gateway to inject config"). Its config,
`ExternalGuardrailConfig` (`apps/text/src/text/core/config.py:310-322`), uses `env_prefix
="TEXT_EXTERNAL_GUARDRAIL_"` — the naming convention this ticket's new `nlp → text` client mirrors
as `NLP_EXTERNAL_TEXT_` (post-707-rename framing; pre-rename it would literally be
`NLP_EXTERNAL_TEXT_` — Task 1 confirms which is current at execution time).

### 2.4 Service-to-service auth — inbound real, outbound needs building

**Inbound**: `apps/nlp/src/nlp/api/middleware/auth.py` — `ServiceAuthMiddleware.dispatch` (`:43`)
validates `X-Service-Token` via `hmac.compare_digest` (`:53`) against
`settings.service.service_token` (`NLP_SERVICE_TOKEN`, `env_prefix="NLP_"`); empty token = dev
bypass (`:46`); WS counterpart `enforce_service_token_ws` (`:66-92`); registered in `app.py:37-39`
before CORS. **Outbound**: `apps/nlp` has zero existing client code that attaches
`X-Service-Token` to a call it makes (the two `httpx` call sites in §2.3 call the gateway using a
different mechanism — `core/effective_config.py:95`'s `header_name: str = "X-Service-Token"` default
param, constructed with `token=settings.service.service_token.get_secret_value()` at
`lifespan.py:33` — this reuses `apps/nlp`'s OWN inbound token to authenticate ITS OWN outbound
gateway calls, a different relationship than calling a peer AI service, which needs `text`'s
service token, not `nlp`'s own). This ticket's new client needs its own outbound credential
resolution — mirror `ExternalGuardrailConfig`'s `service_token: SecretStr` field exactly.

### 2.5 Per-tenant config — `apps/nlp` has none today; `AiTaskDefault` governs MODEL selection only

`grep -rln "tenant" apps/nlp/src/nlp/` returns **zero files** — no tenant awareness anywhere in
`apps/nlp`'s source today. `apps/guardrail/src/guardrail/core/tenant_config.py` (the sanctioned
direct-SQL exception per rule 06) has no `apps/nlp` counterpart. `apps/nlp`'s only "per-tenant"
touchpoint today is indirect and MODEL-SELECTION-only: the gateway resolves `AiTaskDefault` (tenant
row → SYSTEM row) and injects the winning `model_name`/`model_path` into the request body
(`schemas/classification.py:15-25`, §2.2) — `apps/nlp` itself never reads tenant config, it just
receives already-resolved fields.

### 2.6 `AiTaskDefault` — real, DB-driven, but WRITE-GATED global-admin-only for `nlp.*`

`packages/database/src/prisma/db_main/ai-task-default.prisma:1-49` — `AiTaskDefault`: one row per
`(tenantId, taskKey)`, SYSTEM tenant row = platform default; `modelSlug` references `AiModel.slug`
(no FK, "the AiModel slug-reference convention"); `configJson Json?` ("task-specific extras
(thresholds, etc.)"). The file's own header comment (`:12-18`) states governance explicitly: **"the
`guardrail.`, `nlp.`, and `harness.` task-key prefixes are GLOBAL-ADMIN-ONLY (service-level
`isSuperAdmin` guard on writes)… tenants only CONSUME the SYSTEM-row platform default and runtime
resolution ignores per-tenant override rows."** Confirmed in code:
`packages/applications/src/services/ai-task-default/constants.ts:91` —
`GLOBAL_ADMIN_ONLY_TASK_PREFIXES = ['guardrail.', 'nlp.', 'harness.']`; enforced at
`ai-task-default.service.ts:96` (`if (GLOBAL_ADMIN_ONLY_TASK_PREFIXES.some(p =>
taskKey.startsWith(p)) && !isSuperAdmin(this.requestUser))`). Current `nlp.*` keys (`constants.ts:34-36`):
`nlp.ner`, `nlp.classification`, `nlp.diagnosis`.

**This governance is deliberately about MODEL/PROVIDER SELECTION, not instructions** — the
settings-registry's own classification rules (`registry.types.ts:34-42`) state selection is
`failMode: 'closed'` "so an unresolved selection can never silently become another tenant's — or a
global — value," generalizing guardrail's `tenant_config.py` posture. A tenant's topic list or
intent list is NOT a model-selection value — it's tenant-authored CONTENT, structurally the same
kind of thing `ConsultationContextSchema`/`PromptTemplate`/`AsrPipeline` already let tenants author
without touching model governance. Extending `AiTaskDefault.configJson` for `nlp.topic`/`nlp.intent`
would be blocked by the SAME global-admin-only write gate that (correctly) locks model selection —
conflating the two would either (a) make tenant admins unable to write their own topic/intent lists,
defeating the point, or (b) require carving a new exception into `GLOBAL_ADMIN_ONLY_TASK_PREFIXES`
that weakens the existing model-selection lock for `nlp.*` as a side effect. §4 Task 3 instead adds
a **new, tenant-writable model** for instructions only, keeping `AiTaskDefault`'s existing lock
untouched — the same separation-of-concerns rule 09 already states generally ("provider/model
SELECTION is fail-closed… tuning fields fail safe to env — keep that split") applied to a new axis
(selection vs. tenant-authored instruction content) rather than the original tuning-vs-secret axis.

### 2.7 pydantic-settings — confirmed `NLP_` prefix

`apps/nlp/src/nlp/core/config.py:109-172` — `NLPServiceConfig(BaseSettings)`,
`model_config = SettingsConfigDict(env_prefix="NLP_")` (`:172`). Sibling per-concern prefixes in the
same file: `TEXT_CLASSIFIER_` (`:240`), `TOKEN_CLASSIFIER_` (`:281`), `MEDICAL_SUGGESTER_` (`:320`),
`SECURITY_` (`:363`), `SPELLING_CORRECTOR_` (`:381`), `WEBSOCKET_` (`:338`); a top-level `Settings`
container (`:384-397`) composes all of them. This ticket's new peer-client config follows the same
convention: a new `ExternalTextConfig(BaseSettings)` class with its own `env_prefix`.

### 2.8 Gateway proxy route — generic client, no dedicated `NlpController`

`apps/api` reaches `apps/nlp` via `IConfigService.getConfigValue('NLP_URL')` through two generic
clients, not a dedicated NestJS controller: `apps/api/src/modules/ai-inference/ai-inference.client.ts:8,32,82`
(`DEFAULT_NLP_URL = 'http://localhost:8864'`) and
`apps/api/src/modules/ai-service-admin/ai-service-proxy.client.ts:7,37,76` (admin proxy client);
`apps/api/src/modules/health/health.controller.ts:89` fans health checks out to `NLP_URL` too.
`find apps/api/src -iname "*nlp*"` returns no dedicated controller — the four new task types are
reachable the same generic way the five existing ones already are; **no gateway change is required**
for sentiment/toxicity (pure model-swap), and Task 5 confirms whether topic/intent need a request-shape
change on this generic client (they likely don't — the generic client forwards whatever body/response
shape the endpoint declares).

### 2.9 Test conventions, workspace membership, and the closest existing "registry" pattern

`apps/nlp/tests/` is top-level (NOT in-package, matching rule 06's stt/nlp row) — 26 existing files
(`test_health.py`, `test_extract.py`, `test_model_cache.py`, `test_auth_middleware.py`,
`test_effective_config_client.py`, etc.); new tests follow this flat `apps/nlp/tests/test_<feature>.py`
pattern. `apps/nlp/pyproject.toml:5-6` (`name = "nlp"`) is a member of the root uv workspace
(root `pyproject.toml:19-22`, `[tool.uv.workspace]` `members` includes `"apps/nlp"` at `:22`).

Two existing patterns are worth citing as the closest thing to a "registry," neither a literal
node-type registry yet: (1) `AiTaskDefault` itself (§2.6) — an enumerable, namespaced `taskKey`
registry, but DB-driven (data, not code) and scoped to model selection, not dispatch; (2) the
settings-registry descriptor pattern (`packages/applications/src/services/settings-registry/registry.types.ts:1-60`)
— a genuine typed capability-descriptor list (storage tier, scope, sensitivity, editor, fail-mode
per variable), the pattern rule 09 names as the template for governed, self-describing config
surfaces. A future workflow-palette node-type registry for NLP tasks (out of scope here, per §1)
would structurally resemble (2) more than (1) — a typed descriptor list (id, input/output schema,
category), not four new hardcoded endpoints. `docs/architecture/agentic-workflow-platform/backlog.md`
and `design.md` were grepped for `node.type|nodeType|registry` — no hits; this is greenfield.

## 3. Knowledge & Best Practices

- `.claude/rules/06-python-services.md` — `env_prefix` per concern (§2.7); `X-Service-Token`
  outbound auth for the new peer client (§2.3/§2.4); "Fail fast: settings validate at startup; never
  read `os.environ` ad hoc in request handlers"; async-native I/O (`httpx.AsyncClient`, matching
  `ExternalGuardrailClient`); per-tenant config default is gateway-resolved injection — the new
  `TenantNlpTaskInstructions` model (§4 Task 3) follows that default, it is NOT a second
  `tenant_config.py`-style direct-SQL exception (guardrail's exception is justified by "no gateway to
  inject config" between peer services calling guardrail directly; here, the GATEWAY still injects
  the tenant's instructions into the request body before `apps/nlp` ever runs, exactly like
  `TenantSttConfig`/`TenantTtsConfig` — `apps/nlp` stays stateless and never touches Postgres,
  consistent with every other service on this pattern).
- `.claude/rules/03-domain-layer.md` §Adding a New Domain Model — the new
  `TenantNlpTaskInstructions` Prisma model follows the standard field template (`_version` OCC,
  `tenantId`, soft delete) and the hand-authored entity/factory/mapper/repository checklist exactly
  (`gen:model` → hand-author the four → `gen:entity`/`gen:factory` reconcile barrels). It emits
  sys-events, so it needs a `ResourceType` entry in both `audit.prisma` and the domain enum.
- `.claude/rules/04-application-services.md` — the application-layer service resolving/CRUD'ing
  tenant instructions follows `TenantSttConfigService`'s exact shape (symbol DI, `BaseService`,
  sys-events, DTOs) — cite it as the direct structural exemplar (`packages/applications/src/services/tenant-stt-config/`).
- `.claude/rules/02-database-prisma.md` — new model + migration follows the shadow-DB recipe exactly
  (never hand-edit the dev DB ledger).
- `.claude/rules/05-nestjs-api.md` — if a gateway-side injection point is needed for the new
  `nlp.topic`/`nlp.intent` requests (resolving `TenantNlpTaskInstructions` before proxying to
  `apps/nlp`), it follows the SAME injection pattern `AiTaskDefault` resolution already uses for
  `model_name`/`model_path` on the existing classify routes — verify the exact injection call site
  in `ai-inference.client.ts` in Task 4 before adding a parallel one.
- **Known pitfall**: do not let `nlp.topic`/`nlp.intent`'s tenant-instruction table become a second,
  competing place to configure MODEL selection — it carries only instruction content (topic
  list/intent list/free-text guidance), never a `modelSlug`. Model/provider selection for these two
  task types still resolves through `AiTaskDefault` under the existing `nlp.*`
  global-admin-only lock (§2.6) — a tenant customizes WHAT the model looks for, never WHICH model
  runs. Conflating the two is the single most likely design error in this ticket.
- **Known pitfall**: `uv lock` must be re-run at the repo root after adding `httpx`... wait, `httpx`
  is already a dependency of `apps/nlp` per §2.3's grep — no NEW dependency is expected for the peer
  client, but if Task 4 needs anything new (e.g. a prompt-templating helper), re-run `uv lock` per
  rule 06's Definition of Done.
- `.claude/rules/_karpathy.md` §2 — do not build a generic multi-task dispatcher abstraction (§2.1
  confirms none exists) as a side effect of adding four task types; two of them (sentiment,
  toxicity) need zero new Python code beyond tests + `AiTaskDefault` rows, and the other two need
  exactly one new endpoint file each plus the shared peer-client. Resist "while I'm in here" scope
  growth into a registry/dispatcher this ticket doesn't need.

## 4. Implementation Plan

### Task 1 — Verify TASK-707's rename status before writing any new file paths
- **Agent:** T1 · haiku-4-5 · default
- **Files:** none (verification only)
- **Approach:** Check whether `apps/text` still exists or has become `apps/text` (and `TEXT_*` env
  vars → `TEXT_*`). Confirm which prefix Task 4's new client config should target
  (`NLP_EXTERNAL_TEXT_` either way per this ticket's naming choice, §2.3, but the TARGET service's
  own base env var name and default port depend on whether 707 landed).
- **Verify:** a one-line note in the PR description stating which state was found.

### Task 2 — Failing tests + wiring: sentiment and toxicity via the existing generic classifier
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/nlp/tests/test_classify_sentiment_toxicity.py` (new),
  `packages/applications/src/services/ai-task-default/constants.ts` (extend `AI_TASK_KEYS` +
  `AI_TASK_MODEL_TASK_TYPES` with `nlp.sentiment`/`nlp.toxicity` → `ModelTaskType.TEXT_CLASSIFICATION`),
  its existing test file (extend)
- **Approach:** RED first on the TS side (assert the two new task keys are present and correctly
  typed, mirroring `nlp.classification`'s existing entry). On the Python side, RED-then-GREEN a test
  proving `POST /classify/text` produces a correctly-shaped `TextClassificationResponse` when
  `model_name` points at a sentiment-labeled fixture model (use whatever fixture-model pattern
  `test_text_classifier_config.py` already establishes — imitate, don't invent a new fixture
  style). **No new endpoint, no new schema field is added in this task** — the point is proving the
  existing generic path already serves these two task types once `AiTaskDefault` rows exist; if the
  test reveals it does NOT (e.g. the response schema's `predicted_label`/`probabilities` shape is
  insufficient for a use case), stop and flag in §6 rather than silently extending scope.
- **Verify:** `pnpm --filter @arcaai/applications test`; `pnpm nlp:test -- test_classify_sentiment_toxicity.py`.

### Task 3 — Failing tests + implement: tenant-writable instructions model for topic/intent
- **Agent:** T3 · sonnet-5 · high
- **Files:** `packages/database/src/prisma/db_main/tenant-nlp-task-instructions.prisma` (new,
  mirroring `tenant-stt-config.prisma`'s exact shape: `tenantId` scoping, OCC `_version`, a
  `taskKey` discriminator restricted at the application layer to `nlp.topic`/`nlp.intent`, an
  `instructionsJson Json?` field holding the tenant's topic list / intent list / free-text guidance,
  soft delete), its migration (shadow-DB recipe per `02-database-prisma.md`),
  `packages/applications/src/services/tenant-nlp-task-instructions/` (new folder: `ITenantNlpTaskInstructionsService.ts`,
  `tenant-nlp-task-instructions.service.ts` extending `BaseService`,
  `tenant-nlp-task-instructions.service.module.ts`, `dto/`, `__tests__/`, `index.ts` — mirror
  `packages/applications/src/services/tenant-stt-config/`'s exact file layout), `ResourceType`
  additions in `audit.prisma` (`ADD VALUE`) and the domain enum, `apps/api/src/modules/` new
  admin controller (`admin/nlp-task-instructions` or similar — mirror
  `tenant-stt-config`'s controller route naming) with `@RequiresIfMatch()`/`@ExpectedVersion()` on
  PATCH per the OCC house pattern.
- **Approach:** RED-then-GREEN, full TDD per rule 01. CRUD + OCC + sys-events + 404-over-403 tenant
  guard, all per the `tenant-stt-config` exemplar. `configJson`/`instructionsJson` validation:
  `nlp.topic` expects a string array (topic labels); `nlp.intent` expects a string array (intent
  labels) or a richer `{label, description}[]` shape if the LLM prompt (Task 5) benefits from
  descriptions — decide and document in this task, keep it simple (Karpathy §2) unless a richer
  shape is clearly needed.
- **Verify:** `pnpm --filter @arcaai/applications build test`; `pnpm api:build`; the standard
  migration proof (`prisma migrate diff … --script` prints "This is an empty migration" after
  apply).

### Task 4 — Failing tests + implement: `apps/nlp`'s first peer-service client (`nlp` → `text`)
- **Agent:** T3 · sonnet-5 · high
- **Files:** `apps/nlp/src/nlp/core/config.py` (new `ExternalTextConfig(BaseSettings)`, `env_prefix
  ="NLP_EXTERNAL_TEXT_"`, fields `base_url: str`, `service_token: SecretStr`, timeout — mirror
  `ExternalGuardrailConfig` field-for-field), `apps/nlp/src/nlp/services/external_text_client.py`
  (new — mirror `apps/text/src/text/services/external_guardrail.py`'s class shape: constructor takes
  settings + an injected `httpx.AsyncClient`, one `async def generate_label(...)` method attaching
  `X-Service-Token`), `apps/nlp/tests/test_external_text_client.py` (new, RED first, mirroring
  `apps/text/src/text/tests/unit/test_external_guardrail_client.py`'s mocking style — mock the HTTP
  call, never hit a live service in this suite).
- **Approach:** The client posts to `text`'s existing generation endpoint (verify the exact route —
  rule `06-python-services.md`/services-program table names `text` as exposing "Standard APIs + SSE
  + async contract"; find its real non-streaming generate route in `apps/text/src/text/api/endpoints/`
  before hardcoding a path) with a prompt assembled from the tenant's `instructionsJson` (Task 3) +
  the input text, and parses the response into a label (topic) or label set (intent). Timeout and
  error handling mirror `ExternalGuardrailClient`'s own (verify its exact `httpx.TimeoutException`/
  `HTTPStatusError` handling shape and reuse it, not reinvent).
- **Verify:** `pnpm nlp:test -- test_external_text_client.py` — RED then GREEN.

### Task 5 — Failing tests + implement: `/classify/topic` and `/classify/intent` endpoints
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/nlp/src/nlp/api/v1/rest/classify.py` (extend — two new routes in the SAME file as
  the existing `/classify/text`/`/classify/tokens`, following their exact structure: fail-closed 503
  on missing config, semaphore-bound inference, structured error handling),
  `apps/nlp/src/nlp/schemas/classification.py` (extend — `TopicClassificationRequest`/`Response`,
  `IntentClassificationRequest`/`Response`, each carrying `tenant_id` — gateway-injected, needed
  here (unlike `/classify/text`) because THIS endpoint itself resolves `TenantNlpTaskInstructions`
  server-side via Task 3's gateway-injection path, verify exactly how the gateway injects it — as a
  request-body field like `model_name`/`model_path` today, most likely, keeping `apps/nlp` stateless),
  `apps/nlp/tests/test_classify_topic_intent.py` (new, RED first)
- **Approach:** Handler resolves the injected instructions, calls Task 4's
  `ExternalTextClient.generate_label(...)`, returns a structured label/labels response. Concurrency
  bound the same way `classify_text` is (`inference_bound`), even though the actual work happens in
  a peer service call, not local inference — the semaphore protects `apps/nlp`'s own connection/
  concurrency budget to `text`, not GPU memory, but the pattern (bound + release) is worth keeping
  consistent; confirm with the team whether a SEPARATE semaphore (peer-call budget vs. local-inference
  budget) is more correct before reusing `inference_bound` verbatim — flag in §6 if ambiguous.
- **Verify:** `pnpm nlp:test -- test_classify_topic_intent.py` — RED then GREEN.

### Task 6 — Gateway wiring: inject `TenantNlpTaskInstructions` before proxying topic/intent calls
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/api/src/modules/ai-inference/ai-inference.client.ts` (extend — confirm the exact
  existing injection call site for `model_name`/`model_path` on the classify routes in Task 1's
  findings before adding a parallel one for `instructionsJson`), its test
- **Approach:** Mirror the existing `AiTaskDefault` resolution/injection flow exactly, but resolving
  `TenantNlpTaskInstructionsService` (Task 3) instead — this is a DIFFERENT resolution (tenant-writable,
  no global-admin lock) happening on the SAME request path, not a second `AiTaskDefault` read.
- **Verify:** `pnpm api:build`; `pnpm test:unit -- ai-inference.client`.

### Task 7 — E2E + `uv lock`
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/api/tests/e2e/task-729-nlp-task-expansion.spec.ts` (new); root `uv.lock` (re-run
  `uv lock` if Task 4 added any new Python dependency — confirm none did per §3's pitfall note, skip
  if truly unchanged)
- **Approach:** Seed a tenant with `TenantNlpTaskInstructions` rows for `nlp.topic`/`nlp.intent` and
  an `AiTaskDefault` row for `nlp.sentiment`; call all four new task types through the gateway;
  assert sentiment/toxicity return the generic classifier shape and topic/intent return the
  peer-delegated shape reflecting the tenant's own instructions (proves the instructions actually
  flow through, not just that the endpoint 200s); cross-tenant instructions read/write → 404.
- **Verify:** `pnpm test:up:api` then `pnpm test:e2e -- task-729-nlp-task-expansion`.

### Task 8 — Full verification pass
- **Agent:** T2 · sonnet-5 · low
- **Files:** none
- **Approach:** Run every layer gate this ticket touches.
- **Verify:** `pnpm --filter @arcaai/applications build test`, `pnpm api:build`, `pnpm test:unit`,
  `pnpm nlp:test`, `pnpm nlp:lint`, `pnpm nlp:typecheck`, `pnpm lint`.

## 5. Acceptance Criteria

- [ ] `pnpm --filter @arcaai/applications build test` passes, including the new
      `tenant-nlp-task-instructions` service suite
- [ ] `pnpm api:build`, `pnpm test:unit` pass, including the new gateway-injection test
- [ ] `pnpm nlp:test` passes, including `test_classify_sentiment_toxicity.py`,
      `test_external_text_client.py`, `test_classify_topic_intent.py`, all hermetic (no live peer
      calls in the suite)
- [ ] `pnpm nlp:lint`, `pnpm nlp:typecheck` pass
- [ ] `pnpm test:up:api` then `pnpm test:e2e -- task-729-nlp-task-expansion` — all four new task
      types reachable through the gateway; topic/intent responses reflect tenant-specific
      instructions; cross-tenant instruction access → 404
- [ ] `nlp.sentiment`/`nlp.toxicity` require NO new `apps/nlp` endpoint — only new `AiTaskDefault`
      rows and (if Task 2 finds it necessary) a schema extension, justified in the PR description
- [ ] `nlp.topic`/`nlp.intent` delegate to `text` via a new peer-to-peer `X-Service-Token`-authenticated
      client mirroring `ExternalGuardrailClient`
- [ ] Tenant-writable instructions for topic/intent live in a NEW model, never in `AiTaskDefault.configJson`
      (§2.6's separation-of-concerns finding upheld)
- [ ] `ResourceType` parity test green for the new tenant-instructions model
- [ ] `uv lock` re-run and committed if any Python dependency changed
- [ ] `pnpm lint` — zero new errors, including `only-warn` warnings in `packages/*` treated as errors
- [ ] Ticket README's Implementation Summary and Change History updated with actual command output
      pasted

## 6. Risks & Open Questions

- **HUMAN-GATED: toxicity multi-label shape (Task 2).** If product requirements need simultaneous
  multi-category toxicity (toxic + threat + insult at once, not mutually exclusive), the existing
  `TextClassificationResponse` (`predicted_label`, single string) cannot represent it — that would
  require either a new response variant or a schema extension, sized as a follow-up task, not
  assumed away. Confirm the actual requirement before Task 2 claims "no new endpoint needed" as a
  blanket fact.
- **HUMAN-GATED: naming and rename timing (TASK-707 soft dependency).** If TASK-707 lands mid-execution,
  every `apps/text`/`TEXT_*` citation in this ticket needs re-verifying against the renamed paths —
  Task 1 is the re-verification gate but a second pass may be needed if the rename lands between
  Task 1 and later tasks.
- **Peer-call concurrency budget (Task 5)**: reusing `inference_bound` for a network call to `text`
  conflates two different resource budgets (local GPU/CPU inference slots vs. outbound HTTP
  concurrency to a peer service). This ticket's plan flags but does not resolve it — a wrong choice
  here could either starve local classification under load from topic/intent calls, or vice versa.
  Needs a decision, ideally informed by how `apps/text`'s own guardrail-calling code paces its calls
  (verify if `ExternalGuardrailClient`'s callers use a distinct semaphore before deciding).
- **`GLOBAL_ADMIN_ONLY_TASK_PREFIXES` scope**: this ticket does not add `nlp.sentiment`/`nlp.toxicity`/
  `nlp.topic`/`nlp.intent` as EXCEPTIONS to the global-admin-only write lock — MODEL selection for
  all four stays global-admin-only, consistent with the other `nlp.*` keys. If product wants tenant
  admins to pick which sentiment/toxicity MODEL runs (not just tenant-authored instructions for
  topic/intent), that is a governance change to `GLOBAL_ADMIN_ONLY_TASK_PREFIXES` itself and needs
  explicit human sign-off — it is a security-relevant change to an existing, deliberate lock, not a
  routine addition.
- **`text`'s exact generation route (Task 4)** is asserted to exist per the services-program table
  ("Standard APIs + SSE + async contract") but this ticket's research did not verify its exact path
  — Task 4 must confirm the real endpoint (likely under `apps/text/src/text/api/endpoints/generate.py`,
  seen in §2.3's file listing, but not read in this research pass) before wiring the client, and
  should not assume the assignment's phrasing is a literal route name.

## 7. Implementation Summary

_(Empty at authoring — filled during execution.)_

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Wave-3 ticket-authoring agent |
