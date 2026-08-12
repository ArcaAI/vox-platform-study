# @arcaai/vox-codegen

Build-time TypeScript codegen CLI for a tenant's `ConsultationContextSchema`
(TASK-668). Emits named TS types from the SAME discovery bundle `@arcaai/vox`
reads at session start (`GET /tenant/me/context-schema`, TASK-658/661) — an
**accessory to runtime discovery, never a replacement**. A tenant can publish
a new kind between two runs of this generator; the SDK's
`useConsultationSchema()` remains the wire contract, and this file will not
know about the change until regenerated.

## Placement decision (recorded per the ticket)

`packages/agentic-sdk-v2` (`@arcaai/vox`) has no `bin` field, and every tsup
entry is `platform: 'browser'` (`tsup.config.ts`'s `sharedOptions.esbuildOptions`
sets `options.platform = 'browser'` for all five entries — main, core, compat,
plugins, plugins-med-ner). Two options existed:

1. Add a sixth, Node-platform tsup entry to `@arcaai/vox` that overrides
   `sharedOptions`, plus a `bin` field on that package.
2. Put the generator in its own workspace package — the repo's existing
   `packages/tools` generator convention (and, more recently,
   `packages/vox-node`'s "same brand, different runtime" precedent).

**Chose option 2**, per the ticket's own recommendation, and did not find a
reason to override it:

- A Node CLI does not belong in a browser bundle that ships to every
  consultation tab and whose size is actively policed (`tsup.config.ts`'s own
  header in `@arcaai/vox` documents per-entry bundle-size budgets).
- `@arcaai/vox`'s `sharedOptions.esbuildOptions` sets `platform: 'browser'`
  identically across every entry specifically so nothing Node-only (like
  `node:fs`, `node:util`'s `parseArgs`, or a `#!/usr/bin/env node` shebang)
  ends up in a bundle a browser has to parse. A sixth entry would need its
  own divergent `esbuildOptions`/`platform`/`banner` inside a config file
  whose entire structure currently assumes "everything here is browser code"
  — more incidental complexity than a second package.
- `@arcaai/vox-node` (TASK-632) already established the pattern this repo
  uses for "same brand, different runtime": a sibling package, zero runtime
  dependencies, Node-only tsup config (`platform: 'node'`, `target: 'node22'`).
  This package follows that template almost verbatim.

**Consequence for the CLI invocation.** The ticket's objective line reads
`npx @arcaai/vox codegen --tenant <id>`, written before the placement
decision was made. With the generator in its own package, the actual command
is:

```bash
npx @arcaai/vox-codegen --tenant <tenantId> [--watch] [--out <path>]
```

No `codegen` subcommand is needed — the package itself IS the codegen tool,
so there is nothing else it could mean.

## Why the JSON-Schema-subset → TS logic is hand-written, not imported

TASK-665 hand-ported the server's JSON-Schema-subset VALUE evaluator
(`json-schema-subset.ts`, TASK-658) into `@arcaai/vox` rather than importing a
shared package, because `@arcaai/json-schema-subset` did not exist yet at
that baseline. It still does not exist at this baseline (`dev-2.1` @
`d5c43c033` — confirmed by `find packages/json-schema-subset` returning
nothing in this worktree) and this ticket's hard constraints forbid touching
it (a refactor is in flight elsewhere). `schema-to-ts.ts` is therefore a
**fresh, independent implementation** of the same subset semantics —
`type`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const`/
`anyOf`/`allOf`/discriminated `oneOf` — mirroring the same keyword set for
the same reason TASK-665 did: nothing to share against yet. `src/types.ts`
hand-types the discovery bundle envelope for the identical reason, rather
than a type-only import of `@arcaai/vox`'s types, to keep this package a
standalone Node tool with zero workspace dependencies (matching
`@arcaai/vox-node`'s posture) instead of coupling its build graph to a
browser package's `dist/` existing first, for a handful of interfaces. If a
shared types/subset package is ever extracted, this is the first candidate to
migrate onto it.

## CLI

```
vox-codegen — emit TypeScript types from a tenant's consultation context schema

Usage:
  vox-codegen --tenant <id> [options]

Options:
  --tenant <id>       Tenant id to generate types for (required)
  --token <jwt>       Bearer token for a GLOBAL_ADMIN user (or set HOPE_API_TOKEN)
  --base-url <url>    Gateway origin (default: http://localhost:8868, or HOPE_API_BASE_URL)
  --department <id>   Prefer this department's schema default, falling back to the tenant default
  --out <path>        Output file path (default: ./consultation-context-schema.generated.ts)
  --watch              Keep polling and regenerate whenever the schema changes
  --interval <ms>       Poll interval in watch mode (default: 5000)
  -h, --help              Show this help
```

**Auth.** The CLI calls `GET /tenant/me/context-schema` as a global-admin
"manage as tenant" request: `Authorization: Bearer <token>` for a
GLOBAL_ADMIN whose JWT carries an empty tenant binding, plus
`X-Tenant-Id: <tenantId>` — the same elevation path
`resolve-active-tenant.ts` implements for the admin-console BFF's "working
tenant" header. `--token`/`HOPE_API_TOKEN` is expected to be such a token
(e.g. minted via `packages/tools/src/gen-dev-token` locally, or a real login
in CI).

**Committed output, not fetched at boot.** The generated file is meant to be
committed by the integrator, like any other source file, and regenerated
when the tenant's schema changes — never fetched or generated at application
boot.

**`--watch` is polling, not streaming.** TASK-654 §4.7 named an eventual
"MCP-style `listChanged` notification riding the SSE plane" as the client
contract, but nothing implements it at this baseline: TASK-661 explicitly
deferred a response-level version-skew signal, and the loop event stream
TASK-660/665 shipped (`consultation:loop:{id}` / `useConsultationEvents`)
carries per-consultation AGENT actions, not a schema-change notification —
there is no `listChanged` channel to subscribe to yet. `--watch` therefore
polls the same discovery endpoint on `--interval` (default 5000ms),
comparing the response `etag`, and only rewrites the output file when it
changes. If a `listChanged` SSE notification ships later, `src/watch.ts` is
the function to point at it instead.

## Fail loudly, don't guess

The server's authoring gate (TASK-658 AC-8) rejects `if`/`then`/`else` at
publish, and rejects `oneOf` without a sibling `discriminator.propertyName` —
so a legitimately published schema never carries either. `schema-to-ts.ts`
reads untrusted wire JSON, though, so on either construct — or an
unrecognized JSON Schema `type` value — it throws `CodegenError` rather than
silently emitting a type that lies about the payload shape. The CLI catches
`CodegenError` specifically and prints `error.message` to stderr with exit
code 1; anything else (a genuine bug) is left to crash with its full stack.

A discriminated `oneOf` renders as a real TypeScript union, one member per
branch (e.g. `{ kind: "internal"; department: string } | { kind: "external";
providerName: string }`) — never a single object with every branch's
properties merged together as optional siblings ("property soup"), which is
what a naive generator would emit.

## Known limitations

- Constraint keywords with no TypeScript representation
  (`minLength`/`maxLength`/`pattern`/`minimum`/`maximum`/`minItems`/`maxItems`)
  are intentionally not consulted by the type generator — they remain
  runtime-only concerns, enforced by the server (`json-schema-subset.ts`) and
  the SDK (`contextPayloadValidation.ts`) at write time. Generated types
  narrow *shape*, not those bounds.
- `additionalProperties: false` on an object that also declares named
  properties is rendered as the plain object type (named properties only, no
  index signature) rather than an exact/sealed type — TypeScript's structural
  typing does not have a clean built-in "no excess properties" type outside
  literal-assignment contexts, so this under-states strictness rather than
  fabricate one. A fully closed empty object (`additionalProperties: false`,
  no properties) still renders as `Record<string, never>`.
- Non-`STRUCTURED` kinds (`STREAM_AUDIO`, `TEXT`, `DOCUMENT`, `IMAGE`) get a
  one-line comment instead of a payload type — `addContext()` never
  validates a `payload` for them (TASK-665 §4.2), so there is nothing to
  type.

## Programmatic use

```ts
import { fetchConsultationSchemaBundle, generateConsultationSchemaTypes } from '@arcaai/vox-codegen';

const bundle = await fetchConsultationSchemaBundle({ baseUrl, tenantId, token });
const { contents } = generateConsultationSchemaTypes(bundle, { tenantId });
```

See `src/index.ts` for the full exported surface (`runCodegenOnce`,
`watchCodegen`, `jsonSchemaSubsetToTs`, `CodegenError`, and the bundle
types).

## Commands

`pnpm --filter @arcaai/vox-codegen build test lint typecheck` (root
shortcuts: `pnpm sdk-codegen:build`, `sdk-codegen:test`, `sdk-codegen:lint`,
`sdk-codegen:typecheck`).
