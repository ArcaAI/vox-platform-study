# Vox SDK Release — publishing `@arcaai/vox` and its family to GitHub Packages

How the `@arcaai/vox` SDK family is versioned and published to GitHub Packages.

**Owner rule (2026-09-11, restated 2026-09-25): SDK releases are published LOCALLY by following this runbook —
never by the CI `publish-sdk` job.** Version on the active branch (`pnpm changeset:version`), commit, then run the
manual steps below from the operator's machine with the global `~/.npmrc` GitHub Packages token. Only AFTER the
local publish, push the protected `SDK-<ver>` tag: its `publish-sdk` job is then a no-op (`changeset publish` skips
versions already on the registry). If a tag pipeline would reach `publish-sdk` before the local publish is done,
cancel it.

## Layout

This directory holds only this file.

### Package inventory
Eight packages move together in one Changesets `fixed` group (`.changeset/config.json`) — the seven
published ones below plus the private `@arcaai/vox-node-codegen`. (Through 3.6.0 the group also held
the client-AI packages `@arcaai/vad`, `@arcaai/noise-filter` and `@arcaai/med-ner`; 4.0.0 deletes them —
TASK-1006. Their last published versions stay on the registry; nothing new is published for them.)

| Package | Path | Role |
|---|---|---|
| `@arcaai/vox` | `packages/agentic-sdk-v2/` | The SDK itself — depends on `types`, `room` and `stt` (`@arcaai/json-schema-subset` is bundled) |
| `@arcaai/types` | `packages/types/` | Shared types (and a few constants) vox's declarations import. Joined the group at 4.0.0 — the registry had sat at a stale 0.1.0 |
| `@arcaai/vox-node` | `packages/vox-node/` | Non-browser server SDK sibling |
| `@arcaai/vox-codegen` | `packages/vox-codegen/` | Build-time CLI, published alongside the family |
| `@arcaai/room` | `packages/room/` | Audio capture / `AudioTrack` / processor pipeline |
| `@arcaai/stt` | `packages/stt/` | Audio capture helpers + the backend streaming transport (no in-browser model since 4.0.0) |
| `@arcaai/pipeline` | `packages/pipeline/` | Sequential/parallel processing primitives — not a `vox` runtime dependency, but versioned with the family |

`@arcaai/vox-node-codegen` (`packages/vox-node-codegen/`, the build-time generator of vox-node's
`hope.admin.*`) is `private: true` and never published, but it is a **member of the same `fixed`
group** (since 4.0.0), so `pnpm changeset:version` versions it with the family and it can never
drift (it sat at 3.3.0 through 3.5.0 and 3.6.0 while it was in the `ignore` list). `changeset
publish` skips private packages, so being in the group publishes nothing. Two config keys make this
work: `privatePackages: { version: true, tag: false }` (without it Changesets silently leaves private
packages out of the plan), and `@arcaai/admin-console` in `ignore` (it depends on `@arcaai/vox`, so the
setting above would otherwise patch-bump the console on every SDK release). Prove the plan before a
release with a throwaway changeset and `pnpm changeset status --verbose` — it must list exactly the eight.
The private workspace packages that depend on `@arcaai/types` (`api`, `applications`, `database`,
`domains`, `utils`) are in `ignore` for the same reason `admin-console` is: without it every SDK
release would patch-bump them. vox-node INLINES `@arcaai/types` (runtime values and, since 4.0.0,
declarations via `dts.resolve`), so its published manifest depends on nothing.

All publishable packages carry matching `publishConfig`/`repository` fields:

```json
"publishConfig": {
  "access": "public",
  "registry": "https://npm.pkg.github.com"
},
"repository": {
  "type": "git",
  "url": "git+https://github.com/ArcaAI/project-hope.git"
}
```

`registry` is the GitHub Packages npm endpoint. `repository.url` is what ties a published package
to a GitHub repo/org for permission checks — it must point at a repo the publishing token has write
access to.

## How it works

### The CI job (backstop only — not the release path)

```bash
pnpm changeset               # author a changeset for your change
# commit the generated .changeset/<name>.md with your code change
```

On release: bump versions locally with `pnpm changeset:version` (or let CI's own `pnpm changeset
version` step do it), push a protected `SDK-<ver>` or `ALL-<ver>` tag (or land on the legacy
`release-sdk` branch, still supported for back-compat). The `publish-sdk` job then:

1. Writes a `.npmrc` authenticating `@arcaai:registry` against `npm.pkg.github.com` with
   `GITHUB_PACKAGES_TOKEN` — and fails loudly, before publishing anything, if that variable is
   unset (rather than letting `changeset publish` hit an anonymous registry and 401 per package).
2. Builds every publishable package's dependency chain via `turbo build`, INCLUDING
   `@arcaai/json-schema-subset` and `@arcaai/vox-codegen` — both were missing from this build list
   before TASK-931, which would have shipped a broken install or silently skipped `vox-codegen`.
3. Runs `pnpm changeset publish`, which honors each package's own `publishConfig.registry` — so
   only `npm.pkg.github.com` is ever addressed, never a GitLab registry.
4. Commits the version bump back to the `release-sdk` branch.

The `publish` stage runs after `test`, so the full test suite gates every SDK release.

### The release path (operator's machine)

This is how every release is published (owner rule above). One-time setup: a GitHub PAT (classic) with `write:packages` +
`read:packages`, write access to `ArcaAI/project-hope`, added to your global `~/.npmrc`:

```
//npm.pkg.github.com/:_authToken=YOUR_TOKEN_HERE
```

```bash
# 0. Bump every package in the fixed group to the same version first (see Versioning below),
#    commit, and confirm the token works: npm whoami --registry=https://npm.pkg.github.com

# 1. Build vox + its workspace deps (types, room, stt), then the siblings vox does not reach
pnpm sdk:build
pnpm sdk-node:build
pnpm --filter @arcaai/vox-codegen build
pnpm --filter @arcaai/pipeline build

# 2. Publish the dependencies first — vox won't resolve otherwise
pnpm --filter @arcaai/types publish --no-git-checks
pnpm --filter @arcaai/room publish --no-git-checks
pnpm --filter @arcaai/stt publish --no-git-checks

# 3. Publish vox and its siblings last
pnpm --filter @arcaai/vox publish --no-git-checks
pnpm --filter @arcaai/vox-codegen publish --no-git-checks
pnpm --filter @arcaai/vox-node publish --no-git-checks
pnpm --filter @arcaai/pipeline publish --no-git-checks
```

`./scripts/publish-sdk.sh <version> [--dry-run]` (`pnpm sdk:publish`) runs exactly these steps in this
order and stops at the first failure — run it with `--dry-run` first.

`pnpm sdk:build` is `turbo run build --filter=@arcaai/vox...` (root `package.json`) — the `...`
suffix builds `vox` plus everything it depends on.

### Versioning

Prefer `pnpm changeset` + `pnpm changeset:version` over hand-editing `package.json` — the whole
`fixed` group moves together, and `changeset version` also generates CHANGELOGs. The registry
rejects re-publishing an existing version with a 409.

### `--no-git-checks`

`pnpm publish` normally refuses to run on a dirty working tree or an unpushed branch.
`--no-git-checks` bypasses that. It does not affect auth or the published artifact — it is purely
a workflow gate. Prefer committing first and dropping the flag when the tree is clean.

### `workspace:*` dependencies

`@arcaai/vox`'s `dependencies`/`peerDependencies` reference the other packages as `workspace:*`.
`pnpm publish` (and `changeset publish`) rewrites these to the real version being published
automatically. This means publish order matters in the manual path: a consumer installing
`@arcaai/vox` needs the referenced versions of `types`, `room` and `stt` to already exist on the registry.

## Gotchas

- **A GitLab-registry `.npmrc` can never authenticate this publish.** `changeset publish` honors
  each package's own `publishConfig.registry` (`npm.pkg.github.com`), so writing GitLab registry
  credentials into `.npmrc` — an earlier version of this pipeline's mistake — authenticates a
  registry that is never addressed.
- **`@arcaai/vox-node-codegen` refuses `pnpm publish`** (it is `private: true`) — it is versioned by
  the `fixed` group (and by `scripts/publish-sdk.sh`'s `ALIGN_ONLY`), never published.
- **Eight packages move together** (seven published); publishing a subset out of the `fixed` group risks a version
  skew that breaks `workspace:*` resolution for whichever package didn't move.

## Related

- [`../../development-patterns-and-standards.md`](../../development-patterns-and-standards.md) — verified code patterns, including SDK conventions
- [`../../../.claude/rules/08-vox-sdk.md`](../../../.claude/rules/08-vox-sdk.md) — SDK package map, entry points, and the browser/node boundary
- `.gitlab/ci/publish.yml` — the `publish-sdk` job this page describes
- `.changeset/config.json` — the fixed version group and ignore list

### Release log
| Date | Version | How | Notes |
|---|---|---|---|
| 2026-09-11 | 3.3.0 | Manual runbook, from `dev-2.2` at `a6e16b075` (versions committed in `9b3183ffc` via `pnpm changeset:version`; the private `@arcaai/vox-node-codegen` aligned by hand in `66c50d8ac`) | Nine packages published in dependency order under the operator's global `~/.npmrc` token. `@arcaai/vox-node-codegen` is `private: true`, so `pnpm publish` refuses it — bumped for alignment only. |
| 2026-09-25 | 4.0.0 | **Local runbook release** (`./scripts/publish-sdk.sh 4.0.0`, dry run first) from `dev-2.2` at `379a370ac`, after pipeline #1338 passed; operator token `dohuta`. `SDK-4.0.0` re-pointed from `370bb8132` (where pipeline #1332 had been cancelled, nothing published) to `379a370ac` | Seven packages published in dependency order — **`types`** (joined the fixed group; the registry had a stale 0.1.0), `room`, `stt`, `vox`, `vox-codegen`, `vox-node`, `pipeline` — plus the private `vox-node-codegen` versioned only. Major: TASK-1004 (compat entry, `hope.summarization.*`) + TASK-1006 (client-AI packages deleted, `pipelineId` gone everywhere, sync summary methods, `hope.admin.audioPipeline` / `tenantSttConfig`). vox-node's `.d.ts` is now self-contained (it had imported `@arcaai/types`). |
| 2026-09-17 | 3.6.0 | CI `publish-sdk` job, protected `SDK-3.6.0` tag (annotated, at `dev-2.2` `7c6ea348f`), versioned locally via `pnpm changeset:version` from one changeset on the fixed group | All nine fixed-group packages at `3.6.0`. Schema-driven consultation context aligned end to end: typed `open<TContext>`, `consultations.listContext`, `governingRun`, `HopeAPIError.problems`, run `degraded` + node counts, `WorkflowSchemaDescription.contextSchema` / `reviewNodes`, `OPEN_REFUSAL_CODES` + `API_KEY_SCOPE_PRESETS` from `@arcaai/types`; codegen `--check`, `OpenConsultationContext`, `@schemaVersion` / `@contextSchema` / `@reviewNodes`; a NEW 400 `WORKFLOW_CONTEXT_INCOMPATIBLE` refusal on `open`. |
| previous | 3.5.0 | CI `publish-sdk` job, protected `SDK-3.5.0` tag, `pnpm changeset publish` | All nine fixed-group packages at `3.5.0` (`@arcaai/vox-node-codegen` stayed at `3.3.0`, aligned by hand). Fixed alongside this release (TASK-931): `@arcaai/json-schema-subset` and `@arcaai/vox-codegen` were missing from the CI build list; the manual path's registry confusion (a GitLab-targeted `.npmrc` that no publish ever addressed) is resolved. The CI path is now the one actually used to cut a release — treat the manual steps above as the fallback, not the default. |
| 2026-09-29 | 4.0.1 | **Local runbook release** (`./scripts/publish-sdk.sh 4.0.1`, dry run first) from `dev-2.2` at `c8c48f086` (versioned with `pnpm changeset:version`, changeset `task-1012-sdk-4-0-1`); operator token `dohuta`. Gate set green: `sdk:build`, `sdk-node:build`, `vox-codegen` + `pipeline` build, `sdk-node:typecheck`, `sdk-node:check:exports`, `sdk-codegen:test` (suites: vox 3,290, vox-node 587, stt 326 in the TASK-1012 gate pass) | Seven packages published in dependency order (`types`, `room`, `stt`, `vox`, `vox-codegen`, `vox-node`, `pipeline`); private `vox-node-codegen` versioned only. Patch: TASK-1012 — summary hooks moved to the async routes (they 404'd in 4.0.0) with per-route body whitelists, `pipelineId` never sent, dead `remoteConfig` injection removed, dead exports `@deprecated` for 5.0.0. Tag `SDK-4.0.1` not yet pushed. |
