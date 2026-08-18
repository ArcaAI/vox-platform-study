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

/**
 * THE EXPLICIT DECISION THIS GATE ASKED FOR (2026-08-18).
 *
 * The header says a legitimate future change touching these paths SHOULD fail this test and
 * "force an explicit decision, not be silently bypassed". That happened: two P0 security fixes
 * landed on the realtime hot path after TASK-724, and the gate did its job by going red.
 *
 * This is that decision, recorded in code rather than argued in a commit message. The gate is
 * NOT relaxed — it still fails on any UNEXPLAINED change under the forbidden prefixes. An entry
 * here must name the ticket and the reason, so the next reader can tell a sanctioned change from
 * a regression of TASK-724's actual claim (that the STT palette adds no new execution surface —
 * none of the entries below add one; they harden calls the hot path was already making).
 *
 * Note the standing limitation the header already records: `git status` sees the whole shared
 * tree, so these entries stay until the work is committed and the tree is clean.
 */
const SANCTIONED_LATER_CHANGES: ReadonlyArray<{ readonly path: string; readonly ticket: string; readonly why: string }> = [
  // TASK-737/738 — X-Tenant-Id made mandatory + the one shared INTERNAL_ACCESS_TOKEN (owner
  // decision D-D). The proxy forwards headers, so the tenant channel had to be added here.
  { path: 'apps/api/src/modules/streaming/text-proxy.controller.ts', ticket: 'TASK-737/738', why: 'mandatory tenant header + shared internal token' },
  { path: 'apps/api/src/modules/streaming/__tests__/text-proxy.controller.test.ts', ticket: 'TASK-737/738', why: 'covers the above' },
  { path: 'apps/api/src/modules/streaming/__tests__/text-proxy-runtime-profile.controller.test.ts', ticket: 'TASK-737/738', why: 'covers the above' },
  { path: 'apps/api/src/modules/streaming/__tests__/text-proxy-tenant-byo.controller.test.ts', ticket: 'TASK-737/738', why: 'covers the above' },
  // P0 (conformance review F-01) — apps/stt had NO inbound authentication. Closing it required
  // the gateway to start presenting the shared token AND the tenant on every non-exempt hop;
  // without this the fix would 401 every streaming session in a deployed environment.
  { path: 'apps/api/src/modules/streaming/stt-ws.gateway.ts', ticket: 'P0 F-01', why: 'threads tenant to stt session teardown' },
  { path: 'apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts', ticket: 'P0 F-01', why: 'covers the above' },
  { path: 'apps/api/src/modules/streaming/session-removal-retry.service.ts', ticket: 'P0 F-01', why: 'a retry must stay as attributable as the first attempt' },
  { path: 'apps/api/src/modules/streaming/__tests__/session-removal-retry.service.test.ts', ticket: 'P0 F-01', why: 'covers the above' },
  { path: 'apps/api/src/modules/streaming/transcription-job.controller.ts', ticket: 'P0 F-01', why: 'presents token + tenant to stt' },
  { path: 'apps/api/src/modules/streaming/__tests__/transcription-job.controller.test.ts', ticket: 'P0 F-01', why: 'covers the above' },
  { path: 'apps/api/src/modules/streaming/__tests__/transcription-job.stt-fallback.controller.test.ts', ticket: 'P0 F-01', why: 'covers the above' },
  // TASK-757 (policy A2) — `/api/v1/admin/*` becomes JWT-only. This controller is
  // `admin/audio/transcription-jobs`, so it is one of the 65 whose class-level
  // `@RequiredScopes(...)` becomes `@ForbidApiKey()`. It is a decorator swap on the ADMIN
  // read surface: no execution surface added, no realtime/batch call path touched, and the
  // non-admin `transcription-job.controller.ts` hot path is untouched by this ticket.
  {
    path: 'apps/api/src/modules/streaming/admin-transcription-job.controller.ts',
    ticket: 'TASK-757',
    why: 'admin plane becomes JWT-only — decorator swap only, no execution surface',
  },
  // TASK-760 (business-plane URI normalization) — `TextProxyController` moves off the
  // service-named `text` prefix onto the capability-named `text-generations`. This is the TEXT
  // proxy, not the STT realtime path: the WS gateway, the Redis-Streams bridge and
  // `transcription-job.controller.ts` are untouched by this ticket, and TASK-724's actual claim
  // (the STT palette adds no new execution surface) is unaffected. The shim below is a
  // redirect-only controller — it answers 308 and closes; it proxies nothing.
  // `text-proxy.controller.ts` itself is already sanctioned above (TASK-737/738); TASK-760's
  // change to it is the `@Controller` literal only, no handler body.
  {
    path: 'apps/api/src/modules/streaming/text-proxy-redirect.shim.controller.ts',
    ticket: 'TASK-760',
    why: '308 redirect shim for the retired `text` prefix — deleted in ALL-2.0.0',
  },
  {
    path: 'apps/api/src/modules/streaming/streaming.module.ts',
    ticket: 'TASK-760',
    why: 'registers the redirect shim above',
  },
];

const SANCTIONED_PATHS: ReadonlySet<string> = new Set(SANCTIONED_LATER_CHANGES.map((entry) => entry.path));

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
    // NOTE: a CLEAN tree is a legitimate state (fresh clone, CI checkout, right after a commit),
    // so emptiness is a PASS here — there is nothing under the forbidden prefixes. Asserting the
    // tree is dirty made this gate fail for reasons unrelated to the claim it encodes.
    const paths = changedPaths();

    const violations = paths
      .filter((path) => FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)))
      // A path in SANCTIONED_LATER_CHANGES has already had the explicit decision this gate
      // demands; anything else is still a violation and still fails loudly.
      .filter((path) => !SANCTIONED_PATHS.has(path));

    expect(
      violations,
      `the realtime/batch hot path must stay untouched by this palette's registry/compiler work.\n` +
        `If one of these is a deliberate, ticketed change, add it to SANCTIONED_LATER_CHANGES with its ticket and reason — that IS the explicit decision this gate exists to force:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
