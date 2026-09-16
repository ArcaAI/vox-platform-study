# @arcaai/vox-codegen

## Unreleased — 3.6.0

### Minor Changes

- **`--check`, for both modes.** Regenerates in memory and compares against whatever is
  committed on disk (the `Generated:` timestamp line is normalized out first, so two honest
  runs a moment apart still compare equal) — the CI recipe for catching a stale generated
  file. Matches: prints "is up to date" and exits 0, writing nothing. Drifts (including a
  missing file): prints a diff and exits 1, still writing nothing. `--check` and `--watch` are
  mutually exclusive on the consultation-context mode (a check compares one snapshot rather
  than polling); the business-plane mode already refuses `--watch` outright, so the same rule
  applies there without a second message.
- **Tenant-schema mode emits `OpenConsultationContext`** — `{ <kind>?: <KindPayload> }` for
  every STRUCTURED kind with `lifecycle: 'PRE'` whose `producedBy` includes `CLIENT` (a kind
  marked `required: true` drops the `?`). Pass it as the type parameter to
  `hope.consultations.open<OpenConsultationContext>(...)` (`@arcaai/vox-node`) instead of an
  untyped `Record<string, unknown>`. The file header also gains a `@schemaVersion <n>` tag
  (machine-grep-able twin of the existing human-readable `Schema:` line), present whenever the
  tenant has a configured version.
- **Catalogue mode emits `@contextSchema` and `@reviewNodes`** on each generated
  `Workflow_<Slug>_Input` type — `@contextSchema <slug> v<n> (follows latest | pinned)` (or
  `@contextSchema unbound` for a definition with no consultation trigger) and
  `@reviewNodes <ids>` when the graph carries any `core.humanReview` node, both read off
  `GET /workflows/{slug}/schema`'s `contextSchema` / `reviewNodes`.
- **No internal ticket numbers in generated text.** The `@identity` / `@role` / `@materializeAs`
  / `@streamContext` JSDoc annotations no longer carry a parenthetical ticket reference —
  customers read generated code, and a ticket id is not part of the contract.

## 3.5.0

No changes in this release.

## 3.3.0

### Minor Changes

- TASK-951 — the ArcaAI realtime contract on the SDKs.

  - `hope.stt.createStreamSession({ context })` (vox-node) / the stream-session request (vox): a client-declared session context (≤ 4 KB), validated against the ASR agent's frozen context schema and echoed VERBATIM on every transcript of that session together with `sessionEpochMs`.
  - `RealtimeSttSocket.setMetadata(value)` (vox-node) and `SttWebSocketClient.setMetadata(value)` (vox): declare the metadata in force from the current point of the audio onward — one microphone at a time, sticky until the next declaration, no timestamp. Every transcript then carries `metadata` (the flat object in force over its audio, e.g. `{ mic_id: '2' }`) and `metadataSpans` (`SttMetadataSpan[]` / `WsMetadataSpan[]`, the exact bounds clipped to the segment). Refusals arrive on the error channel — `METADATA_TOO_LARGE`, `METADATA_INVALID`, `METADATA_SCHEMA_VIOLATION` with `problems` — and never end the session.
  - `@arcaai/vox-codegen`: the context-schema marker roles (`userIdentity`, `department`, `visitType`, `externalRef`, `materializeAs`, `streamContext`) are emitted as documentation tags on the generated kind types.

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
