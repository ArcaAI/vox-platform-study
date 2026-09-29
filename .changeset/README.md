# Changesets

SDK versions are cut with Changesets (`pnpm changeset:version`) and published to GitHub
Packages LOCALLY from the operator's machine per `docs/operations/vox-sdk-release/` — owner
rule, never by the CI `publish-sdk` job. Until this directory existed, versions were
hand-maintained, which is how `@arcaai/pipeline` sat a full major behind the rest of the
family without anything noticing.

## Adding a changeset

```bash
pnpm changeset
```

Pick the packages, pick major/minor/patch, write one line a consumer would understand.
The file it writes is committed with your change; `changeset version` consumes and deletes it.

## Two things this config encodes

**`fixed` — the SDK family versions in lockstep.** `@arcaai/vox`, `vox-node`, `vox-codegen`,
`room`, `stt`, `pipeline`, `types` and `vox-node-codegen` (private, versioned but never
published) always move together, because `08-vox-sdk.md` requires it and because a consumer
pairing `vox@4` with `room@3` is a support problem nobody wants. Bumping any one of them
bumps all eight — that is the point, not an inconvenience. (The client-AI packages `vad`,
`noise-filter` and `med-ner` left the family when they were deleted in 4.0.0, TASK-1006.)

**`ignore` — packages Changesets must never version.** The apps and backend libraries
(`admin-console`, `api`, `applications`, `database`, `domains`, `utils`) plus the shared
contracts `async-contract` and `workflow-contract`. They are listed here so `changeset
version` / `changeset publish` never touches them.

## What this does NOT version

**Services and apps.** Per `docs/operations/versioning.md`, the git TAG is the version for
anything that ships as a container image — `apps/api` reporting `0.1.0` in every deployed
environment is the exact failure that rule exists to prevent. Apps are `private: true` so
Changesets cannot touch them; do not "fix" that by unsetting it.
