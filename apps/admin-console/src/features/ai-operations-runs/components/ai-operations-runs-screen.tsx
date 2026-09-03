'use client';

import { useState } from 'react';
import { IconTimeline } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import Link from 'next/link';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useSessions } from '../api';
import type { TrajectorySessionKind } from '../api';
import { GateQueuePanel } from './gate-queue-panel';
import { SessionList, sessionKey } from './session-list';
import { TrajectoryTimeline } from './trajectory-timeline';

const TAB_VALUES = ['trajectory', 'gate-queue'] as const;

/** Trajectory tab: session list → selected session's ordered step timeline. */
function TrajectoryTab() {
  const [kind, setKind] = useState<'' | TrajectorySessionKind>('');
  const [selectedKey, setSelectedKey] = useQueryState('session', parseAsString);
  const sessionsQuery = useSessions({ ...(kind ? { kind } : {}), limit: 50 });
  const selected = sessionsQuery.data?.items.find((session) => sessionKey(session.sessionId, session.runId) === selectedKey) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <SessionList kind={kind} onKindChange={setKind} selectedKey={selectedKey} onSelect={(key) => void setSelectedKey(key)} />
      {selected ? (
        <TrajectoryTimeline key={sessionKey(selected.sessionId, selected.runId)} session={selected} />
      ) : (
        <EmptyState
          icon={IconTimeline}
          title="Select a session"
          description="Choose an agentic session from the list to inspect its ordered step trajectory and per-step generation stats."
        />
      )}
    </div>
  );
}

/**
 * AI Operations — Runs (/ai-operations/runs, tier 10-19). The
 * trajectory read plane: distinct agentic sessions → the ordered step timeline
 * with per-step GenerationStats, live SSE updates, and cancel/signal wired to
 * the harness-admin workflow-ops for HARNESS_DOC runs; plus the clinician gate
 * queue. Trajectory data is tenant-scoped, so the screen runs behind the
 * working-tenant gate.
 */
export function AiOperationsRunsScreen() {
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('trajectory'));
  const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'trajectory';

  return (
    <WorkingTenantGate
      title="AI Operations — Runs"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/agent-trajectory/sessions
        </span>
      }
      description="Agentic run telemetry is tenant-scoped. Pick a working tenant from the top-bar switcher to load its sessions."
    >
      <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => void setTabParam(next === 'trajectory' ? null : next)}>
        <ScreenTemplate
          header={
            <PageHeader
              title="AI Operations — Runs"
              meta={
                <>
                  <span>trajectory timeline &middot; per-step stats &middot; gate queue</span>
                  {/* reciprocal cross-link to the definition-scoped
                      tenant view — this screen is the cross-tenant platform-ops
                      sibling; neither forks the other's components. */}
                  <Link href="/workflow-runs" className="text-foreground underline underline-offset-2">
                    See workflow-definition runs (tenant view) →
                  </Link>
                </>
              }
            />
          }
          tabs={
            <TabsList variant="line">
              <TabsTrigger value="trajectory">Trajectory</TabsTrigger>
              <TabsTrigger value="gate-queue">Gate queue</TabsTrigger>
            </TabsList>
          }
          footer={
            <StatusFooter
              end={
                <span aria-hidden className="font-mono">
                  GET /admin/agent-trajectory/sessions/:id/steps
                </span>
              }
            />
          }
        >
          <TabsContent value="trajectory">
            <TrajectoryTab />
          </TabsContent>
          <TabsContent value="gate-queue">
            <GateQueuePanel />
          </TabsContent>
        </ScreenTemplate>
      </Tabs>
    </WorkingTenantGate>
  );
}
