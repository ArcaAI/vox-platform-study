'use client';

/**
 * Workflow Studio — Test tab (TASK-1036 §10.2, wave C lane C3): the owner's debugging surface.
 * "Show the flow, the active node, all execution context and consultation data, all events."
 *
 * LAYOUT. Left: the live Flow (the composer canvas, read-only, with the run over it) and the Step
 * panel. Right: Test input (only what this workflow can use) with the run and playback controls,
 * the Execution context, and the Events. Bottom: the status bar. Everything flows in the studio
 * tab's ONE scroll container — no panel scrolls on its own (rule 11 §1).
 *
 * STATE. A pure fold over the run's ordered protocol-v2 admin-trace events (`use-test-run.ts`), so
 * clicking an event TIME-TRAVELS every panel to that moment, Pause / Step / Play move the same
 * cursor, a reconnect resumes by `seq`, and a `run.resync` snapshot replaces the state.
 *
 * A run executes the SAVED definition (the editor states this above the tab when the buffer is
 * dirty); the Flow draws the editor's graph, which is that definition while nothing is unsaved.
 *
 * PRIVACY. The trace carries PHI; it exists only here, on the admin plane, and the gateway audits
 * every read. Values are shown by default with a one-click "Hide PHI".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, Empty, EmptyDescription, EmptyTitle } from '@arcaai/ui';
import { GatewayError } from '@/shared/api';
import { useSession } from '@/shared/auth/hooks';
import { SandboxBanner } from '@/shared/page/sandbox-banner';
import { useLatestSandboxRun } from '@/shared/sandbox/api/latest-run';
import type { StartSandboxRunBody } from '@/shared/sandbox/api/types';
import { useSandboxRecording } from '@/shared/sandbox/api/use-sandbox-recording';
import { nodeDisplayName } from '../../lib/node-identity';
import { selectSelectedNodeId, useGraphStore, useGraphStoreApi, useOptionalGraphStoreApi } from '../../store';
import type { NodeLastRun } from '../inspector/last-run-tab';
import { useComposerData } from '../canvas';
import { EventsPanel } from './events-panel';
import { ExecutionContext, type ContextKindRow } from './execution-context';
import { relativeTime } from './lib/event-display';
import { planTestInputs } from './lib/test-inputs';
import { RunStatusBar } from './run-status-bar';
import { StepPanel, type StepPanelNode } from './step-panel';
import { TestFlow } from './test-flow';
import { TestInputPanel, type TestInputState } from './test-input-panel';
import { useTestRun } from './use-test-run';

export interface TestTabProps {
  definitionId: string;
}

const TERMINAL: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);
const AGENT_NODE_TYPE = 'core.agent';
const TEXT_TASK = 'TEXT_GENERATION';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof GatewayError) return cause.message;
  return cause instanceof Error ? cause.message : fallback;
}

/** A clock that ticks only while `active` (a timer callback, never a state write in an effect body). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function TestTab({ definitionId }: TestTabProps) {
  // The tab is mounted by the Studio inside its graph store; outside one there is no graph to test.
  if (useOptionalGraphStoreApi() === null) {
    return (
      <Empty data-slot="workflow-test-tab">
        <EmptyTitle>Open this workflow in the Studio to test it</EmptyTitle>
        <EmptyDescription>The Test tab runs the workflow you are editing.</EmptyDescription>
      </Empty>
    );
  }
  return <TestSurface definitionId={definitionId} />;
}

function TestSurface({ definitionId }: TestTabProps) {
  const storeApi = useGraphStoreApi();
  const composer = useComposerData();
  const nodes = useMemo(() => composer?.nodes ?? [], [composer?.nodes]);
  const agentOptions = useMemo(() => composer?.agentOptions ?? [], [composer?.agentOptions]);
  const selectedNodeId = useGraphStore(selectSelectedNodeId);
  const session = useSession();
  const tenantId = session.data ? (session.data.effectiveTenantId ?? session.data.user.tenantId ?? null) : null;

  const controller = useTestRun(definitionId);
  const recorder = useSandboxRecording();
  const [input, setInput] = useState<TestInputState>({ message: '', extraJson: '{}', record: false });
  const [sentInput, setSentInput] = useState<Record<string, unknown> | null>(null);
  const [recordedRunId, setRecordedRunId] = useState<string | null>(null);
  const [hidePhi, setHidePhi] = useState(false);
  const [selectedEventIndex, setSelectedEventIndex] = useState<number | null>(null);

  const plan = useMemo(() => planTestInputs({ nodes, agentOptions, contextSchema: composer?.contextSchema }), [nodes, agentOptions, composer?.contextSchema]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const taskBySlug = useMemo(() => new Map(agentOptions.map((agent) => [agent.slug, agent.task])), [agentOptions]);
  const { view, live, events } = controller;

  const labelOf = useCallback(
    (nodeId: string) => {
      const node = nodeById.get(nodeId);
      return node ? nodeDisplayName(node) : (live.nodes[nodeId]?.label ?? nodeId);
    },
    [nodeById, live.nodes],
  );

  const agentSlugOf = useCallback(
    (nodeId: string): string | null => {
      const ref = nodeById.get(nodeId)?.config.agentRef;
      return isRecord(ref) && typeof ref.slug === 'string' && ref.slug.length > 0 ? ref.slug : null;
    },
    [nodeById],
  );

  const isAiTextStep = useCallback(
    (nodeId: string) => {
      const node = nodeById.get(nodeId);
      if (!node || node.type !== AGENT_NODE_TYPE) return false;
      const slug = agentSlugOf(nodeId);
      // Unknown task (agents still loading): a text output of an agent step is still generated text.
      return slug === null || (taskBySlug.get(slug) ?? TEXT_TASK) === TEXT_TASK;
    },
    [nodeById, agentSlugOf, taskBySlug],
  );

  const kinds: ContextKindRow[] = useMemo(() => {
    const schema = composer?.contextSchema;
    if (!isRecord(schema) || !Array.isArray(schema.kinds)) return [];
    return schema.kinds.filter(isRecord).flatMap((kind) =>
      typeof kind.key === 'string'
        ? [{ key: kind.key, label: typeof kind.label === 'string' ? kind.label : kind.key, primitive: typeof kind.primitive === 'string' ? kind.primitive : 'STRUCTURED', phi: kind.phiClass === 'PHI' }]
        : [],
    );
  }, [composer?.contextSchema]);

  const variableStepIds = useMemo(() => nodes.filter((node) => node.type === 'core.variable').map((node) => node.id), [nodes]);

  // The step panel: the selected step, else the step running at the moment shown, else the first one the run touched.
  const stepNodeId = (selectedNodeId && nodeById.has(selectedNodeId) ? selectedNodeId : null) ?? view.activeNodeId ?? view.nodeOrder.at(-1) ?? null;
  const stepNode: StepPanelNode | null = useMemo(() => {
    if (!stepNodeId) return null;
    const node = nodeById.get(stepNodeId);
    const ref = node && isRecord(node.config.agentRef) ? node.config.agentRef : undefined;
    return {
      id: stepNodeId,
      type: node?.type ?? view.nodes[stepNodeId]?.kind ?? 'step',
      label: labelOf(stepNodeId),
      ...(node?.type === AGENT_NODE_TYPE
        ? {
            agent: {
              slug: typeof ref?.slug === 'string' ? ref.slug : null,
              versionNumber: typeof ref?.versionNumber === 'number' ? ref.versionNumber : null,
            },
          }
        : {}),
    };
  }, [stepNodeId, nodeById, labelOf, view.nodes]);

  const running = controller.runId !== null && live.status === 'RUNNING';
  const terminal = TERMINAL.has(live.status);
  const timeTravelling = controller.viewCount !== null;

  // The input box's own problem (blocks Run, stated under the controls).
  const extra = useMemo((): { value: Record<string, unknown> | null; problem: string | null } => {
    if (plan.extraKinds.length === 0) return { value: null, problem: null };
    try {
      const parsed = JSON.parse(input.extraJson.trim() || '{}') as unknown;
      return isRecord(parsed) ? { value: parsed, problem: null } : { value: null, problem: 'Other input must be a JSON object.' };
    } catch {
      return { value: null, problem: 'Other input is not valid JSON.' };
    }
  }, [plan.extraKinds.length, input.extraJson]);
  const recordUnavailable = input.record && plan.record && tenantId === null ? 'Recording needs a working tenant: pick one from the switcher in the top bar.' : null;

  const runTest = useCallback(async () => {
    const payload: Record<string, unknown> = { ...(extra.value ?? {}) };
    if (plan.message && input.message.trim().length > 0) payload.message = input.message;
    const body: StartSandboxRunBody = Object.keys(payload).length > 0 ? { input: payload } : {};

    let sttSessionId: string | null = null;
    if (input.record && plan.record && tenantId) {
      sttSessionId = await recorder.start({ ...(plan.record.agentSlug ? { agentSlug: plan.record.agentSlug } : {}), tenantId });
      if (!sttSessionId) return; // the recorder states why
      body.recording = { sttSessionId };
    }
    try {
      const runId = await controller.start(body);
      setSentInput(payload);
      setSelectedEventIndex(null);
      setRecordedRunId(sttSessionId ? runId : null);
    } catch (cause) {
      toast.error(errorMessage(cause, 'The test run could not start.'));
      if (sttSessionId) void recorder.stop();
    }
  }, [controller, extra.value, input.message, input.record, plan.message, plan.record, recorder, tenantId]);

  // The run ended: release the microphone.
  useEffect(() => {
    if (terminal && (recorder.status === 'recording' || recorder.status === 'starting')) void recorder.stop();
  }, [terminal, recorder]);

  const stopRun = useCallback(async () => {
    try {
      await controller.cancel();
      toast.success('Stop requested — the run ends at its next step boundary.');
    } catch (cause) {
      toast.error(errorMessage(cause, 'The run could not be stopped.'));
    }
  }, [controller]);

  const reset = useCallback(() => {
    if (running) void controller.cancel().catch(() => {});
    if (recorder.status === 'recording') void recorder.stop();
    controller.reset();
    setSentInput(null);
    setRecordedRunId(null);
    setSelectedEventIndex(null);
  }, [controller, recorder, running]);

  const selectEvent = useCallback(
    (index: number | null) => {
      setSelectedEventIndex(index);
      if (index === null) {
        controller.goLive();
        return;
      }
      controller.travelTo(index + 1);
      const nodeId = events[index]?.nodeId;
      if (nodeId && nodeById.has(nodeId)) storeApi.getState().selectNode(nodeId);
    },
    [controller, events, nodeById, storeApi],
  );

  const goLive = useCallback(() => {
    setSelectedEventIndex(null);
    controller.goLive();
  }, [controller]);

  const now = useNow(running && !timeTravelling);
  const shownEvent = timeTravelling && controller.viewCount ? events[controller.viewCount - 1] : undefined;
  const elapsedMs = (() => {
    if (view.status === 'IDLE') return null;
    if (shownEvent && view.startedAt) return Math.max(0, Date.parse(shownEvent.ts) - Date.parse(view.startedAt));
    if (view.durationMs !== undefined) return view.durationMs;
    if (controller.startedLocalAt !== null) return Math.max(0, now - controller.startedLocalAt);
    return view.startedAt ? Math.max(0, now - Date.parse(view.startedAt)) : null;
  })();

  const originTs = live.startedAt ?? events[0]?.ts;
  const recordingState = recorder.status === 'recording' || recorder.status === 'starting' ? 'live' : recordedRunId !== null && recordedRunId === controller.runId ? 'ended' : null;

  return (
    <div className="flex shrink-0 flex-col gap-4" data-slot="workflow-test-tab" data-definition-id={definitionId}>
      <SandboxBanner />
      {timeTravelling ? (
        <div role="status" className="border-primary/40 bg-primary/5 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <span>
            {selectedEventIndex !== null || controller.viewCount
              ? `Showing the state at event #${shownEvent?.seq ?? controller.viewCount ?? 0}${shownEvent ? ` (${relativeTime(shownEvent.ts, originTs)})` : ''}.`
              : 'Showing the state before the first event.'}{' '}
            {controller.playing ? 'Replaying to live…' : 'The run keeps going live.'}
          </span>
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={goLive}>
            Back to live
          </Button>
        </div>
      ) : null}
      {controller.streamError ? (
        <div role="alert" className="border-destructive/40 bg-destructive/10 text-destructive flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <span>The trace connection was lost: {controller.streamError}</span>
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={controller.reconnect}>
            Reconnect
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <TestFlow view={view} />
          <StepPanel node={stepNode} run={stepNodeId ? view.nodes[stepNodeId] : undefined} hidePhi={hidePhi} live={!timeTravelling} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <TestInputPanel
            plan={plan}
            value={input}
            onChange={setInput}
            inputProblem={extra.problem ?? recordUnavailable}
            recorder={{ status: recorder.status, error: recorder.error, levels: recorder.levels, onStop: () => void recorder.stop() }}
            running={running}
            starting={controller.starting || recorder.status === 'starting'}
            cancelling={controller.cancelling}
            hasEvents={events.length > 0}
            paused={timeTravelling}
            playing={controller.playing}
            speed={controller.speed}
            onRun={() => void runTest()}
            onStopRun={() => void stopRun()}
            onPause={() => {
              setSelectedEventIndex(null);
              controller.pause();
            }}
            onPlay={() => {
              setSelectedEventIndex(null);
              controller.play();
            }}
            onStep={() => {
              setSelectedEventIndex(null);
              controller.step();
            }}
            onReset={reset}
            onSpeedChange={controller.setSpeed}
          />
          <ExecutionContext
            view={view}
            labelOf={labelOf}
            isAiTextStep={isAiTextStep}
            variableStepIds={variableStepIds}
            kinds={kinds}
            sentInput={controller.runId === null ? null : sentInput}
            recording={recordingState}
            hidePhi={hidePhi}
            onHidePhiChange={setHidePhi}
            elapsedMs={elapsedMs}
          />
          <EventsPanel events={events} originTs={originTs} labelOf={labelOf} hidePhi={hidePhi} selectedIndex={selectedEventIndex} onSelect={selectEvent} />
        </div>
      </div>

      <RunStatusBar
        status={live.status}
        starting={controller.starting}
        streamStatus={controller.streamStatus}
        elapsedMs={elapsedMs}
        tokens={view.tokens}
        eventCount={events.length}
        shownCount={controller.viewCount}
        runId={controller.runId}
      />
    </div>
  );
}

/**
 * Per-node "last run" data the inspector's Last run tab and the picker samples read (contract from
 * lane C2b: `NodeLastRun` in `components/inspector/last-run-tab.tsx`): the latest COMPLETED Test-tab
 * run of this definition, from the query cache (memory only).
 */
export function useNodeLastRuns(definitionId: string): Record<string, NodeLastRun> {
  return useLatestSandboxRun(definitionId).nodes;
}
