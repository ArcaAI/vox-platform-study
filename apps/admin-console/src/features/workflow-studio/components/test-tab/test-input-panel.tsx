'use client';

/**
 * The Test tab's Test input (TASK-1036 §10.2): ONLY the controls this workflow can use, each with
 * the reason it is shown — Record (live waveform) for a speech-to-text step, a message box for an
 * Input shape with `message`, Attach for its file kinds, JSON for any other declared kind — and the
 * run controls: Run / Stop, Pause / Play, Step, Reset and playback speed.
 */
import { useId } from 'react';
import { Button, CodeEditor, Label, Spinner, Switch, Textarea, ToggleGroup, ToggleGroupItem } from '@arcaai/ui';
import { IconPaperclip, IconPlayerPauseFilled, IconPlayerPlayFilled, IconPlayerStopFilled, IconPlayerTrackNextFilled, IconRefresh } from '@tabler/icons-react';
import type { SandboxRecordingStatus } from '@/shared/sandbox/api/use-sandbox-recording';
import type { TestInputPlan } from './lib/test-inputs';
import type { PlaybackSpeed } from './use-test-run';
import { Panel } from './panel';

export interface TestInputState {
  message: string;
  extraJson: string;
  record: boolean;
}

export interface TestInputPanelProps {
  plan: TestInputPlan;
  value: TestInputState;
  onChange: (next: TestInputState) => void;
  /** A problem with the input that blocks Run (shown under the controls). */
  inputProblem: string | null;
  recorder: { status: SandboxRecordingStatus; error: string | null; levels: number[]; onStop: () => void };
  running: boolean;
  starting: boolean;
  cancelling: boolean;
  hasEvents: boolean;
  paused: boolean;
  playing: boolean;
  speed: PlaybackSpeed;
  onRun: () => void;
  onStopRun: () => void;
  onPause: () => void;
  onPlay: () => void;
  onStep: () => void;
  onReset: () => void;
  onSpeedChange: (speed: PlaybackSpeed) => void;
}

function Waveform({ levels }: { levels: number[] }) {
  const bars = levels.length > 0 ? levels : [0];
  return (
    <div role="img" aria-label="Microphone level" className="flex h-8 items-center gap-0.5" data-slot="test-waveform">
      {bars.map((level, index) => (
        // Height carries the level; the colour is a token (rule 07).
        <span key={index} className="bg-primary w-1 rounded-full" style={{ height: `${Math.max(8, level)}%` }} />
      ))}
    </div>
  );
}

function Reason({ children }: { children: string }) {
  return <p className="text-muted-foreground text-xs">{children}</p>;
}

export function TestInputPanel(props: TestInputPanelProps) {
  const { plan, value, onChange, recorder } = props;
  const messageId = useId();
  const recordId = useId();
  const jsonId = useId();
  const recording = recorder.status === 'recording' || recorder.status === 'starting' || recorder.status === 'stopping';
  const nothingToShow = !plan.record && !plan.message && !plan.attach && plan.extraKinds.length === 0;

  return (
    <Panel title="Test input">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Run controls">
        {props.running ? (
          <Button type="button" variant="outline" onClick={props.onStopRun} disabled={props.cancelling}>
            {props.cancelling ? <Spinner /> : <IconPlayerStopFilled aria-hidden="true" />}
            Stop run
          </Button>
        ) : (
          <Button type="button" onClick={props.onRun} disabled={props.starting || props.inputProblem !== null}>
            {props.starting ? <Spinner /> : <IconPlayerPlayFilled aria-hidden="true" />}
            Run test
          </Button>
        )}
        {props.paused ? (
          <Button type="button" variant="outline" onClick={props.onPlay} disabled={!props.hasEvents}>
            <IconPlayerPlayFilled aria-hidden="true" />
            Play
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={props.onPause} disabled={!props.hasEvents}>
            <IconPlayerPauseFilled aria-hidden="true" />
            Pause
          </Button>
        )}
        <Button type="button" variant="outline" onClick={props.onStep} disabled={!props.hasEvents}>
          <IconPlayerTrackNextFilled aria-hidden="true" />
          Step
        </Button>
        <Button type="button" variant="ghost" onClick={props.onReset} disabled={!props.hasEvents && !props.running}>
          <IconRefresh aria-hidden="true" />
          Reset
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-muted-foreground text-xs" id={`${jsonId}-speed`}>
            Speed
          </span>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            aria-labelledby={`${jsonId}-speed`}
            value={String(props.speed)}
            onValueChange={(next) => next && props.onSpeedChange(Number(next) as PlaybackSpeed)}
          >
            <ToggleGroupItem value="1">1×</ToggleGroupItem>
            <ToggleGroupItem value="2">2×</ToggleGroupItem>
            <ToggleGroupItem value="4">4×</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        {props.paused
          ? props.playing
            ? 'Replaying the events up to live.'
            : 'The view is paused: the run keeps going. Step moves one event, Play catches up.'
          : props.hasEvents
            ? 'Pause freezes the view while the run keeps going.'
            : 'Pause, Step and Reset become available once the run has events.'}
      </p>
      {props.inputProblem ? (
        <p role="alert" className="text-destructive text-sm">
          {props.inputProblem}
        </p>
      ) : null}

      {plan.record ? (
        <div className="flex flex-col gap-1.5 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Switch id={recordId} checked={value.record} disabled={recording} onCheckedChange={(checked) => onChange({ ...value, record: checked })} />
            <Label htmlFor={recordId}>Record from the microphone</Label>
          </div>
          <Reason>{plan.record.reason}</Reason>
          {recording ? (
            <div className="flex items-center gap-3">
              <Waveform levels={recorder.levels} />
              <span className="text-xs">{recorder.status === 'recording' ? 'Recording — speak now.' : recorder.status === 'starting' ? 'Opening the microphone…' : 'Finishing…'}</span>
              <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={recorder.onStop} disabled={recorder.status !== 'recording'}>
                Stop recording
              </Button>
            </div>
          ) : value.record ? (
            <p className="text-xs">Run test opens the microphone and streams it into the run’s sandbox consultation.</p>
          ) : null}
          {recorder.error ? (
            <p role="alert" className="text-destructive text-xs">
              {recorder.error}
            </p>
          ) : null}
        </div>
      ) : null}

      {plan.message ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={messageId}>{plan.message.label === 'Message' ? 'Message' : `${plan.message.label} (message)`}</Label>
          <Textarea id={messageId} rows={3} value={value.message} onChange={(event) => onChange({ ...value, message: event.target.value })} placeholder="Type what the workflow should work on" />
          <Reason>{plan.message.reason}</Reason>
        </div>
      ) : null}

      {plan.attach ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled aria-describedby={`${jsonId}-attach`}>
              <IconPaperclip aria-hidden="true" />
              Attach files
            </Button>
            <span className="text-muted-foreground text-xs">{plan.attach.mimeTypes.length > 0 ? plan.attach.mimeTypes.join(', ') : 'Any allowed type'}</span>
          </div>
          <Reason>{plan.attach.reason}</Reason>
          <p id={`${jsonId}-attach`} className="text-muted-foreground text-xs">
            Attaching files to a test run is not available yet: the console has no upload route for tenant media.
          </p>
        </div>
      ) : null}

      {plan.extraKinds.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">Other input (JSON)</p>
          <CodeEditor language="json" value={value.extraJson} onChange={(next: string) => onChange({ ...value, extraJson: next })} aria-label="Other input (JSON)" className="min-h-24" />
          <Reason>{`Shown because the Input shape also declares ${plan.extraKinds.map((kind) => kind.label).join(', ')}.`}</Reason>
        </div>
      ) : null}

      {nothingToShow ? (
        <p className="text-muted-foreground text-sm">
          {plan.schemaKnown ? 'This workflow takes no test input.' : 'This workflow declares no Input shape, so it runs on an empty input.'} Press Run test to start it.
        </p>
      ) : null}
    </Panel>
  );
}
