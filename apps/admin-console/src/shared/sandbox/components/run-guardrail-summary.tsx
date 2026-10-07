'use client';

import { IconPlayerPause, IconShieldCheck } from '@tabler/icons-react';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { formatNumber } from '@/shared/format';
import { GuardrailCheckList } from '@/shared/guardrail/guardrail-check-list';
import {
  guardrailActionTakenMeta,
  guardrailCheckLabel,
  guardrailDirectionShortLabel,
  guardrailTraceActionMeta,
  guardrailVerdictLabel,
} from '@/shared/guardrail/labels';
import { guardrailNoticeCopy } from '@/shared/guardrail/notice';
import type { NodeGuardrailView, NodeView, RunView } from '../api/run-fold';

/** Warn / block counts of one node's guardrail activity — for a canvas or list badge. */
export function nodeGuardrailCounts(node: Pick<NodeView, 'guardrails' | 'guardrailNotices'> | undefined): { warn: number; block: number } {
  if (!node) return { warn: 0, block: 0 };
  let warn = 0;
  let block = 0;
  for (const screen of node.guardrails) {
    if (screen.action === 'WARN') warn += 1;
    if (screen.action === 'BLOCK') block += 1;
  }
  for (const notice of node.guardrailNotices ?? []) {
    if (notice.type === 'guardrail.blocked') block = Math.max(block, 1);
    else warn = Math.max(warn, 1);
  }
  return { warn, block };
}

/** A small badge for a node with guardrail warnings or blocks (text + colour, never colour alone). */
export function NodeGuardrailBadge({ node }: { node: Pick<NodeView, 'guardrails' | 'guardrailNotices' | 'paused'> | undefined }) {
  const { warn, block } = nodeGuardrailCounts(node);
  if (node?.paused) return <StatusBadge label="Paused on guardrail" colorRole="destructive" icon={<IconPlayerPause aria-hidden />} />;
  if (block > 0) return <StatusBadge label="Guardrail block" colorRole="destructive" />;
  if (warn > 0) return <StatusBadge label="Guardrail warning" colorRole="warning" />;
  return null;
}

function ScreenRow({ screen }: { screen: NodeGuardrailView }) {
  const meta = guardrailTraceActionMeta(screen.action);
  return (
    <li className="flex flex-col gap-1.5 rounded-md border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{guardrailDirectionShortLabel(screen.direction)} screen</span>
        <StatusBadge label={meta.label} colorRole={meta.role} />
        <span className="text-muted-foreground text-xs">{`${formatNumber(screen.detected)} detected`}</span>
        {typeof screen.latencyMs === 'number' ? (
          <span className="text-muted-foreground text-xs">{`${formatNumber(screen.latencyMs)} ms`}</span>
        ) : null}
      </div>
      {screen.checks && screen.checks.length > 0 ? (
        <table className="w-full text-xs">
          <caption className="sr-only">Checks of this screen</caption>
          <thead className="text-muted-foreground text-left">
            <tr>
              <th scope="col" className="py-1 pr-2 font-semibold">
                Check
              </th>
              <th scope="col" className="py-1 pr-2 font-semibold">
                Verdict
              </th>
              <th scope="col" className="py-1 pr-2 font-semibold">
                Action taken
              </th>
              <th scope="col" className="py-1 font-semibold">
                Category
              </th>
            </tr>
          </thead>
          <tbody>
            {screen.checks.map((check, index) => {
              const taken = guardrailActionTakenMeta(check.actionTaken);
              return (
                <tr key={`${check.checkId}-${index}`} className="border-t">
                  <td className="py-1 pr-2">{guardrailCheckLabel(check.checkId)}</td>
                  <td className="py-1 pr-2">{guardrailVerdictLabel(check.verdict)}</td>
                  <td className="py-1 pr-2">
                    <StatusBadge label={taken.label} colorRole={taken.role} />
                  </td>
                  <td className="text-muted-foreground py-1">{check.category ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : screen.categories && screen.categories.length > 0 ? (
        <p className="text-muted-foreground text-xs">{screen.categories.join(', ')}</p>
      ) : null}
    </li>
  );
}

/**
 * TASK-1050 W3b — a run's guardrail activity from the protocol-v2 fold (`foldRunEvents`): the paused
 * state with the notice that holds it, every notice, and each node's inbound/outbound screens with
 * their action (incl. `WARN` / `IGNORE`) and per-check verdicts. Verdicts and ids only — the admin
 * trace's guardrail events carry no content, and neither does this.
 */
export function RunGuardrailSummary({ view }: { view: RunView }) {
  const nodesWithScreens = view.nodeOrder
    .map((id) => view.nodes[id]!)
    .filter((node) => node.guardrails.length > 0 || (node.guardrailNotices?.length ?? 0) > 0);
  const notices = view.guardrailNotices ?? [];
  const pausedNotice = view.paused ? notices.find((notice) => notice.noticeId === view.paused?.noticeId) : undefined;

  if (!view.paused && notices.length === 0 && nodesWithScreens.length === 0) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <IconShieldCheck aria-hidden className="size-4" />
        No guardrail activity recorded for this run.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {view.paused ? (
        <div role="status" className="border-destructive/30 bg-destructive/5 flex flex-col gap-1.5 rounded-md border p-3 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <IconPlayerPause aria-hidden className="text-destructive size-4" />
            {`Paused at ${view.nodes[view.paused.nodeId]?.label ?? view.paused.nodeId} on a guardrail hold`}
          </p>
          <p className="text-muted-foreground">
            {pausedNotice ? guardrailNoticeCopy(pausedNotice) : 'The run waits for the hold to be resolved, then re-runs this step.'}
          </p>
          {pausedNotice ? <GuardrailCheckList checks={pausedNotice.checks} /> : null}
        </div>
      ) : null}
      {notices.length > 0 ? (
        <section aria-label={`Guardrail notices (${notices.length})`} className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold">{`Notices (${notices.length})`}</h3>
          <ul className="flex flex-col gap-1.5">
            {notices.map((notice) => (
              <li key={notice.noticeId} className="flex flex-col gap-1 rounded-md border px-3 py-2 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <StatusBadge
                    label={notice.type === 'guardrail.blocked' ? 'Blocked' : notice.type === 'guardrail.unverified' ? 'Unverified' : 'Warning'}
                    colorRole={notice.type === 'guardrail.blocked' ? 'destructive' : notice.type === 'guardrail.unverified' ? 'info' : 'warning'}
                  />
                  <span className="text-muted-foreground text-xs">{guardrailDirectionShortLabel(notice.direction)}</span>
                  {notice.nodeId ? <span className="text-muted-foreground font-mono text-xs">{notice.nodeId}</span> : null}
                </span>
                <span>{guardrailNoticeCopy(notice)}</span>
                <GuardrailCheckList checks={notice.checks} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {nodesWithScreens.map((node) => (
        <section key={node.nodeId} aria-label={`Guardrail screens of ${node.label ?? node.nodeId}`} className="flex flex-col gap-1.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <span className="font-mono">{node.label ?? node.nodeId}</span>
            <NodeGuardrailBadge node={node} />
          </h3>
          <ul className="flex flex-col gap-1.5">
            {node.guardrails.map((screen) => (
              <ScreenRow key={screen.seq} screen={screen} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
