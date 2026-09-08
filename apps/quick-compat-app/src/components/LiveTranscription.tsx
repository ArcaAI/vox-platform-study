import { useState } from 'react';
import { useArcaSpeechToText, useAudioCapture } from '@arcaai/vox/compat';
import { ProviderSwitch } from './ProviderSwitch';

interface LiveTranscriptionProps {
  pipelineId: string;
  /** The published ASR Agent the capture session selects (TASK-931); empty ⇒ the tenant assignment decides. */
  sttAgentSlug: string;
  language: string;
}

type Phase = 'idle' | 'starting' | 'recording' | 'stopping';

export function LiveTranscription({ pipelineId, sttAgentSlug, language }: LiveTranscriptionProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<string[]>([]);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Both hooks drive the SAME audio graph and whichever calls `audio.start()`
  // first wins — this one does (see `start` below), so the language must ride
  // along here too or the selection is dropped.
  const capture = useAudioCapture({
    language,
    languageMode: language,
    options: { sttAgentSlug: sttAgentSlug.trim() || undefined },
    onError: (err) => setError(err.message),
  });

  const stt = useArcaSpeechToText({
    // Live transcription does not need a consultation; the stream simply
    // carries no consultation id.
    sessionId: '',
    language,
    transcriptTemplate: '{speaker_id}: {text}',
    options: { pipelineId: pipelineId.trim() || undefined, languageMode: language },
    onTranscript: (text, isFinal) => {
      console.log('REceived: ' + text);
      if (isFinal) {
        setLines((prev) => [...prev, text]);
        setInterim('');
      } else {
        setInterim(text);
      }
    },
    onError: (err) => setError(err.message),
  });

  const start = async () => {
    if (phase !== 'idle') return;
    setPhase('starting');
    setLines([]);
    setInterim('');
    setError(null);
    try {
      // CAPTURE FIRST, transcription second. Both hooks call the same
      // `audio.start(...)` and the first one through applies its options; the
      // second is a no-op against the already-capturing audio graph.
      // `useAudioCapture` is the only hook that carries device/source options
      // (deviceId, sourceStreams, audioProcessing, ...), so it must win the
      // race or those selections are silently dropped in favor of the default
      // microphone. Both hooks pass `pipelineId`, so `activePipeline` (and
      // provider switching) is set either way; `language`/`languageMode` and
      // `pendingSttProvider` are store-backed, so they too are order-independent.
      await capture.startRecording();
      await stt.startTranscription();
      setPhase('recording');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start recording');
      setPhase('idle');
    }
  };

  // Stop releases the mic synchronously and then awaits the STT drain, so tail
  // finals still land while the UI already shows the mic as off.
  const stop = async () => {
    if (phase !== 'recording' && phase !== 'starting') return;
    setPhase('stopping');
    try {
      await Promise.all([capture.stopRecording(), stt.stopTranscription()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop recording');
    } finally {
      setInterim('');
      setPhase('idle');
    }
  };

  const level = capture.deviceStatus?.audioLevel ?? 0;

  return (
    <section className="card">
      <h2>
        Live transcription <span className="badge off">{phase}</span>
      </h2>

      <div className="row">
        <button className="primary" onClick={start} disabled={phase !== 'idle'}>
          Start
        </button>
        <button onClick={stop} disabled={phase !== 'recording' && phase !== 'starting'}>
          Stop
        </button>
        <button
          onClick={() => {
            setLines([]);
            setInterim('');
          }}
          disabled={phase !== 'idle'}
        >
          Clear
        </button>
        <span className="muted">language: {language}</span>
      </div>

      <ProviderSwitch />

      <div className="meter" aria-label="input level">
        <div className="meter-fill" style={{ width: `${Math.min(100, level)}%` }} />
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="transcript">
        {lines.length === 0 && !interim ? <p className="muted">No transcript yet.</p> : null}
        {lines.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
        {interim ? <p className="interim">{interim}</p> : null}
      </div>
    </section>
  );
}
