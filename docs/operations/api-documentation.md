# API Documentation Pipeline

How the HOPE API documents itself, which command to run when, and what to do when one of them
fails. Introduced by TASK-783.

**If you only read one thing:** after changing anything about a route — its path, verb, DTOs,
guards, or Swagger decorators — run this and commit everything it touches.

```bash
pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal
```

Then prove it is consistent:

```bash
pnpm api:openapi:check && pnpm api:portal:check && pnpm --filter @arcaai/vox-node gen:admin:check
```

---

## Script quick reference

Every command is run from the repo root. None of them needs Docker, a database, Redis, Vault, or
a network — including the two that boot the gateway.

| Command | Does | Writes | ~Time |
|---|---|---|---|
| `pnpm api:build` | Compiles `apps/api` + its workspace deps (`nest build`). A prerequisite of the two emits, and already chained into both | `apps/api/dist/` | ~20s |
| `pnpm api:route-manifest` | Emits the **authorization oracle** by walking Nest's route table offline | `apps/api/route-manifest.json` | ~27s |
| `pnpm api:openapi` | Emits the **OpenAPI document** offline via `SwaggerModule.createDocument` | `apps/api/openapi.json` | ~25s |
| `pnpm api:portal` | Joins the two into the console's audience projections | `apps/admin-console/src/server/api-docs/openapi.{admin,business}.json` | <1s |
| `pnpm api:openapi:check` | **Gate.** Coverage + staleness + quality ratchet + example hygiene | nothing | <1s |
| `pnpm api:portal:check` | **Gate.** Projections are neither stale nor hand-edited | nothing | ~1s |
| `pnpm --filter @arcaai/vox-node gen:admin` | Regenerates the SDK's admin surface from the same two artifacts | `packages/vox-node/src/resources/admin/**` (55 files) | ~1s |
| `pnpm --filter @arcaai/vox-node gen:admin:check` | **Gate.** SDK surface matches the artifacts | nothing | ~1s |

`api:route-manifest` and `api:openapi` each re-run `api:build` themselves, so running the pair
back to back builds twice. Chain them as `pnpm api:build && pnpm --filter @arcaai/api route-manifest && pnpm --filter @arcaai/api openapi`
if the ~20s matters; the four-command line at the top of this page is the one to memorise.

**Order matters.** `api:portal` reads what the two emits wrote, and both gates read all four
files. Running `api:portal` against a stale `openapi.json` produces projections that are
internally consistent and wrong.

**None of these run under `pnpm verify`** (`lint:all && typecheck:all && test`). They are their
own CI jobs, so a green local `verify` says nothing about documentation drift — run the gates.

---

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

Every arrow is a committed artifact and a CI gate. Nothing in the portal is hand-maintained, and
nothing about a route's audience is decided twice.

## The one rule

**Never hand-edit any of the four JSON artifacts.** They are generated, byte-deterministic, and
drift-gated. Edit the controller, then regenerate.

Byte-determinism is a property you can lean on: re-running an emit on an unchanged tree leaves
`git status` clean. If a re-run dirties a file you did not expect to change, that is a real
finding — usually that the committed artifact was emitted from a different build.

---

## Recipes

| You did this | Run |
|---|---|
| Added / removed / renamed a route, or changed its verb or path | the full four-command line, then the three gates |
| Changed only DTOs or `@Api*` documentation decorators | `pnpm api:openapi && pnpm api:portal`, then `pnpm api:openapi:check && pnpm api:portal:check` |
| Changed only guards / scopes / `@Authorize` / `@RequiresIfMatch` | `pnpm api:route-manifest && pnpm api:portal`, then the gates (the SDK gate too — scopes shape its admin surface) |
| Added a tag to `apps/api/src/openapi/tags.ts` | `pnpm api:openapi && pnpm api:portal`; `pnpm --filter @arcaai/api test` covers the taxonomy test |
| Edited `scripts/gen-api-portal.ts` (the join logic) | `pnpm api:portal` — the inputs did not change, only the derivation |
| Edited `scripts/check-openapi-coverage.ts` | nothing to regenerate; run `pnpm api:openapi:check` |
| Just want to read the docs | see *Viewing it locally* below — no regeneration needed |
| CI failed on one of the three gates | run that gate locally; each failure message names its own fix |

When in doubt, run the full line. It is ~50s and idempotent.

---

## The scripts in detail

### `pnpm api:route-manifest` and `pnpm api:openapi` — the two offline emits

Both build the entire gateway DI graph with `NestFactory.create()` and **never** call
`.listen()`. No port is bound and no request is ever served. Sources:
`apps/api/src/scripts/emit-route-manifest.ts` and `emit-openapi.ts` — read those headers before
changing either; the constraints are documented at the call sites.

They run against the **compiled** `nest build` output, not `tsx`/`ts-node`. This is not a
preference: `nest-cli.json` registers the `@nestjs/swagger` compiler plugin (implicit
`@ApiProperty` inference, `introspectComments`), which only runs through Nest's own compiler. A
`ts-node` run would silently under-report type coverage relative to what the gateway actually
serves.

The placeholder env in the package scripts (`JWT_SECRET_KEY=offline-…-placeholder`,
`DATABASE_URL=…@127.0.0.1:1/openapi_offline`, `REDIS_HOST=127.0.0.1 REDIS_PORT=1`) exists because
two providers refuse to *construct* without those variables present — `JwtStrategy` rejects an
empty or dev-placeholder secret, and `BullModule.forRootAsync`'s factory throws if the Redis pair
is absent. Presence is all that is checked; nothing is ever reached. Do not "fix" these to point
at real infrastructure.

**A clean run is silent.** Exactly one line on stdout, nothing on stderr:

```
$ pnpm api:openapi
[emit-openapi] wrote 455 paths to …/apps/api/openapi.json (40 offline queues quiesced)

$ pnpm api:route-manifest
[emit-route-manifest] wrote 657 routes (409 admin, 391 machine-reachable) to …/route-manifest.json (40 offline queues quiesced)
```

That was not always true, and the fix is worth knowing about because it changes how you should
read these commands. Both used to exit 0 while printing a `prisma:error` block and ~200 raw
`ECONNREFUSED` stack dumps, which made a successful run indistinguishable from a broken one. Two
causes, both fixed at the source:

- `AppSettingsService` warmed its cache from its **constructor** — unawaited I/O that fired at DI
  time and dialled a database these scripts deliberately do not have. The load now lives in
  `onModuleInit`, which these scripts never run.
- The 40 BullMQ queues had no `'error'` listener, so BullMQ's `console.error` fallback printed
  raw stacks. `apps/api/src/scripts/offline-infrastructure.ts` attaches one immediately after
  `create()` — the connection error is *expected* under the scripts' own "no infrastructure"
  premise, so this process owns it.

The `(40 offline queues quiesced)` suffix is that count. **Treat any other output as a signal.**
A stray `prisma:error` means something reintroduced I/O into a provider constructor; a changed
queue count means queues are being registered by a path the helper does not walk.

### `pnpm api:portal` — the audience projections

`scripts/gen-api-portal.ts`. Pure function over the two artifacts, no I/O beyond reading them.
Output:

```
[gen-api-portal] wrote 587 operations to apps/admin-console/src/server/api-docs/openapi.admin.json
[gen-api-portal] wrote 178 operations to apps/admin-console/src/server/api-docs/openapi.business.json
```

If it warns `N operation(s) had no manifest route and were passed through un-enriched`, the two
inputs came from different builds — re-emit both before trusting the output.

`--check` (i.e. `pnpm api:portal:check`) compares instead of writing and exits 1 on any
difference, naming the file that drifted.

### `pnpm api:openapi:check` — the coverage gate

`scripts/check-openapi-coverage.ts`. Reads the two artifacts and reports:

```
[openapi-coverage]
  manifest routes       657
  spec operations       587
  deliberately excluded 70
  quality (ratcheted — may improve, may not regress):
    missing summary      1 (max 1)
    missing description  412 / 587 (max 412)
    missing 4xx response 290 / 587 (max 290)
    missing tag          0
  example hygiene        clean

[openapi-coverage] OK — every served route is either documented or deliberately excluded.
```

Four failure modes, each with its own message:

| Failure | Means | Fix |
|---|---|---|
| *"N route(s) are served but carry no OpenAPI metadata"* | a live route is invisible in the reference | add `@ApiOperation` + `@ApiResponse`, or `@ApiExcludeEndpoint()` with a comment saying why |
| *"N operation(s) are in openapi.json but not in route-manifest.json"* | the two artifacts were emitted from **different builds** | `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi` |
| *"documentation quality went BACKWARDS"* | a route shipped undocumented | document it, or raise `QUALITY_RATCHET` and justify it in the commit message |
| *"N example-hygiene violation(s)"* | an example carries a real e-mail domain, or a seeded system-user / API-key id | use `example.com` (RFC 2606); never put a credential id in an example |

Example hygiene deliberately **allows** the SYSTEM (`00000000-…`) and GLOBAL (`50000000-…`)
tenant ids — those are documented platform constants a caller has to recognise. It rejects the
seeded system user (`60000000-…`) and API-key ids (`70000000-…`), because an example that hands a
reader a credential id teaches them to send it.

### `pnpm --filter @arcaai/vox-node gen:admin` — the SDK surface

Not documentation, but it consumes the same two artifacts, so it fails whenever they drift.
`packages/vox-node-codegen`. Do not hand-edit `packages/vox-node/src/resources/admin/**` — with
the single exception of `admin-resource.ts`, which is hand-authored. See
`.claude/rules/08-vox-sdk.md`.

---

## Adding or changing a route

A route is documented when it carries the metadata the Swagger explorer can see. Concretely:

| Requirement | Enforced by |
|---|---|
| An `@ApiTags(...)` from the canonical taxonomy | `src/openapi/__tests__/tags.test.ts` — an undeclared tag fails the build |
| A summary, and ideally a description | `openapi-coverage-check` reports both; summary is effectively universal already |
| At least one 4xx response | ratcheted by `openapi-coverage-check` — see *The description debt* |
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
  reported `apiExcluded: false`, and the cross-check the flag exists to power had never once been
  able to fire.

## How the audience split is decided

`gen-api-portal.ts` derives, per route, which of the four credential classes can reach it, using
`route-manifest.json` alone. Two rules are encoded literally because both are easy to get wrong:

1. **`@ForbidApiKey()` is unconditional.** It is checked before scopes and abilities, so a
   broadly-scoped key does not get through. Every `/api/v1/admin/**` route carries it.
2. **No declared scope means DENY.** An absent `apiKeyScopes` / `svcScopes` is a 403 expectation
   for that credential class, not an "unknown".

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

Seeded as the GLOBAL policy `api-documentation-read` (`seed/01-policy.ts`), granted to
`TENANT_ADMIN` and `DOCTOR` (`seed/03-role.ts` — `DOCTOR` already holds `api-key-own-manage`,
i.e. can mint a credential and integrate). The gate is enforced server-side in
`apps/admin-console/src/server/api-docs/index.ts`, which fetches the caller's CASL rules from the
gateway and **fails closed** if it cannot. The route segment and the spec route handler check it
independently — one controls the screens, the other controls the bytes, and neither relies on the
other.

A dev database seeded before TASK-783 does not have the policy, so only super admins can open the
portal locally until you re-seed: `pnpm db:seed` (destructive to local data — your call).

## Viewing it locally

```bash
pnpm admin:dev      # http://localhost:5176 → /developer
```

Three screens, all behind console auth and the ability above:

| Route | What |
|---|---|
| `/developer` | overview — your first call, API keys, credential classes, the error contract, optimistic concurrency, and the gateway build stamp |
| `/developer/reference` | the Scalar reference, with an admin/business plane switch |
| `/developer/sdk` | `@arcaai/vox-node` usage |

`/api/docs/spec/{admin,business}` serves the projections themselves (JSON; 401 unauthenticated,
403 without the ability, 404 for any other plane name).

The gateway's own Swagger UI at `/api/v1/docs` is unrelated and unchanged: non-production only,
unauthenticated, no audience split. It is a local-dev convenience, not a product surface.

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

Scalar (`@scalar/api-reference-react`), embedded natively in the console at `/developer/reference`.
Several of its features are switched off on purpose, in **every** environment rather than only
where the defaults happen to hide them:

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

All three run offline against committed JSON — no gateway boot, no database, no network. Each has
a local equivalent, so nothing here should ever surprise you in a pipeline:

| Job (`.gitlab/ci/validate.yml`) | Local equivalent | Fails when |
|---|---|---|
| `openapi-coverage-check` | `pnpm api:openapi:check` | a served route has no OpenAPI metadata and is not `@ApiExclude*`, the two artifacts came from different builds, quality regressed past the ratchet, or an example fails hygiene |
| `generate-api-portal-check` | `pnpm api:portal:check` | either portal projection is stale or hand-edited |
| `generate-vox-node-admin-check` | `pnpm --filter @arcaai/vox-node gen:admin:check` | the SDK's generated admin surface drifts from the two artifacts |

## The description debt

As of 2026-08-20: **412 of 587 operations carry a summary and nothing else**, and 290 declare no
4xx response.

These are **ratcheted**, not merely reported. `QUALITY_RATCHET` in
`scripts/check-openapi-coverage.ts` records the worst the repo is allowed to be; the gate fails if
a change makes any of them larger. Failing on the absolute counts today would block every
unrelated change, and a gate that has to be bypassed is not a gate — a ratchet is the version that
can actually be switched on, and it puts the debt in the diff instead of in a report nobody reads.

Lowering a number needs no justification, and you are expected to lower it in the same commit that
improves matters. **Raising one does**, in the commit message: it means a route shipped
undocumented on purpose. Work the business-plane operations down first — those are the ones a
customer reads.

## Deprecating a route

1. `deprecated: true` in the spec (`@ApiOperation({ deprecated: true })`).
2. Name the replacement in the description.
3. Serve `Deprecation` and `Sunset` headers.
4. Minimum two releases of notice before removal.
5. Keep a 308 shim for one release where the URI merely moved (the `*RedirectShimController`
   pattern from TASK-760), and mark it `@ApiExcludeEndpoint()` so the old path does not clutter
   the reference.

Never remove a route silently.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| An emit prints `prisma:error` or `ECONNREFUSED` stacks | a provider reintroduced I/O in its constructor, or a queue is registered by a path `offline-infrastructure.ts` does not walk | find the provider; move the I/O to `onModuleInit`. Do not point the placeholder env at real infrastructure |
| An emit fails with `Cannot find module '…/dist/scripts/…'` | `apps/api` was not built | `pnpm api:build` (or use the root `api:openapi` / `api:route-manifest` aliases, which build first) |
| `[Error: ENOTEMPTY: directory not empty, rmdir '…/apps/api/dist/…']` | environmental, not yours: `apps/api`'s build starts with `rimraf dist`, which loses a race against an editor/IDE file-watcher indexing `dist`. Observed intermittently on macOS with Cursor open on the workspace | re-run; if it repeats, `rm -rf apps/api/dist` first. The `&&` chain means a failed build never lets a stale artifact through — you get the build error, not a wrong emit |
| `[emit-…] failed:` followed by a stack | a genuine bootstrap failure — a provider threw during `NestFactory.create()` | read the error; `abortOnError: false` is set precisely so it reaches you instead of a bare exit 1 |
| A gate fails in CI but passes locally | your artifacts are newer than the committed ones | commit all four JSON files together with the controller change |
| A re-emit dirties an artifact you did not touch | the committed artifact was emitted from a different build | commit the re-emitted file; then check whether an earlier change forgot to regenerate |
| The portal 403s for a user who should see it | dev DB predates the `api-documentation-read` policy | `pnpm db:seed` |
| The reference renders light inside a dark console | Scalar restored its own persisted theme | `forceDarkModeState` must be set alongside `darkMode` — see *Renderer* |

## Related

- `.claude/rules/05-nestjs-api.md` — the gateway's guard pipeline, API test standard, and the
  Documentation Surface definition of done
- `.claude/rules/13-nextjs-apps.md` — the admin console's routing, BFF, and quality gates
- `.claude/rules/08-vox-sdk.md` — `@arcaai/vox-node` and its generated admin surface
- `docs/operations/versioning.md` — release tags and build identity
- `docs/implementation/TASK-783-Developer-Api-Documentation-Portal/README.md` — the ticket
