# HOPE API debug — post-fresh-pull investigation (agent console log)

**Date:** 2026-11-16
**Workspace:** `/Users/apple/repos/VOX`
**Task:** User reports that "some commands" in `review/alaaSv3/debug-hope-api-gateway-step-by-step.md` no longer run after a fresh pull of a newer `project-hope` version.
**Scope constraints from user:**
- Focus on **API debugging only** — ignore running the ALaaS client (`audio-stream-svc`, `web_ui`, `mmr_agent`).
- **Do NOT make any changes to the `project-hope` repo** (no source/config edits).
- Write any instructions/steps to `review/alaaSv3/`.
- Log the agent console (this file) and the investigation consoles.

**Log destinations chosen (directory mandated by user; filenames by agent convention):**
- Agent console: `review/alaaSv3/agent_log/20261116-api-debug-investigation.md` (this file)
- Investigation console: `review/alaaSv3/investigate_console_20261116.log`

---

## Actions taken (investigation phase — read-only only)

1. Read the debug guide and the existing agent log (`20261114-alaas-hope-debug-session.md`) to learn the established logging convention (`agent_log/` for agent console, dated `deploy_console_*.log` for terminal output).
2. Verified `project-hope` git state: branch `main`, HEAD `b1929a98f` (2026-11-15), only untracked files (no local source modifications). Fresh pull brought in newer task work (TASK-707/933/1020/1102/1143/1171, bug-069, etc.).
3. Ran read-only diagnostics (ports, docker ps, package.json scripts, `.vscode/launch.json`, `.env.dev` key presence, route decorators, DTOs). All output appended to `review/alaaSv3/investigate_console_20261116.log`.

### Runtime snapshot at investigation time
- **Listening:** 6379 (hope-redis), 8200 (hope-vault), 5432 (hope-postgres) via Docker; **8861 STT** running (`python3.1`, PID 45687). **8868 API and 9229 inspector are NOT listening** (API not running).
- **Docker up:** hope-postgres/redis/vault/qdrant/minio/temporal/temporal-ui/reranker, plus alaas-dev-postgres (5433) and alaas-dev-redis (6380). (ALaaS stores left alone per scope.)

### Findings — things in the guide that changed / are now broken

| # | Guide reference | Finding after fresh pull | Severity |
|---|---|---|---|
| 1 | §5 step 4 — select **`Attach: HOPE API (9229)`** in VS Code | `project-hope/.vscode/launch.json` is a tracked file and was reverted by the pull. It now contains ONLY a `Text` debugpy config. The `Attach: HOPE API (9229)` config the user had added locally is GONE. | **Break** |
| 2 | §3.5 / §8 — `pnpm dev:doctor` | Root `package.json` has **no** `dev:doctor` script. Correct script is `pnpm stack:dev:doctor` (`./scripts/dev-doctor.sh`). | **Break** |
| 3 | §4 breakpoint line numbers (`open` ~744, `getById` ~817, `update` ~959, `close` ~1266, etc.) | Files grew substantially. Current method lines: `open` 820, `getById` 928, `update` 1196, `close` 1497, `reopen` 1553, `addContext` 1963, `getContextItems` 1980. Routes are now declared through a custom `@ApiEndpoint({ method, path })` decorator instead of `@Post('open')` / `@Get(':id')`. Streaming controller routes largely intact (`stream/session`, `refresh-ticket`, `switch-to-*`, `language-modes`). | **Stale** |
| 4 | §6.1B — `POST /api/v1/auth/service-token` | Route still exists, but implementation moved to `apps/api/src/modules/service-account/service-account-token.controller.ts` (`@Controller('auth')` + `@Post('service-token')`). Endpoint string unchanged. A bootstrap audit now asserts the route is registered. | OK (note) |
| 5 | §2.1 env checks | `.env.dev` is untracked and survived; all checked keys present (`HF_HOME=/Users/apple/.cache/huggingface`, DB/Redis/Vault/JWT). | OK |
| 6 | §3.3 `HF_HOME=... pnpm stt:dev` | `stt:dev` is now `./scripts/dev-service.sh stt` (port via `STT_PORT`, default 8861). STT currently already running. | OK (note) |
| 7 | §6.1C `pnpm -s gen:token -u super_admin -e 24h -p` | Now `pnpm --filter @arcaai/tools gen-dev-token`; `-u/-e/-p` flags still supported in source; seeded username still `super_admin`. | OK |
| 8 | §6.2 `POST /consultations/open` with `{"patientId","context":{}}` | DTO still requires only `patientId`; rest optional. But service-side department/workflow/template resolution (TASK-1102) can now return `DEPARTMENT_REQUIRED`, `TEMPLATE_NOT_SELECTABLE`, etc. Needs live verification. | Verify |
| 9 | §1.1 `pkill` patterns | Still match the current dev command (`nest start --debug 127.0.0.1:9229 --watch` via `apps/api` `dev` script); API inspector host/port is configurable via `API_INSPECT_HOSTPORT`. | OK |

### Not yet verified (requires running commands)
- Whether `pnpm api:dev` boots cleanly on the new version (new bootstrap audits for service-account surface / api-key scopes can refuse to start).
- Whether `login` / `service-token` / consultation / stream-session curl calls still return expected shapes.
- Which exact command(s) the user hit first (user said "some commands" without naming them).

## Execution phase (user approved "verify all", "run and log")

### STEP A — first `pnpm api:dev` attempt: FAILED
- API never listened on 8868/9229. TypeScript build reported **366 errors** (e.g. `TS2305 Module '"@arcaai/applications"' has no exported member 'RecordingBackfillService'`, `recordGovernedRunWaiting` missing, `enterGuardrailHold` signature change).
- Root cause: `packages/applications/dist` was **stale** after the fresh pull (export existed in `src`, absent in `dist`). The guide has no step to rebuild workspace packages after a pull.

### STEP B — fix (no repo edits): `pnpm build:packages`
- `turbo run build --filter=./packages/*` → **18/18 tasks successful** (also ran `prisma generate` + index generation).

### STEP C — retry `pnpm api:dev`: SUCCESS
- Health `200` on `:8868`; inspector listening on `127.0.0.1:9229`; **0 TS errors**. Version `0.0.0-main.b1929a98`.

### STEP D/F — curl verification
| Call | Result | Cause / note |
|---|---|---|
| `GET /api/v1/health` | 200 | OK |
| `POST /auth/login` without tenantKey | 200 | Token has `tenantId: ""` → all tenant-scoped calls return `400 Tenant ID is required`. **Guide's login body is now insufficient.** |
| `POST /auth/login` **with `tenantKey: "ARCAAI"`** | 200 | Correct; token carries tenant. Seeded key confirmed in `seed/05-tenant.ts`. |
| `GET /consultations/workflows` (tenant JWT) | 200 | OK |
| `POST /auth/service-token` (creds read read-only from ALaaS .env) | 200 | Endpoint still valid |
| `pnpm -s gen:token -u super_admin -e 24h -p` | 0 | Still works |
| `POST /consultations/open` `{"patientId","context":{}}` | 404 | Generic `Resource not found`; likely downstream of stale DB schema — needs re-test after schema sync |
| `GET /audio/transcription-jobs/language-modes` | 400 `P2022` | Prisma error: column `t0.limitedToPlans` does not exist. Also `aiProviderConnection.providerType`, `workflowAssignment.isDefault` missing. **DB schema is stale after pull.** |

### STEP I/J — DB schema sync options
- `pnpm db:push` → **refused (safe)**: data-loss warnings (drop `AiModel.isPlatformDefaultFor` with 37 non-null rows, remove `TenantPlan.TRIAL`, add Notification unique constraint). Needs `--accept-data-loss`.
- `pnpm db:migrate:status` → **all 87 migrations unapplied including init** — this local `hope` DB was created by `db push`, has no `_prisma_migrations` history. `migrate deploy` is NOT a usable path.
- Therefore the repo-supported way to sync local dev DB is `pnpm setup:dev` / `pnpm db:all` → `prisma db push --force-reset --accept-data-loss` + reseed (and Temporal orphan cleanup). **This is destructive to the local `hope` dev DB.** User previously consented to such a reset on 2026-11-14, but explicit confirmation is being requested again before proceeding.

## Final verification (after approved DB reset)

### STEP L — local `hope` DB reset + reseed (user approved)
- `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=1 RUN_SEED=all NODE_ENV=development pnpm db:all`
- Result: `prisma db push --force-reset` succeeded ("database hope … successfully reset"), clients regenerated, full seed completed (users, service accounts, API keys, agents, workflows, 11 consultations, etc.), Temporal orphan cleanup no-op.
- **No project-hope repo files were edited.**

### STEP M/N/O — re-verified curls
| Call | Before DB reset | After DB reset / with correct account |
|---|---|---|
| `GET /health` | 200 | 200 |
| `GET /audio/transcription-jobs/language-modes` (tenant JWT) | 400 `P2022` | **200** |
| `GET /consultations/workflows` | 200 | 200 |
| `POST /consultations/open` as `super_admin` | 404 | 404 (super-admin is not a clinician) |
| `POST /consultations/open` as `arcaai_doctor` | — | **201** (consultation created, dept GEN) |
| `GET /consultations/:id` | — | **200** |
| `POST /:id/start` | — | **200** (`RECORDING`, v3) |
| `POST /:id/stop` | — | **200** (`DRAINING`/`STOPPED`, v4) |
| `GET /audio/transcription-jobs/consultation/:id` | — | **200** (`[]`) |
| `POST /audio/transcription-jobs/stream/session` | — | **502** (see below) |

Login requirements confirmed: `tenantKey: "ARCAAI"` mandatory; `arcaai_doctor`/`password123` works, `doctor` does not belong to ARCAAI (401).

### STEP P — stream-session 502 diagnosis
- API: `Failed to create streaming session` → `upstreamStatus: 500`, `AxiosError ERR_BAD_RESPONSE`, mapped to 502 `GATEWAY.DOWNSTREAM_UNAVAILABLE`.
- STT `:8861/health` is 200 (minio/redis/streaming/processors healthy) but session creation fails.
- Accompanying: `GET /api/v1/internal/stt/model-registry-credential` → 401 `Invalid API key` (`keyPrefix bab62d61b91d`); ASR model metadata warning; resolved agent `realtime-transcription-en` (source `tenant`).
- Conclusion: downstream STT/config issue, not an API-code defect; documented in the corrected guide §7.

### Deliverables produced (all under `review/alaaSv3/`)
- `debug-hope-api-gateway-fresh-pull-20261116.md` — corrected API-only procedure (startup order, auth, refreshed breakpoint map, verified curls, troubleshooting)
- `hope-api-attach.code-workspace` — VS Code attach config (`Attach: HOPE API (9229)`) placed outside `project-hope` so no repo edit is needed
- `agent_log/20261116-api-debug-investigation.md` — this agent console log
- `investigate_console_20261116.log` — full investigation + verification console output

**Runtime left as-is:** HOPE API running in background (watch mode, `:8868` + `:9229`), STT running on `:8861`, Docker infra up. ALaaS client untouched.
