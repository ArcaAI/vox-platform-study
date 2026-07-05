# BUG-001 — next-themes Script Tag Console Error (admin-console)

| Field | Value |
|---|---|
| Status | Completed |
| Type | bugfix |
| App | `apps/admin-console` (Next.js 16.3.0-preview.5, React 19.2.7) |
| Related | TASK-415 (Hope Admin Console) |
| Upstream | [pacocoursey/next-themes#385](https://github.com/pacocoursey/next-themes/issues/385), [#387](https://github.com/pacocoursey/next-themes/issues/387) |

## Requirement Analysis

Every load of a console page in development shows a React console error in the Next.js dev overlay:

```
Encountered a script tag while rendering React component. Scripts inside React
components are never executed when rendering on the client. Consider using
template tag instead (https://developer.mozilla.org/en-US/docs/Web/HTML/Element/template).

    at script (<anonymous>:null:null)
    at Providers (src/shared/providers.tsx:27:17)
    at ConsoleLayout (src/app/(console)/layout.tsx:24:9)
```

Theming itself works (no functional breakage) — the requirement is to remove the
recurring console error without regressing the no-FOUC theme bootstrap.

## Current State Evaluation (root cause)

1. `src/shared/providers.tsx` renders `<ThemeProvider>` from `next-themes@0.4.6`.
2. `next-themes` renders its FOUC-prevention bootstrap as an inline `<script
   dangerouslySetInnerHTML=...>` **inside the React tree**, on both server and
   client renders (verified in `next-themes/dist/index.mjs`, `ThemeScript` memo
   component). The script carries no `type` attribute.
3. The React canary bundled with Next 16 (`next/dist/compiled/react-dom/cjs/
   react-dom-client.development.js`, warn site at the `case "script"` branch of
   `createInstance`) warns once per session when a client render creates an
   **executable** script element. The guard is `isScriptDataBlock(props)`: only
   scripts whose `type` is a non-executable data-block MIME (e.g.
   `application/json`) are exempt.
4. Stock `react-dom@19.2.7` (used by Vitest) does not contain this warn site —
   it is canary-only, which is why it appears in the browser but not in unit
   tests.
5. Trigger paths: client-side mount of the `(console)` layout (e.g. the
   `router.replace` + `router.refresh` soft navigation after login) and dev
   re-renders. The server-rendered copy of the script executes during HTML
   parsing and sets the theme class before paint; the client-rendered copy is
   never executed by React (by design), so the warning is cosmetic — but it
   fires on every dev session and pollutes the console.

Upstream status: `next-themes` is effectively unmaintained (last release
March 2025); issue #385 is open with an unmerged PR (#386). Community-validated
workarounds: (a) maintained forks (`@teispace/next-themes`, `@wrksz/themes`),
(b) pnpm patch of the dist bundle, (c) client-only `scriptProps={{ type:
'application/json' }}`.

## Implementation Plan

Chosen fix: **(c) client-only `scriptProps` data-block type** — zero new
dependencies, no patched vendored code, upgrade-safe, and precisely targets the
warn-site guard (`isScriptDataBlock`):

- On the server (`typeof window === 'undefined'`), pass no `scriptProps` so the
  SSR-emitted script stays executable → no-FOUC bootstrap unchanged.
- On the client, pass `{ type: 'application/json' }` so React treats the
  (never-executed) client copy as an inert data block → warning suppressed at
  its guard. The element carries `suppressHydrationWarning`, so the
  server/client `type` attribute difference is explicitly tolerated.

TDD steps:

1. RED — `src/shared/__tests__/providers.test.tsx`: rendering `<Providers>` in
   a client (happy-dom) environment must produce the next-themes bootstrap
   script as an inert data block (`type="application/json"`). Fails against
   current code (script has no `type`).
2. GREEN — add the conditional `scriptProps` to `providers.tsx`.
3. Gates — `pnpm --filter @arcaai/admin-console test`, `lint`, `build`.
4. Runtime — drive the running dev server with a browser: log in, load a
   console page, confirm the console error is gone and the theme (dark/light
   toggle + pre-paint class) still works.

## Implementation Summary

### Files changed

| File | Change |
|---|---|
| `apps/admin-console/src/shared/providers.tsx` | Added module-scope `themeScriptProps` (`undefined` on the server, `{ type: 'application/json' }` in the browser) and passed it as `scriptProps` to `<ThemeProvider>`. |
| `apps/admin-console/src/shared/__tests__/providers.test.tsx` | New regression test: rendering `<Providers>` in the client (happy-dom) environment must produce the next-themes bootstrap script as an inert `application/json` data block. |

No API, schema, or dependency changes.

### TDD evidence

- RED (before fix): `expected null to be 'application/json'` — the client-rendered
  theme script had no `type`.
- GREEN (after fix): rendered markup is `<script type="application/json" nonce="">((e,i,s,u,m,a,l,h)=>{...`.

### Gates (actual output)

```
pnpm --filter @arcaai/admin-console test   → Test Files 75 passed (75), Tests 503 passed (503)
pnpm --filter @arcaai/admin-console lint   → clean (eslint src --max-warnings 0)
pnpm --filter @arcaai/admin-console build  → ✓ Compiled successfully (Next.js 16.3.0-preview.5, Turbopack), 41 routes
```

### Runtime verification (next dev on :5176, driven browser)

- Post-login soft navigation `/login → /dashboard` (the original repro path):
  `console.error` recorder captured **0** "Encountered a script tag" warnings
  (0 console errors total).
- Hard load of `/dashboard`: 0 warnings; SSR HTML still emits the executable
  bootstrap `<script>((e, i, s, u, m, a, l, h)=>{...` (no `type` attribute), so
  the no-FOUC behavior is intact; client DOM script carries
  `type="application/json"`.
- Theme still works: toggle switched `<html>` to `.dark` + `color-scheme: dark`,
  persisted via `localStorage.theme`, and a hard reload re-applied dark before
  paint with 0 warnings. (Preference restored to `system` afterwards.)
- `/_next/mcp get_errors`: no build errors; no script-tag runtime error. The one
  dev-overlay entry seen during verification was a hydration-mismatch on
  `data-cursor-ref` attributes injected by the browser-automation tooling
  itself — unrelated to the app or this fix.
- `/_next/mcp get_compilation_issues`: `{"issues":[]}`.

### Notes

- The warning cannot be reproduced in Vitest because stock `react-dom@19.2.7`
  does not contain the canary warn site; the regression test therefore locks the
  behavioral contract (client-side theme script is a non-executable data block,
  which is exactly the `isScriptDataBlock` exemption the canary checks).
- Unrelated dev-environment friction hit during verification: the gateway's
  `/auth/login` throttle (5/min, Redis-backed) was intermittently exhausted by
  other local clients, delaying browser login. No action taken; not part of
  this bug.
- If/when `next-themes` ships a fixed release (issue #385 / PR #386), the
  `scriptProps` workaround can be dropped; the regression test will flag any
  behavior change on upgrade.

## Change History

| Date | Change |
|---|---|
| 2026-07-05 | Ticket opened; root cause traced to next-themes inline script vs React canary script-tag warning; plan approved as part of "investigate and fix" request. |
| 2026-07-05 | Fix implemented (client-only `scriptProps` data block) with TDD regression test; all gates green; runtime-verified in `next dev` with a driven browser (0 warnings, no-FOUC intact, both themes). Status → Completed. |
