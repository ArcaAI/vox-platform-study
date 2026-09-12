/**
 * Create the DRAFT `ChangelogEntry` for a platform (`ALL-`) release train.
 *
 * `versioning.md` §3 step 4 and `release-runbook.md` §5 step 5 have promised
 * since TASK-648 that "CI ... creates a DRAFT ChangelogEntry". Nothing did:
 * `changelog-from-commits.ts` was written, unit-tested and then never called by
 * anything, so between `ALL-2.1.0` and `ALL-2.2.0` the console's What's New
 * screen stayed empty through 1,257 commits. This script is the missing caller.
 *
 * Two jobs, deliberately separable:
 *
 *   1. RENDER — read the commits in `(previous ALL- tag, HEAD]`, classify them
 *      with `changelog-from-commits.ts`, and emit the draft payload. Pure git +
 *      CPU, no network, always runs. The payload is written to `--out` so a
 *      release pipeline keeps it as an artifact even when step 2 cannot run.
 *
 *   2. POST — exchange a service account for a token and `POST /admin/changelog`.
 *      Opt-in via `--post`, because a TAG pipeline has no inherent knowledge of
 *      which deployed gateway should receive the draft, and this repo's CI has
 *      never talked to one (it writes to the deployment repo over git instead).
 *
 * The credential is a SERVICE ACCOUNT and can be nothing else: every `/admin/*`
 * route is `@ForbidApiKey()`, so an API key cannot reach this route under any
 * scope. `workingTenantId` is NOT sent — a service-account token binds its
 * tenant at exchange, so `X-Tenant-Id` alongside it is a protocol error.
 *
 * NOTHING HERE PUBLISHES. The payload has no publish-shaped field and the
 * gateway forces `DRAFT` regardless; a human rewrites it in the console and
 * presses Publish. That split is the point — CI writes the machine's first
 * draft, a person decides what tenants actually read.
 *
 * Usage:
 *   npx tsx scripts/changelog-draft.ts [<tag>] [--since <ref>] [--out <file>] [--post]
 *
 *   <tag>          Release tag (default: `$CI_COMMIT_TAG`). Must be an `ALL-` tag.
 *   --since <ref>  Explicit base ref, overriding previous-tag auto-detection.
 *   --out <file>   Write the payload JSON here (default: `changelog-draft.json`).
 *   --post         Also POST it. Requires HOPE_GATEWAY_URL, HOPE_SVC_CLIENT_ID,
 *                  HOPE_SVC_CLIENT_SECRET — missing any is a hard error, never
 *                  a silent skip.
 */

import { writeFileSync } from 'node:fs';
import { PLATFORM_TRAIN_PREFIX, parseReleaseTag } from '../packages/utils/src/version-grammar';
import { buildChangelog, buildDraftChangelogPayload, getCommitsInRange, getPreviousFamilyTag } from './changelog-from-commits';

interface DraftArgs {
  tag: string | null;
  since: string | null;
  out: string;
  post: boolean;
  cwd: string;
}

export function parseDraftArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): DraftArgs {
  const args: DraftArgs = { tag: env.CI_COMMIT_TAG ?? null, since: null, out: 'changelog-draft.json', post: false, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--since') args.since = argv[++i] ?? null;
    else if (arg === '--out') args.out = argv[++i] ?? args.out;
    else if (arg === '--cwd') args.cwd = argv[++i] ?? args.cwd;
    else if (arg === '--post') args.post = true;
    else if (!arg.startsWith('--')) args.tag = arg;
  }
  return args;
}

/** Gateway coordinates for the POST half. Throws by NAME on anything missing. */
export interface GatewayConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export function readGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const missing = (['HOPE_GATEWAY_URL', 'HOPE_SVC_CLIENT_ID', 'HOPE_SVC_CLIENT_SECRET'] as const).filter((key) => !env[key]);
  if (missing.length > 0) {
    // Named and loud: a release note that silently never gets drafted is the
    // exact failure this script exists to end.
    throw new Error(
      `--post needs ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} unset. ` +
        `Set them as protected CI variables (the client id and secret belong to a SUPER_ADMIN-issued service account ` +
        `holding svc:admin:changelog:manage), or drop --post to render the payload only.`,
    );
  }
  return {
    // Trailing slash stripped so the join below can never produce `//api/v1`.
    baseUrl: env.HOPE_GATEWAY_URL!.replace(/\/+$/, ''),
    clientId: env.HOPE_SVC_CLIENT_ID!,
    clientSecret: env.HOPE_SVC_CLIENT_SECRET!,
  };
}

/**
 * Exchange the credential pair for a short-lived opaque token.
 *
 * No `workingTenantId`: the tenant binds at exchange, and a changelog entry is
 * SYSTEM-tenant by construction, so omitting it resolves SYSTEM — which is
 * exactly where the row belongs.
 */
async function exchangeServiceToken(config: GatewayConfig): Promise<string> {
  const response = await fetch(`${config.baseUrl}/api/v1/auth/service-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: config.clientId, clientSecret: config.clientSecret }),
  });
  if (!response.ok) {
    // The secret is in the REQUEST, never the response — but say nothing about
    // the body beyond the status, so a mis-set secret cannot leak via an echo.
    throw new Error(`service-token exchange failed: HTTP ${response.status}. Check HOPE_SVC_CLIENT_ID / HOPE_SVC_CLIENT_SECRET.`);
  }
  const body = (await response.json()) as { accessToken?: string };
  if (!body.accessToken) throw new Error('service-token exchange returned no accessToken');
  return body.accessToken;
}

/**
 * POST the draft. A 409 means the entry for this platform version already
 * exists (`ChangelogEntry_platformVersion_unique`) — a re-run of the same tag's
 * pipeline, which must be idempotent rather than a red release.
 */
export async function postDraft(config: GatewayConfig, payload: Record<string, unknown>, token: string): Promise<'created' | 'exists'> {
  const response = await fetch(`${config.baseUrl}/api/v1/admin/changelog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Account-Token': token },
    body: JSON.stringify(payload),
  });
  if (response.status === 409) return 'exists';
  if (!response.ok) throw new Error(`POST /admin/changelog failed: HTTP ${response.status} ${await response.text()}`);
  return 'created';
}

async function main(): Promise<void> {
  const { tag, since, out, post, cwd } = parseDraftArgs(process.argv.slice(2));

  const parsed = tag ? parseReleaseTag(tag) : null;
  if (tag && !parsed) throw new Error(`"${tag}" is not a release tag.`);
  if (parsed && parsed.service !== PLATFORM_TRAIN_PREFIX) {
    // A per-service tag ships one image; it is not a platform train and has no
    // "what's new" story to tell a tenant admin.
    console.log(`${tag} is a ${parsed.service} tag, not a platform train — no changelog draft. Nothing to do.`);
    return;
  }

  const sinceRef = since ?? (parsed ? getPreviousFamilyTag(PLATFORM_TRAIN_PREFIX, tag, cwd) : null);
  const commits = getCommitsInRange(sinceRef, 'HEAD', cwd);
  const entries = buildChangelog(commits);
  const payload = buildDraftChangelogPayload(entries, parsed ? parsed.version : 'unversioned');

  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[changelog-draft] ${sinceRef ?? '(repo start)'}..HEAD — ${commits.length} commit(s) → ${out}`);
  console.log(`[changelog-draft] ${payload.summary}`);

  if (!post) {
    console.log('[changelog-draft] rendered only (no --post). A super admin can paste this into the console, or re-run with --post.');
    return;
  }

  const config = readGatewayConfig(process.env);
  const token = await exchangeServiceToken(config);
  const outcome = await postDraft(config, payload as unknown as Record<string, unknown>, token);
  console.log(
    outcome === 'created'
      ? `[changelog-draft] DRAFT created for ${payload.platformVersion}. It is INVISIBLE to tenants until a super admin publishes it in the console.`
      : `[changelog-draft] a changelog entry for ${payload.platformVersion} already exists — left untouched.`,
  );
}

// Only run when invoked directly, so the exported helpers stay unit-testable.
if (process.argv[1] && /changelog-draft\.ts$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(`[changelog-draft] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
