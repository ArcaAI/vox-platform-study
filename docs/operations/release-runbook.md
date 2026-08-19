# Release runbook — scripts, Changesets, and cutting a version

| | |
|---|---|
| **Companion to** | [versioning.md](./versioning.md) — that document owns the tag grammar and what CI does with a tag. This one is the hands-on procedure: which command to run, in which order, and what will bite you. |
| **Audience** | Whoever is cutting the release. |

---

## 1. The one thing to understand first

**This repo has two version systems, and they do not overlap.** Nearly every release mistake
comes from applying one system's rules to the other's artifact.

| | npm packages | Services and apps |
|---|---|---|
| **What** | `@arcaai/vox`, `vox-node`, `room`, `stt`, `vad`, `noise-filter`, `med-ner`, `pipeline`, plus `utils`, `types`, `json-schema-subset` | `apps/api`, the Python services, `admin-console` |
| **Ships as** | a tarball in the GitLab Package Registry | a container image |
| **Versioned by** | **Changesets** → the version in `package.json` | **the git tag** → baked into `/app/build-info.json` at build time |
| **You bump it by** | `pnpm changeset`, then CI | pushing a tag |
| **`package.json` version** | authoritative | **meaningless — never edit it** |

> **Why `package.json` is meaningless for services.** `apps/api` reported `0.1.0` in every
> deployed environment for exactly as long as anyone read its `package.json` for a version.
> The tag is the version. Apps are `private: true` so Changesets cannot touch them; do not
> "fix" that.

---

## 2. Scripts, and when each is right

```bash
pnpm changeset             # describe a change — run this WITH your PR, not at release time
pnpm changeset:status      # what would be released, and what has no changeset yet
pnpm changeset:version     # consume changesets → bump package.json + write CHANGELOGs   [CI does this]
pnpm changeset:publish     # push tarballs to the registry                                [CI does this]
```

`changeset:version` and `changeset:publish` are listed so you can reason about CI and run them
in an emergency. **In the normal flow you run neither** — you run `pnpm changeset` while writing
the change, and CI does the rest.

### `scripts/publish-sdk.sh` (`pnpm sdk:publish`) — superseded

This script exists only because Changesets was never configured; its own header says *"If
changesets is ever configured, prefer it and retire this script."* Changesets **is** configured
now, so:

- **Do not use it for a normal release.** It hand-bumps every package to a version you type,
  which is precisely how the SDK family drifted (`@arcaai/pipeline` sat at `2.0.6` while the
  rest moved to `3.0.0`).
- It is kept as a **break-glass fallback** for the case where the registry rejects a Changesets
  publish half-way and you need to push one package by hand. Use `--dry-run` first.

---

## 3. Releasing npm packages (the SDK family)

### While writing the change

```bash
pnpm changeset
```

Pick the packages, pick major/minor/patch, and write **one line a consumer would understand** —
it lands verbatim in the published CHANGELOG. Commit the generated `.changeset/*.md` file with
your code. That is the whole author-side obligation.

**Picking the bump.** Anything a consumer must react to is `major`: a renamed export, a changed
request or response shape, a removed path, a new required option. If you are unsure between
`minor` and `major`, it is `major` — an unexpected major costs someone an afternoon; an
unexpected breaking change costs them a production incident.

**The eight SDK packages move together.** `fixed` in `.changeset/config.json` groups `vox`,
`vox-node`, `room`, `stt`, `vad`, `noise-filter`, `med-ner` and `pipeline`, so a changeset
touching any one of them bumps **all eight** to the same version. This is deliberate
(`08-vox-sdk.md`): a consumer pairing `vox@3` with `room@2` is a support problem nobody wants.
Do not try to release one of them alone.

### At release time

Nothing manual. CI's `publish-sdk` job runs `changeset version` (bump + CHANGELOG), builds every
publishable package, runs `changeset publish`, and commits the version bumps back.

### Checking before you cut

```bash
pnpm changeset:status
```

- *"Some packages have been changed but no changesets were found"* → a real change is about to
  ship silently unversioned. Add one, or `pnpm changeset --empty` if it genuinely needs no
  release (a test-only or docs-only change).
- Exit 0 with a bump list → that is exactly what CI will publish.

---

## 4. Releasing a service

Services are not touched by Changesets at all. Follow [versioning.md](./versioning.md) §2–§3:
push a tag matching `<SVC>-<M>.<m>.<p>` (e.g. `TEXT-2.1.0`) or `ALL-<M>.<m>.<p>` for the platform
train. CI builds the image, captures the digest, registers the release row, and generates the
technical changelog from commits.

**A tag does not deploy anything.** Reaching production is a separate, manual digest promotion —
never a rebuild. versioning.md §4 is the authority.

---

## 5. Cutting a platform train (`ALL-*`) — the full sequence

This is the only flow that touches both systems.

1. **Land the work.** Every PR that changes a published package carries its own changeset.
2. **Check the ledger is clean.**
   ```bash
   pnpm changeset:status
   pnpm verify              # lint + typecheck + test
   ```
3. **Write the human release note.** CI generates a *technical* changelog from commits and, on
   an `ALL-` tag only, a **draft** `ChangelogEntry`. The draft is pre-filled from `feat` and
   breaking-change commits and is **not publishable as-is** — a global admin edits it into plain
   language in the admin console. Draft it in the repo first, under
   [`docs/operations/release-notes/`](./release-notes/), so it is reviewable in the PR rather
   than typed into a web form at the last minute. `ALL-3.0.0.md` is the worked example.
4. **Push the tag.** `git tag ALL-3.1.0 && git push origin ALL-3.1.0`.
5. **Let CI run.** Images built and scanned, digests captured, release rows registered, SDK
   packages versioned and published, draft `ChangelogEntry` created.
6. **Publish the release note** from the admin console. Until a global admin publishes it, it is
   invisible to every tenant.
7. **Promote to an environment** — a separate manual step, digest only (versioning.md §4).

---

## 6. Rules that will bite

**Never hand-edit a published package's version.** It is how `pipeline` fell a major behind the
family and stayed there unnoticed. If you find yourself typing a version number into a
`package.json`, stop — that is `pnpm changeset`'s job.

**A public-but-unpublished package must be in `ignore`.** `.changeset/config.json` lists
`async-contract`, `vox-codegen` and `workflow-contract`. Miss one and `changeset publish` will
try to push it to the registry.

**But an ignored package may not be a dependency of a published one.** Changesets validates this
and refuses to run. `@arcaai/json-schema-subset` is a `workspace:*` runtime dependency of
`@arcaai/vox`, so it must be published, and it must be in the publish job's build list — it was
missing from that list, which would have shipped a `@arcaai/vox` whose dependency could not be
resolved.

**A new app must be `private: true` from its first commit.** Otherwise `changeset publish` will
attempt to npm-publish a deployable service.

**`changeset version` is destructive to changeset files** — it consumes and deletes them. That is
correct behaviour, but it means running it locally to "see what would happen" loses the files
unless you discard the working tree afterwards. Prefer `pnpm changeset:status`.

**An untagged build can never reach production.** It is versioned `0.0.0-<branch>.<sha8>` by
design (versioning.md §5).

---

## 7. If something goes wrong

| Symptom | What it means | Do |
|---|---|---|
| `changeset status` exits 1 with *"no changesets were found"* | A change is about to ship unversioned | `pnpm changeset`, or `--empty` if no release is warranted |
| *"Invalid tree: X depends on the skipped package Y"* | An `ignore` entry is a dependency of a published package | Remove Y from `ignore` and add it to the publish job's build list |
| Publish half-succeeded | Some tarballs are in the registry, some are not | Re-running `changeset publish` is safe — it skips versions already present. Only if that fails, use `pnpm sdk:publish:dry` to inspect, then the break-glass script |
| Published `@arcaai/vox` fails to install | A `workspace:*` dependency was not published alongside it | Check the publish job's build list against `dependencies` |
| A service reports version `0.0.0-…` | It was built from an untagged commit | Expected. Tag it and rebuild; do not edit `package.json` |
