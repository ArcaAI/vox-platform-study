import { permanentRedirect } from 'next/navigation';

/**
 * `/ai-task-defaults` → `/ai-platform?tab=tasks` (TASK-845 step 5).
 *
 * A RENAME, not a retier: the screen that lived here — the SYSTEM-tenant half
 * of a two-tier cascade — became the platform-default SCOPE of the unified AI
 * Platform screen, at a different URL. Bookmarks and deep links to this path
 * would otherwise 404, so the convention in `13-nextjs-apps.md` applies and
 * this stub stands for one release.
 *
 * (Contrast `/tools-mcp` in TASK-846, which changed route GROUP and therefore
 * kept its URL. A stub there would have been a duplicate route and a build
 * failure. Check which of the two you have before writing one.)
 *
 * The stub sits in `(shared)`, not `(global)`, deliberately: the `(global)`
 * layout `notFound()`s every non-elevated session, so a tenant admin following
 * an old link would get a 404 instead of being forwarded to the screen they can
 * actually use.
 *
 * DELETE THIS FILE in the release after the one that ships TASK-845.
 */
export default function AiTaskDefaultsRedirectPage() {
  permanentRedirect('/ai-platform?tab=tasks');
}
