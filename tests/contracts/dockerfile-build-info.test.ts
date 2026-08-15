/**
 * Every runnable image must bake `/app/build-info.json` from the
 * eight BUILD_* args CI passes (see .gitlab/ci/build.yml SERVICE_NAME per job
 * and docs/implementation/TASK-648-Service-Version-And-Release-Registry/
 * contracts/build-info.schema.json). This test asserts the invariant across
 * every Dockerfile CI actually builds a running image from.
 *
 * Deliberately excluded (documented, not silently skipped):
 *   - infrastructure/docker/python-base/Dockerfile — shared BASE image only,
 *     no CMD/ENTRYPOINT, never runs as a process. Every consumer of it bakes
 *     its own build-info.json in its own final stage.
 *   - apps/example/Dockerfile — not built by any job in .gitlab/ci/build.yml
 *     (a standalone raw-WebSocket demo); not part of the build-info schema's
 *     `service` enum.
 *   - apps/stt/docker/Dockerfile.apple — Apple-silicon local dev variant, not
 *     built by CI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');

const REQUIRED_ARGS = [
  'BUILD_SERVICE',
  'BUILD_VERSION',
  'BUILD_RELEASE_TAG',
  'BUILD_GIT_BRANCH',
  'BUILD_GIT_SHA',
  'BUILD_AT',
  'BUILD_CI_PIPELINE_ID',
  'BUILD_CI_PIPELINE_URL',
] as const;

interface DockerfileCase {
  /** Path relative to repo root. */
  path: string;
  /** Human label for assertion messages. */
  label: string;
}

// One entry per Dockerfile that CI builds into a runnable image
// (.gitlab/ci/build.yml `build-*` jobs). Dockerfiles that produce more than
// one SERVICE_NAME from different --target stages (harness, stt) still only
// need ONE bake site, because each target's stage inherits from (or IS) the
// stage that writes build-info.json, and the SAME --build-arg BUILD_SERVICE
// value flows through the whole build invocation regardless of which stage
// is the final --target.
const RUNNABLE_DOCKERFILES: DockerfileCase[] = [
  { path: 'apps/api/Dockerfile', label: 'api' },
  { path: 'apps/admin-console/Dockerfile', label: 'admin-console' },
  { path: 'apps/compat-playground/Dockerfile', label: 'compat-playground' },
  { path: 'apps/text/Dockerfile', label: 'text' },
  { path: 'apps/nlp/Dockerfile', label: 'nlp' },
  { path: 'apps/guardrail/Dockerfile', label: 'guardrail' },
  { path: 'apps/tts/Dockerfile', label: 'tts' },
  { path: 'apps/harness/Dockerfile', label: 'harness + harness-worker' },
  { path: 'apps/stt/docker/Dockerfile', label: 'stt-ml-runtime + stt-worker' },
  { path: 'packages/database/Dockerfile', label: 'database' },
  { path: 'infrastructure/docker/qdrant-init/Dockerfile', label: 'qdrant-init' },
];

function readDockerfile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8');
}

describe('build-info.json bake contract', () => {
  it.each(RUNNABLE_DOCKERFILES)('$label declares all eight BUILD_* args', ({ path }) => {
    const contents = readDockerfile(path);
    for (const arg of REQUIRED_ARGS) {
      expect(contents, `${path} is missing "ARG ${arg}"`).toMatch(new RegExp(`^ARG ${arg}$`, 'm'));
    }
  });

  it.each(RUNNABLE_DOCKERFILES)('$label writes /app/build-info.json', ({ path }) => {
    const contents = readDockerfile(path);
    expect(contents, `${path} does not write /app/build-info.json`).toContain('> /app/build-info.json');
  });

  it.each(RUNNABLE_DOCKERFILES)(
    '$label handles null releaseTag/ciPipelineId/ciPipelineUrl as bare JSON null, not the string "null"',
    ({ path }) => {
      const contents = readDockerfile(path);
      // The printf format string must place these three fields UNQUOTED
      // (%s substituted with either a quoted string or the bare word null,
      // computed beforehand) — never `"%s"` for these three keys, which
      // would bake the literal string "null" when the arg is empty.
      expect(contents).toMatch(/"releaseTag":%s/);
      expect(contents).toMatch(/"ciPipelineId":%s/);
      expect(contents).toMatch(/"ciPipelineUrl":%s/);
      expect(contents).not.toMatch(/"releaseTag":"%s"/);
      expect(contents).not.toMatch(/"ciPipelineId":"%s"/);
      expect(contents).not.toMatch(/"ciPipelineUrl":"%s"/);
    },
  );

  it.each(RUNNABLE_DOCKERFILES)('$label writes build-info.json as the LAST RUN before USER/CMD/ENTRYPOINT', ({ path }) => {
    const contents = readDockerfile(path);
    const buildInfoIndex = contents.indexOf('> /app/build-info.json');
    expect(buildInfoIndex, `${path}: build-info write not found`).toBeGreaterThan(-1);

    // Every COPY --from=builder / COPY --from=ml-builder (source-code and
    // dependency layers) must appear BEFORE the build-info write, so the
    // per-commit BUILD_* args invalidate as little of the cache as possible.
    const copyFromMatches = [...contents.matchAll(/^COPY --from=/gm)];
    for (const match of copyFromMatches) {
      expect(match.index, `${path}: a COPY --from= appears after the build-info write`).toBeLessThan(buildInfoIndex);
    }
  });

  it('hope-python-base is deliberately NOT in the runnable set (base image, no CMD/ENTRYPOINT)', () => {
    const contents = readDockerfile('infrastructure/docker/python-base/Dockerfile');
    expect(contents).not.toMatch(/^(CMD|ENTRYPOINT)/m);
    expect(contents).not.toContain('build-info.json');
  });
});
