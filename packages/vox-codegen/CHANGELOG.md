# @arcaai/vox-codegen

## 3.2.0

### Minor Changes

- **`--tenant` can now authenticate as a SERVICE ACCOUNT, so a build pipeline types a tenant's context schema without a human's super-admin JWT (TASK-933).**

  Pass `--client-id` / `--client-secret` (env fallbacks `HOPE_SVC_CLIENT_ID` / `HOPE_SVC_CLIENT_SECRET`) instead of `--token`, with an optional `--working-tenant`. The CLI exchanges them at `POST /auth/service-token` and reads with `X-Service-Account-Token` and NO `X-Tenant-Id` — the working tenant binds at the exchange, not per request. `--token` continues to work unchanged.

  Credentials are read from the environment by preference because a secret passed on argv is visible in `ps`.

## 3.1.0

### Minor Changes

- 2e09493: **`vox-codegen` types a tenant's agents and workflows, not just its context schema (3.1.0).**

  New business-plane mode, alongside the existing consultation-context-schema mode:

  ```
  npx @arcaai/vox-codegen --api-key <key> --base-url <url> --agents --workflows --out ./generated
  ```

  It reads `GET /agents`, `GET /agents/{slug}`, `GET /workflows` and
  `GET /workflows/{slug}/schema` with `X-API-Key` and emits `Agent_<Slug>_Input` /
  `Agent_<Slug>_Output` and `Workflow_<Slug>_Input` / `Workflow_<Slug>_Output` through the
  same JSON-Schema-subset transpiler the context-schema mode uses. **It never calls an admin
  route** — an API key cannot reach one, and what a tenant PUBLISHES is exactly what an
  integrator needs to type.

  The existing `--tenant <id> --token <jwt>` mode (consultation context schema, super-admin
  JWT) is unchanged, still the default, and still the only mode that supports `--watch`. The
  two are mutually exclusive: mixing an API key with `--tenant` is a refusal, not a guess.

  This package also LEAVES the Changesets `ignore` list and joins the `publish-sdk` build
  list, so it is versioned and published with the rest of the family instead of being bumped
  by hand.
