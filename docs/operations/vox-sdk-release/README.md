# Vox SDK Release — Operator Runbook

> How to build and publish the `@arcaai/vox` SDK family to GitHub Packages.
> This is a **manual, ad hoc** release path — the scaffolded GitLab CI pipeline
> (`.gitlab/ci/publish.yml`) targets the GitLab Package Registry instead, and is
> not wired up (Changesets isn't installed; see "Known gaps" below). Until one
> pipeline is finished and adopted, this page is the source of truth for cutting
> a release.

## Package inventory

| Package | Path | Role |
|---|---|---|
| `@arcaai/vox` | `packages/agentic-sdk-v2/` | The SDK itself — depends on all four packages below |
| `@arcaai/room` | `packages/room/` | Audio capture / `AudioTrack` / processor pipeline |
| `@arcaai/stt` | `packages/stt/` | Whisper STT plugin for `@arcaai/room` |
| `@arcaai/vad` | `packages/vad/` | Silero VAD plugin |
| `@arcaai/noise-filter` | `packages/noise-filter/` | RNNoise WASM plugin |
| `@arcaai/med-ner` | `packages/med-ner/` | Optional peer — browser medical NER |
| `@arcaai/pipeline` | `packages/pipeline/` | Sequential/parallel processing primitives — **not** a `vox` dependency; build/publish separately if needed |

All seven carry matching `publishConfig` and `repository` fields:

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

`registry` is the GitHub Packages npm endpoint (same for every package regardless of
which repo owns it). `repository.url` is what actually ties a published package to a
GitHub repo/org for permission checks — it must point at a repo the publishing token
has write access to. This has changed twice already this release cycle (previously
`Arca-AgenticSDK`, briefly `packages` from an unrelated concurrent edit) — **confirm
it still reads `ArcaAI/project-hope` before publishing** if it's been a while.

## One-time setup (per machine)

1. Create a GitHub PAT (classic) with `write:packages` + `read:packages` scopes,
   with write access to `ArcaAI/project-hope`.
2. Add the auth line to your **global** `~/.npmrc` (never commit a token to the repo):
   ```
   //npm.pkg.github.com/:_authToken=YOUR_TOKEN_HERE
   ```

## Release steps

```bash
# Bump all SDK packages together (recommended so workspace:* rewrites stay aligned)
for p in agentic-sdk-v2 room stt vad noise-filter med-ner pipeline; do
  node -e "
    const fs = require('fs');
    const path = 'packages/$p/package.json';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    pkg.version = '2.0.2';
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
    console.log(pkg.name + ' -> ' + pkg.version);
  "
done

# 1. Build vox + its workspace deps (room, stt, vad, noise-filter, med-ner)
pnpm sdk:build

# 2. Publish the dependencies first — vox won't resolve otherwise
pnpm --filter @arcaai/room publish --no-git-checks
pnpm --filter @arcaai/vad publish --no-git-checks
pnpm --filter @arcaai/noise-filter publish --no-git-checks
pnpm --filter @arcaai/stt publish --no-git-checks
pnpm --filter @arcaai/med-ner publish --no-git-checks

# 3. Publish vox last
pnpm --filter @arcaai/vox publish --no-git-checks

# 4. (Optional, separate — not a vox dependency)
pnpm --filter @arcaai/pipeline build
pnpm --filter @arcaai/pipeline publish --no-git-checks
```

`pnpm sdk:build` is `turbo run build --filter=@arcaai/vox...` (root `package.json`) —
the `...` suffix builds `vox` plus everything it depends on.

### Versioning

All seven packages are currently pinned to `2.0.0` for this release. Bump the
`version` field in the relevant `package.json` before re-publishing — the registry
rejects re-publishing an existing version with a 409.

### `--no-git-checks`

`pnpm publish` normally refuses to run on a dirty working tree or an unpushed
branch. `--no-git-checks` bypasses that. It does **not** affect auth or the
published artifact — it's purely a workflow gate. Prefer committing first and
dropping the flag when the tree is clean.

### `workspace:*` dependencies

`@arcaai/vox`'s `dependencies`/`peerDependencies` reference the other six packages
as `workspace:*`. `pnpm publish` rewrites these to the real version being published
automatically — no manual edit needed. But it means **publish order matters**:
a consumer installing `@arcaai/vox` needs the referenced versions of `room`, `stt`,
`vad`, `noise-filter`, and `med-ner` to already exist on the registry.

### `files` field

`@arcaai/vox` and `@arcaai/stt` didn't originally carry a `files` allowlist (unlike
`room`/`vad`/`noise-filter`/`med-ner`, which ship `dist` + `src` + `README.md`).
Both now have `files: ["dist", "src", "README.md"]` added for consistency — without
it, `npm pack` includes everything not `.gitignore`d, bloating the tarball.

## Known gaps

- **CI publish pipeline targets the wrong registry.** `.gitlab/ci/publish.yml` is
  fully scaffolded (Changesets version/publish flow, triggered by a `SDK-*`/`ALL-*`
  git tag) but publishes to the **GitLab** Package Registry, not GitHub Packages —
  despite five of the seven package.jsons declaring `publishConfig.registry:
  npm.pkg.github.com`. `@changesets/cli` isn't installed and `.changeset/` doesn't
  exist, so the pipeline isn't actually runnable yet.
- **Decide one path**: either finish the GitLab CI pipeline as documented (GitLab
  registry, Changesets), or rework it to push to GitHub Packages instead (matching
  the package.json declarations) — but not both, and not this manual path
  indefinitely.
- `@arcaai/pipeline` isn't part of `@arcaai/vox`'s dependency graph despite living
  alongside the other SDK packages — it needs its own build + publish step if a
  release should include it.
