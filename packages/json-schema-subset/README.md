# @arcaai/json-schema-subset

The constrained JSON Schema (draft 2020-12) subset a tenant may author for a
`ConsultationContextSchema` kind, plus the evaluator that validates a submitted
payload against it.

## Why this package exists

The rule previously existed in **three** independent copies — the server
(TASK-658), the browser SDK (TASK-665) and the admin console (TASK-666) — each
for a defensible reason: neither the SDK nor the console can depend on
`@arcaai/applications`, which is server-only, and both must evaluate a
tenant-authored schema at *runtime* rather than compile against a static one.

Three implementations of one clinical validation rule drift, and the drift is
silent in both directions: a payload the console accepts but the server
rejects (bad UX), or one every layer accepts for a different reason (bad
data). This package is the single implementation all three consume.

**The server is still the authoritative enforcement point.** The SDK and
console call these functions as a fast-fail UX aid, never as the gate — but
they can now only ever agree with the server, because it is the same code.

## API

| Export | Purpose |
|---|---|
| `authorableJsonSchemaProblems(schema, path?)` | Structural problems with an **authored** schema. Rejects `if`/`then`/`else` at any depth, requires a sibling `discriminator.propertyName` on `oneOf`, bounds depth to `MAX_SCHEMA_DEPTH` and node count to `MAX_SCHEMA_NODES`. Empty array = authorable. |
| `jsonSchemaValueProblems(schema, value, path?)` | Problems with a submitted **value** against an authored schema. Empty array = conforms. |
| `MAX_SCHEMA_DEPTH` (12), `MAX_SCHEMA_NODES` (512) | The authoring bounds. |

Both return problem strings rather than throwing, so a caller can surface every
problem in one response.

## Constraints

- **Zero runtime dependencies, permanently.** This package is bundled into
  `@arcaai/vox`, which ships to every consultation tab and whose bundle size is
  actively policed. No ajv, no zod, no `@arcaai/*` imports.
- **One test suite lives here** (`src/__tests__/`). Do not re-create per-consumer
  copies of it — that is the duplication this package removed.
- Dual CJS/ESM output so the NestJS server (`moduleResolution: node`) and the
  bundled browser consumers can both use it.

## Consumers

| Consumer | Uses | Notes |
|---|---|---|
| `@arcaai/applications` | both functions | Authoritative: publish-time authoring gate + payload write validation |
| `@arcaai/vox` | `jsonSchemaValueProblems` | Wrapped by `validateConsultationContextPayload`; bundled into the SDK dist |
| `@arcaai/admin-console` | both functions | Editor field builder, publish preview, payload tester |
