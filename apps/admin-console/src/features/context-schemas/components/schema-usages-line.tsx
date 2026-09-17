'use client';

/**
 * "Used by 11 workflows · 2 agents — all accept v3." — the one line under the
 * schema header that answers who depends on this schema before an admin changes
 * it.
 *
 * A LINE, not a tab: the answer is a sentence, and a sentence that says
 * "all accept" needs no list at all. Only the detail behind `View` is a list,
 * and it is a plain dialog because it is read, scanned and dismissed — there is
 * nothing to edit in it.
 *
 * Every verdict is rendered as a WORD ("Accepts" / "Refuses" / "Unknown"), never
 * as a colour alone (rule 11 §7), and "unknown" is never collapsed into
 * "accepts" — a consumer whose compiled config could not be read is a fact the
 * admin should see, not a silent pass.
 */

import { useState } from 'react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import type { ContextSchemaAgentUsage, ContextSchemaUsagesResponse, ContextSchemaVerdict, ContextSchemaWorkflowUsage } from '../api/types';
import { cx } from '@/shared/cx';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';

type Usage = ContextSchemaWorkflowUsage | ContextSchemaAgentUsage;

const VERDICT_LABEL: Record<ContextSchemaVerdict, string> = {
  accepts: 'Accepts',
  refuses: 'Refuses',
  unknown: 'Unknown',
};

function VerdictBadge({ verdict }: { verdict: ContextSchemaVerdict }) {
  if (verdict === 'refuses') return <Badge variant="destructive">{VERDICT_LABEL.refuses}</Badge>;
  if (verdict === 'unknown') return <Badge variant="outline">{VERDICT_LABEL.unknown}</Badge>;
  return <Badge variant="secondary">{VERDICT_LABEL.accepts}</Badge>;
}

/** "2 workflows and 1 agent" — never a bare count. */
function consumerPhrase(workflows: number, agents: number): string {
  const parts: string[] = [];
  if (workflows > 0) parts.push(`${workflows} workflow${workflows === 1 ? '' : 's'}`);
  if (agents > 0) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`);
  return parts.join(' and ');
}

function bindingLabel(usage: Usage): string {
  return usage.binding === 'pinned' ? `pinned v${usage.boundVersion ?? '?'}` : 'follows latest';
}

function UsageRow({ usage, kind }: { usage: Usage; kind: string }) {
  return (
    <li className="flex flex-col gap-1 border-b py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{usage.name || usage.slug}</span>
        <Badge variant="outline">{kind}</Badge>
        <span className="text-muted-foreground text-xs">{bindingLabel(usage)}</span>
        <VerdictBadge verdict={usage.verdict} />
        {!usage.isActive ? <Badge variant="outline">{usage.status} · not active</Badge> : null}
      </div>
      {usage.problems.length > 0 ? (
        <ul className="text-muted-foreground flex flex-col gap-0.5 pl-1 text-xs">
          {usage.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function SchemaUsagesLine({
  usages,
  isPending,
  error,
}: {
  usages: ContextSchemaUsagesResponse | undefined;
  isPending: boolean;
  /** A failed read says so; it never renders as "nothing uses this". */
  error: unknown;
}) {
  const [open, setOpen] = useState(false);

  if (isPending) return <Skeleton className="h-5 w-72" />;

  if (error || !usages) {
    return <p className="text-muted-foreground text-sm">Which workflows and agents use this schema could not be read.</p>;
  }

  const rows: { usage: Usage; kind: string }[] = [
    ...usages.workflows.map((usage) => ({ usage: usage as Usage, kind: 'Workflow' })),
    ...usages.agents.map((usage) => ({ usage: usage as Usage, kind: 'Agent' })),
  ];

  if (rows.length === 0) {
    return <p className="text-muted-foreground text-sm">No workflow or agent uses this schema yet.</p>;
  }

  const refusing = rows.filter(({ usage }) => usage.verdict === 'refuses').length;
  const unknown = rows.filter(({ usage }) => usage.verdict === 'unknown').length;
  const version = usages.againstVersion != null ? `v${usages.againstVersion}` : 'the pinned version';
  const verdictSentence =
    refusing > 0
      ? `${refusing} will refuse ${version}.`
      : unknown > 0
        ? `${rows.length - unknown} accept ${version}; ${unknown} could not be checked.`
        : `all accept ${version}.`;

  // Refusals first — the reason the line exists is to be read before a publish.
  const ordered = [...rows].sort((a, b) => Number(b.usage.verdict === 'refuses') - Number(a.usage.verdict === 'refuses'));

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>
        Used by {consumerPhrase(usages.workflows.length, usages.agents.length)} {'—'} {verdictSentence}
      </span>
      <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setOpen(true)}>
        View
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={cx('flex max-h-[70vh] flex-col', DIALOG_SIZE_CLASS.md)}>
          <DialogHeader>
            <DialogTitle>Workflows and agents using this schema</DialogTitle>
            <DialogDescription>
              Judged against {version}. A consumer that follows the latest version always accepts; one pinned to an older version refuses any kind
              that version does not declare.
            </DialogDescription>
          </DialogHeader>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {ordered.map(({ usage, kind }) => (
              <UsageRow key={`${kind}-${usage.slug}`} usage={usage} kind={kind} />
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
