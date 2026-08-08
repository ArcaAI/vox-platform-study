'use client';

/**
 * Approval status + the version the approval is PINNED to (TASK-634 R6).
 *
 * `PromptResolutionService.resolveGovernedContent` serves the `PromptVersion`
 * snapshot at `approvedVersionNumber` — never the mutable `content` column. So
 * a template can sit at v5 in the editor while clinical flows still run v3, and
 * before this component the console had no way to say so. That gap is exactly
 * how a "fixed" prompt can appear correct in the admin UI and stay wrong in
 * production until the next approval.
 *
 * Deliberately NON-INTERACTIVE (a badge, not a tooltip trigger): these render
 * inside grid cells and inside the governance list's row `<button>`, and a
 * focusable tooltip trigger there would be interactive content nested in a
 * button — invalid HTML, a keyboard trap risk, and it swallows the row's
 * accessible name. The badge text is self-describing instead, with the longer
 * explanation as a `title` for pointer users.
 *
 * `approvedVersionNumber` is optional on the wire (older gateways omit it), so
 * an absent field renders nothing rather than a misleading "never approved".
 */

import { Badge } from '@arcaai/ui/components/shadcn/badge';
import type { PromptTemplate, PromptTemplateStatus } from '../api/types';

const STATUS_LABEL: Record<PromptTemplateStatus, string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  APPROVED: 'Approved',
};

export function statusVariant(status: PromptTemplateStatus): 'default' | 'secondary' | 'outline' {
  if (status === 'APPROVED') return 'default';
  if (status === 'PUBLISHED') return 'secondary';
  return 'outline';
}

export function TemplateStatusBadge({ status }: { status: PromptTemplateStatus }) {
  return <Badge variant={statusVariant(status)}>{STATUS_LABEL[status] ?? status}</Badge>;
}

/** "serving v3 · editing v5" — or just "serving v3" when the two agree. */
export function ApprovalPin({ template }: { template: Pick<PromptTemplate, 'approvedVersionNumber' | 'currentVersionNumber' | 'status'> }) {
  const pinned = template.approvedVersionNumber;
  if (pinned === undefined) return null;

  if (pinned === null) {
    return (
      <Badge
        variant="outline"
        className="font-mono text-[10px]"
        title="No version is pinned. Clinical resolution skips this template and falls through to the next tier."
      >
        not approved
      </Badge>
    );
  }

  const drifted = template.currentVersionNumber > pinned;
  return (
    <Badge
      variant={drifted ? 'destructive' : 'secondary'}
      className="font-mono text-[10px]"
      title={
        drifted
          ? `Resolution serves the pinned snapshot v${pinned}. The current content is v${template.currentVersionNumber} and will not run until it is approved again.`
          : `Resolution serves the pinned snapshot v${pinned}, which is also the current content.`
      }
    >
      serving v{pinned}
      {drifted ? ` · editing v${template.currentVersionNumber}` : ''}
    </Badge>
  );
}
