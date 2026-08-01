import { useEffect, useRef } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Label,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  Slider,
  Switch,
} from '@arcaai/ui';
import { toast } from 'sonner';
import { usePlaygroundSession } from '../context/playground-session';
import type { PlaygroundAudioMode } from '../context/playground-session';

/**
 * Audio-source selection for the Live-transcription tab (TASK-597 lane A).
 *
 * Four modes, one capture graph:
 *
 *   single mic          → `audio.start({ deviceId })`
 *   multi mic (mixed)   → `+ secondaryDeviceId, additionalDeviceIds` — N mics
 *                         summed by `@arcaai/room`'s AudioMixer into ONE uplink
 *   file → single mic   → `audio.start({ sourceStreams: [oneStream] })`
 *   file(s) → multi mic → several file-backed streams, mixed the same way
 *
 * The file modes exist so a run is deterministic and repeatable (which is what
 * makes WER/CER comparable across pipeline switches). They deliberately reuse
 * the mixer → noise-filter → VAD → STT path rather than a shortcut, so what you
 * measure is the real pipeline.
 */

const MODES: { value: PlaygroundAudioMode; label: string; hint: string }[] = [
  { value: 'single-mic', label: 'One microphone', hint: 'The classic single-input consultation.' },
  { value: 'multi-mic', label: 'Multiple microphones (mixed)', hint: 'N inputs summed into one uplink stream.' },
  { value: 'file-single', label: 'Audio file → one microphone', hint: 'Replay a recording through the real pipeline.' },
  { value: 'file-multi', label: 'Audio file(s) → multiple microphones', hint: 'One file per virtual mic, or split a stereo file.' },
];

const RATES = [0.5, 1, 1.5, 2];

function formatSeconds(total: number): string {
  const safe = Number.isFinite(total) ? Math.max(0, total) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function AudioSourcePanel() {
  const { audio, capture } = usePlaygroundSession();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isFileMode = audio.mode === 'file-single' || audio.mode === 'file-multi';
  // ---------------------------------------------------------------------------
  // `phase`, not `isRecording` — a deliberate choice (TASK-597 lane G).
  //
  // Since lane B, `isRecording` goes false the instant Stop is clicked while the
  // transport keeps draining (`phase === 'stopping'`). Source selection must
  // stay locked across that window: the graph is torn down but the session is
  // not idle, and re-picking a device there would leave the panel describing a
  // configuration the just-closed run never used.
  // ---------------------------------------------------------------------------
  const locked = capture.phase !== 'idle';

  // Drive file playback from the recording lifecycle: a file source that is not
  // playing feeds SILENCE into the pipeline, which looks exactly like a broken
  // STT session. Start on record, pause on stop — the manual transport below
  // stays available for scrubbing before/after a run.
  //
  // Pausing at the Stop CLICK (leaving `recording`) rather than at end-of-drain
  // is the correct behaviour, not a leftover: `stopAudio` ends every source
  // track synchronously on click, so from that moment the file-backed
  // `MediaStream` is already dead and playing on would only advance a clock
  // feeding nothing. Written against `phase` so the reasoning is explicit.
  const wasRecording = useRef(false);
  useEffect(() => {
    const isRecordingPhase = capture.phase === 'recording';
    if (!isFileMode || audio.sources.length === 0) {
      wasRecording.current = isRecordingPhase;
      return;
    }
    if (isRecordingPhase && !wasRecording.current && !audio.playback.isPlaying) {
      audio.play();
    } else if (!isRecordingPhase && wasRecording.current && audio.playback.isPlaying) {
      audio.pause();
    }
    wasRecording.current = isRecordingPhase;
  }, [capture.phase, isFileMode, audio]);

  useEffect(() => {
    if (audio.fileError) toast.error(audio.fileError);
  }, [audio.fileError]);

  const handleGrant = async () => {
    try {
      await audio.requestPermission();
      toast.success('Microphone access granted — device names are readable now.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Microphone permission was denied.');
    }
  };

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    await audio.loadFiles(Array.from(fileList));
    toast.success('Audio decoded — press Start, playback follows automatically.');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audio source</CardTitle>
        <CardDescription>
          Everything below feeds the same graph — mixer → noise filter → VAD → STT — via{' '}
          <code className="font-mono text-xs">audio.start(&#123; deviceId … | sourceStreams &#125;)</code> (TASK-597).
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <fieldset disabled={locked} className="contents">
          <div className="flex flex-col gap-2">
            <Label id="audio-source-mode-label">Mode</Label>
            <RadioGroup
              aria-labelledby="audio-source-mode-label"
              value={audio.mode}
              onValueChange={(value) => audio.setMode(value as PlaygroundAudioMode)}
              className="gap-2"
            >
              {MODES.map((option) => (
                <div key={option.value} className="flex items-start gap-2">
                  <RadioGroupItem value={option.value} id={`audio-mode-${option.value}`} className="mt-1" />
                  <Label htmlFor={`audio-mode-${option.value}`} className="flex flex-col items-start gap-0.5 font-normal">
                    <span>{option.label}</span>
                    <span className="text-muted-foreground text-xs">{option.hint}</span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          {isFileMode ? (
            <FileControls
              audio={audio}
              onPick={() => fileInputRef.current?.click()}
              onFiles={handleFiles}
              inputRef={fileInputRef}
              multiple={audio.mode === 'file-multi'}
            />
          ) : (
            <DeviceControls audio={audio} onGrant={handleGrant} />
          )}
        </fieldset>

        <SourceList audio={audio} locked={locked} />

        {locked ? (
          <p className="text-muted-foreground text-xs">
            {capture.phase === 'stopping'
              ? 'Source selection stays locked until the transport finishes finalizing.'
              : 'Source selection is locked while a session is live — stop first to change it.'}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

type Audio = ReturnType<typeof usePlaygroundSession>['audio'];

/** Microphone picker. Labels are blank until permission is granted. */
function DeviceControls({ audio, onGrant }: { audio: Audio; onGrant: () => void }) {
  const multi = audio.mode === 'multi-mic';

  if (audio.permissionStatus === 'prompt') {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          {/* Shape of the loaded list, so the panel does not jump on grant. */}
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-5 w-48" />
        </div>
        <p className="text-muted-foreground text-xs">
          The browser hides device names until microphone access is granted — <code className="font-mono">enumerateDevices()</code> returns entries
          with empty labels.
        </p>
        <Button type="button" onClick={onGrant} className="self-start">
          Grant microphone access
        </Button>
      </div>
    );
  }

  if (audio.devices.length === 0) {
    return <p className="text-muted-foreground text-sm">No audio input devices were found.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Label>{multi ? 'Microphones (selection order = mixer order)' : 'Microphone'}</Label>
        <Button type="button" variant="outline" size="sm" onClick={() => void audio.refreshDevices()}>
          Refresh
        </Button>
      </div>

      {multi ? (
        <div className="flex flex-col gap-2">
          {audio.devices.map((device) => {
            const index = audio.selectedDeviceIds.indexOf(device.deviceId);
            return (
              <div key={device.deviceId} className="flex items-center gap-2">
                <Checkbox id={`mic-${device.deviceId}`} checked={index >= 0} onCheckedChange={() => audio.toggleDevice(device.deviceId)} />
                <Label htmlFor={`mic-${device.deviceId}`} className="min-w-0 flex-1 truncate font-normal">
                  {device.label || device.deviceId}
                </Label>
                {index >= 0 ? <Badge variant="secondary">mic {index + 1}</Badge> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <RadioGroup
          value={audio.selectedDeviceIds[0] ?? ''}
          onValueChange={(value) => audio.selectDevice(value)}
          aria-label="Microphone"
          className="gap-2"
        >
          {audio.devices.map((device) => (
            <div key={device.deviceId} className="flex items-center gap-2">
              <RadioGroupItem value={device.deviceId} id={`mic-${device.deviceId}`} />
              <Label htmlFor={`mic-${device.deviceId}`} className="min-w-0 flex-1 truncate font-normal">
                {device.label || device.deviceId}
              </Label>
            </div>
          ))}
        </RadioGroup>
      )}

      {audio.selectedDeviceIds.length === 0 ? (
        <p className="text-muted-foreground text-xs">Nothing selected — the SDK will open the system default microphone.</p>
      ) : null}
    </div>
  );
}

/** File picker + transport. */
function FileControls({
  audio,
  onPick,
  onFiles,
  inputRef,
  multiple,
}: {
  audio: Audio;
  onPick: () => void;
  onFiles: (files: FileList | null) => Promise<void>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  multiple: boolean;
}) {
  const { playback } = audio;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          multiple={multiple}
          className="sr-only"
          aria-label={multiple ? 'Audio files' : 'Audio file'}
          onChange={(e) => {
            void onFiles(e.target.files);
            // Reset so re-picking the same file fires `change` again.
            e.target.value = '';
          }}
        />
        <Button type="button" variant="outline" onClick={onPick} disabled={audio.isDecoding}>
          {multiple ? 'Choose audio files…' : 'Choose an audio file…'}
        </Button>
        {audio.sources.length > 0 ? (
          <Button type="button" variant="ghost" onClick={audio.clearFiles}>
            Clear
          </Button>
        ) : null}
      </div>

      {multiple ? (
        <div className="flex items-center gap-2">
          <Switch id="split-stereo" checked={audio.splitStereo} onCheckedChange={audio.setSplitStereo} />
          <Label htmlFor="split-stereo" className="font-normal">
            Split a stereo file into two virtual mics (L → mic 1, R → mic 2)
          </Label>
        </div>
      ) : null}

      {audio.isDecoding ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-2 w-full" />
        </div>
      ) : null}

      {audio.sources.length > 0 && !audio.isDecoding ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={playback.isPlaying ? audio.pause : audio.play}>
              {playback.isPlaying ? 'Pause' : 'Play'}
            </Button>
            <span className="text-muted-foreground font-mono text-xs">
              {formatSeconds(playback.currentTime)} / {formatSeconds(playback.duration)}
            </span>
            <Badge variant={playback.isPlaying ? 'default' : 'outline'}>{playback.isPlaying ? 'playing' : 'paused'}</Badge>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="file-seek">Position</Label>
            <Slider
              id="file-seek"
              aria-label="Playback position"
              min={0}
              max={Math.max(playback.duration, 0.001)}
              step={0.1}
              value={[Math.min(playback.currentTime, playback.duration)]}
              onValueChange={([value]) => audio.seek(value ?? 0)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch id="file-loop" checked={playback.loop} onCheckedChange={audio.setLoop} />
              <Label htmlFor="file-loop" className="font-normal">
                Loop
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Rate</span>
              {RATES.map((rate) => (
                <Button
                  key={rate}
                  type="button"
                  size="sm"
                  variant={playback.rate === rate ? 'default' : 'outline'}
                  onClick={() => audio.setRate(rate)}
                >
                  {rate}×
                </Button>
              ))}
            </div>
          </div>

          <p className="text-muted-foreground text-xs">
            Playback starts automatically when you press Start and pauses on Stop — a paused file feeds silence to the pipeline.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** The resolved sources, in mixer order, each with its gain. */
function SourceList({ audio, locked }: { audio: Audio; locked: boolean }) {
  if (audio.sources.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Label>Mixer sources ({audio.sources.length})</Label>
        {audio.sources.length > 1 ? <Badge variant="secondary">mixed into one uplink stream</Badge> : null}
      </div>
      {audio.sources.map((source) => (
        <div key={source.id} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm">
              <span className="font-mono text-xs">{source.micLabel}</span> · {source.sourceLabel}
            </span>
            <span className="text-muted-foreground font-mono text-xs">{source.gain.toFixed(2)}×</span>
          </div>
          <Slider
            aria-label={`${source.micLabel} gain`}
            min={0}
            max={2}
            step={0.05}
            value={[source.gain]}
            disabled={locked}
            onValueChange={([value]) => audio.setGain(source.id, value ?? 1)}
          />
        </div>
      ))}
    </div>
  );
}
