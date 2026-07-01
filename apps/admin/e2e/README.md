# Admin Console — Frontend E2E (Playwright)

Browser-driven, full-stack E2E for the HOPE Admin Console. Specs drive the real
UI (Vite dev server, `:5174`), which proxies `/api` to the real API Gateway
(`:8868`) — exercising the **frontend → backend** path end to end.

## Layout

```
apps/admin/
  playwright.config.ts        # 3 viewport projects: desktop / tablet / mobile
  e2e/
    fixtures/auth.ts          # loginAs(persona) — seeded-persona UI login
    _smoke.spec.ts            # harness smoke (login page renders)
    task-3XX-<slug>.spec.ts   # one file per ticket (added by ticket owners)
```

## Viewport projects (= approved responsive model)

| Project | Width | Tier (TASK-384) |
|---|---|---|
| `desktop` | 1280 | ≥ 1024 (`lg`) — full sidebar + data grid |
| `tablet` | 834 | 768–1023 (`md`) — icon-rail + condensed table |
| `mobile` | 390 | < 768 — drawer nav + card-list + FAB |

Target one tier with `--project=mobile` (etc.).

## Personas (seeded; `password123`)

`superAdmin` (cross-tenant, no workspace key), `tenantAdmin`, `arcaaiAdmin`
(`ARCAAI` key), `doctor`. See `fixtures/auth.ts` + `docs/qa/manual-tests/README.md` §5.

## Run (needs a seeded stack)

```bash
pnpm docker:test:up && pnpm test:db:reset      # Postgres/Redis + seed
pnpm dev:api:test                              # API on :8868 (separate terminal)
npx playwright install chromium                # one-time
# from repo root:
pnpm exec playwright test --config apps/admin/playwright.config.ts
```

The `webServer` block auto-starts `pnpm dev` for the admin app; the API at
`:8868` must already be up (login fails fast otherwise).

## Discover without running (authored-spec gate — no stack needed)

```bash
pnpm exec playwright test --config apps/admin/playwright.config.ts --list
```

This compiles + lists every spec across the three projects without launching a
browser or server — the gate ticket owners use to prove specs are wired before
a live stack is available.
