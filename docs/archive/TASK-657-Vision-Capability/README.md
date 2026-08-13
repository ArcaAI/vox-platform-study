# TASK-657 — Vision Capability

- **Status:** In Progress
- **Type:** feature
- **Baseline:** `dev-2.1` @ `a61df126b` (clean tree; worktree was mis-based on `main` and reset per the agent contract)
- **Parent:** [TASK-654 — Consultation Context Schema & Configurable Loop](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/README.md) §6.1 (W0, sonnet-5/medium, Size M) — this ticket is fully independent of the rest of the programme
- **Spec:** [execution-plan.md § TASK-657](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/execution-plan.md)

## 1. Requirement Analysis

Make `vision.extract_text` real by giving SMR (`apps/smr`) the ability to carry an image to a vision-capable LLM, end to end:

1. `GenerateRequest` gains an additive content-parts union alongside `prompt: str`. Every existing text-only caller must be byte-identical to before.
2. `LLMProvider.generate`'s contract is extended to carry parts (via the request — no signature change needed since the request already flows through).
3. Nine provider adapters get image support, in ascending order of lift:
   - `bedrock.py`, `anthropic.py` — content is already list-shaped; add an image block type.
   - `openai_compat.py`, `azure_openai.py`, `openai.py` — convert bare-string `content` to a content-parts array when an image is present.
   - `ollama.py` — populate the (currently absent) `images` key on `/api/generate`.
   - `vertex.py` — `Part.from_bytes`.
   - `vllm.py` — inherits `OpenAICompatProvider._build_messages`; no separate code change, but included in the vision contract test since it gets vision for free.
   - `llama_cpp.py` — raw `/completion` has no multimodal concept. It must **declare** that and reject an image request with a clear typed error.
4. `supports_vision` on `ProviderInfo`/`ModelInfo` (`apps/smr/src/smr/models/provider.py`).
5. `vlm.extract` task key added to `packages/applications/src/services/ai-task-default/constants.ts`.
6. Seed at least one vision `AiModel` using the existing `ModelCategory.VISION` / `ModelTaskType.IMAGE_TEXT_TO_TEXT` enum values (already in the Prisma schema, used by zero seeded rows).

**Fail-closed constraint.** An unresolvable vision model must raise, never silently fall back to OCR — the established posture for provider/model *selection* in this codebase (`require_model`, `ModelNotSelectedError`, `failMode: 'closed'` on `models.*` settings descriptors).

**Must not change.** Any existing text-only call path — every current SMR request keeps its exact behaviour and wire payload.

## 2. Current State Evaluation

Verified 2026-08-11 against `dev-2.1` @ `a61df126b` (see TASK-654 README §3.7 for the original finding; re-verified directly against the files below before writing code):

- `GenerateRequest.prompt` is `str` (`apps/smr/src/smr/models/requests.py:79-102`). No image/content-parts field exists.
- `LLMProvider.generate(request) -> tuple[str, str, GenerationStats]` (`apps/smr/src/smr/providers/base.py:40-61`) — text-in/text-out by contract. The single choke point every adapter implements.
- All nine adapters build a plain-string `content` field via a `_build_messages`/`_build_create_kwargs`/`_build_converse_params`/`_build_payload` helper: `openai_compat.py:103-108`, `azure_openai.py:104-109`, `openai.py:125-130`, `anthropic.py:130-141` (content already a list, but of one string block), `bedrock.py:108-120` (content already `[{"text": prompt}]`), `vertex.py:206-209` (`contents=request.prompt`, a bare string), `ollama.py:82-111` (no `images` key present at all — the execution-plan's "populate the unused key" description was aspirational; there is currently no such key to populate), `llama_cpp.py:58-88` (raw prompt string, no chat/image concept).
- `vllm.py` subclasses `OpenAICompatProvider` and does not override `_build_messages` — it inherits the fix for free. Confirmed no separate vision code needed there.
- Task keys — 12 total, none vision (`packages/applications/src/services/ai-task-default/constants.ts:26-39`).
- `ModelCategory.VISION`, `MULTI_MODAL` and `ModelTaskType.IMAGE_TEXT_TO_TEXT` / `VISUAL_QUESTION_ANSWERING` exist in `packages/database/src/prisma/db_main/enums.prisma:84-157` (both the Prisma enum and the generated `packages/domains/src/enums/generated/ModelTaskType.ts` / `ModelCategory.ts`) and are used by zero seeded rows.
- The AI-model seed catalog's local TS enum *mirrors* (`packages/database/src/prisma/db_main/seed/ai-models/shared.ts`) only carry `AUDIO`/`NLP` for `ModelCategory` and no `IMAGE_TEXT_TO_TEXT` for `ModelTaskType` — these mirrors need the two new members before a vision row can be added (they are hand-maintained subsets of the real Prisma enum, "only the values actually used by a seed row are mirrored").
- `packages/database/src/prisma/db_main/seed/__tests__/ai-model-consolidation-seed.test.ts` pins the catalog to an EXACT slug list and count (`catalog.length === 42`) and an exact LM-Studio identifier pin list — both must be updated in lockstep with the new seed row or the database test suite goes red.
- Exception hierarchy: `apps/smr/src/smr/core/exceptions.py` — `InputValidationError` maps to HTTP 422 via `_STATUS_MAP` in `core/exception_handlers.py`. `ModelNotSelectedError` is the existing precedent for "the caller's input can't be honoured, fail with a clear typed 422" — the same shape fits an image sent to a provider with no vision wire.
- `AI_TASK_KEYS`-driven descriptor generation (`packages/applications/src/services/settings-registry/descriptors/model-defaults.descriptors.ts`) is a `.map()` over `AI_TASK_KEYS` keyed against a `META` record — adding a task key WITHOUT a matching `META` entry throws at module load. This file is a load-bearing companion change even though the ticket text doesn't name it explicitly.
- `GLOBAL_ADMIN_ONLY_TASK_PREFIXES = ['guardrail.', 'nlp.', 'harness.']` — `vlm.` does not match any prefix, so `vlm.extract` is tenant-admin configurable by default (same governance class as `smr.*`), which fits: it is implemented inside SMR's own provider/adapter framework, is a generation-style task, and is not a platform-only safety/compliance surface.

## 3. Design Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | `content_parts: list[ContentPart] \| None = None` on `GenerateRequest`, a discriminated union of `TextContentPart` / `ImageContentPart` on a `type` field | Additive; `None`/absent is the default so every existing caller is unaffected. A discriminated union (not a bare `list[ImageContentPart]`) matches "content-parts union" in the spec and leaves room for future part kinds without another migration. |
| D2 | `ImageContentPart.data` is base64 bytes with **no** `data:` URI prefix; `media_type` is a plain MIME string (default `image/png`) | The `data:` URI scheme is one provider's (OpenAI-wire) convention, not a property of the image. Each adapter builds its own wire shape from `data`/`media_type` (OpenAI-wire prepends `data:`, Anthropic/Bedrock/Vertex decode/use raw bytes, Ollama sends the base64 string as-is). |
| D3 | `GenerateRequest.image_parts()` helper method, not a free function | Every adapter needs "the image parts of this request" — a method keeps call sites terse (`request.image_parts()`) and is where a request-shape invariant belongs. |
| D4 | New `VisionNotSupportedError(InputValidationError)` in `core/exceptions.py`, raised by a new `reject_vision()` helper in `providers/base.py`, used only by `llama_cpp.py` | Matches the existing `ModelNotSelectedError` pattern exactly (a `core/exceptions.py` subclass of `InputValidationError`, so it inherits the 422 mapping for free) — a caller that picked a text-only engine for a vision request must find out with a clear typed error, not get a silently wrong (image-dropped) answer. |
| D5 | `ProviderInfo.supports_vision: bool` (default `False`) is an **architectural/wire-protocol** fact set explicitly by each adapter's `get_info()`, not a per-model vendor-listing probe | No adapter today introspects a vendor's model listing for multimodal capability; this ticket only knows "can this engine carry an image at the wire level at all." `ModelInfo.supports_vision: bool \| None = None` is added as informational, future-probe-ready metadata (same posture as the existing `state`/`engine_native` fields), left unset (`None`) by every adapter for now. |
| D6 | `vlm.extract` is **not** added to `GLOBAL_ADMIN_ONLY_TASK_PREFIXES`; no `META` copy-paste beyond the one new entry | It sits in SMR's own adapter framework (like `smr.*`), not the platform-only `guardrail./nlp./harness.` safety surfaces. Tenant-admin configurable, `failMode: 'closed'` (inherited automatically — `MODEL_DEFAULT_SETTINGS` sets `failMode: 'closed'` for every key in `AI_TASK_KEYS` unconditionally). |
| D7 | **No SYSTEM `AiTaskDefault` row is seeded for `vlm.extract`** | See §5 Decisions below — this is the fail-closed choice, not an oversight. |

## 4. Implementation Plan

TDD, RED before GREEN, in this order:

1. **RED**: regression test — every existing adapter's message/payload builder produces the exact prior shape when `content_parts` is absent (run against current `dev-2.1` code, i.e. before any implementation, to prove the fixture is meaningful).
2. `apps/smr/src/smr/models/requests.py` — `TextContentPart`, `ImageContentPart`, `ContentPart` discriminated union, `GenerateRequest.content_parts`, `GenerateRequest.image_parts()`.
3. `apps/smr/src/smr/core/exceptions.py` — `VisionNotSupportedError`.
4. `apps/smr/src/smr/providers/base.py` — `reject_vision()` helper; docstring note on the `LLMProvider.generate` contract.
5. Adapters (ascending lift, per spec): `bedrock.py`, `anthropic.py` → `openai_compat.py`, `azure_openai.py`, `openai.py` → `ollama.py` → `vertex.py` → `llama_cpp.py` (reject).
6. `apps/smr/src/smr/models/provider.py` — `supports_vision` fields; wire into every adapter's `get_info()`.
7. `packages/applications/src/services/ai-task-default/constants.ts` + `.../settings-registry/descriptors/model-defaults.descriptors.ts` (companion, load-bearing).
8. `packages/database/.../seed/ai-models/shared.ts` (enum mirrors) → `llm.ts` (new row) → `ai-model-consolidation-seed.test.ts` (catalog pins updated in lockstep).
9. Gates; fill in §6 with pasted output; Decisions §5 confirmed against the real seed choice made.

## 5. Decisions — vision model to seed (owner: confirm)

**Chosen: an in-boundary (self-hosted) default, not a BYOK cloud provider.**

Seeded row: `lms-medgemma-1.5-4b-it-vision` — MedGemma 1.5 4B IT served via LM Studio, `provider: 'lm-studio'`, `category: VISION`, `taskType: IMAGE_TEXT_TO_TEXT`, `sourceUri: 'medgemma-1.5-4b-it'` (the SAME LM Studio identifier as the existing text-only `lms-medgemma-1.5-4b-it` row — a 4B MedGemma checkpoint is natively multimodal; this is one set of weights serving two `AiModel` catalog rows for two task types, which the schema explicitly allows — `AiModel`'s only uniqueness constraint is `(tenantId, slug)`, not `sourceUri`). Catalogued but **not loaded** on the dev LM Studio instance (same state as several existing rows, e.g. `lms-gemma-4-e4b-it-qat`) — the identifier is provider-correct, the weights are simply not pulled on this host yet.

**PHI-egress tradeoff, stated explicitly:**

| | In-boundary (chosen) | BYOK cloud (Azure OpenAI / Anthropic / Vertex — all adapters already support vision) |
|---|---|---|
| PHI egress | None — image bytes never leave the tenant's own infrastructure | Every call crosses the fail-closed egress screen (`apps/harness/src/harness/guards/phi/egress.py`); the tenant must explicitly configure a BYOK cloud vision credential and accept that clinical images (photographed wounds, scanned documents, X-ray photos) leave the boundary |
| Availability | Requires an operator to actually pull the weights (today: catalogued, not loaded — `vlm.extract` therefore has NO SYSTEM default and fails closed, per D7) | Available as soon as a tenant configures a credential; no local GPU/host dependency |
| Quality | MedGemma is domain-tuned for medical image+text, but a 4B checkpoint is small | Frontier cloud VLMs (GPT-5.4, Claude, Gemini) are larger and more capable out of the box |
| Cost | Local compute only | Per-call vendor billing |

**Why no SYSTEM `AiTaskDefault` row for `vlm.extract` (D7).** The chosen model is catalogued-but-not-loaded — exactly the state the existing catalog already treats as "must not be selected by any `AiTaskDefault`" (see the comment on `LLM_AI_MODELS` in `llm.ts`: *"NO `AiTaskDefault` may select one"*). Leaving `vlm.extract` unresolved is not an oversight: it is the fail-closed contract this ticket is required to hold (§1) working exactly as designed — `EffectiveSettingsService.resolveEffective('models.vlm.extract', ...)` raises `ArgumentInvalidException` ("could not be resolved") until a global admin or tenant admin either (a) points `vlm.extract` at this row once the operator has pulled the weights, or (b) configures a BYOK cloud vision credential and points `vlm.extract` at that provider/model instead. Both paths are ordinary `AiTaskDefault` writes; neither needs new code.

**Recommendation for the owner to confirm**: keep the in-boundary default and leave `vlm.extract` unresolved until an operator loads real vision weights, OR seed a BYOK cloud SYSTEM default now (accepting the egress tradeoff) so `vlm.extract` resolves out of the box. This ticket implements the former (safer default, consistent with the existing "not loaded ⇒ not selected" catalog convention) and leaves the latter as a one-row seed change if the owner prefers it.

## 6. Implementation Summary

(filled in after gates run — see below)

## Change History

- 2026-08-11 — Ticket opened; plan authored before implementation, per the TASK-654 agent contract §1.3.
