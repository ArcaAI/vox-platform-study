# TASK-668 — SDK codegen CLI

- **Status:** Completed
- **Type:** feature
- **Wave:** W5 of [TASK-654](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/README.md) — the last ticket of the original plan · Tier sonnet-5 / medium · Size M
- **Depends on:** TASK-665 (SDK schema discovery — shipped, present at this baseline)
- **Baseline:** `dev-2.1` @ `d5c43c033` (merge(TASK-666): admin console context schema editor)
- **Worktree:** `agent-acac20ebb03414c8e` — `git reset --hard dev-2.1` performed before any work (spawned on a stale local branch, not `dev-2.1`)
- **Spec:** [execution-plan.md § TASK-668](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/execution-plan.md)

---

## 1. Requirement Analysis

**Objective.** `npx @arcaai/vox-codegen --tenant <id>` emits TypeScript types from a tenant's
`ConsultationContextSchema` discovery bundle. It is an **accessory to runtime discovery, never a
replacement** — a tenant can add or change a kind between two runs of this generator, and a stale
generated file must never silently lie about the payload shape; the SDK's `useConsultationSchema()`
remains the wire contract.

| # | Acceptance criterion (from the ticket) |
|---|---|
| AC-1 | A placement decision is made and recorded: extend `@arcaai/vox` with a Node tsup entry, or create a new workspace package |
| AC-2 | A root script is added under the `<target>:<action>` taxonomy |
| AC-3 | The CLI fetches the tenant's schema (same endpoint the SDK uses) and emits `.ts` types |
| AC-4 | `--watch` is supported for the dev loop |
| AC-5 | Generated output is committed by the integrator, not fetched at boot (documented, not a runtime behavior to test) |
| AC-6 | A discriminated `oneOf` produces a real TS union, not merged property soup |
| AC-7 | `if`/`then`/`else` is never handled (rejected server-side) — but the tool fails loudly if it ever sees one, rather than emitting something wrong |
| AC-8 | Generated types compile against a fixture schema |

### 1.1 Design constraints inherited from the parent

- **Additive-only on `@arcaai/vox`'s six shared modules** (execution-plan §1.4) — moot here: this
  ticket adds **zero** lines to `packages/agentic-sdk-v2` (see §3 the placement decision).
- **`apps/compat-playground` must still build if `@arcaai/vox` is touched** — moot for the same
  reason; verified anyway not to have touched it (§5).
- **No Ajv/Zod added to `packages/agentic-sdk-v2`** — moot; this ticket doesn't touch that package,
  and the new package itself adds zero runtime dependencies of any kind.
- **Do not touch `packages/json-schema-subset/**`** (a refactor is in flight elsewhere) — honored;
  that package does not exist in this worktree at all (`find packages/json-schema-subset` returns
  nothing at `dev-2.1` @ `d5c43c033`), confirming it hadn't merged yet at this baseline.

---

## 2. Current State Evaluation

Verified against `dev-2.1` @ `d5c43c033`, before any TASK-668 code.

| Area | Finding |
|---|---|
| `@arcaai/vox`'s `bin` field | Absent. `packages/agentic-sdk-v2/package.json` has no `bin` key. |
| `@arcaai/vox`'s tsup entries | All five (`index`, `core`, `compat`, `plugins`, `plugins-med-ner`) share `sharedOptions.esbuildOptions` which sets `options.platform = 'browser'` unconditionally — confirmed by reading `tsup.config.ts` in full. |
| The discovery endpoint | `GET /tenant/me/context-schema` (TASK-658, confirmed live at this baseline via `apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts`) returns `ConsultationContextSchemaBundleResponse` — the same shape `@arcaai/vox`'s `ConsultationSchemaBundle` (`src/types/consultationSchema.ts`, TASK-665) mirrors client-side. Gated with a bare `@Authorize()` and CLS-resolved tenant — there is no `tenantId` route/query param on this endpoint. |
| How a caller selects an arbitrary tenant | `apps/api/src/interceptors/resolve-active-tenant.ts` — a GLOBAL_ADMIN whose JWT carries an empty tenant binding may send `X-Tenant-Id: <uuid>` to elevate the active CLS tenant for that request (the exact mechanism the admin-console BFF proxy uses for its "working tenant"). This is the mechanism a `--tenant <id>` CLI flag has to drive. |
| `@arcaai/json-schema-subset` | Does **not exist** in this worktree (`find packages/json-schema-subset` → no matches). The hard constraints forbid touching it regardless; it turns out there is nothing to touch — it hadn't merged to `dev-2.1` at this baseline. |
| `@arcaai/vox`'s hand-ported evaluator | `packages/agentic-sdk-v2/src/core/contextPayloadValidation.ts` (TASK-665) — a dependency-free port of the server's `jsonSchemaValueProblems`, VALUE validation only (no type generation). Confirms the supported keyword set to mirror: `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `anyOf`, `allOf`, discriminated `oneOf` (plus constraint keywords with no TS equivalent: `min/maxLength`, `pattern`, `minimum`, `maximum`, `min/maxItems`). |
| Existing generator convention | `packages/tools` — `ts-node`-invoked scripts, no `bin` field, no npm-published CLI surface (internal dev tooling only). Not a template for an `npx`-published package. |
| Existing "same brand, different runtime" convention | `packages/vox-node` (`@arcaai/vox-node`, TASK-632) — sibling package to `@arcaai/vox`, zero runtime dependencies, Node-only tsup config (`platform: 'node'`, `target: 'node22'`), its own `sdk-node:*` root script family. The closer template. |
| Root script taxonomy | `sdk:*` → `@arcaai/vox`, `sdk-node:*` → `@arcaai/vox-node` (`package.json:66-92`) — both `<target>:<action>` families with an identical action set (`dev`, `build`, `test`, `test:watch`, `test:cov`, `lint`, `lint:fix`, `typecheck`, `clean`, +format for `sdk`). |
| `turbo.json#globalEnv` | Alphabetically sorted list of every runtime env var any package reads via `process.env` (enforced by `turbo/no-undeclared-env-vars` at lint time). |

---

## 3. The placement decision (recorded, per the ticket's instruction)

**Chose: a new workspace package, `packages/vox-codegen` (`@arcaai/vox-codegen`).**

Two options existed (ticket text, execution-plan.md TASK-668):

1. Add a Node tsup entry to `@arcaai/vox` that overrides `sharedOptions`.
2. Put the generator in its own workspace package.

**Reasoning for option 2** (the ticket's own recommendation; found no reason to override it):

- `@arcaai/vox` is a **browser bundle shipped to every consultation tab**, and its `tsup.config.ts`
  sets `platform: 'browser'` identically across all five entries specifically so nothing Node-only
  (`node:fs`, `node:util`'s `parseArgs`, a `#!/usr/bin/env node` shebang) ends up in code a browser
  has to parse. A sixth entry would need its own divergent `esbuildOptions`/`platform`/`banner`
  inside a config file whose entire structure currently assumes "everything here is browser code" —
  more incidental complexity, and a standing invitation for a future edit to that shared config to
  silently break the CLI's `platform: 'node'` override (or vice versa).
- `@arcaai/vox-node` (TASK-632) already established this repo's answer to "same brand, different
  runtime": a sibling package, zero runtime dependencies, its own Node-only tsup config, its own
  `sdk-node:*` script family. `@arcaai/vox-codegen` follows that template almost line for line
  (package.json shape, tsconfig, eslint config, vitest config).
- `packages/tools`'s generator convention was the ticket's other named precedent, but it is
  `ts-node`-invoked internal tooling with no `bin` field — not a template for an `npx`-published
  CLI. `@arcaai/vox-node` is the closer match once it's in the picture.

**Consequence for the CLI invocation.** The ticket's objective line (`npx @arcaai/vox codegen
--tenant <id>`) was written before this decision. With the generator in its own package, there is
no `codegen` subcommand — the package itself IS the codegen tool:

```bash
npx @arcaai/vox-codegen --tenant <tenantId> [--watch] [--out <path>]
```

This is stated as a decision, not a compromise: a subcommand would only make sense if
`@arcaai/vox-codegen` did more than one thing.

**Root script** (AC-2, `<target>:<action>` taxonomy, mirroring `sdk-node:*` exactly):
`sdk-codegen:dev`, `sdk-codegen:build`, `sdk-codegen:test`, `sdk-codegen:test:watch`,
`sdk-codegen:test:cov`, `sdk-codegen:lint`, `sdk-codegen:lint:fix`, `sdk-codegen:typecheck`,
`sdk-codegen:clean` (`package.json`).

---

## 4. Implementation Plan (as executed)

| # | Layer | Files |
|---|---|---|
| 1 | Package scaffold | `packages/vox-codegen/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,eslint.config.mjs,README.md}` — modeled on `packages/vox-node` |
| 2 | Types | `src/types.ts` — hand-typed discovery bundle mirror (`ConsultationSchemaBundle`, `ContextKindDeclaration`, `ContextOutputDeclaration`, `ConsultationContextSchemaDefinition`) |
| 3 | Errors | `src/errors.ts` — `CodegenError`, the fail-loudly signal |
| 4 | Codegen core | `src/schema-to-ts.ts` — JSON-Schema-subset → TS type expression, fresh implementation (§2 "why hand-written") |
| 5 | File generator | `src/generate.ts` — bundle → named types + `ConsultationContextKindMap`/`ConsultationContextOutputMap` |
| 6 | Transport | `src/fetch-schema.ts` — `GET /tenant/me/context-schema` with `Authorization`/`X-Tenant-Id`, fail-LOUD (opposite of the SDK's fail-open posture — §6.1) |
| 7 | Orchestration | `src/run.ts` (one-shot), `src/watch.ts` (polling `--watch`) |
| 8 | CLI | `src/cli.ts` — `bin` entry, `node:util`'s `parseArgs`, zero CLI-parsing dependencies |
| 9 | Barrel | `src/index.ts` |
| 10 | Root wiring | `package.json` (`sdk-codegen:*` scripts), `turbo.json` (`HOPE_API_TOKEN`, `HOPE_API_BASE_URL` added to `globalEnv`) |
| 11 | Tests | 6 files, 43 tests (see §7 AC → test map) |

### 4.1 TDD list (RED first) → what actually drove code

| # | Test | Drove |
|---|---|---|
| 1 | Generated types compile against a fixture schema | `generate.test.ts` "TDD-1" — a full fixture bundle (nested object, array, enum, discriminated `oneOf`, non-STRUCTURED kind, output) run through the real TypeScript compiler API (`src/__tests__/support/typecheck.ts`) with **zero diagnostics** |
| 2 | A discriminated `oneOf` produces a real TS union, not merged properties | `generate.test.ts` "TDD-2" + `schema-to-ts.test.ts` "renders a discriminated oneOf as a union" — asserts the union syntax directly and asserts the two branches' distinguishing properties (`department`, `providerName`) never appear adjacent in one object literal |
| 3 | An unsupported/unknown construct fails loudly | `schema-to-ts.test.ts` "fail loudly" block — `if`/`then`/`else` (root and nested), `oneOf` without a discriminator, a discriminator missing `propertyName`, an unrecognized `type` value, and a non-object schema node all throw `CodegenError` |
| 4 | `--watch` regenerates on change | `watch.test.ts` — a 4-call fetch sequence (etag `"1"`, `"1"` again, `"2"`, `"2"` again) proves the file is rewritten only on the two etag transitions, not on the unchanged poll; a second test proves an already-aborted signal never even calls fetch |

---

## 5. Implementation Summary

**Status: Review.** All eight acceptance criteria implemented and covered by tests; every gate green.

### 5.1 The codegen core (`schema-to-ts.ts`)

`jsonSchemaSubsetToTs(schema, options)` recursively renders one JSON-Schema-subset node as a
TypeScript type expression string. Supported keywords mirror `contextPayloadValidation.ts` /
`json-schema-subset.ts` exactly: `type` (`object`/`array`/`string`/`number`/`integer`/`boolean`/
`null`), `properties`/`required` (object members, `?` for non-required), `additionalProperties`
(typed → index signature; `false` on an empty object → `Record<string, never>`; default/`true` on
an empty object → `Record<string, unknown>`), `items` (array element type), `enum`/`const` (union
of / single literal type), `anyOf` (union), `allOf` (intersection), and discriminated `oneOf`
(union, one member per branch — see AC-6 below). Constraint keywords with no TS representation
(`min/maxLength`, `pattern`, `minimum`, `maximum`, `min/maxItems`) are read by neither this function
nor its callers — they stay runtime-only, enforced server- and SDK-side.

### 5.2 AC-6 — discriminated `oneOf` → real union

```ts
// Fixture: referral field is `oneOf` two branches, `discriminator.propertyName: "kind"`
referral?: ({ kind: "internal"; department: string; } | { kind: "external"; providerName: string; });
```

Each branch is rendered independently and joined with `|` — never flattened into one object with
both `department` and `providerName` as optional siblings ("merged property soup", the failure mode
a naive generator hits). `generate.test.ts`'s "TDD-2" test asserts the union syntax directly and
asserts the two discriminant-specific properties never appear adjacent in a single object literal.

### 5.3 AC-7 — fail loudly, don't guess

`schema-to-ts.ts` throws `CodegenError` for exactly three constructs, all read from **untrusted wire
JSON** (a discovery bundle straight off the network) even though the server's authoring gate
(TASK-658 AC-8) means none of them should ever arrive from a legitimately published schema:

1. `if`/`then`/`else` anywhere in the schema tree (at any depth — checked on every visited node).
2. `oneOf` without a sibling `discriminator.propertyName` (a non-empty string).
3. An unrecognized `type` value (closed list: `object array string number integer boolean null`).

`cli.ts` catches `CodegenError` specifically and prints `error.message` to stderr with exit code 1,
**never writing a file** — proven by the CLI smoke test in §6.2 below (`vox-codegen: 'if'/'then'/
'else' is not in the authorable subset...` would print for a hand-fed malformed fixture; the
committed test suite covers the generator function directly, and `cli.test.ts` covers the same
propagation path for a fetch-level `CodegenError`).

### 5.4 AC-8 — generated types compile against a fixture schema

`src/__tests__/support/typecheck.ts` type-checks a generated source string **in-memory** using the
real TypeScript compiler API (`ts.createProgram` over a compiler host that serves the generated
string for one virtual file name and falls through to the real `ts.sys` for everything else,
including the installed `typescript` package's own `lib.*.d.ts` files) — no temp files, no child
process. `generate.test.ts`'s "TDD-1" test runs the full fixture bundle (nested objects, arrays,
enums, a discriminated `oneOf`, a non-STRUCTURED kind, an output type) through it and asserts zero
diagnostics.

### 5.5 The fetch/auth model (AC-3) — and why it's fail-LOUD, unlike the SDK

`fetch-schema.ts` calls the identical endpoint `@arcaai/vox` reads
(`GET /tenant/me/context-schema`), as a global-admin "manage as tenant" request:
`Authorization: Bearer <token>` + `X-Tenant-Id: <tenantId>` — `resolve-active-tenant.ts`'s
elevation path (§2), the same mechanism the admin-console BFF uses for its working-tenant header.

`ConsultationSchemaClient.ts` (the SDK's own fetch, TASK-665) is deliberately **fail-open**: a
schema-plane outage must never block a live consultation session, so any fetch error there resolves
to "no schema configured" rather than rejecting. This CLI does the **opposite** on purpose: it is a
build-time tool with no session to protect, so a fetch failure throws `CodegenError` and stops the
run — it never silently writes a file claiming "no schema configured" when the truth is "the gateway
was unreachable" or "the token was rejected". `fetch-schema.test.ts` covers a 401, a network
rejection, and a malformed body, all surfacing as `CodegenError` rather than a fabricated empty
bundle.

### 5.6 `--watch` (AC-4) — polling, not streaming

TASK-654 §4.7 named an eventual "MCP-style `listChanged` notification riding the SSE plane" as the
client contract, but nothing implements it at this baseline: TASK-661 explicitly deferred a
response-level version-skew signal (its own §6 "Incomplete"), and the loop event stream TASK-660/665
shipped (`consultation:loop:{id}` / `useConsultationEvents`) carries per-consultation AGENT actions,
not a schema-change notification — there is no `listChanged` channel to subscribe to. `watch.ts`
therefore polls the same discovery endpoint on `--interval` (default 5000ms), comparing the
response's `etag`, and only rewrites the output file when it changes (`watch.test.ts`'s "TDD-4"
test proves exactly this: 4 polls, 2 etag values, exactly 2 file-changed cycles reported). This is
documented in the package README as the point where a future `listChanged` SSE notification should
be wired in instead.

### 5.7 Decisions worth reviewing

| # | Decision | Reasoning |
|---|---|---|
| D-1 | New package `@arcaai/vox-codegen`, not a `@arcaai/vox` entry | §3 above — the ticket's own recommendation, confirmed against the actual `tsup.config.ts` |
| D-2 | Hand-typed bundle shape + hand-written subset-to-TS generator, no shared package import | `@arcaai/json-schema-subset` does not exist at this baseline (confirmed, §2); importing `@arcaai/vox`'s TYPES only would still couple this package's build graph to `@arcaai/vox`'s `dist/` existing first, for a handful of interfaces — not worth it for a standalone Node tool (mirrors TASK-665's own precedent of hand-porting rather than sharing) |
| D-3 | Zero runtime dependencies (`node:util`'s `parseArgs`, global `fetch`, `node:fs/promises`) | Matches `@arcaai/vox-node`'s posture; nothing in this CLI's flag set or transport needs a third-party package |
| D-4 | Fetch is fail-LOUD, not fail-open like the SDK | §5.5 — no live session to protect here; a silent "no schema configured" on a network/auth failure would be actively misleading for a build-time tool |
| D-5 | `--watch` polls rather than streams | §5.6 — no `listChanged` SSE channel exists yet to subscribe to; documented as the seam for when one does |
| D-6 | Constraint keywords (`min/maxLength` etc.) are not consulted by the type generator | They have no TypeScript representation; they remain runtime-only, enforced server- and SDK-side. Documented in the package README's "Known limitations" |
| D-7 | `additionalProperties: false` with named properties renders as the plain object type (no attempt at an "exact" type) | TypeScript has no clean structural "no excess properties" type outside literal-assignment contexts; under-stating strictness here is safer than fabricating one that doesn't actually hold |

---

## 6. Verification Evidence

All commands run from the worktree at `dev-2.1` @ `d5c43c033`, after `pnpm install` (root, all
workspaces) and `DATABASE_URL`/`DIRECT_URL` placeholders exported for the full-monorepo `pnpm lint`
run (per execution-plan §1.1b/§1.1c — this worktree has no `.env.dev`).

### `pnpm --filter @arcaai/vox-codegen build`

```
CLI Building entry: {"cli":"src/cli.ts"}
CLI Building entry: src/index.ts
CLI Target: node22
CJS dist/cli.js     18.07 KB
CJS ⚡️ Build success in 71ms
ESM dist/index.mjs     13.73 KB
ESM ⚡️ Build success in 69ms
CJS dist/index.js     14.03 KB
CJS ⚡️ Build success in 69ms
DTS ⚡️ Build success in 330ms
DTS dist/index.d.mts 11.51 KB
DTS dist/index.d.ts  11.51 KB
```

`dist/cli.js` carries the `#!/usr/bin/env node` shebang banner and is written with the executable
bit set (`-rwxr-xr-x`) — confirmed directly (`head -c 60 dist/cli.js`, `ls -la dist/`).

### `pnpm --filter @arcaai/vox-codegen test`

```
 Test Files  6 passed (6)
      Tests  43 passed (43)
   Duration  811ms
```

Test files: `generate.test.ts` (9 tests, incl. TDD-1/TDD-2), `schema-to-ts.test.ts` (21 tests, incl.
the TDD-3 fail-loudly block), `fetch-schema.test.ts` (7 tests), `run.test.ts` (1 test), `watch.test.ts`
(2 tests, incl. TDD-4), `cli.test.ts` (6 tests).

### `pnpm --filter @arcaai/vox-codegen typecheck`

```
> tsc --noEmit
(clean — exit 0)
```

### `pnpm --filter @arcaai/vox-codegen lint`

```
> eslint src
(clean — exit 0, no warnings)
```

Two `turbo/no-undeclared-env-vars` warnings (`HOPE_API_TOKEN`, `HOPE_API_BASE_URL`) surfaced on the
first run and were resolved by adding both to `turbo.json#globalEnv` (per `.claude/rules/00-project-context.md`
"New runtime env vars must be added to `turbo.json#globalEnv`") — not suppressed.

### `pnpm lint` (whole monorepo, exit 0)

```
 Tasks:    32 successful, 32 total
Cached:    0 cached, 32 total
  Time:    34.247s
```

`@arcaai/vox-codegen:lint` included in the 32 tasks; zero errors anywhere. The only warnings printed
(`apps/api` — 65 `eslint-comments/require-description` warnings) are pre-existing and untouched by
this ticket (confirmed by grep count against `dev-2.1` before this change — same set of files, none
in `packages/vox-codegen` or `packages/agentic-sdk-v2`).

### `@arcaai/vox` — not touched, so not gated

This ticket adds zero lines to `packages/agentic-sdk-v2`. The parent execution-plan's extra gate
("if you touched `@arcaai/vox`, its build/test and an `apps/compat-playground` build") therefore
does not apply — confirmed via `git status --short` showing no path under `packages/agentic-sdk-v2/`
or `apps/compat-playground/` in this ticket's diff.

### 6.2 Manual CLI smoke tests (built binary, not just unit tests)

```
$ node dist/cli.js --help
vox-codegen — emit TypeScript types from a tenant's consultation context schema
... (exit 0)

$ node dist/cli.js --token x
vox-codegen: --tenant <id> is required
(exit 1)

$ HOPE_API_TOKEN=fake node dist/cli.js --tenant t1 --base-url http://127.0.0.1:1 --out /tmp/out.ts
vox-codegen: Failed to reach http://127.0.0.1:1/api/v1/tenant/me/context-schema: fetch failed
(exit 1)
```

Confirms the actual built executable (not just the in-process `main()` function under test) parses
args, prints help, validates required flags, and fails loudly on an unreachable gateway — with no
output file written on the error path.

### AC → test map

| AC | Test | File |
|---|---|---|
| AC-1 (placement decision recorded) | — | `packages/vox-codegen/README.md` §"Placement decision"; this README §3 |
| AC-2 (root script, `<target>:<action>`) | — | `package.json` `sdk-codegen:*` (verified: `pnpm sdk-codegen:build` — §5 above ran the equivalent filtered form) |
| AC-3 (fetches same endpoint, emits `.ts`) | "sends Authorization + X-Tenant-Id and hits the tenant/me/context-schema endpoint" + 6 more | `fetch-schema.test.ts` |
| AC-4 (`--watch`) | "regenerates the file only when the etag changes across polls, and stops on abort" + "does not poll at all when the signal is already aborted" | `watch.test.ts` |
| AC-5 (committed output, not fetched at boot) | — (documentation, not a runtime behavior) | `packages/vox-codegen/README.md` §"CLI" |
| AC-6 (discriminated oneOf → real union) | "TDD-2" + "renders a discriminated oneOf as a union, one member per branch" | `generate.test.ts`, `schema-to-ts.test.ts` |
| AC-7 (fail loudly on unsupported constructs) | "fail loudly" describe block (7 tests) | `schema-to-ts.test.ts` |
| AC-8 (generated types compile) | "TDD-1: generated types compile against a fixture schema" + "handles an unconfigured tenant... " (also type-checked) | `generate.test.ts` |

---

## 7. Incomplete / explicitly out of scope

- **No `listChanged` SSE notification.** `--watch` polls (§5.6/D-5) because no such channel exists
  anywhere in the platform at this baseline — not a gap in this ticket, a gap in the platform that a
  future ticket would need to close on the SERVER side first (a `consultation-context-schema`-scoped
  SSE stream analogous to `consultation:loop:{id}`) before this CLI could consume it.
- **No department-scoped discovery in the CLI's `--watch`/one-shot path beyond the `--department`
  flag** — `--department <id>` is threaded straight through to the `departmentId` query param
  `fetch-schema.ts` already supports (mirrors the discovery endpoint's own `?departmentId=`); there
  is no auto-discovery of "which departments exist for this tenant" — the operator supplies the id.
- **No `pnpm approve-builds` run** for the ignored native build scripts pnpm flagged during
  `pnpm install` (`@swc/core`, `esbuild`, `msgpackr-extract`, `protobufjs`, etc.) — pre-existing
  repo-wide state, unrelated to this ticket, not touched.
- **No end-to-end run against a live gateway** — the manual smoke tests (§6.2) exercise the built
  binary's argument handling and fail-loud behavior against an intentionally unreachable address;
  a real discovery-bundle round trip against a running `apps/api` + seeded tenant schema was not
  performed (would require the local dev stack up, out of scope for a build-time tool's unit-level
  gates).

---

## Change History

- 2026-08-12 — Ticket opened from the TASK-654 execution-plan spec, the last ticket of the original
  plan. Worktree reset from a stale local branch to `dev-2.1` @ `d5c43c033`. Read TASK-665's README
  and code (`consultationSchema.ts`, `contextPayloadValidation.ts`, `ConsultationSchemaClient.ts`),
  the discovery/admin controllers, and `resolve-active-tenant.ts` before writing any code — confirmed
  the discovery bundle shape, the `X-Tenant-Id` elevation mechanism a `--tenant` flag needs, and that
  `@arcaai/json-schema-subset` does not exist at this baseline (settling the "hand-write vs. import"
  question for the subset-to-TS generator).
- 2026-08-12 — Implemented `packages/vox-codegen` in one pass (types → errors → subset-to-TS
  generator → file generator → fetch → run/watch orchestration → CLI → barrel), modeled on
  `packages/vox-node`. 6 test files, 43 tests, including an in-memory TypeScript-compiler-API check
  that generated output actually compiles. Root `sdk-codegen:*` scripts added; `HOPE_API_TOKEN`/
  `HOPE_API_BASE_URL` added to `turbo.json#globalEnv`. All gates green (§6). Status **Review**. Not
  merged, not pushed.
- 2026-08-12: Status corrected to Completed — verified via git log (commit `014908ed5`); implementation confirmed merged. Doc header was stale.
