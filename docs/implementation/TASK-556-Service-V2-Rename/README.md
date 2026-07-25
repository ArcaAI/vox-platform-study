# TASK-556 — Service V2 Rename

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | refactor / infrastructure |
| **Ticket** | TASK-556 |

## Requirement Analysis

Fully rename service identity from `stt-v2` / `smr-v2` / `tts-v2` to `stt` / `smr` / `tts` across code, packages, env keys, CI/infra, rules, and docs (including archive).

### Hard constraint

**Naming-token substitution only** — replace identity tokens; do **not** rephrase, expand, or “improve” surrounding prose. No behavioral changes beyond env dual-read aliases for the transition window.

### Rename matrix (canonical targets)

| Layer | From | To |
|---|---|---|
| App dirs | `apps/stt-v2`, `apps/tts-v2` | `apps/stt`, `apps/tts` (`apps/smr` already correct) |
| uv / pyproject name | `stt-v2`, `smr-v2`, `tts-v2` | `stt`, `smr`, `tts` |
| Python import pkgs | `stt_v2`, `smr_v2`, `tts_v2` | `stt`, `smr`, `tts` |
| Console scripts | `stt-v2`, `stt-v2-worker` | `stt`, `stt-worker` |
| pnpm aliases | `dev:stt-v2`, `py:smr-v2:*`, `test:stt-v2:up`, … | `dev:stt`, `py:smr:*`, `test:stt:up`, … |
| Scripts | `start-test-stt-v2.sh`, `start-test-smr-v2.sh` | `start-test-stt.sh`, `start-test-smr.sh` |
| Gateway env | `STT_V2_URL` (+ host/port/log) | `STT_URL` (+ `STT_HOST`/`STT_PORT`/`STT_LOG_LEVEL`) |
| SMR Python env prefix | `SMR_V2_*` | `SMR_*` (align with gateway `SMR_URL` / avoid double `SMR_SMR_`) |
| Public WS paths | `/ws/stt-v2/stream`, `/ws/tts-v2/stream` | `/ws/stt/stream`, `/ws/tts/stream` |
| SDK | `SttV2WebSocketClient`, `STT_V2_ENDPOINTS`, `types/stt-v2.ts` | `SttWebSocketClient`, `STT_ENDPOINTS`, `types/stt.ts` |
| Effective-config / internal ids | `'stt-v2'`, `'tts-v2'` | `'stt'`, `'tts'` (SMR already `'smr'`) |
| CI jobs / images | `test-stt-v2`, `stt-v2-ml-runtime`, `stt-v2-worker`, … | `test-stt`, `stt-ml-runtime`, `stt-worker`, … |
| Metrics / Grafana | `stt_v2_*`, `smr_v2_*`, dashboards `smr-v2-*.json` | `stt_*`, `smr_*`, `smr-*.json` (TTS metrics already `tts_*`) |
| OTEL / app_name | `stt-v2`, `smr-v2`, `tts-v2` | `stt`, `smr`, `tts` |

Do **not** confuse with unrelated bare names: `packages/stt/` (browser), Nest `packages/applications/.../services/stt/`, npm package `agentic-sdk-v2` (SDK major, not the Python service).

## Current State Evaluation

Wave 0 + Wave 1 completed (dir moves, Python/TS/scripts/CI/docs token substitution). Wave 2 integrated leftovers and verified.

## Implementation Plan

1. Wave 0 (sequential): README + `git mv` + root pyproject/uv.lock
2. Wave 1 (parallel agents): Python apps, Nest/ESLint/env, SDK, applications, scripts/pnpm, CI/Grafana, rules/docs
3. Wave 2: leftover sweep, dual-read consistency, verify, Implementation Summary

## Implementation Summary

Wave 2 integrate + verify completed. Service identity tokens are consistently `stt` / `smr` / `tts` on disk; remaining old tokens are intentional dual-read allowlist only (see below).

### Wave 2 fixes (high level)

- `packages/stt/` (browser): `/ws/stt/stream`, `SttWebSocketClient` in provider + tests
- Nest `InternalServiceTokenGuard`: `smr` → `SMR_SERVICE_TOKEN` (aligned with Python `SMR_` + Vault seed); e2e dual-reads `E2E_SMR_SERVICE_TOKEN` / `E2E_SMR_V2_SERVICE_TOKEN`
- Root `.env.example` / `.env.dev` / `.env.production` + `turbo.json`: `SMR_V2_*` → `SMR_*`
- `packages/domains` `IAppConfig`: confirmed `STT_URL`; `IConfigService.AppConfig` simplified to `IAppConfig`
- API docs / comments: `SttV2*` → `Stt*`
- Removed local gitignored `*_v2.egg-info` under `apps/stt/src` and `apps/smr/src`

### Intentional dual-read allowlist (temporary)

| Area | Tokens kept |
|---|---|
| Nest / applications config | `STT_URL \|\| STT_V2_URL` |
| ESLint denylist + tests | bans `STT_V2_URL` during dual-read window |
| STT Python settings | `AliasChoices(..., STT_V2_MODEL_S3_*)` |
| SMR Python settings | `AliasChoices` / `_promote_legacy_smr_v2_env` for `SMR_V2_*` |
| E2E model-retention | `E2E_SMR_SERVICE_TOKEN ?? E2E_SMR_V2_SERVICE_TOKEN` |

### Operator follow-up (out of repo)

External `hope-deployments` Helm/ArgoCD image and service names still need updating for staging/prod (`stt-v2` → `stt`, etc.) before deploy jobs succeed against renamed CI images.

### Verification evidence (Wave 2)

```
# Import smoke (conda arcaenv)
OK stt smr tts

# SMR unit subset
30 passed in 3.45s

# STT unit (test_settings.py, PYTHONPATH=apps/stt/src)
31 passed in 2.32s

# Vitest: SttWebSocketClient + packages/stt streaming + InternalServiceTokenGuard
Test Files  4 passed (4)
Tests  139 passed (139)

# ESLint RuleTester
node packages/eslint-plugin-arcaai-internal/__tests__/no-direct-downstream-url-env.test.js
(exit 0)
```

Final on-disk `rg` (excluding `node_modules`, `.git`, `uv.lock`, `coverage-report.json`, `*egg-info*`): zero non-allowlist hits.

## Change History

| Date | Change |
|---|---|
| 2026-07-25 | Created ticket; Wave 0 started (dir moves + uv package rename) |
| 2026-07-25 | Wave 1 parallel agents completed (Python/TS/scripts/CI/docs) |
| 2026-07-25 | Wave 2 integrate+verify: packages/stt WS/SDK sync, Nest/e2e `SMR_SERVICE_TOKEN`, root env/turbo `SMR_*`, dual-read allowlist documented; status → Review |
