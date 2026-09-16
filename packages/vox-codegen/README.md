# @arcaai/vox-codegen — tenant type generator

`packages/vox-codegen`, npm package `@arcaai/vox-codegen`, bin `vox-codegen`. Versioned in lockstep
with the rest of the SDK family. A Node >= 22 build-time CLI that emits TypeScript types from a
tenant's live HOPE configuration. Two mutually exclusive modes:

| Mode                                                      | Credential      | Emits                                                                                        |
| --------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------- |
| `--tenant <id> --token <jwt>`                             | SUPER_ADMIN JWT | the tenant's consultation context schema                                                     |
| `--tenant <id> --client-id <id> --client-secret <secret>` | service account | the same context schema, with a machine credential                                           |
| `--api-key <key> [--agents] [--workflows]`                | tenant API key  | what the tenant publishes: `Agent_<Slug>_Input`/`_Output`, `Workflow_<Slug>_Input`/`_Output` |

Both families emit named TS types from the same data the runtime reads, and both are an accessory
to runtime discovery, never a replacement — a tenant can publish a new kind, agent version or
workflow between two runs of this generator, and a generated file will not know about the change
until regenerated. Mixing credential classes across a single run is a refusal, not a guess: they
authenticate differently, read different routes and answer different questions.

It is a standalone package (not a `@arcaai/vox` subpath) because `@arcaai/vox` ships only
browser-`platform` tsup bundles and carries no `bin` field; a Node CLI does not belong in a bundle
every consultation tab downloads. It follows `@arcaai/vox-node`'s "same brand, different runtime"
precedent and has no workspace dependencies of its own.

## Layout

| Path                                                   | What it holds                                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`                                           | Argument parsing and the two-mode dispatch                                                                                        |
| `src/fetch-schema.ts` / `src/generate.ts`              | Context-schema mode: fetch + emit                                                                                                 |
| `src/fetch-catalogue.ts` / `src/generate-catalogue.ts` | Business-plane mode: fetch published agents/workflows + emit                                                                      |
| `src/schema-to-ts.ts`                                  | Hand-written JSON-Schema-subset -> TypeScript renderer (mirrors the server's authoring-time subset; no shared package exists yet) |
| `src/run.ts` / `src/run-catalogue.ts` / `src/watch.ts` | One-shot and polling-watch orchestration; each `run*.ts` also exports a `check*Once` sibling for `--check`                        |
| `src/check.ts`                                         | `--check` primitives shared by both modes: timestamp normalization, a unified-style diff, compare-against-disk                    |
| `src/exchange-service-token.ts`                        | Service-account token exchange for the context-schema mode                                                                        |
| `src/errors.ts`                                        | `CodegenError` — thrown on untrusted wire JSON this generator cannot safely render                                                |
| `src/types.ts`                                         | Hand-typed discovery-bundle envelope (kept independent of `@arcaai/vox`'s types on purpose)                                       |
| `src/index.ts`                                         | Programmatic entry point — see below                                                                                              |

## Commands

| Command                                                                                                                       | Effect                      |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `pnpm --filter @arcaai/vox-codegen build` / root `pnpm sdk-codegen:build`                                                     | tsup build                  |
| `pnpm --filter @arcaai/vox-codegen dev` / root `pnpm sdk-codegen:dev`                                                         | tsup watch mode             |
| `pnpm --filter @arcaai/vox-codegen test` / root `pnpm sdk-codegen:test`                                                       | Vitest                      |
| `pnpm sdk-codegen:test:cov`                                                                                                   | Vitest with coverage        |
| `pnpm --filter @arcaai/vox-codegen lint` / root `pnpm sdk-codegen:lint`                                                       | ESLint                      |
| `pnpm --filter @arcaai/vox-codegen typecheck` / root `pnpm sdk-codegen:typecheck`                                             | `tsc --noEmit`              |
| `npx @arcaai/vox-codegen --tenant <id> [--token <jwt> \| --client-id <id> --client-secret <secret>] [--watch] [--out <path>]` | Run the context-schema mode |
| `npx @arcaai/vox-codegen --api-key <key> [--agents] [--workflows] [--out <dir>]`                                              | Run the business-plane mode |

## How it works

### CLI flags

```
CONSULTATION CONTEXT SCHEMA (super-admin JWT, or a service account)
  vox-codegen --tenant <id> --token <jwt> [options]
  vox-codegen --tenant <id> --client-id <id> --client-secret <secret> [options]

  --tenant <id>          Tenant id to generate types for (required)
  --token <jwt>          Bearer token for a SUPER_ADMIN user (or set HOPE_API_TOKEN)
  --client-id <id>       Service-account client id (or set HOPE_SVC_CLIENT_ID)
  --client-secret <s>    Service-account secret (or set HOPE_SVC_CLIENT_SECRET) - prefer the
                         env var, an argv secret is visible in `ps`
  --working-tenant <id>  Tenant to bind the service-account token to (default: --tenant)
  --department <id>      Prefer this department's schema default, falling back to the tenant default
  --out <path>           Output FILE path (default: ./consultation-context-schema.generated.ts)
  --watch                Keep polling and regenerate whenever the schema's etag changes
  --interval <ms>        Poll interval in watch mode (default: 5000)
  --check                Regenerate in memory and compare against --out; exit 1 on drift, without writing

PUBLISHED AGENTS AND WORKFLOWS (API key - the business plane)
  vox-codegen --api-key <key> [--agents] [--workflows] [options]

  --api-key <key>      Tenant API key (or set HOPE_API_KEY). Never reaches an admin route.
  --agents             Emit Agent_<Slug>_Input / _Output for every published agent
  --workflows          Emit Workflow_<Slug>_Input / _Output for every published workflow
  --out <dir>          Output DIRECTORY (default: ./generated)
  --check              Regenerate in memory and compare against --out; exit 1 on drift, without writing

COMMON
  --base-url <url>     Gateway origin (default: http://localhost:8868, or HOPE_API_BASE_URL)
```

### Context-schema mode auth

The CLI calls `GET /tenants/me/context-schema`; what differs is the header. A super-admin JWT
sends `Authorization: Bearer <token>` plus `X-Tenant-Id: <tenantId>` (the "manage as tenant"
elevation path). A service account exchanges `--client-id`/`--client-secret` at
`POST /auth/service-token` and sends the result as `X-Service-Account-Token` with NO
`X-Tenant-Id` — the token carries its working tenant, bound at exchange via `--working-tenant`
(default: `--tenant`). This is the mode a build pipeline wants: the service account is a
revocable machine identity holding `svc:tenant:context-schema:read`, not a human's expiring JWT.

`--watch` does not refresh a service-account token: it is minted once before the loop, and the
gateway's default TTL is 15 minutes, so a long watch in service-account mode eventually 401s and
stops. `--watch` is a local authoring affordance; a pipeline runs the one-shot form. It is also
polling, not streaming — no server-side `listChanged` notification exists yet, so it polls the
discovery endpoint on `--interval` and rewrites the output only when the response `etag` changes.

### Business-plane mode

Reads four routes and no admin route: `GET /agents`, `GET /agents/{slug}`, `GET /workflows`,
`GET /workflows/{slug}/schema`, all with `X-API-Key` — structural, since an API key can never
reach `/admin/*`. The key needs exactly two scopes, which is what the tenant console's
**Type generation (build tools)** purpose grants beside `tenant:context-schema:read`:

```
agent:definition:read
workflow:definition:read
```

Writes one file per requested plane (`agents.generated.ts`,
`workflows.generated.ts`) plus a map keyed by slug:

```ts
import type { Agent_NoteWriter_Input, AgentContractMap } from './generated/agents.generated';

const input: Agent_NoteWriter_Input = { text: note };
const { output } = await hope.agents.invoke<AgentContractMap['note-writer']['output']>('note-writer', input);
```

An entry whose definition declares no schema renders `unknown`, not `Record<string, unknown>` —
"no declared contract" and "any contract is fine" are different facts. `--watch` is not available
in this mode: the context-schema mode polls one endpoint and compares an etag, while a published
catalogue is N definitions with no aggregate validator.

### `--check` — the CI recipe

Both modes accept `--check`: regenerate in memory, compare against whatever is committed at
`--out`, and exit 1 with a diff on drift — never writing. The `Generated: <timestamp>` header
line is normalized out first, so two honest runs a moment apart still compare equal; a
genuinely stale file still fails. `--check` and `--watch` are mutually exclusive on the
context-schema mode (a check is one snapshot, not a poll); the business-plane mode already
refuses `--watch` outright, so the same rule holds there without a second message.

```
vox-codegen --tenant <id> --client-id <id> --client-secret <secret> --out ./generated/schema.ts --check
vox-codegen --api-key <key> --agents --workflows --out ./generated --check
```

### `OpenConsultationContext`

The context-schema mode also emits `export type OpenConsultationContext = { <kind>?: <KindPayload> }`
— one property per STRUCTURED kind with `lifecycle: 'PRE'` whose `producedBy` names `CLIENT`
(a kind marked `required: true` drops the `?`). Pass it as `open()`'s type parameter instead of
an untyped `Record<string, unknown>`:

```ts
import { HopeClient } from '@arcaai/vox-node';
import type { OpenConsultationContext } from './generated/consultation-context-schema.generated';

await hope.consultations.open<OpenConsultationContext>({
  patientId: '123',
  context: { vitals: { systolic: 128, diastolic: 82 } },
});
```

The file header also carries a `@schemaVersion <n>` tag — a machine-grep-able twin of the
human-readable `Schema:` line, present whenever the tenant has a configured version.

### Catalogue mode's workflow tags

Each generated `Workflow_<Slug>_Input` type carries two extra JSDoc tags, read off
`GET /workflows/{slug}/schema`: `@contextSchema <slug> v<n> (follows latest | pinned)` (or
`@contextSchema unbound` for a definition with no consultation trigger) names which schema
version the trigger validates against and whether it tracks the tenant's current pin;
`@reviewNodes <ids>` lists every `core.humanReview` node id in the graph, when there are any —
the id `hope.workflows.reviews.get/decide` need, discoverable without a second read.

### Fail loudly, don't guess

The server's authoring gate rejects `if`/`then`/`else` and `oneOf` without a sibling
`discriminator.propertyName` at publish time, so a legitimately published schema never carries
either. `schema-to-ts.ts` still reads untrusted wire JSON, so on either construct — or an
unrecognized JSON Schema `type` — it throws `CodegenError` rather than emitting a type that lies
about the payload shape; the CLI prints `error.message` to stderr with exit code 1 and lets any
other error crash with its full stack. A discriminated `oneOf` renders as a real TypeScript union,
one member per branch, never a merged "property soup" object.

### Documentation-only annotations

Five markers on a `STRUCTURED` context kind's declaration render as JSDoc hints on the generated
type — never a type constraint or an authorization signal: `userIdentity` (`@identity`),
`department`/`visitType`/`externalRef` (`@role ...`, one per marked property), and
`materializeAs`/`streamContext` (attached at the type level, above the kind's `export type`). A
marker naming a property absent from the kind's own fields is ignored rather than thrown on.

### Known limitations

- Constraint keywords with no TypeScript representation (`minLength`, `pattern`, `minimum`,
  `minItems`, etc.) are not consulted — they stay runtime-only, enforced by the server and the
  SDK at write time. Generated types narrow shape, not those bounds.
- `additionalProperties: false` alongside named properties renders as the plain named-properties
  object (no index signature), not a sealed/exact type — TypeScript has no clean built-in for
  that outside literal-assignment contexts. A fully closed empty object still renders as
  `Record<string, never>`.
- Non-`STRUCTURED` kinds (`STREAM_AUDIO`, `TEXT`, `DOCUMENT`, `IMAGE`) get a one-line comment
  instead of a payload type — `addContext()` never validates a payload for them.

### Programmatic use

```ts
import { fetchConsultationSchemaBundle, generateConsultationSchemaTypes } from '@arcaai/vox-codegen';

const bundle = await fetchConsultationSchemaBundle({ baseUrl, tenantId, token });
const { contents } = generateConsultationSchemaTypes(bundle, { tenantId });
```

Full exported surface: `src/index.ts` (`runCodegenOnce`, `runCatalogueCodegenOnce`,
`watchCodegen`, `jsonSchemaSubsetToTs`, `CodegenError`, and the bundle/catalogue types).

## Gotchas

- The generated file is meant to be committed, like any other source file, and regenerated when
  the tenant's schema or catalogue changes — never fetched or generated at application boot.
- Pass a service-account secret through `HOPE_SVC_CLIENT_SECRET`, not argv — an argv secret is
  visible in `ps` to every process on the machine for the run's duration.
- `CodegenError` on an `if`/`then`/`else` or discriminator-less `oneOf` means the upstream schema
  was published in a shape this generator (and the server's own authoring gate) should never
  have allowed through — treat it as a signal to check the source schema, not a generator bug.

## Related

- [`@arcaai/vox`](../agentic-sdk-v2/README.md) — the runtime discovery this generator is an
  accessory to (`useConsultationSchema()`, `hope.agents.list()` never go stale; a generated file
  can).
- [`@arcaai/vox-node`](../vox-node/README.md) — the server SDK a generated `agents.generated.ts`
  / `workflows.generated.ts` pairs with.
- [`docs/guides/client-integration-guide.md`](../../docs/guides/client-integration-guide.md) —
  chapter 2 is this CLI in its place in the whole integration.
- `.claude/rules/08-vox-sdk.md` — SDK architecture rules.
