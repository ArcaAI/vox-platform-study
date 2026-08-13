# TASK-600 — "Translate to English" (Sarvam) flag for compat summarization

**Status:** Review — REWORKED so Sarvam translation lives in **SMR** (not STT). All layers unit-verified; Phase 5 live run owner-deferred. Uncommitted on dev-2.1. Consumption capture = TASK-601 (separate agent).
**Type:** feature
**Branch:** dev-2.1
**Owner:** Tap Huynh
**Created:** 2026-08-02

---

## Requirement Analysis

Add a boolean flag to the SDK-compat and API-compat **summary** path:
- **True** → the backend translates the **transcript** to English via **Sarvam** before summarizing.
- **False** → summarize as-is (current behavior).

### Decisions (owner, 2026-08-02)
- **T1 — Scope:** translate **the transcript only** (`session_data.conversation_segments[].text`). **Pre-summary is OUT of scope** — no flag, no translation there.
- **T2 — Provider/creds:** reuse the **existing Sarvam provider** already integrated for STT transcription (its platform key + per-tenant BYOK), "beside transcription" — do NOT add new credentials.
- **T3 — Failure mode:** **fail-open** — on any Sarvam/translation error, log a warning and proceed with the ORIGINAL transcript (never block the summary).
- **T4 — Placement:** run **before summarization**; the exact host (gateway vs STT vs SMR) is being chosen per this codebase's best practices (research in progress) rather than assumed.
- **T5 — Consumption capture: OUT OF SCOPE for TASK-600** (owner: a separate concurrent agent owns consumption capturing/monitoring). To avoid collision, TASK-600 does **not** modify `metrics.py` or add any billing/usage store. As a courtesy hook, the STT `/internal/translate` response includes a `chars`/`request` count + `provider` so the consumption agent can meter it, but TASK-600 wires none of it.
- **T7 — REWORK (owner, 2026-08-02): move the Sarvam call from STT into SMR.** SMR is being positioned as the text-generative router (many LLM/text-gen providers + capabilities), so Sarvam belongs there. Decisions: **extensible `TranslateProvider` registry** (Sarvam first) as a NEW SMR `/api/v1/translate` capability (translation doesn't fit the chat-shaped `LLMProvider.generate` contract); **full BYOK via AiProviderConnection** — reuse the tenant's existing Sarvam credential from the unified plane (`resolveTenantCloudOverrides('stt','sarvam')`; one Sarvam key serves all capabilities) rather than adding a 4th `translation` service (which would ripple into the admin credential UI — deferred as an easy later extension). STT reverts to transcription-only. Gateway repoints to SMR. SDK/playground unchanged. Creds: `SMR_SARVAM_API_KEY`/`SMR_SARVAM_BASE_URL` platform + per-request `provider_overrides['sarvam']` BYOK. Supersedes T6.

- **T6 — (SUPERSEDED by T7) Placement:** the Sarvam call lives in **STT** (`/internal/translate`, reusing `CloudRestConfig`/`resolve_override_key`/the `sarvam_asr` REST pattern); the **gateway orchestrates** via a new `packages/applications` symbol-token service (`ISttTranslationService`) `@Optional`-injected into `SmrCompatController`, run before `prepareSummary(...)`, fail-open. Matches the NER-enrichment-before-summary precedent; SMR only ever sees English. STT keeps its existing headerless `/internal/*` posture (no inbound service-token today — network-isolated); tenant creds/BYOK travel in the POST body via `resolveProviderOverrides(tenantId)`.

## Current State Evaluation (verified)
- Sarvam is integrated in **`apps/stt`** (Python): `streaming/sarvam_asr.py` (`sarvam_recognize_utterance`, plain `httpx`, `api-subscription-key` header, base `https://api.sarvam.ai`), `models/sarvam_loader.py`, creds via `SARVAM_API_KEY`/`SARVAM_BASE_URL` (platform) + per-tenant `provider_overrides["sarvam"]["api_key"]` (BYOK, TASK-567), resolved through `CloudRestConfig`.
- STT already hosts **gateway-called internal endpoints** gated by `X-Service-Token` — precedent: `voice_profile/api/routes.py` `APIRouter(prefix="/internal/voice-profile")`, `POST /internal/voice-profile/extract`. Gateway→STT with `STT_URL` (via `IConfigService`) + `X-Service-Token` is the established direction.
- Compat summary shim: `apps/api/src/modules/smr-compat/smr-compat.controller.ts` (`computeSummary`/`streamSummary` → `prepareSummary` → `buildSummaryPrompt(sessionData, …)`); the transcript is rendered from `sessionData.conversation_segments` in `summary-prompt.builder.ts:renderSegments`.
- SDK compat: `packages/agentic-sdk-v2/src/compat/useSMR.ts` `buildSyncPayload`; `SMRRequest` in `compat/types.ts`.
- No existing translation code anywhere (greenfield translation; existing Sarvam client is STT-only).

### Architecture decision (flagged — confirm at approval)
**Translation is hosted in the STT service, reused "beside transcription"** (faithful to T2), and the gateway calls it. This keeps the Sarvam key inside STT (never exposed to the gateway) and reuses the existing creds/BYOK resolution. *Alternative considered:* gateway-direct Sarvam translate (TS client reading `SARVAM_API_KEY`) — fewer hops but re-implements the Sarvam client in TS and needs the key in the gateway; rejected for T2.

## Implementation Plan (TDD, layer order)

### Phase 1 — STT translation capability + internal endpoint (`apps/stt`)
1. **RED:** `tests/unit/streaming/test_sarvam_translate.py` — `sarvam_translate_text(config, text, target='en-IN', source='auto')` posts to `{base}/translate` with `api-subscription-key`, returns `translated_text`; chunks input over Sarvam's per-call limit and rejoins; raises a typed error on non-2xx.
2. **GREEN:** add `streaming/sarvam_translate.py` (beside `sarvam_asr.py`) reusing `CloudRestConfig` + the same creds resolution (platform key + BYOK). Sarvam Translate contract: `POST https://api.sarvam.ai/translate`, body `{ input, source_language_code:"auto", target_language_code:"en-IN" }` → `{ translated_text, source_language_code }`. Chunk long transcripts (~1000-char limit) and rejoin.
3. Internal endpoint `POST /internal/translate` (new `translate/api/routes.py`, `X-Service-Token` gated, registered in `main.py`): body `{ texts: string[], target_language?: "en-IN", tenantId? }` → `{ translations: string[] }` (order-preserving). Resolves per-tenant Sarvam creds the same way STT transcription does. Batch so the gateway sends all segments in one call.
4. **Verify:** `pnpm stt:test` (unit), `pnpm py:… lint/typecheck` (ruff/mypy) — hermetic (mock httpx), no live Sarvam.

### Phase 2 — Gateway: flag + translate-before-summarize (`apps/api`)
1. **RED:** smr-compat controller tests — with `translate_to_english:true`, the transcript sent into `buildSummaryPrompt` is the STT-translated text; STT failure ⇒ original text used (fail-open) and a warning logged; flag false/absent ⇒ no STT call.
2. **GREEN:** add optional `translate_to_english?: boolean` to `SyncSummaryRequest`. New `stt-translate.client.ts` (resolve `STT_URL` via `IConfigService`, attach `X-Service-Token` from `SecretsService`, `POST /internal/translate`). In `computeSummary`/`streamSummary`: when the flag is set, translate `session_data.conversation_segments[].text` (batch) and swap the translated text into the session data passed to `prepareSummary`; wrap in try/catch → fail-open. Register the client in `SmrCompatModule`.
3. **Verify:** `pnpm api:build`, `pnpm test:unit`.

### Phase 3 — SDK compat sends the flag (`packages/agentic-sdk-v2`)
1. **RED:** `useSMR` test — `summarizeSync` wire body includes `translate_to_english:true` when set, omitted otherwise.
2. **GREEN:** add `translateToEnglish?: boolean` to `SMRRequest`; emit top-level `translate_to_english` in `buildSyncPayload` (sync + async + stream).
3. **Verify:** `pnpm --filter @arcaai/vox build test`.

### Phase 4 — Playground toggle (`apps/compat-playground`)
1. **RED:** `SummaryCard` test — a "Translate transcript to English (Sarvam)" `Switch` passes `translateToEnglish` into `summarizeSync`.
2. **GREEN:** add the toggle next to Enhanced/Stream; thread `translateToEnglish` into the summarize call (persist in config).
3. **Verify:** `pnpm --filter @arcaai/compat-playground build lint test`.

### Phase 5 — Runtime verification
- Browser/curl A/B on the summary endpoint: a Malayalam/Hindi transcript with `translate_to_english:true` → English summary; with false → untranslated path. Confirm fail-open when Sarvam key is unset.

## Files (create/modify) — provisional
- `apps/stt/src/stt/streaming/sarvam_translate.py` (new) + `apps/stt/src/stt/translate/api/routes.py` (new) + `main.py` (register) + tests
- `apps/api/src/modules/smr-compat/{dto/sync-summary.request.ts, stt-translate.client.ts (new), smr-compat.controller.ts, smr-compat.module.ts}` + tests
- `packages/agentic-sdk-v2/src/compat/{types.ts, useSMR.ts}` + test
- `apps/compat-playground/src/components/{SummaryCard.tsx, summarization/…}` + test
- `turbo.json#globalEnv` / `.env.sample`: only if a new env var is needed (none expected — reuse `SARVAM_API_KEY` already in STT)

## Verification Criteria (definition of done)
- [ ] `pnpm stt:test` + ruff/mypy green (translation unit + endpoint)
- [ ] `pnpm api:build` + `pnpm test:unit` green (flag + fail-open)
- [ ] `pnpm --filter @arcaai/vox build test` green (wire flag)
- [ ] `pnpm --filter @arcaai/compat-playground build lint test` green (toggle)
- [ ] Runtime A/B: non-English transcript → English summary when flag on; fail-open verified

## Follow-up observation (out of scope for TASK-600)
- The BYOK-only principle (T8) also applies to **STT** and **TTS** Sarvam, but those still have **env-var credential fallbacks** from earlier work: `apps/stt` `SARVAM_API_KEY` (via `sarvam_loader.py` → `settings.sarvam_api_key`) and `apps/tts` `TTS_SARVAM_API_KEY`. Migrating them to BYOK-only (drop the env fallback; resolve via the provider plane) is a separate cleanup ticket — flagged, not changed here.

## Open questions / risks
- **Confirm STT-hosted vs gateway-direct** translation (recommended STT-hosted per T2).
- Sarvam Translate per-call char limit / model params (e.g. `mayura:v1`, `speaker_gender`, `mode`) — confirm current API when implementing; chunk long transcripts.
- Latency: translation adds a gateway→STT→Sarvam hop before summarization (acceptable; only when flag on).

## Implementation Summary

### Phase 1 — STT translation capability + internal endpoint ✅ (2026-08-02)
- `apps/stt/src/stt/streaming/sarvam_translate.py` (new): `sarvam_translate_text` / `sarvam_translate_texts` — plain `httpx` POST to `{base}/translate` with `api-subscription-key`, `source_language_code:"auto"` → `target_language_code`, whitespace-boundary chunking for long input, blank-passthrough, bounded-concurrency batch, `SarvamTranslateError` on failure. No metrics emitted (consumption owned elsewhere).
- `apps/stt/src/stt/translation/api/{routes.py,schemas.py}` (new): `POST /internal/translate` (registered in `main.py`), resolves Sarvam creds via `resolve_override_key` + `settings.sarvam_api_key`/`sarvam_base_url` (BYOK-first, same order as `SarvamLoader`); 503 when no key, 502 on Sarvam failure. Response includes `translations`, `provider`, `chars` (courtesy consumption hook). Headerless-auth posture matching existing STT `/internal/*`.
- Tests: `tests/unit/streaming/test_sarvam_translate.py` (7) + `tests/unit/translation/test_translate_routes.py` (4). Evidence: 11 passed; ruff clean.

### Phase 2 — Gateway flag + translate-before-summarize ✅ (2026-08-02)
- `dto/sync-summary.request.ts`: optional `translate_to_english` (summary only).
- `smr-compat.controller.ts`: `@Optional() ITenantSttConfigService` injected; `maybeTranslateBody(body, tenantId)` — when the flag is set, POST transcript segment texts to STT `/internal/translate` (with `resolveProviderOverrides(tenantId)` BYOK), swap translated text into a cloned `session_data`, feed to `prepareSummary`. FAIL-OPEN: any error → warn + original transcript. Wired into `computeSummary` + `streamSummary`; no `doctor_id`/dept resolution changed.
- `smr-compat.module.ts`: imports `TenantSttConfigServiceModule`.
- Tests: controller +3 (translate / fail-open / flag-absent). Evidence: smr-compat suites green (builder 18, controller 44); `pnpm api:build` 8/8; eslint clean.

### Phase 3 — SDK compat sends the flag ✅ (2026-08-02, agent)
- `src/compat/types.ts`: `SMRRequest.translateToEnglish?: boolean`. `src/compat/useSMR.ts`: `buildSyncPayload` emits top-level `translate_to_english: true` (summary sync/async/stream) only when set; omitted otherwise. Pre-summary untouched. Tests +2. Evidence: `@arcaai/vox` 3823 tests, typecheck clean.

### Phase 4 — Playground toggle ✅ (2026-08-02, agent)
- `SummaryCard.tsx`: "Translate transcript to English (Sarvam)" `Switch`, state seeded/persisted via `config.translateToEnglish`, passed as `translateToEnglish` into `summarizeSync` (not pre-summary). `config-store.ts`: `PlaygroundConfig.translateToEnglish?`. Tests +2; rebuilt `@arcaai/vox` dist (stale-dist gotcha). Evidence: `@arcaai/compat-playground` 205 tests, build/lint/typecheck clean.

### Phase 5 — Runtime verification ⏳ OWNER-RUNNABLE (deferred, with reason)
- Not run this session because: (1) **no `SARVAM_API_KEY` is configured in `.env.dev`** (declared in `turbo.json#globalEnv` only) — a live call would 503 → gateway fail-opens → untranslated, so it can't demonstrate real translation; and (2) it requires restarting BOTH the API (to load Phase 2) and STT (to expose `/internal/translate`), which are dev-stack-managed. To verify: set a real `SARVAM_API_KEY`, restart `api` + `stt`, then A/B a Malayalam/Hindi transcript with `translate_to_english:true` vs false (and confirm fail-open when the key is unset). All four layers are unit-tested + build-green in the meantime.

- **T8 — BYOK-ONLY, NO ENV CREDENTIAL (owner, 2026-08-02):** Sarvam (translate AND STT) is a BYOK provider — its credential is NEVER an environment variable. The global admin brings up the platform key (a SYSTEM-tenant provider-connection row) and tenant admins bring their own; both come from the unified provider plane. SMR reads NO `SMR_SARVAM_API_KEY`; the api_key arrives only via the request `provider_overrides`. The gateway resolves it by cascading **tenant → SYSTEM (global admin)** from the plane (`resolveTenantCloudOverrides('stt', tenantId)` then `(…, SYSTEM_TENANT_ID)`), decrypted. No key resolves ⇒ no override sent ⇒ SMR 503 ⇒ fail-open (no translation). Only non-secret `SMR_SARVAM_BASE_URL`/`SMR_SARVAM_MODEL` remain as env.

## Rework (T7 + T8) — Sarvam translation in SMR, BYOK-only

- **STT revert ✅**: deleted `streaming/sarvam_translate.py`, `translation/` (endpoint+schemas), the two STT tests, and the `main.py` registration — STT is transcription-only again. `main.py` parses clean; no dangling refs.
- **Gateway repoint ✅**: `smr-compat.controller.ts` `maybeTranslateBody` now POSTs to `{SMR_URL}/api/v1/translate` with `getForwardHeaders()` (SMR `X-Service-Token`). `resolveSarvamByok(tenantId)` cascades **tenant → SYSTEM (global admin)** via `IProviderConnectionService.resolveTenantCloudOverrides('stt', …)` (decrypted), forwarding only the `{sarvam}` entry as `provider_overrides`; **no env credential**. Module swaps `TenantSttConfigServiceModule` → `AiProviderConnectionServiceModule`; imports `SYSTEM_TENANT_ID` from `@arcaai/domains`. Fail-open unchanged. Tests updated (45 pass incl. SYSTEM-fallback); `api:build` 8/8, eslint clean.
- **SMR translate capability ✅**: `core/config.py` `SarvamConfig` (`SMR_SARVAM_` prefix) + root `Settings.sarvam`; new `translation/` package (`TranslateProvider` Protocol + `TranslateProviderRegistry` + `SarvamTranslateProvider`; errors `SarvamTranslateError`/`SarvamCredentialError`); `models/translate.py` (`TranslateRequest`/`TranslateResponse`, reuses `ProviderOverride`); `api/endpoints/translate.py` `POST /api/v1/translate` (404 unknown provider / 502 translate fail / 503 missing key); `core/dependencies.py` `get_translate_registry`; `main.py` registers the Sarvam factory (BYO-first, unconditional) + `app.state.translate_registry` + router. **BYOK-ONLY (T8):** `SarvamConfig` has NO `api_key` field/env; the key comes ONLY from `provider_overrides[provider]` (per-request) — absent ⇒ `SarvamCredentialError` → 503. `base_url`/`model` fall back to non-secret config. Key is `SecretStr`, never logged. Behind `X-Service-Token`. Tests: 20 (provider incl. no-override/empty-key→credential-error + no-network-call-when-missing, + endpoint) + 38 regression; ruff + mypy clean. Wire contract matches the gateway exactly.
- **Env**: added `SMR_SARVAM_API_KEY`/`SMR_SARVAM_BASE_URL`/`SMR_SARVAM_MODEL` to `turbo.json#globalEnv`.
- **Unchanged**: Phase 3 (SDK flag) + Phase 4 (playground toggle) — wire-level, backend-agnostic.

## Change History
- 2026-08-02 — Ticket created; plan drafted; decisions T1–T6 recorded (T5 consumption capture OUT — separate agent).
- 2026-08-02 — Phase 1 (STT Sarvam translation + /internal/translate) and Phase 2 (gateway flag + fail-open translate-before-summarize) implemented TDD + verified.
- 2026-08-02 — Phases 3 (useSMR sends translate_to_english) + 4 (playground toggle) done. All layers unit-tested + build-green. Phase 5 live run deferred to owner (no Sarvam key in dev + needs api/stt restart). Status: Review (uncommitted).
- 2026-08-02 — REWORK (T7): moved Sarvam translation from STT into SMR (SMR = text-generative router). STT reverted to transcription-only; new SMR `/api/v1/translate` capability (`TranslateProvider` registry + Sarvam provider, `SMR_SARVAM_` config, BYOK via `provider_overrides`); gateway repointed to SMR with unified-plane BYOK (`resolveTenantCloudOverrides('stt','sarvam')`). SDK/playground unchanged. Evidence: SMR 17+38 tests ruff/mypy clean; gateway 44 tests + api:build 8/8 + eslint clean; STT revert clean (21-test nearby suite green). Status: Review (uncommitted).
