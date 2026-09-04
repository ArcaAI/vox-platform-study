# HOPE — Release Versioning & Cutting a Release

> Operator runbook for cutting a release: how to decide the version bump, what to
> type, what CI does automatically, and what still needs a human. The
> single source of truth for the tag grammar in code is
> [`packages/utils/src/version-grammar.ts`](../../packages/utils/src/version-grammar.ts).
>
> **Deploy mechanics** (Argo CD, GitOps, rollback) are a separate concern documented in
> [`docs/operations/deployment/README.md`](deployment/README.md). This page is about
> *versions* — deciding one, cutting the tag that produces it, and what happens to it
> afterward. Where the two overlap (promotion to prod), this page states the invariant
> and points at the deployment runbook for the mechanics.

---

> **Doing the release?** [release-runbook.md](./release-runbook.md) is the hands-on
> companion: which command to run in which order, how Changesets versions the npm
> packages (this document covers tags, which version the SERVICES), and the traps.

## 1. Deciding the version bump

Every service is versioned independently by its own git tag family; the platform as a
whole additionally has a release train (§2). For a given change, ask what it touches:

| Bump | When | Examples |
|---|---|---|
| **MAJOR** | Breaking change to a **published contract** | Gateway REST/WS shape changes in an incompatible way; a `@arcaai/vox` or `@arcaai/vox-node` public API removed/changed; a DB migration that isn't backwards-compatible with the previous release; a config key removed |
| **MINOR** | Backwards-compatible capability | New endpoint; new provider; new optional field or env var |
| **PATCH** | No contract impact | Bug fix, dependency bump, perf, docs, infra-only change |
| **Pre-release** | Release candidate, never promotable to prod | `-rc.N`, `-alpha.N`, `-beta.N` suffix |

If you are unsure whether something is a "published contract": the gateway's REST/WS
surface, an SDK's public exports, a Prisma migration, and a documented config key all
count. An internal refactor with the same external behavior does not — that's PATCH.

CI enforces the MAJOR half of this rule mechanically once the changelog generator (W12)
ships: a `BREAKING CHANGE:` footer or `feat!:`/`fix!:` marker in the commits since the
last tag of the same family fails the release pipeline unless the new tag is a MAJOR
bump. Until then, this is a human judgment call — get it right, because the registry
badge and the changelog both derive from the tag, not from a description you type
afterward.

---

## 2. The tag grammar — what to type

The git tag **is** the version. There is no other input.

```
<SVC>-<MAJOR>.<MINOR>.<PATCH>[-<prerelease>]     e.g. TEXT-2.1.0, STT-3.0.0-rc.1
ALL-<MAJOR>.<MINOR>.<PATCH>                      e.g. ALL-2.2.0 — the platform release train
```

Valid `<SVC>` prefixes (`packages/utils/src/version-grammar.ts`, `SERVICE_TAG_PREFIXES`,
kept in lockstep with the tag regexes in `.gitlab/ci/build.yml`):

```
ALL  API  ADMIN  GUARD  HARNESS  NLP  TEXT  STT  TTS
```

(`SDK` is also accepted by the workflow-level tag rule for the separate npm-SemVer SDK
family — see `.gitlab-ci.yml` and `08-vox-sdk.md`; it does not build a container image
and is out of scope for this doc.)

Numeric components reject leading zeros (real SemVer). The pre-release suffix follows
SemVer's dot-separated identifier grammar. Build metadata (`+...`) is **not** accepted —
an image is identified by its digest, and a `+build` suffix would be a second, weaker
identity competing with it.

```bash
git tag TEXT-2.1.0
git push origin TEXT-2.1.0
```

### Which tags trigger which builds

Tag → `PIPELINE_TYPE` is decided in `.gitlab-ci.yml` (`workflow.rules`), and the actual
per-service build jobs live in `.gitlab/ci/build.yml`:

| Tag matches | `PIPELINE_TYPE` | What runs |
|---|---|---|
| `^(SDK\|TEXT\|STT\|GUARD\|TTS\|HARNESS\|API\|ADMIN\|NLP\|ALL)-` | `release` | The full test suite (`rules.yml` runs everything on a release-tag pipeline), then the build job(s) whose own rule matches the tag prefix |
| `^v\d+` (e.g. `v2.2.0`) | `tag_release` | **No build.** Only `promote-prod` becomes available (manual) — see §4 |

Each build job in `build.yml` has its own `rules:` on top of the shared
`.build-common-rules`, keyed on the exact prefix — e.g. `build-text` runs on
`$CI_COMMIT_TAG =~ /^TEXT-/ || $CI_COMMIT_TAG =~ /^ALL-/`, `build-api` on
`/^API-/ || /^ALL-/`, and so on for every service in the scope table below. So:

- `TEXT-2.1.0` builds only the `text` image.
- `ALL-2.2.0` builds **every** image (`api`, `admin-console`, `text`,
  `stt-ml-runtime`, `stt-worker`, `nlp`, `guardrail`, `tts`, `harness`, `harness-worker`,
  `database`, `qdrant-init`, `hope-python-base`) — that is what makes it "the platform
  release train."

The image pushed by a release-tag build is tagged with the **tag itself, verbatim**
(non-alphanumerics replaced with `-`) plus `sha-<sha8>` — see `.build-template` in
`.gitlab/ci/templates.yml`. It is never tagged `latest`.

**A release tag (`TEXT-2.1.0`, `ALL-2.2.0`) builds and publishes images. It does not, by
itself, deploy anywhere.** Deployment to `dev`/`staging` happens automatically from
`dev-*`/`staging-*` branch pushes (`promote-dev`/`promote-staging` in
`.gitlab/ci/deploy.yml`, gated on `PIPELINE_TYPE == "dev"`/`"staging"`). Production is a
different tag family entirely — see §4.

---

## 3. What happens automatically after you push a release tag

1. **Full test suite** runs (release-tag pipelines are never test-skipped).
2. **Build**: each matching service's Dockerfile builds, stamped with the OCI labels
   `org.opencontainers.image.{source,revision,created,version}` (`.build-template`).
   The image additionally carries
   `/app/build-info.json` — the build-metadata contract in
   [`docs/operations/build-info.schema.json`](build-info.schema.json) —
   baked in from the same build args, so the running process can report its own real
   version instead of a stale constant (§5).
3. **Digest capture**: the CI publish step resolves the pushed manifest's digest.
4. **Release row**: the service registers itself with the gateway on next boot (or, for
   the registry to have a row even before any pod restarts, the CI digest-capture step
   attaches the digest to the release row) — `ServiceRelease`, one immutable row per
   `(serviceName, gitCommitSha, releaseTag)`.
5. **Generated technical changelog**: CI collects commits since the previous tag of the
   same family, groups them by Conventional Commit type, and attaches the JSON to the
   release row (`ServiceRelease.changelog`) — this is machine-generated and never
   hand-edited.
6. **On an `ALL-` tag only**: CI also creates a **DRAFT** `ChangelogEntry` — the curated,
   human-readable "what's new" note — pre-filled from the `feat` + breaking-change
   commits.

What still needs a human:

- **Publishing the release note.** The `ChangelogEntry` CI creates is a draft. A global
  admin edits it into plain language and publishes it from the admin console before any
  tenant admin sees it on login. An unpublished draft is invisible to everyone but global
  admins.
- **Promoting to staging/prod.** Reaching `staging` still requires a `staging-*` branch
  push (today the only live environment is `hope-v2-dev` — see
  `docs/operations/deployment/README.md` §2 before assuming otherwise). Reaching `prod`
  is always a separate, manual step — §4.

---

## 4. How production is reached: digest promotion only, never a build

**This is the load-bearing invariant of the whole design: one release row, three
environments.** A production deploy never rebuilds anything. It takes a digest that a
`dev-*`/`staging-*` pipeline already built and scanned on this same commit, and attaches
that digest to the environment.

Concretely:

- Production is triggered by a **separate tag family**, `vX.Y.Z` (e.g. `v2.2.0`) — not
  `ALL-<ver>` and not a `<SVC>-<ver>` tag. Pushing a `vX.Y.Z` tag sets
  `PIPELINE_TYPE=tag_release` (`.gitlab-ci.yml`), and `.gitlab/ci/build.yml`'s
  `.build-common-rules` has **no** clause that matches `tag_release`, so nothing builds.
- The `promote-prod` job (`.gitlab/ci/deploy.yml`) is the only thing that runs, and it is
  `when: manual` — a human clicks it. Its rule is `if: $PIPELINE_TYPE == "tag_release"`.
- `promote-prod` calls `.gitlab/ci/promote.sh`, which resolves the `sha-<sha8>` image a
  prior `dev-*`/`staging-*` pipeline already pushed **for the same `$CI_COMMIT_SHA`**
  (pushing a tag never moves the commit it points at, so the SHA is identical to whatever
  branch pipeline last built it), copies that manifest to the `prod` environment tag with
  `docker buildx imagetools create` (zero rebuild), pins the `deployment/k8s/overlays/prod`
  Kustomize overlay to the resolved `sha256:` digest, and pushes that commit to the
  `arca/hope-v2-deployment` repo's `main` — the branch Argo CD's prod Application tracks.
  If no such `sha-<sha8>` image exists yet, `imagetools inspect` fails closed rather than
  silently rebuilding.
- **The commit you tag `vX.Y.Z` must already have been built and scanned on a
  `dev-*`/`staging-*` branch pipeline.** If it hasn't, `promote-prod` has nothing to
  promote and fails.

So the sequence for a production release is: land the change on `dev-*` (or
`staging-*` once that environment is live), let the branch pipeline build and push
`sha-<sha8>`, cut the matching `<SVC>-<ver>`/`ALL-<ver>` release tag for the version
record and changelog, then — separately — tag the same commit `vX.Y.Z` and run
`promote-prod` manually. One `ServiceRelease` row, three environments' worth of
`ServiceInstance` rows pointing at it.

---

## 5. Rules that will bite

- **Tags are immutable and never moved.** The same rule already holds for image digests
  (see `docs/operations/deployment/README.md` §1 on why a live rollback must go through
  Git, never a direct mutation). Re-tagging a release would silently repoint a release
  row at different code with no error anywhere.
- **The git tag is the version — never `package.json`, never `npm_package_version`, never
  a hand-maintained constant.** `apps/api/src/modules/health/health.controller.ts:12`
  currently reads
  `const SERVICE_VERSION = process.env.npm_package_version || '0.1.0';` — `npm_package_version`
  is set by the pnpm/npm script runner, but the API image starts `node dist/main.js`
  directly, so that env var is never set in any deployed container and the gateway has
  reported `0.1.0` in every environment it has ever run in. The fix is to read the baked
  `/app/build-info.json` instead. Do not reintroduce a `package.json` version as a source of truth anywhere in this system.
- **Untagged builds never get a fake SemVer.** A `dev-*`/`staging-*`/`cicd`/feature branch
  push produces `0.0.0-<branch-slug>.<sha8>` (e.g. branch `dev-2.1`, commit `0ab258f9…` →
  `0.0.0-dev-2-1.0ab258f9`), using the exact same `[^a-zA-Z0-9]` → `-` slugging rule the
  image-tag computation in `.build-template` already applies to `CI_COMMIT_BRANCH`, so the
  version string and the image tag agree. It sorts below every real release and reads as
  "not a release" in the console at a glance.
- **An untagged build can never be promoted to prod.** `promote-prod` requires
  `CI_COMMIT_TAG` to be set (`promote.sh`: `: "${CI_COMMIT_TAG:?promote-prod must run on a
  vX.Y.Z tag pipeline...}"`) — there is no path from a bare branch build to production.
- **`ALL-<ver>` and `vX.Y.Z` are not the same tag and do not imply each other.** Cutting
  `ALL-2.2.0` does not deploy anything and does not require you to also cut `v2.2.0` —
  they serve different purposes (release/changelog record vs. prod promotion trigger).
  Keep their version numbers aligned by convention when you do cut both for the same
  platform release, but nothing in CI enforces that they match.
- **Pre-releases (`-rc.N`, `-alpha.N`, `-beta.N`) never promote to prod.** They exist for
  release-candidate testing on dev/staging only.

---

## 6. Worked example — cutting `ALL-2.2.0`

1. **Confirm the bump.** You're shipping a new Text provider (backwards-compatible) and a
   guardrail bug fix — nothing breaks a published contract, so this is a MINOR bump:
   `2.1.0` → `2.2.0`.
2. **Make sure the commit is already built on a branch pipeline** if you intend to reach
   prod from it — push (or confirm you're on) `dev-2.2` (or the relevant `dev-*`/
   `staging-*` branch) so `sha-<sha8>` already exists in the registry.
3. **Cut and push the platform tag:**
   ```bash
   git tag ALL-2.2.0
   git push origin ALL-2.2.0
   ```
4. **Watch the pipeline.** `PIPELINE_TYPE=release` runs the full test suite, then builds
   every image in scope (`api`, `admin-console`, `text`,
   `stt-ml-runtime`, `stt-worker`, `nlp`, `guardrail`, `tts`, `harness`,
   `harness-worker`, `database`, `qdrant-init`, `hope-python-base`), each tagged
   `ALL-2.2.0` + `sha-<sha8>`. CI collects the commits since the previous `ALL-` tag,
   generates the technical changelog per service, and creates a **DRAFT**
   `ChangelogEntry` for the platform version `2.2.0`.
5. **Publish the release note.** In the admin console, a super admin opens the draft,
   rewrites it for a tenant-admin audience, and publishes it. It will now appear once,
   on next login, to every admin who hasn't seen it (never during impersonation).
6. **Check the registry.** Once each service has booted with the new image (on whichever
   environment it's actually deployed to), `/(console)/(global)/releases` shows the new
   `ServiceRelease` rows and, per service, whether a live `ServiceInstance` is running
   that version yet.
7. **When ready for production**, tag the *same* commit separately:
   ```bash
   git tag v2.2.0
   git push origin v2.2.0
   ```
   This does not rebuild anything — it only makes the manual `promote-prod` job
   available. Run it; it re-tags the already-scanned `sha-<sha8>` digest into the `prod`
   overlay and pushes the promotion commit to `arca/hope-v2-deployment`. Follow
   `docs/operations/deployment/README.md` §4 to confirm Argo CD picked it up and to run
   the post-deploy smoke check.
