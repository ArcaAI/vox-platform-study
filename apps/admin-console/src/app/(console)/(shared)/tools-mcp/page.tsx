import type { Metadata } from 'next';
import { FeatureGateBoundary } from '@/shared/feature-gates/feature-gate-boundary';
import { ToolsMcpScreen } from '@/features/tools-mcp/components/tools-mcp-screen';

export const metadata: Metadata = { title: 'Tools & MCP' };

/**
 * screen 5 — agentic tool / MCP connector registry, full CRUD under If-Match OCC.
 *
 * TIER 20-29 (shared audience) since OWNER DECISION OD-7 (2026-09-01): tenant
 * admins may configure MCP connectors, so this moved out of `(global)` (tier
 * 10-19), whose layout `notFound()`s every non-elevated session.
 *
 * NO REDIRECT STUB ACCOMPANIES THIS MOVE, and none is possible: Next.js route
 * groups are excluded from the URL, so the path is `/tools-mcp` before and
 * after. Nothing to redirect — no bookmark, deep link or nav entry changes —
 * and a stub left at `(global)/tools-mcp` would resolve to the SAME path and
 * fail the build as a duplicate route. The one-release redirect convention in
 * `13-nextjs-apps.md` covers RENAMED routes; this is a retier, not a rename.
 *
 * TASK-932 §3.2: wrapped in `console.tools.mcp.enabled` — a platform-wide
 * visibility gate, not an authorisation change (rule 13 §Routing); the
 * backend stays ability-gated exactly as above.
 */
export default function ToolsMcpPage() {
  return (
    <FeatureGateBoundary gate="console.tools.mcp.enabled">
      <ToolsMcpScreen />
    </FeatureGateBoundary>
  );
}
