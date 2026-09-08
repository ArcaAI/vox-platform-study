# @arcaai/vox-codegen

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
