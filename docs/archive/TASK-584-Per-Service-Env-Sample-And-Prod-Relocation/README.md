# TASK-584 — Per-Service `.env.sample` Naming + Per-Service Production Reference Relocation

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | infrastructure (naming/location consistency) + docs |
| **Branch** | `thuynh/2607` |
| **Owner** | Tap Huynh |
| **Created** | 2026-07-29 |
| **Related** | TASK-583 (introduced the root consolidated `.env.sample`), TASK-582 (Python service env content audit), TASK-558 (original env architecture — `ENV_FILE_MAP` loader contract, unchanged by this ticket) |

## Requirement Analysis

Two naming/location follow-ups, explicitly **not** a loader-behavior change (confirmed via AskUserQuestion):

1. Every service should have its own example file literally named `.env.sample` (not `.env.example`), matching the root consolidated file from TASK-583.
2. Production reference templates should live at each service's own root as `.env.prod`, not at the monorepo root as `.env.production`.

Owner explicitly declined the alternative (production actually loading a file at boot) — production stays host-env-only. This is purely: rename/relocate tracked reference files, rebuild the derived artifacts, update documentation.

## Current State Evaluation

- **Confirmed by reading the code, not assumed**: `packages/applications/src/common/env/env-file-resolution.ts:102-105` (`shouldLoadEnvFile()`) returns `false` whenever `NODE_ENV==='production'`, checked *before* `ENV_FILE_MAP` (`:70-75`) is ever used to open a file. The `production: '.env.production'` map entry is a lookup-table value that is **never dereferenced for file I/O in production**. This file, `packages/database/src/env.ts`, `packages/database/src/client.ts`, the settings-registry descriptors, and any `.test.ts` files are explicitly **not touched** by this ticket.
- Root has two distinct existing tracked files that must not collide: `.env.example` (generated bootstrap floor, TASK-558) and `.env.sample` (hand-assembled consolidation, TASK-583). "Each service" scopes to the 8 individual deployables (`apps/api`, `apps/admin-console`, `packages/tools`, 6 Python services) — the root bootstrap floor is not itself "a service" and keeps its name.
- Production reference files today: root `.env.production` (166 lines, mixed content spanning gateway infra + `GUARDRAIL_VLLM_*`/`SMR_VLLM_*`/`HARNESS_JUDGE_*` engine configs + shared `AZURE_SPEECH_*`) plus 4 pre-existing per-service files (`apps/{api,nlp,smr,stt}/.env.production`); `guardrail`, `harness`, `tts`, `admin-console` have none yet.

## Implementation Plan

**Part A — `.env.example` → `.env.sample` per service:**
1. `scripts/env-sync.mts` — rename the 3 TS-generated per-app targets (`apps/api`, `apps/admin-console`, `packages/tools`); root bootstrap floor stays `.env.example`. Re-run `pnpm env:sync`, remove orphaned old-path files.
2. `git mv` the 6 Python services' `.env.example` → `.env.sample`.
3. Rebuild root `.env.sample` (TASK-583's assembly script) from the renamed sources.
4. Reference sweep across living docs (skip archived/historical tickets).

**Part B — `.env.production` → per-service `.env.prod`, no loader change:**
1. `git mv` the 4 existing per-service files.
2. Distribute root `.env.production`'s content: gateway-scoped → `apps/api/.env.prod` (merged alongside its existing systemd/Vault-AppRole content as a second labeled section); `SMR_VLLM_*`/`SMR_LLAMA_CPP_*` → `apps/smr/.env.prod`; new `apps/guardrail/.env.prod` (`GUARDRAIL_VLLM_*`/`GUARDRAIL_LLAMA_CPP_*`); new `apps/harness/.env.prod` (`HARNESS_JUDGE_*`); new `apps/tts/.env.prod` (shared `AZURE_SPEECH_*`).
3. `git rm` root `.env.production`.
4. `.gitignore` / `.gitleaks.toml` updated for the new filename.
5. Reference sweep across living docs.

## Verification Criteria (Definition of Done)

- [ ] `git ls-files | grep -E '\.env\.(example|production)$'` — only root `.env.example` remains.
- [ ] `git ls-files | grep -E '\.env\.(sample|prod)$'` — one `.env.sample` per of 8 deployables + root; one `.env.prod` per of 6 Python-adjacent services with a production posture (api/nlp/smr/stt/guardrail/harness/tts = 7, admin-console excluded — no production file existed for it before, not introduced here).
- [ ] `pnpm env:sync --check` clean.
- [ ] `gitleaks protect --staged` clean.
- [ ] Root `.env.sample` re-assembles with zero active duplicate keys.
- [ ] Nothing committed — staged only.

## Implementation Summary

Both parts done. **Part A**: `scripts/env-sync.mts` now generates `apps/api/.env.sample`, `apps/admin-console/.env.sample`, `packages/tools/.env.sample` (root bootstrap floor unchanged at `.env.example`); the 6 Python services' files were `git mv`'d; root `.env.sample` rebuilt from the renamed sources (2210 lines, 408 distinct active keys, zero duplicates). **Part B**: the 4 existing `apps/{api,nlp,smr,stt}/.env.production` were `git mv`'d to `.env.prod`; root `.env.production` (166 lines) was fully distributed — gateway-scoped content merged into `apps/api/.env.prod` as a second labeled section alongside its existing systemd/Vault-AppRole content, `SMR_VLLM_*`/`SMR_LLAMA_CPP_*` into `apps/smr/.env.prod`, new `apps/guardrail/.env.prod` (`GUARDRAIL_VLLM_*`/`LLAMA_CPP_*`), new `apps/harness/.env.prod` (`HARNESS_JUDGE_*`), new `apps/tts/.env.prod` + addition to `apps/stt/.env.prod` (shared `AZURE_SPEECH_*`) — then root `.env.production` removed. `.gitignore`/`.gitleaks.toml` updated for the new filenames.

**Confirmed, not assumed**: no loader/runtime behavior change — `env-file-resolution.ts`'s `shouldLoadEnvFile()` still returns `false` for `NODE_ENV=production` before `ENV_FILE_MAP` is ever dereferenced; that file, `packages/database/src/{env,client}.ts`, the settings-registry descriptors, and their tests were not touched.

**Two real correctness issues found and fixed beyond the plan**, both in the reference sweep:
1. Merging `apps/api/.env.prod`'s two postures created duplicate active keys for `PORT`/service URLs/`REDIS_HOST`/`LOG_LEVEL`/`OTEL_*`/`API_KEY_*` — resolved by keeping the K8s-posture (§1) values active and cross-referencing them from the systemd-posture (§2) section instead of re-declaring.
2. That same merge broke two existing tests: `secrets-migration.test.ts`'s loose regexes (`/^SESSION_SECRET_KEY=.+/m`) treated the K8s section's `KEY=    # inline comment` style as an inlined secret — tightened to `/^SESSION_SECRET_KEY=\S/m` (requires a non-whitespace char immediately after `=`); a masked example connection string (`postgres://hope_app:****@...`) in a code comment tripped the "no DB password" check — added a negative lookahead excluding all-asterisk placeholders specifically (still catches a real leaked password).

**Also found and fixed**: `git rm` on 3 files in one command aborted atomically when one (`apps/api/.env.example`) had staged changes differing from HEAD, silently leaving `apps/admin-console/.env.example` and `packages/tools/.env.example` still tracked after the "successful" rename step — caught during the final verification inventory, not assumed clean.

Reference sweep touched ~35 living docs/scripts/tests across both renames (dev guide, scripts/README, `.claude/rules/*`, per-service READMEs and deployment guides, Vault runbooks, CI config, `infrastructure/single-deployment/**`) — historical/archived tickets and `docs/research/**`/`docs/archive/**` were deliberately left alone, consistent with TASK-582/583's established scope discipline.

### Verification (actual output)

- `git ls-files | grep -E '\.env\.(example|production)$'` — only root `.env.example` plus out-of-scope files (`apps/example`, `apps/ui-playground`, `docs/archive`, `docs/research`, `packages/database/tests/pgbouncer-validation` — none renamed by design).
- `git ls-files | grep '\.env\.sample$'` — 9 files (root + 8 deployables). `git ls-files | grep '\.env\.prod$'` — 7 files (api/guardrail/harness/nlp/smr/stt/tts).
- `pnpm env:sync --check` — clean (144 keys, 6 artifacts match).
- Full touched-test run: `env-sync.test.ts` (23), `env-port-standardization.test.ts` (85), `secrets-migration.test.ts` (8), `stt-v1-config-removal.test.ts` (19), `harness-service-token-seed.test.ts` (3) — **138 passed, 0 failed**.
- `gitleaks protect --staged --config .gitleaks.toml --no-banner --redact --verbose` — clean (`no leaks found`, scanned ~221KB).
- Nothing committed — staged only.

## Change History

- 2026-07-29 — Ticket created as a TASK-582/583 follow-up. Plan approved via Plan Mode. Status In Progress.
- 2026-07-29 — Both parts implemented; full verification sweep green (138 tests, env:sync --check, gitleaks). Found and fixed two real correctness issues beyond the plan (duplicate-key hazard in the apps/api/.env.prod merge, two tests broken by that merge) and one process gap (an atomic `git rm` failure that silently left 2 files un-renamed, caught by the final inventory check rather than assumed). Nothing committed — staged only. Status Review.
