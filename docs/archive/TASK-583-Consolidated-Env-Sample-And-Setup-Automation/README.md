# TASK-583 — Consolidated `.env.sample` + Auto-Generated Local Dev/Test Env Files + Env Reference Docs

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | infrastructure (tooling) + docs |
| **Branch** | `thuynh/2607` |
| **Owner** | Tap Huynh |
| **Created** | 2026-07-29 |
| **Related** | TASK-582 (Python Service Env Template Hygiene — cleaned up content; this ticket fixes the mechanics), TASK-558 (Environment Configuration Refactor — established the `.env.dev` gitignored/generated model this ticket extends to `.env.test`) |

## Requirement Analysis

Follow-up to TASK-582. That pass fixed the *content* of every `.env*` file but not the *mechanics*:
- `.env.dev` requires a manual `cp .env.example .env.dev` step (`docs/development-guide.md:39-43`) not automated by `pnpm setup:dev`.
- `.env.test` is a git-tracked file that `scripts/test-setup.sh` mutates in place with real local Vault AppRole credentials — the exact incident found three times during TASK-582 verification.

Owner request: one consolidated placeholder-only sample file for dev+test; `pnpm setup:dev`/`pnpm setup:test` auto-create the real per-environment file from it; document which vars are provider/model defaults or fallbacks; produce a dedicated reference doc for engineers setting up local dev/test.

## Current State Evaluation

- **CI never reads `.env.test`, tracked or not** — confirmed by direct code reading: `packages/applications/src/common/env/env-file-resolution.ts:25-26` and `packages/py-env/src/hope_env/__init__.py:22-23` both skip file-loading entirely whenever `CI` is truthy, and GitLab CI sets `CI=true` by default. Untracking `.env.test` has zero CI impact.
- `.env.dev` is already gitignored (TASK-558) but nothing creates it automatically; the guide instructs a manual `cp`.
- `.env.test` is tracked, and `scripts/test-setup.sh` (`set_env` upsert helper) writes real Vault AppRole `role_id`/`secret_id` into it whenever Vault-backed local test runs happen — this is by design (its own header calls it "the test counterpart to dev-setup's `refresh-vault-creds.sh` step"), but the target file being *tracked* is the mismatch.
- `docs/development-guide.md` exists (320 lines) with a "First-time setup" (§3) and "Testing" (§8) section that need updating once the mechanics change.

## Owner decisions (confirmed via AskUserQuestion, 2026-07-29)

1. **Untrack `.env.test`** — becomes gitignored + generated, matching `.env.dev`'s model. `.env.sample` becomes the only tracked artifact.
2. **`.env.sample` merges everything** — root + `apps/api` + `apps/admin-console` + `packages/tools` + all 6 Python services into one file, diverging deliberately from TASK-558's "one `.env.example` per deployable" principle for setup-convenience. Per-service `.env.example` files stay as-is.

## Implementation Plan

1. **`.env.sample`** (new, tracked, root) — concatenation of all 10 current example files under clear section banners, dev-shaped default values, `<CHANGE_ME>` placeholders preserved.
2. **`scripts/generate-env-file.sh`** (new) — `ensure_env_file <target> <mode>`: no-op if target exists; otherwise copy `.env.sample` → target, and for `mode=test` apply the known dev→test overrides (DEV+100 ports, isolated test-infra endpoints, `NODE_ENV=test`, `CI=false`, `RATE_LIMIT_ENABLED=false`, test-only fake secrets) via the same upsert pattern already in `test-setup.sh`.
3. **Wire in**: `dev-setup.sh` gets a new Step 0 calling `ensure_env_file .env.dev dev`; `test-setup.sh`'s hard "file must already exist" gate becomes `ensure_env_file .env.test test`.
4. **`.gitignore`**: drop the `!.env.test` negation, add `!.env.sample`; `git rm --cached .env.test`.
5. **`docs/development-guide.md`**: update §3 (auto-created `.env.dev`), §8 (auto-created `.env.test`), §13 (link new reference doc).
6. **New doc**: `docs/architecture/environment-configuration-reference.md` — how the local files come to exist, full per-service variable reference, provider/model default-and-fallback semantics (guardrail/smr/tts/stt/nlp/harness), and a var→file cross-reference table.

## Verification Criteria (Definition of Done)

- [ ] `git ls-files` shows `.env.sample` tracked, `.env.dev`/`.env.test` untracked; `git check-ignore` matches both.
- [ ] Dry-run of `ensure_env_file` against backed-up-and-removed `.env.dev`/`.env.test` produces correctly-shaped files (dev ports vs test DEV+100 ports); real local files restored from backup afterward, untouched.
- [ ] Re-running `ensure_env_file` against an existing target is a no-op (doesn't clobber real local secrets).
- [ ] `pnpm env:sync --check` still clean.
- [ ] `gitleaks protect --staged` clean.
- [ ] Nothing committed — staged only.

## Implementation Summary

All 6 plan items done. Files changed/added: `.env.sample` (new, 2247 lines, 408 distinct active keys — assembled programmatically from the 10 tracked example files, not by hand, to guarantee fidelity), `scripts/generate-env-file.sh` (new), `scripts/dev-setup.sh` + `scripts/test-setup.sh` (Step 0 added), `.gitignore` (untracked `.env.test`, allowlisted `.env.sample`), `.gitleaks.toml` (the custom `hope-committed-env-file` path rule needed `.env.sample` added to its allowlist — found during verification, see below), `docs/development-guide.md` + `scripts/README.md` (updated instructions), `docs/architecture/environment-configuration-reference.md` (new).

**A real correctness issue found and fixed during assembly, beyond the original plan**: naively concatenating the 10 source files would have produced **duplicate active keys** for bare, unprefixed names multiple services independently chose (`PORT`: root wants `8868`, `apps/nlp` wants `8864`, `apps/stt` wants its own; `OTEL_SERVICE_NAME`: three different per-service values) — exactly the "duplicate keys / silent last-wins" defect TASK-558 already found and fixed once. The assembly script de-duplicates: first occurrence stays active, later ones become commented cross-reference notes. Verified this doesn't lose correctness for the primary workflow — `scripts/dev-service.sh` already injects the correct per-service `PORT` as a shell-level override before any file is read, confirmed by reading its `ENV_REPORT` construction.

**Also found during assembly**: the root `.env.example`'s generated header still instructed the old manual `cat .env.example apps/api/.env.example ... > .env.dev` workflow this ticket replaces. Fixed at the source (`scripts/env-sync.mts`'s header-rendering function, not the generated output directly) and re-ran `pnpm env:sync` to regenerate — confirmed `env:sync --check` still clean afterward.

**Found during gitleaks verification (not anticipated in the plan)**: the repo's custom `hope-committed-env-file` gitleaks rule is a structural tripwire — any tracked `.env.<suffix>` file not on its allowlist trips on every line, filename-based, not content-based. It fired 1601 times on `.env.sample` (2247 lines) simply because the allowlist only knew about `*.example`/`.env.production`/`.env.test`. Added `.env.sample` to the allowlist and removed the now-dead `.env.test` entry (no longer tracked, so the rule can't see it in a `--staged` scan regardless).

### Verification (actual output)

- `git ls-files | grep -E '\.env\.(dev|test)$'` — empty (neither tracked); `git ls-files | grep '\.env\.sample'` — present.
- Dry-run: real local `.env.dev`/`.env.test` renamed aside (never deleted) via `mv`, `./scripts/generate-env-file.sh .env.dev dev` and `... .env.test test` run fresh — confirmed correct shape (`.env.dev` `PORT=8868`/`DATABASE_URL=<CHANGE_ME>`; `.env.test` `PORT=8968`/`DATABASE_URL=postgresql://test:test@localhost:5433/...`, both matching the intended dev-vs-test port/DB split).
- Idempotency: re-ran `ensure_env_file` against the just-created files — MD5 unchanged both times, confirmed no-op (never overwrites).
- Real local files restored from the `mv`-aside backups immediately after — line counts back to their pre-test values (`.env.dev` 506, `.env.test` 191), `JWT_SECRET_KEY` presence confirmed (content, not value, checked).
- `pnpm env:sync --check` — clean both before and after the `env-sync.mts` header fix.
- `gitleaks protect --staged --config .gitleaks.toml --no-banner --redact --verbose` — clean after the allowlist fix (`no leaks found`, scanned ~188KB).
- Nothing committed — staged only.

### Note on shared working tree

Two follow-up tasks this session's audit had spawned (`task_6198177e` STT phantom-knob, `task_1085b94f` NLP dual-flag) were started by the owner in separate local sessions during this ticket's implementation, in the same working directory (not isolated worktrees) — visible in `git status` as staged changes to `apps/nlp/src/nlp/utils.py`, `apps/nlp/tests/test_environment_flag.py`, `apps/stt/src/stt/core/config/settings.py`, `apps/stt/src/stt/streaming/session_manager.py`, `apps/stt/tests/unit/test_streaming.py`. None of those files were touched by this ticket; noted here only so a future reader doesn't mistake them for TASK-583 output when reviewing `git status`/`git diff` on this branch.

## Change History

- 2026-07-29 — Ticket created as a TASK-582 follow-up. Plan approved via Plan Mode. Status In Progress.
- 2026-07-29 — All 6 plan items implemented; verification sweep run (dry-run generation with backup/restore, idempotency check, `env:sync --check`, gitleaks). Found and fixed two items beyond the original plan (duplicate-key hazard in the assembly, stale manual-workflow instruction in the generated root example) and one unanticipated gap (gitleaks allowlist). Nothing committed — staged only. Status Review.
- 2026-07-29 — TASK-584 extended the per-service `.env.sample` naming convention this ticket introduced (root only) to every deployable, and relocated `.env.production` to per-service `.env.prod`. See `docs/implementation/TASK-584-Per-Service-Env-Sample-And-Prod-Relocation/README.md`.
