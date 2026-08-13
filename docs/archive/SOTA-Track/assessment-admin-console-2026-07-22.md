# Assessment — Admin-Console Headed Sweep (waiver-built screens) — 2026-07-22

| | |
|---|---|
| **Program** | TASK-539 Continuous Quality Re-Assessment, cycle 1 §4 |
| **Finding under test** | F-009 — "Admin-console screens built under design waivers with no headed-browser pass (TASK-526 explicitly; 528 hub never driven authenticated)" |
| **Assessor** | Fable 5 (xhigh), runtime assessor per the program doctrine ("Review = statically green, runtime-unproven") |
| **Stack driven** | Real BFF login → gateway → seeded dev DB: `pnpm api:dev` (:8868) + `pnpm admin:dev` (:5176) + `pnpm guardrail:dev` (:8863) + `pnpm nlp:dev` (:8864), all started and torn down by this assessment; dev containers (postgres/redis/vault/temporal/minio/qdrant) already up and untouched |
| **Method** | Playwright 1.61 real chromium (headless), driven through the app's OWN e2e harness (`apps/admin-console/playwright.config.ts`, `auth.setup.ts` one-shot BFF form login → storage-state, `helpers/auth.ts` working-tenant selection) via a purpose-written sweep spec (15 tests). Axe (`@axe-core/playwright`) on the live DOM per screen with WCAG 2.2 AA tags; full-viewport screenshots per screen. Driver + all JSON results + 15 screenshots archived in the session scratchpad (`sweep/`); driver removed from the tree after the run |

## Verdict on F-009

**Proven and CLOSED.** All ten target screens (including every waiver-built one) now have a headed-browser pass against live seeded data through the real auth stack: every screen rendered real rows (no stuck skeletons, no error boundaries), every primary interaction succeeded, both retired-route redirects work logged-in, and dark theme spot-checks pass axe. The sweep also did exactly what the doctrine predicts an honest first drive does: it surfaced **4 new runtime findings** that 1,081 green unit tests and a green build never showed (F-035 systemic hydration mismatch, F-036 IdP role-picker trap, F-037 serious axe violation in the discovery drawer, F-039 admin-console suites entirely absent from CI).

## Per-screen results

Working tenant: seeded tenant literally named "Global" (`seed/05-tenant.ts`) — see Minor observations. All light-theme unless noted. "axe" = `@axe-core/playwright` with tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` against the live DOM, transitions frozen.

| Screen | Rendered (real data) | Primary interaction | axe | Notes |
|---|---|---|---|---|
| `/ai-services` (Guardrail·NLP·Instructions) | ✅ live guardrail status card (`healthy`, granite-guardian-4.1-8b via lm-studio :1234, redis healthy, GLiNER lazy) once guardrail+NLP up; with them down, each card reached its own truthful ErrorState (both states runtime-proven) | Instructions tab activated → effective agentic instruction set for the working tenant (resolved prompt tier SOAP `71000000-…36`, judge prompt pin PDSQI-9 1.0.0 w/ promptHash, sensor thresholds, safety criteria) | CLEAN (light + dark) | Error text exposes the upstream path `GET /api/health` — see F-038 |
| `/db-studio` | ✅ studio ENABLED path: iframe shell live | `Open in new tab` escape hatch verified → `href=/api/hope/admin/pstudio`; iframe `src` same | CLEAN | Disabled-card path already covered by the standing `db-studio.spec.ts` (route-stubbed) |
| `/agents?tab=governance` | ✅ 38 templates; governance panel lists APPROVED v1 templates (Breast & Endocrine New Referral/Revisit, Cardiology, Catch-All SOAP…) | Deep link selects the Governance tab (`data-state=active`), panel populated (1,588 chars) | CLEAN | Right half of the governance tab is blank until a template is picked — no empty-state hint (minor) |
| golden-sets + edit-burden (`/harness/observability`) | ✅ Chain integrity "Chain intact", 6 WORM audit rows minutes old (SENSOR_RUN/GENERATE), gate queue 3 pending w/ SLA badges, eval runs truthful empty, Golden sets + Edit burden h2 panels present | Header `Refresh` invalidates all panel queries; all re-settled clean | CLEAN | Live rows correspond to the 3 harness-doc sessions on /ai-operations/runs |
| `/ai-configuration` (tenant tier) | ✅ Effective models (9 task keys, read-only, cascade tier shown) | Switched to Cloud credentials tab → BYO Azure OpenAI + Bedrock cards (write-only key fields, Vault-Transit copy); **"Acting on «Global»" banner present on the mutating tab** (rule-13 mandate honored) | CLEAN (light + dark) | Write-only/no-reveal copy matches the config-plane assessment's runtime proof |
| `/ai-models` (discovery drawer) | ✅ 37 models in the registry grid | `Discover from servers` → drawer with 12 discovered models (ollama/lm-studio entries, Registered badges) + 4 truthful probe errors (ollama/lm-studio/vllm/llama-cpp probes — servers down/partial in this env) | **1 SERIOUS: `scrollable-region-focusable`** (drawer scroll region not keyboard-reachable) → F-037 | Base registry screen itself scanned clean in the standing `ai-models.spec.ts` |
| `/ai-operations/runs` | ✅ 3 HARNESS_DOC sessions (7 steps each) listed | Selected first session → real trajectory: `#0 PHASE fetch_policy OK 14ms {version:3}`, `#32 RETRIEVAL retrieve_context SKIPPED {enabled:false}`, `#48 TOOL_CALL assemble_prompt OK 38ms`; Live toggle, Signal, Cancel-run controls present | CLEAN | Global tier + WorkingTenantGate combination behaves as documented |
| `/ai-operations/metrics` | ✅ real derived metrics: Avg tokens/s 36.9, regen rate 0% (0/3), gate pending 3, stop-reason chart (3×stop); Median TTFT truthfully "—" ("No latency samples… fills in as LLM_CALL steps report GenerationStats") | Screen has no filter combobox in this state (window fixed "last 7 days" per footer) — truthful-empty + populated tiles recorded | CLEAN | Dev-overlay "1 Issue" badge visible in screenshot = F-035 hydration error |
| `/identity-providers` (tenant tier) | ✅ list shell + count renders | `New provider` → create form (Display name, Issuer/discovery URL, Client ID/secret, Default role picker) | CLEAN | Default-role picker offers `GLOBAL_ADMIN` and `SERVICE_ACCOUNT` → F-036 |
| `/tts-config` (tenant tier) | ✅ config renders | Credentials tab → BYO provider keys panel ("write-only, masked on read", Azure Speech `not configured`/`disabled` — real DB state) | CLEAN | Matches per-tenant TTS config plane semantics |
| `/prompt-studio` (retired) | ✅ redirects logged-in → `/agents?tab=governance`, Governance tab `data-state=active` | — | — | Standing `retired-routes.spec.ts` also passes |
| `/pstudio` (retired) | ✅ redirects logged-in → `/db-studio`, h1 visible | — | — | |
| Dark theme spot-checks | `/ai-services` + `/ai-configuration` re-driven with `colorScheme: dark` | full render both | CLEAN both | Screenshot confirms correct dark tokens on the guardrail status card |

13 axe scans total (11 light incl. two open-overlay states, 2 dark): **1 serious violation, 0 critical** — the target "0 serious/critical" is missed by exactly F-037.

## Rubric scores

| Dimension | Score | Justification (evidence) |
|---|---|---|
| **Correctness** | **adequate** | All 10 screens render live data with correct tier/gate posture (working-tenant gates, "Acting on" banner on mutating tabs, truthful empty/error states, retired-route redirects). Marred by F-035: a systemic SSR hydration mismatch on session-gated screens (5 distinct screens caught it in one sweep) — self-heals via client re-render, so no user-visible breakage, but it is a real defect class in the shell. |
| **Completeness** | **adequate** | F-009's claim is now false: everything waiver-built has been driven. But the standing e2e suite has NO specs for 5 of the 10 target screens (`ai-configuration`, `identity-providers`, `tts-config`, `ai-operations/runs`, `ai-operations/metrics`) — this sweep's coverage of them dies with the assessment unless promoted into specs. |
| **Performance** | **adequate** (measured only incidentally) | Screens settled in 1.6–9s per test including navigation, data fetch and axe on a dev build (production build not measured — honest delta). F-035 forces a full client re-render of every gated screen's tree on first load: real, avoidable waste with a one-line-class fix (seed the session query server-side). No formal CWV/latency capture was in scope. |
| **Security & PHI** | **adequate-to-strong** | Runtime-proven BFF posture: post-login storage state = exactly one `hope_admin_session` httpOnly/Lax cookie, **zero** localStorage/sessionStorage entries. IdP JIT provisioning's GLOBAL_ADMIN block verified in code at the enforcement point (`federated-auth.service.ts` — explicit pre-session check, covers both `defaultRoleId` and group-mapped paths); the UI merely fails to pre-filter (F-036). BYO key fields are write-only with no reveal flow (screen copy + config-plane assessment concur). Observability panels expose PHI-safe metadata only, as designed. |
| **Test posture** | **at-risk** | The suite itself is well-built (skip-not-fail gating, one-shot login vs the 5/60s throttle, axe both themes, route-stub negative paths) — but **no CI job runs ANY admin-console test**: `test-apps` runs only `@arcaai/ui-playground`; grep of `.gitlab/ci/test.yml` for `admin-console` = 0 hits (build.yml only builds the image). 1,081 unit tests + ~37 e2e spec files are local-discipline-only → F-039. Also 5 target screens spec-less (Completeness row). |
| **SOTA delta** | — | (1) Seed TanStack Query with the server session (`HydrationBoundary`/`initialData` from the layout's already-computed `safeSession`) — the standard Next-16+TanStack SSR pattern; kills F-035 and a redundant fetch. (2) Promote per-screen axe scans from per-spec calls into a shared fixture so no screen ships spec-less. (3) CI: wire `pnpm --filter @arcaai/admin-console test` into the test stage and (given a compose stack) a nightly e2e job — best-in-class consoles gate merges on both. (4) Playwright visual snapshots for the frame-numbered screens would close the drift-control loop of the design workflow (frames ↔ build). |

## Runtime evidence

Environment gates before start: `lsof -i :8868` / `:5176` both free; dev containers up (`hope-postgres`, `hope-redis`, `hope-vault`, `hope-temporal`, `hope-minio`, `hope-qdrant` — untouched). Known hazard from the prior assessment (F-034) re-checked: the 5 orphaned `nest --watch` PIDs (7482/8579/10310/71486/73583) are STILL alive (up to 25h elapsed) — left untouched per environment rules; this run's API was nonetheless observed serving correctly throughout.

```
$ curl -s -o /dev/null -w "health=%{http_code}\n" http://localhost:8868/api/v1/health   → health=200
$ curl -s ... http://localhost:5176/login                                               → login=200
# api-dev.log: "Nest application successfully started … port=8868"
```

Full sweep (first pass — guardrail/NLP intentionally not yet started, catching the error-state path):

```
Running 15 tests using 8 workers
  ✓ [setup] authenticate as seeded global admin (1.2s)
  ✓ ai-operations/runs: screen renders behind the working-tenant gate
  ✓ db-studio: status surface resolves (iframe shell or truthful disabled card)
  ✓ ai-configuration: effective models table + BYO credentials tab
  ✓ ai-operations/metrics: derived generation metrics render
  ✓ ai-services: three tabs render; Instructions tab shows the effective document
  ✓ retired route /pstudio redirects to /db-studio
  ✓ ai-models: registry renders and the discovery drawer opens with live probes
  ✓ agents governance tab: deep link selects the tab and the panel loads
  ✓ harness observability: golden sets + edit burden panels render with the audit surface
  ✓ tts-config: configuration and credentials tabs render
  ✓ retired route /prompt-studio redirects to the agents governance tab
  ✓ dark theme: ai-configuration renders and passes the axe contrast sweep
  ✓ identity-providers: list renders and the create form opens
  ✓ dark theme: ai-services renders and passes the axe contrast sweep
  15 passed (13.0s)
```

Second pass after starting guardrail (+ LM Studio reachable) and NLP — ai-services happy path:

```
$ curl … http://localhost:8864/api/v1/health → nlp=200        (guardrail health lives at /api/health → F-038)
# guardrail-dev.log: "GET /api/health HTTP/1.1" 200 OK; upstream probe http://localhost:1234/v1/models 200
  ✓ ai-services: three tabs render; Instructions tab shows the effective document   (1.8s)
  ✓ dark theme: ai-services renders and passes the axe contrast sweep               (1.7s)
# result JSON: rendered (no error state), axe CLEAN both themes
```

Strengthened runs-screen interaction (re-run):

```
  ✓ ai-operations/runs … → selected the first agentic session; trajectory detail rendered
# screenshot: fetch_policy OK 14ms {version:3} · retrieve_context SKIPPED · assemble_prompt OK 38ms · Signal/Cancel controls
```

Hydration-failure evidence (admin dev log, `[browser] Uncaught Error` ×5 during the sweep — routes identified from the React component stacks):

```
Hydration failed because the server rendered HTML didn't match the client. …
  <AiOperationsMetricsScreen>… <MetricsBody><ScreenTemplate>
    <div  + className="flex min-h-0 flex-1 flex-col"   (client: real body)
          - className="flex flex-col gap-4"            (server: gate/skeleton branch)
# same signature on: AgentsScreen (×2), HarnessObservabilityScreen, IdentityProvidersScreen
```

BFF session posture (Playwright storage state after real form login):

```
cookies: [('hope_admin_session', httpOnly=True, sameSite='Lax')]
origins (localStorage entries): []
```

CI wiring probe:

```
$ grep -rn "admin-console" .gitlab/ci/test.yml   → (no matches; build.yml only builds the Docker image)
$ grep -n "turbo test" .gitlab/ci/test.yml       → filters: logger/utils/pipeline/domains/applications · vox/room/vad/stt/noise-filter/med-ner/ui · ui-playground
```

Teardown (all four services started by this assessment):

```
TERM sent to pgid 29236 (api wrapper) / 29289 (admin) / 29806 (guardrail+nlp); listener 29439 (:8868) TERM'd
final: lsof -i :8868 -i :5176 -i :8863 -i :8864 → empty (all freed)
orphan watchers p7482/8579/10310/71486/73583 → 5 still alive (deliberately untouched — owner action from F-034 stands)
driver spec removed from tests/e2e/ (archived with results + 15 screenshots in the assessment scratchpad)
```

## Findings (ranked)

### F-035 (P2, Correctness/Performance) — Systemic hydration mismatch on every session-gated screen
**Evidence:** 5 uncaught `Hydration failed` browser errors in one sweep (metrics, agents ×2, harness-observability, identity-providers); dev-overlay "1 Issue" badge visible in two screenshots. The React diff shows the server rendered `WorkingTenantGate`'s `!session.data` skeleton branch while the client hydrated the real screen body.
**Mechanism:** `(console)/layout.tsx` decrypts the session server-side (`getSession()` → `safeSession`) but never seeds the client cache; `useSession()` re-fetches `/api/auth/session` client-side, and selective hydration of the streamed page segment races that fetch — when the fetch wins, the client's first render disagrees with the SSR HTML.
**Failure scenario:** every full-page load of a gated screen re-renders the whole subtree client-side (wasted work, layout flash risk); any client-side error monitoring in production pages on a permanent stream of hydration errors, burying real defects; future React versions treat mismatches more strictly.
**Remediation (S):** pass the layout's `safeSession` into `Providers` and seed `queryClient` (`initialData`/`HydrationBoundary`) for `['auth','session']` so SSR and first client render agree deterministically — also deletes a redundant fetch per page load.

### F-039 (P1, Test posture) — Admin-console suites are invisible to CI
**Evidence:** `.gitlab/ci/test.yml` runs turbo test filters for packages, SDK and `ui-playground` only; `admin-console` appears solely in `build.yml` (Docker image). The 1,081-test vitest suite and the ~37-file Playwright e2e suite run only when a developer remembers to.
**Failure scenario:** any regression in the console (the largest UI surface shipping to operators) merges green; the Phase-0 baseline even cited "admin-console 1081" as part of the green static gates — a number CI never reproduces.
**Remediation (S for unit / M for e2e):** add `--filter=@arcaai/admin-console` to a test job (unit suite is hermetic, jsdom/happy-dom); e2e needs a composed stack — start as a scheduled/nightly job using the suite's own skip-not-fail gating.

### F-037 (P2, Accessibility) — Discovery drawer: serious `scrollable-region-focusable` axe violation
**Evidence:** the only violation in 13 scans — the `Discover from servers` drawer's scroll region (`.overflow-y-auto.p-4.min-h-0`) is not keyboard-focusable, so keyboard users cannot scroll the discovered-models list (12 entries; more below the fold).
**Failure scenario:** keyboard-only operator opens discovery, cannot reach models past the viewport; WCAG 2.1.1 failure on a shipped screen; contradicts rule 11 §11's "axe 0 violations per screen" DoD (the drawer-open state was never scanned by the standing spec — it scans the base screen only).
**Remediation (S):** `tabIndex={0}` + an accessible name/role on the scroll container (or make the list itself focusable); extend `ai-models.spec.ts` to scan the drawer-open state.

### F-036 (P3, Security-UX/defense-in-depth) — IdP default-role picker offers roles the backend rejects
**Evidence:** the `New provider` form's "Default role" select lists `GLOBAL_ADMIN` and `SERVICE_ACCOUNT` alongside legitimate clinical roles. Backend verification: `federated-auth.service.ts` hard-blocks GLOBAL_ADMIN at JIT provisioning (explicit pre-session check — the boundary HOLDS), and service accounts cannot sign in interactively at all.
**Failure scenario:** a tenant admin configures SSO with default role GLOBAL_ADMIN; config saves fine; every subsequent first-login via that IdP throws 403 at provisioning — the misconfiguration is discovered by locked-out end users at login time, not by the admin at config time. `SERVICE_ACCOUNT` as a default is a semantically dead choice presented as valid.
**Remediation (S):** filter the role options (exclude GLOBAL_ADMIN + SERVICE_ACCOUNT) or validate at config-save with a clear error; keep the backend check as the enforcement point.

### F-038 (P3, Ops/conformance) — Guardrail health endpoint diverges from the documented convention
**Evidence:** `curl :8863/api/v1/health` → 404; the service serves `GET /api/health` (its own log + the ai-services card's "Proxied verbatim … (GET /api/health)"). Rule 06 and the other services document/expose `/api/v1/health` (NLP: 200 verified live this session).
**Failure scenario:** uniform health probes (k8s templates, dashboards, `dev:doctor`-style tooling) configured to the documented path report guardrail down while it is healthy — or worse, mask a real outage behind an "expected 404".
**Remediation (S):** serve both paths (alias) or fix the docs/rule; verify k3s manifests probe the path the service actually answers.

### Minor observations (no register rows)
- **Seeded tenant named "Global"** (`seed/05-tenant.ts`): every tenant-scoped banner reads "Acting on: «Global»", which an operator can misread as "acting globally/cross-tenant" — exactly the confusion the banner exists to prevent. Cosmetic seed rename (e.g. "Demo Clinic") would remove the trap in every demo/screenshot.
- **Agents governance tab**: right detail area is blank (no empty-state hint) until a template is selected; frame-09 empty-state pattern would fit.
- The screens' endpoint-hint footers (`GET /admin/...`) matched the real proxied calls observed in the BFF log throughout — good truth-in-UI discipline.

## Deltas (what this assessment did NOT prove)
- **Dev build only** (`next dev`): production `next build` output, CWV, and standalone-Docker behavior unmeasured. Hydration errors were observed in dev; the mechanism is build-independent but production log noise was not directly demonstrated.
- **Desktop viewport only** (1280×720); no tablet/mobile pass, no 200%-zoom or manual keyboard protocol (axe automation catches ≲57% — per the a11y skill, the manual pass remains owed for these screens' DoD).
- Guardrail/NLP happy path was proven, but LM Studio's model inventory happened to be up on this host; the NLP tab's populated state was asserted only as "settled without error", not field-by-field.
- Playground screens (tier 50–59) and the remaining console screens with standing specs were NOT re-driven here (the standing suite covers them; TASK-534's e2e run is the owning evidence line).
- No load/perf measurement beyond wall-clock test times; single user.

## Suggested follow-ups (for the planning track)
1. Promote the five spec-less target screens into standing specs (reuse the archived sweep driver's assertions nearly verbatim) — S, closes the Completeness gap permanently.
2. F-039 CI wiring — S/M as above.
3. F-035 session seeding — S; verify by re-running the sweep with the browser log asserted clean of hydration errors.
4. F-037/F-036/F-038 — three S fixes; fold into the cycle-1 quick-wins clearance ticket.
