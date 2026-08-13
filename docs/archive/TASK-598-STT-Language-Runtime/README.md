# TASK-598 — STT Language as a Runtime Choice (de-hardcode pipeline + SDK defaults)

**Status:** Review
**Type:** refactor
**Date:** 2026-08-02

## Requirement Analysis

Two asks from the owner:

1. **Remove languages from the STT pipeline definition** (and any hardcoded language).
2. **Allow a developer and an end-user to set the language.**

Confirmed scope (via clarifying questions):

- **Fallback when nobody selects a language = auto-detect.**
- **Remove the hardcoded language from ALL seeded pipelines** (not just the code-switch defaults).
- **The existing `languageMode` mechanism (TASK-587) is the language-setting API** — no new developer API. Dev sets it via `audio.start({ languageMode })` / `AudioSourceConfig.languageMode`; end-user picks it via the TASK-587 picker.

## Current State Evaluation

Language was hardcoded in two layers, with a runtime override already in place:

- **Pipeline definitions** — `packages/database/src/prisma/db_main/seed/06-stt.ts` baked `inference.language` into each pipeline's `configYaml`. Six pipelines pinned a concrete language: the four ArcaAI code-switch pipelines (`"ml-en"`, incl. the platform default `arcaai-whisper-large-ml-en-gguf`), plus the `asr-en-template` (`en`) and `asr-ml-template` (`"ml"`). There is **no `language` column** on any Prisma model — it lives entirely inside `configYaml`.
- **SDK defaults** — the `@arcaai/vox` consultation path forces a language by default through a chain of `'en'`/`'en-US'` defaults (`store.audioLanguage`, `DEFAULT_STT_CONFIG.language`, `DEFAULT_AUDIO_CONFIG.stt.language`, `getSTTLanguage()`, `@arcaai/stt` `DEFAULT_LANGUAGE_LOCALE`). This request-level `language` **outranks** the pipeline YAML at the backend, so editing only the seed would NOT produce auto-detect — the SDK would still force `en`.

**Backend precedence (unchanged):** `languageMode` **>** request `language` **>** pipeline YAML `inference.language`. The end-user/dev `languageMode` is resolved against the session engine at `apps/stt/.../streaming/session_manager.py::_load_asr_pipeline` and overwrites `inference_config.language`.

**Key discovery:** the TASK-587 catalog already contains an **`auto`** mode, and `engine_supports_mode(auto, *)` is `True` for **every** engine (`resolve_mode_for_engine('auto', …)` → `language=None`). So defaulting the language *mode* to `auto` yields auto-detect end-to-end — regardless of the inert `'en'` `language` defaults — with a tiny, low-risk change instead of ripping `'en'` out of the config-schema/personalization/store layers and ~8 test files.

## Implementation Plan

1. **Seed** — set every hardcoded `inference.language` to `null` (auto-detect). Tenant/global copies + versions derive from `PIPELINE_CONFIGS`, so they inherit automatically.
2. **SDK** — default the transmitted **language mode** to `'auto'` when neither a runtime option nor the app config pins one, so an un-selected session auto-detects. A dev/end-user pick still wins.
3. **STT Python service** — no change (already treats "no language / no mode" as auto; `yaml_parser` accepts `null`).
4. **Docs + regression tests.**

## Implementation Summary

### Seed — pipelines no longer pin a language
`packages/database/src/prisma/db_main/seed/06-stt.ts`: the six hardcoded `inference.language` values (`"ml-en"` ×4, `en`, `"ml"`) are now `null`, with comments noting language is a runtime choice (`languageMode`, TASK-587). All other pipelines were already `null`. Verified: **no non-null `language:` remains** in the file. No schema/migration change (language is `configYaml`-only). Seed tests assert only that an `inference:` section and valid model slugs exist — still green.

### SDK — default language mode to `auto`
- `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` — the runtime resolution now reads `options?.languageMode ?? store.sttLanguageMode ?? 'auto'`, so a start with no explicit pick auto-detects.
- `packages/agentic-sdk-v2/src/core/PluginManager.ts` — the config-assembly path now sets `languageMode: runtimeOptions.languageMode ?? sttConfig.languageMode ?? 'auto'` (was a conditional spread that omitted the field). This covers both the runtime and config-only paths (`runtimeOptions` flow through here).

The inert `'en'`/`'en-US'` `language` defaults were intentionally **left in place** — they are always overridden by the default `'auto'` mode at the backend, and the local (in-browser) STT path is disabled platform-wide. This is the minimal, low-risk realization of "auto-detect fallback" (owner-approved over the full rip-out).

### Tests
`packages/agentic-sdk-v2/src/core/__tests__/PluginManager.streamingTransport.test.ts` — added two regression tests: (1) `languageMode` defaults to `'auto'` when unset; (2) an explicit runtime `languageMode` still overrides the auto default.

## Verification (evidence)

- `pnpm --filter @arcaai/database test` → **892 passed** (seed change safe).
- `pnpm --filter @arcaai/vox typecheck` → clean.
- `pnpm --filter @arcaai/vox test` → **3817 passed** (incl. compat suite + 2 new tests).
- `pnpm --filter @arcaai/vox lint` → **0 errors** (4 pre-existing warnings, none from this change).
- `pnpm --filter @arcaai/vox build` → success.

### Operational follow-up (owner)
- Re-seed the dev DB (`pnpm db:seed`) and **restart the STT service** so the live `AsrPipeline.configYaml` rows carry `language: null`.
- Commit (branch `dev-2.1`; uncommitted per current workflow).

### Behavior change to note
Previously an un-selected consultation was decoded as **English** (`language: 'en'`). Now, unset ⇒ **auto-detect**. On the platform default (the ml-en fine-tune) auto-detect matches the model's intended native code-switch behavior (per the seed comment "the fine-tune code-switches natively; pinning over-biases the script") — an improvement for the default path. Any explicit `languageMode` (`en`/`ml`/`ml-en`/`vi`/`vi-en`) still overrides.

## Change History

- 2026-08-02 — Initial implementation. Seed pipelines de-hardcoded (`inference.language → null`); SDK defaults the transmitted language mode to `'auto'`; 2 regression tests added. Builds/tests/lint green. Status: Review (pending owner re-seed + STT restart + commit).
