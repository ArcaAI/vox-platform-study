/**
 * TASK-724 (STT palette) — grep-gate proving the realtime hot path is untouched.
 *
 * README §1's central design decision is that a published STT `WorkflowDefinition` compiles
 * into an `AsrPipeline` + `AsrPipelineVersion` row (Task 4) and binds `pipelineId` into the
 * EXISTING realtime/batch entry points — it adds NO new execution surface. §4 Task 6 and the
 * ticket's own Acceptance Criteria name a concrete, checkable claim: this ticket's diff touches
 * no file under `apps/api/src/modules/streaming/**` (the WS gateway, Redis-Streams bridge,
 * transcription-job controller — the realtime/batch hot path) or `apps/stt/src/stt/streaming/**`
 * (the Python streaming session machinery). Mirrors TASK-704's Task 6 grep-gate pattern: a
 * repo-enforced, machine-checkable version of a claim made in prose.
 *
 * Uses `git status --porcelain` (not `git diff`, which misses untracked new files) against the
 * live working tree — this asserts the CURRENT state of the shared tree, not "only this
 * ticket's own changes" (a shared-tree limitation with no clean per-ticket attribution
 * mechanism available here — see this ticket's README §7 for the concurrent-session context).
 * If a legitimate future change needs to touch these paths, this test SHOULD fail and force an
 * explicit decision, not be silently bypassed.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

const FORBIDDEN_PREFIXES = ['apps/api/src/modules/streaming/', 'apps/stt/src/stt/streaming/'];

function changedPaths(): string[] {
  const raw = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // porcelain format: "XY path" or "XY path -> newpath" for renames — take the last token.
    .map((line) => line.split(' -> ').pop() ?? line)
    .map((line) => line.replace(/^[ MADRCU?!]{1,2}\s+/, '').replace(/^"(.*)"$/, '$1'));
}

describe('TASK-724 realtime hot path untouched (grep-gate)', () => {
  it('the working tree has no changed/new file under apps/api/src/modules/streaming/** or apps/stt/src/stt/streaming/**', () => {
    const paths = changedPaths();
    expect(paths.length, 'sanity: git status must report something in an active dev tree').toBeGreaterThan(0);

    const violations = paths.filter((path) => FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)));

    expect(violations, `the realtime/batch hot path must stay untouched by this palette's registry/compiler work:\n${violations.join('\n')}`).toEqual([]);
  });
});
