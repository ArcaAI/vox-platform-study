# API Documentation Pipeline

How the HOPE API documents itself, and what you have to do so a route you add shows up
correctly in the developer portal. Introduced by TASK-783.

## The shape of it

```
apps/api  (Nest controllers + DTOs + authorization decorators)
   │
   ├── pnpm api:openapi        ──▶  apps/api/openapi.json          request/response TYPES
   └── pnpm api:route-manifest ──▶  apps/api/route-manifest.json   the AUTHORIZATION oracle
                                            │
                    pnpm api:portal  ◀───────┘  (joins the two on `METHOD /path`)
                                            │
                    apps/admin-console/src/server/api-docs/
                      ├── openapi.admin.json      every documented route
                      └── openapi.business.json   only what a tenant credential can reach
                                            │
                    /developer/reference  (Scalar, behind read:ApiDocumentation)
```

Every arrow is a committed artifact and a CI gate. Nothing in the portal is hand-maintained,
and nothing about a route's audience is decided twice.

## The one rule

**Never hand-edit any of the four JSON artifacts.** They are generated, byte-deterministic, and
drift-gated. Edit the controller, then regenerate:

```bash
pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal
```

Then commit all four alongside your controller change.

## Adding or changing a route

A route is documented when it carries the metadata the Swagger explorer can see. Concretely:

| Requirement | Enforced by |
|---|---|
| An `@ApiTags(...)` from the canonical taxonomy | `src/openapi/__tests__/tags.test.ts` — an undeclared tag fails the build |
| A summary, and ideally a description | `openapi-coverage-check` reports both; summary is effectively universal already |
| At least one 4xx response | reported by `openapi-coverage-check` (not yet a hard gate — see *The description debt*) |
| Present in the spec **or** deliberately excluded | `openapi-coverage-check` — this one IS a hard gate |

To add a tag, add it to `apps/api/src/openapi/tags.ts` with a description, a display name, and
its plane. The list order is the renderer's sidebar order, so keep the plane groups contiguous.

To hide a route from the docs on purpose, use `@ApiExcludeEndpoint()` (or
`@ApiExcludeController()`) **and leave a comment saying why**. That is the only sanctioned way to
be absent from the spec.

### `@ApiExclude*` hides a route from the DOCUMENT, not from the network

This is the distinction that has bitten this repo twice, so it is worth stating flatly: an
excluded route is still mounted, still served, still reachable, and still needs its guards.
Exclusion is a documentation decision and nothing more.

- It must **never** be used to keep a route out of a security test. `route-manifest.json`'s
  `apiExcluded` flag exists so the documentation cross-check can tell "deliberately hidden" from
  "undocumented" — it is not a statement about the HTTP surface.
- The flag's readers live in `apps/api/src/openapi/api-exclude-metadata.ts`. Neither decorator
  stores a boolean (`@ApiExcludeEndpoint()` stores `{ disable: true }`,
  `@ApiExcludeController()` stores `[true]`), so reading them with `=== true` silently reports
  that nothing is excluded. That is exactly what happened before TASK-783: all 657 routes
  reported `apiExcluded: false`, and the cross-check the flag exists to power had never once
  been able to fire.

## How the audience split is decided

`gen-api-portal.ts` derives, per route, which of the four credential classes can reach it, using
`route-manifest.json` alone. Two rules are encoded literally because both are easy to get wrong:

1. **`@ForbidApiKey()` is unconditional.** It is checked before scopes and abilities, so a
   broadly-scoped key does not get through. Every `/api/v1/admin/**` route carries it.
2. **No declared scope means DENY.** An absent `apiKeyScopes` / `svcScopes` is a 403
   expectation for that credential class, not an "unknown".

A route reaches `openapi.business.json` only if it is outside the admin plane *and* a
tenant-presentable credential can call it. The business projection does not merely hide
administration routes — it does not contain them, because a payload is a leak the moment it is
served, whatever the client renders.

The derived facts ride on each operation as `x-hope-plane`, `x-hope-credentials`,
`x-hope-api-key-scopes`, `x-hope-service-account-scopes`, `x-hope-abilities`,
`x-hope-permission-mode` and `x-hope-requires-if-match`, plus a rendered prose note.

## Who can read the portal

| Ability | Grants |
|---|---|
| `read:ApiDocumentation` | the portal, and the **business** projection |
| `manage:ApiDocumentation` (in practice `manage:all`) | additionally the **administration** projection |

Seeded as the GLOBAL policy `api-documentation-read`, granted to `TENANT_ADMIN` and `DOCTOR`
(which already holds `api-key-own-manage`, i.e. can mint a credential and integrate). The gate is
enforced server-side in `apps/admin-console/src/server/api-docs/index.ts`, which fetches the
caller's CASL rules from the gateway and **fails closed** if it cannot. The route segment and the
spec route handler check it independently — one controls the screens, the other controls the
bytes, and neither relies on the other.

After changing the seed, re-seed for it to take effect locally: `pnpm db:seed`.

## Versioning: contract vs build

Two different numbers, deliberately not merged:

- **`info.version`** in `openapi.json` is the CONTRACT version and is a constant
  (`OPENAPI_CONTRACT_VERSION` in `apps/api/src/swagger.config.ts`). The spec is a committed,
  drift-gated artifact — a value read from the release tag, git, or the environment would differ
  per machine and fail the gate on a clean tree. It is also the correct reading of OpenAPI's
  `info.version`: it describes the *document*, not the deployment.
- **The build** is a property of the running image and is read from it. The portal footer shows
  the gateway's own `GET /health` version. See `versioning.md` and
  `.claude/rules/09-infrastructure-devops.md` §Release Versioning.

## Renderer

Scalar (`@scalar/api-reference-react`), embedded natively in the console at
`/developer/reference`. Three of its features are switched off on purpose, in **every**
environment rather than only where the defaults happen to hide them:

| Setting | Why |
|---|---|
| `showDeveloperTools: 'never'` | its toolbar carries Share / Deploy, which push the document to Scalar's cloud. Default is `'localhost'` — i.e. ON in development |
| `agent: { disabled: true }` | the Ask-AI sidebar entry ships document context to a model endpoint we do not control |
| `mcp: { disabled: true }` | same, for the Generate/Connect MCP entry point |
| `hideClientButton` + `hideTestRequestButton` | the built-in client would fire real requests as the signed-in operator, against real tenant data, with no undo on a DELETE |

`forceDarkModeState` is set alongside `darkMode`. Without it Scalar restores its own persisted
preference and renders light inside a dark console; hiding its toggle does not prevent that, it
only hides the way back.

Re-enabling the client is a product decision that needs a sandbox tenant with synthetic data
first. It is not a config tweak.

## CI gates

| Job | Fails when |
|---|---|
| `openapi-coverage-check` | a served route has no OpenAPI metadata and is not `@ApiExclude*`, **or** the spec and the manifest were emitted from different builds |
| `generate-api-portal-check` | either portal projection is stale or hand-edited |
| `generate-vox-node-admin-check` | the SDK's generated admin surface drifts from the two artifacts |

All three run offline against committed JSON — no gateway boot, no database, no network.

## The description debt

As of 2026-08-20: **412 of 587 operations carry a summary and nothing else**, and 290 declare no
4xx response.

These are **ratcheted**, not merely reported. `QUALITY_RATCHET` in
`scripts/check-openapi-coverage.ts` records the worst the repo is allowed to be; the gate fails
if a change makes any of them larger. Failing on the absolute counts today would block every
unrelated change, and a gate that has to be bypassed is not a gate — a ratchet is the version
that can actually be switched on, and it puts the debt in the diff instead of in a report nobody
reads.

Lowering a number needs no justification. **Raising one does**, in the commit message: it means a
route shipped undocumented on purpose. Work the business-plane operations down first — those are
the ones a customer reads.

## Deprecating a route

1. `deprecated: true` in the spec (`@ApiOperation({ deprecated: true })`).
2. Name the replacement in the description.
3. Serve `Deprecation` and `Sunset` headers.
4. Minimum two releases of notice before removal.
5. Keep a 308 shim for one release where the URI merely moved (the `*RedirectShimController`
   pattern from TASK-760), and mark it `@ApiExcludeEndpoint()` so the old path does not clutter
   the reference.

Never remove a route silently.

## Related

- `.claude/rules/05-nestjs-api.md` — the gateway's guard pipeline and API test standard
- `.claude/rules/13-nextjs-apps.md` — the admin console's routing, BFF, and quality gates
- `docs/operations/versioning.md` — release tags and build identity
- `docs/implementation/TASK-783-Developer-Api-Documentation-Portal/README.md` — the ticket
