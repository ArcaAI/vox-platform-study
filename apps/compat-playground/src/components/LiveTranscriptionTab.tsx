import { AudioSourcePanel } from './AudioSourcePanel';
import { ControllerColumn } from './ControllerColumn';
import { ScorecardPanel } from './ScorecardPanel';
import { LIVE_TRANSCRIPTION_EXAMPLE_FILES, TabExampleCode } from './TabExampleCode';
import { TranscriptColumn } from './TranscriptColumn';
import { usePlaygroundSession } from '../context/playground-session';

/**
 * Tab 2 — live transcription.
 *
 * Layout only: controls on the left, results on the right, stacking to a single
 * column below `xl`. All session state comes from `usePlaygroundSession()`, so
 * this tab renders the SAME live session the Summarization tab reads — and
 * because its `<TabsContent>` is `forceMount`ed in `App.tsx`, switching tabs
 * mid-recording never unmounts it.
 *
 * Lane A adds the audio-source panel above the controls; lane D adds the
 * WER/CER scorecard under the transcript.
 */
export function LiveTranscriptionTab() {
  const { transcript, session } = usePlaygroundSession();

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      {/* Lane A — source selection sits above the controls: it is the first
          decision of a run and it locks once capture is live. */}
      <div className="flex flex-col gap-4">
        <AudioSourcePanel />
        <ControllerColumn />
      </div>
      <TranscriptColumn lines={transcript.lines} interim={transcript.interim} isPreSession={session.isPreSession} />
      {/* Lane D — full-width row under both columns; reads the transcript from the same context. */}
      <div className="xl:col-span-2">
        <ScorecardPanel />
      </div>
      {/* R2 — the tab ends with its own source, nothing from the other two tabs. */}
      <div className="xl:col-span-2">
        <TabExampleCode
          files={LIVE_TRANSCRIPTION_EXAMPLE_FILES}
          description="The capture path end to end: source selection, the mixer options handed to useAudioCapture, the transcript callback, per-mic metadata, and the scorer."
        />
      </div>
    </div>
  );
}
