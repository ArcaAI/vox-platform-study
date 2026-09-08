'use client';

import { useMemo, useState } from 'react';
import { IconAlertTriangle, IconPlayerPlayFilled, IconPlayerStopFilled, IconRefresh } from '@tabler/icons-react';
import { useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { useSession } from '@/shared/auth';
import { CanvasHeader, PlaygroundCanvas } from '@/features/playground-shared/components/playground-canvas';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useLiveSttSession, usePlaygroundAsrAgents } from '../api';
import type { LiveSttStatus } from '../api';
import { isStalledQuery } from '../lib/stalled-query';
import { BatchTab } from './batch-tab';

/**
 * TASK-932 §3.7 — the languages this screen offers to DECLARE.
 *
 * The pair the platform's own ASR agent transcribes (`ASR_PARAMETERS.decoding.languageMode:
 * 'ml-en'`). It is not a default and it is not a catalogue: the empty option stays selected, and
 * an agent that serves another language is reached by the SDK caller declaring its tag. Kept here
 * rather than read from `GET /audio/transcription-jobs/language-modes` because that catalogue
 * describes MODES (`ml-en` code-switch) and this control declares a single LANGUAGE — the two are
 * different axes, which is exactly what OD-1 turned on.
 */
const LANGUAGE_OPTIONS: ReadonlyArray<{ tag: string; label: string }> = [
  { tag: 'en', label: 'English' },
  { tag: 'ml', label: 'Malayalam' },
];
import { StreamingTab } from './streaming-tab';

const FOOTER_STATUS: Record<LiveSttStatus, string> = {
  idle: 'Ready — no active session',
  requesting_mic: 'Waiting for microphone permission',
  creating_session: 'Creating streaming session',
  connecting: 'Connecting to the gateway WebSocket',
  streaming: 'Streaming live audio',
  reconnecting: 'Reconnecting with a fresh ticket',
  stopping: 'Stopping the session',
  error: 'Session closed',
};

/** Statuses during which starting another session makes no sense. */
const BUSY_STATUSES: readonly LiveSttStatus[] = ['requesting_mic', 'creating_session', 'connecting', 'streaming', 'reconnecting', 'stopping'];

function ScreenBody() {
  const session = useSession();
  const live = useLiveSttSession();
  const agentsQuery = usePlaygroundAsrAgents();

  const [tabParam, setTabParam] = useQueryState('tab');
  const tab = tabParam === 'batch' ? 'batch' : 'streaming';

  // Which published ASR Agent transcribes (TASK-865). `null` — the default — means
  // "send no slug": the tenant → department AgentAssignment cascade decides. The
  // tenant default is shown as a hint in the picker, never preselected.
  const [agentSlug, setAgentSlug] = useState<string | null>(null);
  /**
   * TASK-932 §3.7 — the transcription language.
   *
   * `null` is the DEFAULT and is not English: TASK-891 OD-1 settled that the code-switch mode
   * stays on until a language is DECLARED, so the empty option is labelled honestly rather than
   * defaulted away. The transport has carried this field since TASK-891
   * (`use-live-stt-session.ts`, `uploadBatchAudio`) and nothing has ever sent it — this screen is
   * the missing half, on both tabs.
   */
  const [language, setLanguage] = useState<string | null>(null);

  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const selectedAgent = agents.find((agent) => agent.slug === agentSlug) ?? null;

  // BUG-014: a pending query that is NOT fetching never resolves, so the
  // skeleton would stand forever. Fold it in with the error case and render
  // one retryable terminal control instead (rules 10 and 11 Only when
  // there is nothing to show — a refetch that fails over cached options must
  // keep the working picker rather than take the screen away.
  const pickerFailed = !agentsQuery.data && (agentsQuery.isError || isStalledQuery(agentsQuery));

  // Sessions bind to the effective (impersonated, when active) tenant;
  // tenant-bound admins use their home tenant. The WS tenant-claim guard
  // fails closed without this value.
  const tenantId = session.data ? (session.data.effectiveTenantId ?? session.data.user.tenantId) : null;

  const busy = BUSY_STATUSES.includes(live.status);
  // No agent is REQUIRED: with none selected the gateway resolves the tenant default.
  const canStart = !!tenantId && !busy;

  function handleStart() {
    if (!tenantId) {
      toast.error('Sessions need a tenant scope.');
      return;
    }
    void setTabParam(null);
    void live.start({ ...(agentSlug ? { agentSlug } : {}), ...(language ? { language } : {}), tenantId });
  }

  function handleStop() {
    void live.stop();
  }

  return (
    <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => void setTabParam(next === 'streaming' ? null : next)}>
      <ScreenTemplate
        header={
          <div className="mx-auto w-full max-w-[1100px] px-4">
            <CanvasHeader
              title="Live Transcription"
              description={'Streaming session \u00b7 runs under your own account'}
              actions={
                busy ? (
                  <Button variant="outline" onClick={handleStop} disabled={live.status === 'stopping'}>
                    <IconPlayerStopFilled aria-hidden />
                    Stop session
                  </Button>
                ) : (
                  <Button onClick={handleStart} disabled={!canStart}>
                    <IconPlayerPlayFilled aria-hidden />
                    Start session
                  </Button>
                )
              }
            />
          </div>
        }
        toolbar={
          <div className="mx-auto flex w-full max-w-[1100px] flex-wrap items-center gap-x-3 gap-y-2 px-4">
            {/* No control to point at while the picker is unavailable. */}
            <Label htmlFor={pickerFailed ? undefined : 'agent-picker'}>Transcription agent</Label>
            {pickerFailed ? (
              <div role="status" className="border-destructive/40 flex items-center gap-2 rounded-md border px-3 py-1.5">
                <IconAlertTriangle aria-hidden className="text-destructive size-4 shrink-0" />
                <span className="text-sm">
                  Agents did not load <span className="text-muted-foreground">{'·'} GET /agents?task=SPEECH_TO_TEXT</span>
                </span>
                <Button variant="outline" size="sm" aria-label="Retry loading agents" onClick={() => void agentsQuery.refetch()}>
                  <IconRefresh aria-hidden />
                  Retry
                </Button>
              </div>
            ) : agentsQuery.isPending ? (
              <Skeleton className="h-9 w-64" />
            ) : (
              <NativeSelect id="agent-picker" className="w-64" value={agentSlug ?? ''} onChange={(event) => setAgentSlug(event.target.value || null)} disabled={busy}>
                {/* Empty = the tenant assignment cascade decides; a published tenant default is named as the hint. */}
                <NativeSelectOption value="">{agents.length === 0 ? 'No agents published \u00b7 tenant default' : 'Tenant default'}</NativeSelectOption>
                {agents.map((agent) => (
                  <NativeSelectOption key={agent.slug} value={agent.slug}>
                    {agent.name}
                    {agent.isTenantDefault ? ' \u00b7 tenant default' : ''}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            {/* TASK-932 §3.7 — the transcription language. A sibling of the agent picker rather
                than a property of it: the same ASR agent serves several languages, and OD-1 says
                a specific one is reached only by declaring it. */}
            <Label htmlFor="language-picker">Language</Label>
            <NativeSelect
              id="language-picker"
              className="w-48"
              value={language ?? ''}
              onChange={(event) => setLanguage(event.target.value || null)}
              disabled={busy}
            >
              {/* Empty = undeclared: the agent's own code-switch mode decides (TASK-891 OD-1). */}
              <NativeSelectOption value="">Not declared &middot; code-switch</NativeSelectOption>
              {LANGUAGE_OPTIONS.map((option) => (
                <NativeSelectOption key={option.tag} value={option.tag}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        }
        tabs={
          <div className="mx-auto w-full max-w-[1100px] px-4">
            <TabsList variant="line">
              <TabsTrigger value="streaming">Streaming session</TabsTrigger>
              <TabsTrigger value="batch">Batch upload</TabsTrigger>
            </TabsList>
          </div>
        }
        footer={
          // The session-lifecycle line and the session id were already
          // written as footer content (`FOOTER_STATUS`) but rendered inline in
          // the toolbar; they now ride the pinned status bar so they stay
          // visible while the transcript scrolls.
          <StatusFooter
            start={FOOTER_STATUS[live.status]}
            end={
              live.session ? (
                <span className="font-mono" title={live.session.sessionId}>
                  session {live.session.sessionId}
                </span>
              ) : null
            }
          />
        }
      >
        <PlaygroundCanvas className="max-w-[1100px]">
          <TabsContent value="streaming">
            <StreamingTab live={live} agentName={selectedAgent?.name ?? null} canStart={canStart} onStart={handleStart} />
          </TabsContent>
          <TabsContent value="batch">
<BatchTab agentSlug={agentSlug} language={language} />
          </TabsContent>
        </PlaygroundCanvas>
      </ScreenTemplate>
    </Tabs>
  );
}

/**
 * Frame 51 — Live transcription playground (matrix row 35). Tenant context
 * is required: streaming sessions bind `user.tenantId`, so an elevated
 * session without a working tenant gets the NoTenant gate.
 *
 * Frame: `ScreenTemplate` (rule 11 §1) in `scroll` mode, wrapped in `<Tabs>`
 * so the pinned `tabs` region shares context with the panels in `children`.
 * The pipeline picker is the `toolbar`; the session-lifecycle line and session
 * id are the pinned `StatusFooter`.
 */
export function LiveTranscriptionScreen() {
  return (
    <WorkingTenantGate
      title="Live Transcription"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          POST /audio/transcription-jobs/stream/session
        </span>
      }
      description="Live streaming sessions bind to a tenant. Pick a working tenant from the switcher in the top bar to start transcribing."
    >
      <ScreenBody />
    </WorkingTenantGate>
  );
}
