# @arcaai/vox-codegen

Build-time TypeScript codegen CLI for a tenant's HOPE configuration. **Two
modes, mutually exclusive:**

| Mode | Credential | Emits |
|---|---|---|
| `--tenant <id> --token <jwt>` | SUPER_ADMIN JWT | the tenant's consultation CONTEXT SCHEMA (TASK-668) |
| `--tenant <id> --client-id <id> --client-secret <secret>` | SERVICE ACCOUNT (TASK-933) | the same context schema, with a MACHINE credential |
| `--api-key <key> [--agents] [--workflows]` | tenant API key | what the tenant PUBLISHES: `Agent_<Slug>_Input` / `_Output`, `Workflow_<Slug>_Input` / `_Output` (TASK-931) |

Both emit named TS types from the SAME data the runtime reads, and both are an
**accessory to runtime discovery, never a replacement**. A tenant can publish a
new kind, agent version or workflow between two runs of this generator; the
SDK's `useConsultationSchema()` / `hope.agents.list()` remain the wire contract,
and a generated file will not know about the change until regenerated.

Mixing the two is a refusal, not a guess: they authenticate differently, read
different routes and answer different questions, so "which did you mean" has no
safe default.

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
vox-codegen — emit TypeScript types from a tenant's HOPE configuration

CONSULTATION CONTEXT SCHEMA (super-admin JWT, or a service account)
  vox-codegen --tenant <id> --token <jwt> [options]
  vox-codegen --tenant <id> --client-id <id> --client-secret <secret> [options]

  --tenant <id>          Tenant id to generate types for (required)
  --token <jwt>          Bearer token for a SUPER_ADMIN user (or set HOPE_API_TOKEN)
  --client-id <id>       Service-account client id (or set HOPE_SVC_CLIENT_ID)
  --client-secret <s>    Service-account secret (or set HOPE_SVC_CLIENT_SECRET). Prefer the
                         environment variable: an argv secret is visible in `ps`.
  --working-tenant <id>  Tenant to bind the service-account token to (default: --tenant)
  --department <id>      Prefer this department's schema default, falling back to the tenant default
  --out <path>           Output FILE path (default: ./consultation-context-schema.generated.ts)
  --watch                Keep polling and regenerate whenever the schema changes
  --interval <ms>        Poll interval in watch mode (default: 5000)

PUBLISHED AGENTS AND WORKFLOWS (API key — the business plane)
  vox-codegen --api-key <key> [--agents] [--workflows] [options]

  --api-key <key>      Tenant API key (or set HOPE_API_KEY). Never reaches an admin route.
  --agents             Emit Agent_<Slug>_Input / _Output for every published agent
  --workflows          Emit Workflow_<Slug>_Input / _Output for every published workflow
  --out <dir>          Output DIRECTORY (default: ./generated)

COMMON
  --base-url <url>     Gateway origin (default: http://localhost:8868, or HOPE_API_BASE_URL)
  -h, --help           Show this help
```

### The business-plane mode (`--agents` / `--workflows`)

```bash
npx @arcaai/vox-codegen --api-key "$HOPE_API_KEY" --base-url http://localhost:8868 \
  --agents --workflows --out ./src/generated
```

Writes one file per requested plane — `agents.generated.ts`,
`workflows.generated.ts` — so a workflow edit does not dirty the agents another
team imports. Each carries a type pair per entry plus a map keyed by the **slug**,
because the slug is what a call site actually passes:

```ts
import type { Agent_NoteWriter_Input, AgentContractMap, AgentSlug } from './generated/agents.generated';

const input: Agent_NoteWriter_Input = { text: note };
const { output } = await hope.agents.invoke<AgentContractMap['note-writer']['output']>('note-writer', input);
```

**It reads four routes and no admin route:** `GET /agents`, `GET /agents/{slug}`,
`GET /workflows`, `GET /workflows/{slug}/schema`, all with `X-API-Key`. That
restriction is structural rather than a rule to remember — an API key can never
reach `/admin/*` — and it is the right restriction: what a tenant PUBLISHES is
exactly what an integrator needs to type.

An entry whose schema the definition does not declare renders **`unknown`**, not
`Record<string, unknown>`. "No declared contract" and "any contract is fine" are
different facts, and generating the second from the first produces code that
compiles and then 400s.

`--watch` is **not** available here: the context-schema mode polls one endpoint
and compares its `etag`, while a published catalogue is N definitions with no
aggregate validator, so a watch would be an N-request poll that cannot tell
"unchanged" from "not read yet".

**Auth — two credential classes, exactly one per run.**

The CLI calls `GET /tenants/me/context-schema` either way; what differs is the
header, and the difference is not cosmetic.

- **Super-admin JWT** (`--token` / `HOPE_API_TOKEN`) — a "manage as tenant"
  request: `Authorization: Bearer <token>` for a SUPER_ADMIN whose JWT carries an
  empty tenant binding, plus `X-Tenant-Id: <tenantId>`, the same elevation path
  `resolve-active-tenant.ts` implements for the admin-console BFF's "working
  tenant" header. Mint one via `packages/tools/src/gen-dev-token` locally, or a
  real login in CI.
- **Service account** (`--client-id` + `--client-secret`, TASK-933) — the CLI
  exchanges the pair at `POST /auth/service-token` for a short-lived opaque token
  and sends it as `X-Service-Account-Token`. It sends **no `X-Tenant-Id`**: a
  service-account token carries its working tenant, bound at the exchange, so a
  per-request header would be a second and conflicting statement of tenancy.
  `--working-tenant` defaults to `--tenant`; `--tenant` itself then only names
  the subject of the generated file.

This is the mode a BUILD PIPELINE wants. A super-admin JWT is a human's token
with a human's expiry, and the account behind it is a person; the service account
is the platform's machine identity, holds `svc:tenant:context-schema:read`, and
is revocable on its own. Supplying both classes is a refusal, not a preference —
the gateway rejects a request carrying two.

The client secret never appears in an error message this tool emits. Pass it
through `HOPE_SVC_CLIENT_SECRET` rather than argv where you can: an argv secret
is visible in `ps` to every process on the machine for as long as the run lasts.

**`--watch` does not refresh a service-account token.** It is minted once, before
the loop, and the gateway's default TTL is 15 minutes — so a long watch in
service-account mode will eventually 401 and stop. `--watch` is a local authoring
affordance; a pipeline runs the one-shot form.

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

## The `@identity` annotation (TASK-950)

A tenant admin may mark ONE property of a `STRUCTURED` context kind as the
clinician's staff-identifier field (`ContextKindDeclaration.userIdentity`).
When `generate.ts` renders that kind's payload type, the marked property
carries a `/** @identity … */` JSDoc — a documentation hint only, not a type
constraint — noting that a service-account caller's `open()` resolves (or
provisions) the HOPE user from that value. A marker naming a property absent
from the kind's own `fields` is ignored rather than thrown on: the annotation
is best-effort, exactly like the rest of this generator's stance on
untrusted wire JSON.

## The `@role`, `@materializeAs` and `@streamContext` annotations (TASK-951)

Four more markers beside `userIdentity` document the mapping roles a tenant's
schema may declare, all documentation hints only — never a type constraint,
and never authorization:

- `ContextKindDeclaration.department` / `.visitType` / `.externalRef` each
  name ONE property of a `STRUCTURED` kind's `fields`. `generate.ts` renders
  the marked property with a `/** @role department (by code|name) … */`,
  `/** @role visitType … */` or `/** @role externalRef … */` JSDoc,
  alongside — and using the identical field-level mechanism as — the
  `@identity` annotation above. A marker naming an absent property is
  ignored, exactly like `@identity`'s own dangling-marker behaviour.
- `ContextKindDeclaration.materializeAs: 'CASE_NOTE'` and `.streamContext:
  true` mark the KIND itself rather than one property, so `generate.ts`
  attaches `@materializeAs CASE_NOTE` / `@streamContext` at the TYPE level —
  the JSDoc block directly above the kind's `export type` declaration —
  instead of on a member.

An unmarked bundle's generated output is byte-identical to a run of this
generator from before TASK-951; the annotation machinery is a no-op unless a
kind actually declares one of these five markers.

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
