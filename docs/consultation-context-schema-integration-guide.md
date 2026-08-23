# Consultation Context Schema — Developer Integration Guide

Owner: Platform Engineering · Introduced: 2026-08-23 · Verified against `dev-2.2`

How to build an integration against a tenant-declared **consultation context schema** — the
declaration a tenant admin authors and the agentic consultation loop is built on top of.

Two lanes, one schema:

| Lane | Package | You are writing | Section |
|---|---|---|---|
| **Backend / server** | `@arcaai/vox-node` + `@arcaai/vox-codegen` | Node/Bun/Deno/edge service, batch job, integration adapter | [§4](#4-backend-lane) |
| **Frontend / browser** | `@arcaai/vox` + `@arcaai/vox-codegen` | React consultation UI | [§5](#5-frontend-lane) |

Both lanes generate types with the **same CLI** — `@arcaai/vox-codegen` emits plain TypeScript with
zero runtime imports, so one generated file serves a browser app, a Node service, or both.

---

## 1. The model in one page

A tenant admin declares *what kinds of context a consultation carries*. Clients discover that
declaration at runtime; the server validates every submitted payload against the **pinned** version
of it.

Three rows, the house governance triple (same shape as `PromptTemplate`/`PromptVersion`):

| Row | Mutability | What it is |
|---|---|---|
| `ConsultationContextSchema` | mutable head | What the admin edits; carries `slug`, `scope`, `isDefault`, lifecycle |
| `ConsultationContextSchemaVersion` | **immutable** | One published `definition` snapshot + `checksum`. A correction is a new version, never an edit |
| `ConsultationContextSchema.pinnedVersionNumber` | movable pin | Which snapshot discovery serves and validation runs against. `NULL` until first publish — an unpinned schema is never served |

Source of truth: [`consultation-context-schema.prisma`](../packages/database/src/prisma/db_main/consultation-context-schema.prisma).

### The declaration (`definition`)

```jsonc
{
  "schemaVersion": "1.0",              // the only value this platform understands
  "kinds": [ /* 1..64 */ ],
  "outputs": [ /* optional; counts against the same 64 ceiling */ ]
}
```

Each `kinds[]` entry invents **tenant vocabulary** but must declare exactly one of five **platform
primitives**. Rejecting an unknown primitive at publish is the enforcement point that keeps tenant
vocabulary on platform substrate:

| Primitive | Substrate | Has `fields`? |
|---|---|---|
| `STREAM_AUDIO` | STT session + `AudioRecording` | no |
| `TEXT` | encrypted `ContextItem.content` | no |
| `DOCUMENT` | Media + object storage, text via OCR | no |
| `IMAGE` | Media + object storage | no |
| `STRUCTURED` | encrypted JSON validated against `fields` | **yes** |

Kind fields: `key` (`^[a-z0-9_]{2,48}$`), `label`, `primitive`, `phiClass` (`PHI`\|`NON_PHI`),
`cardinality` (`ONE`\|`MANY`), `lifecycle` (`PRE`\|`DURING`\|`POST`\|`ANY`), `producedBy`
(`CLIENT`\|`AGENT`\|`SYSTEM`), plus optional `required`, `description`, `fields`, `constraints`,
`deprecated`. Unknown keys are **rejected** — validation is fail-closed on shape and returns every
problem at once. Contract:
[`context-schema-definition.ts`](../packages/applications/src/services/consultation-context-schema/context-schema-definition.ts).

`fields` is a **JSON Schema draft-2020-12 subset** (`@arcaai/json-schema-subset`) — no
`if`/`then`/`else`, no undiscriminated `oneOf`. Both the server and the browser SDK evaluate
payloads with that one shared implementation.

### Discovery resolution

`GET /api/v1/tenants/me/context-schema[?departmentId=...]` returns the **resolved, pinned** bundle:

```
DEPARTMENT-scoped default (when departmentId given and one exists)  →  TENANT-scoped default
```

An unconfigured tenant gets **200 with every field `null` and `etag: "none"`** — deliberately not a
404, which a client cannot tell apart from a routing mistake. Handle it; don't treat it as an error.

```ts
interface ConsultationSchemaBundle {
  schemaId: string | null;
  slug: string | null;
  name: string | null;
  versionNumber: number | null;          // the PINNED number, never "latest"
  contextSchemaVersionId: string | null; // ← what you send back on writes
  checksum: string | null;
  definition: { schemaVersion: string; kinds: [...]; outputs?: [...] } | null;
  etag: string;                          // strong validator, or "none"
}
```

---

## 2. The one rule that governs both lanes

> **Codegen is a build-time accessory to runtime discovery, never a replacement for it.**

A tenant can publish a new kind — or deprecate one — between two runs of the generator. The
generated file will not know until you regenerate. So:

- **Never gate application logic on the generated types alone.** They are compile-time ergonomics.
- **Always keep the runtime discovery read** (`useConsultationSchema()` in the browser; your own
  `GET /tenants/me/context-schema` on the server) as the wire contract.
- **Always pin the write.** Send `X-Context-Schema-Version: <contextSchemaVersionId>` — the version
  you actually read — on every `kindKey` write, so a mid-consultation publish never silently
  upgrades or breaks a caller. The browser SDK does this for you; a backend integration must do it
  by hand (§4.4).
- **Unknown kind ⇒ let the server decide.** Client-side validation is permissive by design: an
  unresolvable `kindKey` passes locally, because the kind may be genuinely newer than your build.
  The server is the final authority and validates independently.

---

## 3. Generating types — `@arcaai/vox-codegen`

One CLI, runtime-agnostic output. Package:
[`packages/vox-codegen`](../packages/vox-codegen/README.md).

### 3.1 Run it

```bash
npx @arcaai/vox-codegen --tenant <tenantId> --out ./src/generated/consultation-context.ts
```

In-monorepo (before the package is installed from the registry):

```bash
pnpm sdk-codegen:build && node packages/vox-codegen/dist/cli.js --tenant <tenantId> --out ./src/generated/consultation-context.ts
```

| Flag | Meaning |
|---|---|
| `--tenant <id>` | **Required.** Tenant to generate for |
| `--token <jwt>` | Bearer token — or `HOPE_API_TOKEN` |
| `--base-url <url>` | Gateway origin — or `HOPE_API_BASE_URL` (default `http://localhost:8868`) |
| `--department <id>` | Prefer that department's schema, falling back to the tenant default |
| `--out <path>` | Output file (default `./consultation-context-schema.generated.ts`) |
| `--watch` / `--interval <ms>` | Poll discovery and rewrite on ETag change (default 5000ms) |

### 3.2 Auth — read this before you debug a 403

The CLI calls discovery as a **super-admin "manage as tenant"** request:
`Authorization: Bearer <SUPER_ADMIN jwt with an empty tenant binding>` **plus**
`X-Tenant-Id: <tenantId>` — the same elevation path the admin-console BFF uses for its working
tenant.

It is **not** an API-key call and **not** a service-account call. Locally, mint a token with
`packages/tools/src/gen-dev-token`; in CI, use a real login.

### 3.3 What it emits

A named type per **`STRUCTURED`** kind and output, plus exhaustive lookup maps. Non-`STRUCTURED`
kinds carry no `fields`, so they get a comment, not a type — there is no payload to type for them.

```ts
/**
 * AUTO-GENERATED by @arcaai/vox-codegen — DO NOT EDIT BY HAND.
 * Tenant: 5000...  Schema: general_medicine v3 (0199...)
 */

// ---- Context kinds ----
// `audio_stream` — primitive "STREAM_AUDIO", no structured payload to type.
// `case_note` — primitive "TEXT", no structured payload to type.

/** `vitals` — Vital Signs */
export type VitalsPayload = { systolic: number; diastolic: number; pulse?: number };

export interface ConsultationContextKindMap { vitals: VitalsPayload }
export type ConsultationContextKindKey = keyof ConsultationContextKindMap;

// ---- Outputs ----
export interface ConsultationContextOutputMap { problem_list: ProblemListOutput }
export type ConsultationContextOutputKey = keyof ConsultationContextOutputMap;
```

An unconfigured tenant produces a valid file with `Record<string, never>` maps — not a failure.

### 3.4 Commit the output; fail the build on drift

- The generated file is **committed source**, like any other. Never fetch or generate it at
  application boot.
- Regenerate on every schema publish. Fail loud: the CLI throws on an unreachable gateway rather
  than emitting a "no schema configured" file that lies.
- CI suggestion — regenerate and `git diff --exit-code` the output path, the same discipline
  `gen:admin:check` applies to `@arcaai/vox-node`'s generated admin surface.
- `--watch` is **polling**, not streaming. There is no `listChanged` notification channel today.

---

## 4. Backend lane — `@arcaai/vox-node` + codegen

`@arcaai/vox-node` is Node ≥ 22 / Bun / Deno / edge, zero runtime dependencies, no React. Rules in
[`08-vox-sdk.md`](../.claude/rules/08-vox-sdk.md).

### 4.1 Credentials

| Credential | Header | Reaches |
|---|---|---|
| API key | `X-API-Key` | business plane only — **never** `/admin/*` (`@ForbidApiKey()`, checked before scopes) |
| Service account | `X-Service-Account-Token` | the only path to the admin plane |

Supplying both throws at construction. With a service account, `workingTenantId` binds **at token
exchange**, so never send `X-Tenant-Id` alongside it.

### 4.2 Authoring the schema (fully typed, admin plane)

`hope.admin.consultationContextSchema` is generated from the gateway route manifest and covers all
eight admin routes. Required scope: **`svc:admin:consultation-context-schema:manage`**.

```ts
import { HopeClient } from '@arcaai/vox-node';

const hope = new HopeClient({
  baseUrl: process.env.HOPE_API_BASE_URL!,
  serviceAccount: { clientId, clientSecret, workingTenantId: tenantId },
});

const cs = hope.admin.consultationContextSchema;

const draft = await cs.create({
  slug: 'general_medicine',          // unique per tenant, never reused
  name: 'General Medicine',
  scope: 'TENANT',                   // or 'DEPARTMENT' + departmentId
  isDefault: true,
});

// The DECLARATION is never edited in place — publish writes a new immutable
// version AND moves the pin to it. There is no separate "activate" step.
const published = await cs.publish(draft.id, {
  definition,
  changeReason: 'add vitals kind',
  // allowBreakingChange: true,      // required to remove/rename a kind (see below)
});

// `pin` is for ROLLBACK — choosing an older version, not activating a new one.
await cs.pin(draft.id, { versionNumber: published.pinnedVersionNumber! - 1 });

await cs.listVersions(draft.id);
await cs.list();
await cs.getById(draft.id);

// Metadata-only update, under optimistic concurrency. `ifMatch` is required by
// the type and accepts a row read through this SDK, a version number, or an ETag.
await cs.update(draft.id, { name: 'General Medicine (v2)' }, { ifMatch: published });

await cs.deleteById(draft.id); // soft delete; published versions are never removed
```

Semantics worth knowing:

- **Publish auto-pins.** A successful publish sets `pinnedVersionNumber` to the new version and
  moves `status` to `PUBLISHED` (an `APPROVED` schema stays `APPROVED` — a republish never drops a
  governance sign-off).
- **A breaking publish is refused with 400** — a removed or renamed kind or property, a changed
  primitive/type, or a widened `required`. The response lists every break. Re-submit with
  `allowBreakingChange: true` to acknowledge it.
- **Republish is idempotent by checksum.** An identical `definition` produces no new version and
  does not move the pin.
- **A schema is born `DRAFT` with no pin**, and an unpinned schema is never served. Moving `status`
  back to `DRAFT` makes it unservable again without discarding its published versions.
- `update` is metadata only (`name`, `description`, `isDefault`, `status`, `templateLocked`).
  `If-Match` required → drift answers **412**, a missing header **428**. Publishing is deliberately
  *not* a compare-and-set, so it never fails on an unrelated concurrent metadata edit.
- Delete never removes published versions: a `ContextItem` stamped with one must resolve it forever.

### 4.3 Generating and using types on the server

Same CLI, same output — the generated file has no browser dependency:

```bash
npx @arcaai/vox-codegen --tenant "$TENANT_ID" --out ./src/generated/consultation-context.ts
```

```ts
import type {
  ConsultationContextKindKey,
  ConsultationContextKindMap,
} from './generated/consultation-context';

function buildContext<K extends ConsultationContextKindKey>(
  kindKey: K,
  payload: ConsultationContextKindMap[K],
) {
  return { kindKey, payload };
}
```

### 4.4 Submitting context from a backend — the gap, stated plainly

**`@arcaai/vox-node` has no typed business-plane context surface today.** `hope.consultations`
exposes `get()` and the `.summaries` sub-resource, nothing else; there is no `addContext`, no
discovery read, and `Transport` is deliberately not exported — so there is no escape hatch to route
a raw call through the client.

Until a resource is added, a backend integration calls the gateway directly. Handle discovery and
version pinning yourself:

```ts
const API = `${process.env.HOPE_API_BASE_URL}/api/v1`;
const auth = { 'X-API-Key': process.env.HOPE_API_KEY!, 'Content-Type': 'application/json' };

// 1. Discover — scope `tenant:context-schema:read`; `tenants/me` resolves to the KEY'S TENANT.
const bundle = await (await fetch(`${API}/tenants/me/context-schema`, { headers: auth })).json();

// 2. Write, PINNED to the version you just read.
await fetch(`${API}/consultations/${consultationId}/context`, {
  method: 'POST',
  headers: {
    ...auth,
    ...(bundle.contextSchemaVersionId
      ? { 'X-Context-Schema-Version': bundle.contextSchemaVersionId }
      : {}),
  },
  body: JSON.stringify({
    type: 'STRUCTURED',   // ← ContextItemType, still REQUIRED alongside kindKey
    kindKey: 'vitals',
    payload: { systolic: 128, diastolic: 82 },
  }),
});
```

Four traps in that snippet:

1. **`type` is still mandatory.** `kindKey` does not replace `ContextItemType` (`AUDIO_RECORDING`,
   `WORKNOTE`, `RAW_SUMMARY`, `MODIFIED_SUMMARY`, `PRE_SUMMARY`, `NAMED_ENTITY`, `TRANSCRIPT`,
   `CASE_NOTE`, `ATTACHMENT`, `SIGNED_NOTE`, `STRUCTURED`).
2. **`payload` without `kindKey` is a 400.** There would be nothing to validate it against.
3. **Omitting `X-Context-Schema-Version` means "validate against whatever is pinned right now"** —
   your caller can be silently upgraded mid-run.
4. **The gateway rejects undeclared body fields wholesale** (`forbidNonWhitelisted`). Extra keys are
   a 400, not a silent drop.

If your service submits context routinely, prefer adding a `ConsultationsResource.addContext` to
`@arcaai/vox-node` (business plane, hand-authored — the generated `admin/**` tree is off-limits to
hand edits) over spreading raw `fetch` calls through your codebase.

---

## 5. Frontend lane — `@arcaai/vox` + codegen

### 5.1 Discovery is provider-owned

`AgenticProvider` fetches the bundle at mount and re-fetches on a same-tab tenant switch. Every
consumer in the tree therefore observes the **same pinned version** for the life of the session —
which is exactly what makes the `X-Context-Schema-Version` header meaningful. `useConsultationSchema()`
does **not** fetch; it is a read-only view over that bundle.

```tsx
import { useConsultationSchema, useArcaSession } from '@arcaai/vox';
import type { ConsultationContextKindMap } from './generated/consultation-context';

function VitalsForm() {
  const { bundle, isConfigured, findKind, isDeprecated, validatePayload } = useConsultationSchema();
  const session = useArcaSession();

  if (!isConfigured) return <SchemaNotConfigured />; // 200-with-nulls is a real state

  const kind = findKind('vitals');
  if (!kind) return null;                             // newer/unknown kind — degrade, don't crash
  if (isDeprecated(kind)) console.warn(kind.deprecated?.message);

  async function submit(payload: ConsultationContextKindMap['vitals']) {
    const { valid, problems } = validatePayload('vitals', payload); // optional pre-flight
    if (!valid) return showErrors(problems);

    await session.addContext({ type: 'STRUCTURED', kindKey: 'vitals', payload });
  }
}
```

### 5.2 What `addContext()` does for you

1. Validates `{ kindKey, payload }` against the session-pinned bundle with the same shared
   `@arcaai/json-schema-subset` evaluator the server uses, throwing `AgenticError('VALIDATION_ERROR')`
   before the round trip.
2. Sends `X-Context-Schema-Version: <bundle.contextSchemaVersionId>` automatically when a schema is
   pinned.
3. Writes the item into the per-provider store and broadcasts it cross-tab on
   `agentic.<tenantId>`.

Client-side validation is a UX aid, permissive by design: no bundle, an undeclared `kindKey`, or a
non-`STRUCTURED` kind all pass locally. That is the forward-compatibility guarantee — a client one
release behind must not reject a kind the tenant published yesterday.

### 5.3 Entry points

Import the schema hooks from `@arcaai/vox/core` when your surface has no audio: `/core` carries the
provider, hooks, types and client with no audio/ML code. Keep `med-ner` behind
`@arcaai/vox/plugins/med-ner`.

---

## 6. Feeding the agentic workflow / harness loop

The context schema is what a workflow's **`input.context_binding`** node (`N-1`, safety class
*mandatory*) is built on. Its config carries an embedded `contextSchema` (`schemaVersion` + `kinds`,
optional `outputs`) plus `bindings` — each `{ kindKey, from }` — wiring a declared kind to a runtime
source. Contract:
[`node-config-schemas.ts`](../packages/workflow-contract/src/node-config-schemas.ts).

Two things to get right:

1. **The node's primitive set is a SUBSET.** Inside `input.context_binding`, `kinds[].primitive` and
   `outputs[].primitive` accept only `TEXT` and `STRUCTURED` — not the full five. A `STREAM_AUDIO`
   kind is captured by the STT palette (`stt.*` nodes), not bound here. A workflow that tries to
   bind an audio kind fails compilation.
2. **`kindKey` grammar is shared** (`^[a-z0-9_]{2,48}$`) across the schema, the node config, and the
   write DTO. Rename a kind and you break every binding that names it — republish the schema and
   update the workflow together.

`definition.outputs[]` declares what the loop is expected to *produce* (e.g. `problem_list`,
`soap_note`); the generated `ConsultationContextOutputMap` gives you types for consuming those on
either lane. The seeded day-1 defaults are a working reference:
[`07e-consultation-loop-defaults.ts`](../packages/database/src/prisma/db_main/seed/07e-consultation-loop-defaults.ts)
(tenant scope) and
[`07f-arcaai-department-context-schemas.ts`](../packages/database/src/prisma/db_main/seed/07f-arcaai-department-context-schemas.ts)
(two contrasting department-scoped vocabularies).

---

## 7. Gotchas

| Symptom | Cause |
|---|---|
| 200 with all-null fields, `etag: "none"` | Tenant has no configured schema. **Not** an error — branch on it |
| Codegen 403 | CLI needs a SUPER_ADMIN JWT + `X-Tenant-Id`, not an API key or service-account token |
| `400 payload requires kindKey` | A `payload` was sent without naming a kind |
| `400 Tenant-defined context kinds are not available in this deployment` | `kindKey` named but the schema service is not wired — fail-closed by design |
| 400 on an apparently valid body | Undeclared field. The gateway runs `forbidNonWhitelisted` |
| 412 on `update` | `_version` drift. 428 means you omitted `If-Match` |
| 400 listing `breakingChanges` on publish | A kind/property was removed, renamed, retyped, or made required. Re-submit with `allowBreakingChange: true` |
| Published, but discovery still serves the old version | The schema's `status` was moved back to `DRAFT`, or you pinned an older version |
| Types exist for some kinds only | Only `STRUCTURED` kinds carry `fields`; the rest get a comment |
| Wrong department's kinds generated | Pass `--department <id>`; department scope shadows the tenant default |
| Schema changed but types didn't | Codegen is build-time. Regenerate (or run `--watch`) |
| Payload validated locally, rejected by server | Expected. Client validation is permissive; the server is authoritative |
| `hope.consultations.addContext is not a function` | It does not exist. See §4.4 |

## 8. Reference

| What | Where |
|---|---|
| Definition contract + validator | `packages/applications/src/services/consultation-context-schema/context-schema-definition.ts` |
| Prisma model | `packages/database/src/prisma/db_main/consultation-context-schema.prisma` |
| Admin + discovery controllers | `apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts` |
| Context write path | `packages/applications/src/services/consultation/context/context.service.ts` |
| Codegen CLI | `packages/vox-codegen/README.md` |
| Browser hook | `packages/agentic-sdk-v2/src/hooks/useConsultationSchema.ts` |
| Browser validation | `packages/agentic-sdk-v2/src/core/contextPayloadValidation.ts` |
| Node admin resource | `packages/vox-node/src/resources/admin/consultation-context-schema.ts` |
| Workflow node config | `packages/workflow-contract/src/node-config-schemas.ts` |
