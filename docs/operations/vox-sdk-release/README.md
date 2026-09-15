# Vox SDK Release — publishing `@arcaai/vox` and its family to GitHub Packages

How the `@arcaai/vox` SDK family is versioned and published to GitHub Packages. As of TASK-931
this is **CI-only**: pushing a protected `SDK-<ver>` or `ALL-<ver>` tag runs the `publish-sdk`
GitLab CI job (`.gitlab/ci/publish.yml`), which runs `pnpm changeset version` then
`pnpm changeset publish`, authenticated by a masked `GITHUB_PACKAGES_TOKEN` CI variable. The manual,
operator's-machine steps below this point are kept as a documented fallback, not the primary path —
the last several releases (through 3.5.0) were cut via CI.

## Layout

This directory holds only this file.

### Package inventory
Nine packages move together in one Changesets `fixed` group (`.changeset/config.json`):

| Package | Path | Role |
|---|---|---|
| `@arcaai/vox` | `packages/agentic-sdk-v2/` | The SDK itself — depends on all the packages below except `pipeline` |
| `@arcaai/vox-node` | `packages/vox-node/` | Non-browser server SDK sibling |
| `@arcaai/vox-codegen` | `packages/vox-codegen/` | Build-time CLI, published alongside the family |
| `@arcaai/room` | `packages/room/` | Audio capture / `AudioTrack` / processor pipeline |
| `@arcaai/stt` | `packages/stt/` | Whisper STT plugin for `@arcaai/room` |
| `@arcaai/vad` | `packages/vad/` | Silero VAD plugin |
| `@arcaai/noise-filter` | `packages/noise-filter/` | RNNoise WASM plugin |
| `@arcaai/med-ner` | `packages/med-ner/` | Optional peer — browser medical NER |
| `@arcaai/pipeline` | `packages/pipeline/` | Sequential/parallel processing primitives — not a `vox` runtime dependency, but versioned with the family |

`@arcaai/vox-node-codegen` is `private: true` and is deliberately in the Changesets `ignore` list —
it is never published, only version-aligned by hand alongside the rest.

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

### The CI path (current)

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

### The manual fallback (operator's machine)

Use only when CI cannot run. One-time setup: a GitHub PAT (classic) with `write:packages` +
`read:packages`, write access to `ArcaAI/project-hope`, added to your global `~/.npmrc`:

```
//npm.pkg.github.com/:_authToken=YOUR_TOKEN_HERE
```

```bash
# Bump every package in the fixed group to the same version first (see Versioning below).

# 1. Build vox + its workspace deps (room, stt, vad, noise-filter, med-ner)
pnpm sdk:build

# 2. Publish the dependencies first — vox won't resolve otherwise
pnpm --filter @arcaai/room publish --no-git-checks
pnpm --filter @arcaai/vad publish --no-git-checks
pnpm --filter @arcaai/noise-filter publish --no-git-checks
pnpm --filter @arcaai/stt publish --no-git-checks
pnpm --filter @arcaai/med-ner publish --no-git-checks

# 3. Publish vox and its siblings last
pnpm --filter @arcaai/vox publish --no-git-checks
pnpm --filter @arcaai/vox-codegen publish --no-git-checks
pnpm --filter @arcaai/vox-node publish --no-git-checks

# 4. Pipeline (not a vox dependency, but part of the fixed group)
pnpm --filter @arcaai/pipeline build
pnpm --filter @arcaai/pipeline publish --no-git-checks
```

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
`@arcaai/vox` needs the referenced versions of `room`, `stt`, `vad`, `noise-filter`, and `med-ner`
to already exist on the registry.

## Gotchas

- **`GIT_LFS_SKIP_SMUDGE` must stay `"0"` for this job.** `@arcaai/noise-filter`'s `files` allowlist
  ships `assets/rnnoise.wasm`, an LFS object — an LFS pointer stub would publish a broken package.
- **A GitLab-registry `.npmrc` can never authenticate this publish.** `changeset publish` honors
  each package's own `publishConfig.registry` (`npm.pkg.github.com`), so writing GitLab registry
  credentials into `.npmrc` — an earlier version of this pipeline's mistake — authenticates a
  registry that is never addressed.
- **`@arcaai/vox-node-codegen` refuses `pnpm publish`** (it is `private: true`) — bump its version
  for alignment only, never try to publish it.
- **Nine packages move together**; publishing a subset out of the `fixed` group risks a version
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
| current | 3.5.0 | CI `publish-sdk` job, protected `SDK-3.5.0` tag, `pnpm changeset publish` | All nine fixed-group packages at `3.5.0` (`@arcaai/vox-node-codegen` stayed at `3.3.0`, aligned by hand). Fixed alongside this release (TASK-931): `@arcaai/json-schema-subset` and `@arcaai/vox-codegen` were missing from the CI build list; the manual path's registry confusion (a GitLab-targeted `.npmrc` that no publish ever addressed) is resolved. The CI path is now the one actually used to cut a release — treat the manual steps above as the fallback, not the default. |
