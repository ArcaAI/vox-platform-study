#!/usr/bin/env tsx
/**
 * CI tag-grammar gate.
 *
 * Rejects a release tag that does not match the frozen grammar defined in
 * `packages/utils/src/version-grammar.ts` (`RELEASE_TAG_PATTERN`). Imports
 * that module directly instead of re-deriving a second shell regex, so the
 * CI gate, the build-info readers, and the console badge cannot drift apart.
 *
 * SDK release tags (`SDK-<semver>`) are a pre-existing, separate scheme — the
 * SDK family stays in npm-SemVer lockstep publishing via `publish-sdk`
 * (out of scope for this grammar) — and are intentionally NOT
 * governed by this grammar. They are skipped, not rejected.
 *
 * Invoked by the `validate-release-tag` job in `.gitlab/ci/validate.yml`,
 * which only runs when `PIPELINE_TYPE == "release"` (the `<SVC>-`/`ALL-` tag
 * family — see `.gitlab-ci.yml`'s workflow rules). The separate `v<X.Y.Z>`
 * tag family (`PIPELINE_TYPE == "tag_release"`, promote-prod) builds nothing
 * and is out of scope for this grammar (see `.gitlab/ci/promote.sh`).
 */
import { RELEASE_TAG_PATTERN, SERVICE_TAG_PREFIXES } from '../../packages/utils/src/version-grammar';

const tag = process.env.CI_COMMIT_TAG;

if (!tag) {
  console.log('No CI_COMMIT_TAG set — nothing to validate.');
  process.exit(0);
}

if (tag.startsWith('SDK-')) {
  console.log(`"${tag}" is an SDK release tag — governed by npm SemVer via publish-sdk, not this grammar. Skipping.`);
  process.exit(0);
}

if (!RELEASE_TAG_PATTERN.test(tag)) {
  console.error(
    `Release tag "${tag}" does not match the grammar <SVC>-<MAJOR>.<MINOR>.<PATCH>[-<prerelease>] ` +
      `(service ∈ ${SERVICE_TAG_PREFIXES.join(', ')}). Build metadata ("+...") is rejected — an image is ` +
      `identified by its digest, not a second, weaker version string. ` +
      `See the release-tag grammar.`,
  );
  process.exit(1);
}

console.log(`"${tag}" matches the release tag grammar.`);
