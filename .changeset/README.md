# Changesets

`.gitlab/ci/publish.yml` runs `changeset version` then `changeset publish` against the
GitLab Package Registry. Until this directory existed, both were no-ops against a missing
install — SDK versions were hand-maintained, which is how `@arcaai/pipeline` sat a full
major behind the rest of the family without anything noticing.

## Adding a changeset

```bash
pnpm changeset
```

Pick the packages, pick major/minor/patch, write one line a consumer would understand.
The file it writes is committed with your change; CI consumes and deletes it.

## Two things this config encodes

**`fixed` — the SDK family versions in lockstep.** `@arcaai/vox`, `vox-node`, `room`, `stt`,
`vad`, `noise-filter`, `med-ner` and `pipeline` always move together, because
`08-vox-sdk.md` requires it and because a consumer pairing `vox@3` with `room@2` is a
support problem nobody wants. Bumping any one of them bumps all eight — that is the point,
not an inconvenience.

**`ignore` — public-but-not-published packages.** `async-contract`, `json-schema-subset`,
`vox-codegen` and `workflow-contract` are not in the publish job's build list. They are
listed here so `changeset publish` never tries.

## What this does NOT version

**Services and apps.** Per `docs/operations/versioning.md`, the git TAG is the version for
anything that ships as a container image — `apps/api` reporting `0.1.0` in every deployed
environment is the exact failure that rule exists to prevent. Apps are `private: true` so
Changesets cannot touch them; do not "fix" that by unsetting it.
