import { useRef, useState } from 'react';
// `useArcaSttLanguageModes` is a v2-native hook (TASK-587) with no v1 ancestor.
// It MUST be imported from `@arcaai/vox/compat` — the SAME entry bundle as
// `<ArcaCompatProvider>` — because the store React context does not cross
// entry-point bundles (tsup `splitting: false`). Importing it from
// `@arcaai/vox/core` makes `useStoreApi()` read a different context instance
// and throw "must be used within an <AgenticProvider>".
import { useArcaSessionManager, useAudioCapture, useArcaSpeechToText, useArcaSttLanguageModes } from '@arcaai/vox/compat';
import { type SttLanguageModeOption } from '@arcaai/ui';
import { toast } from 'sonner';
import { ControllerColumn } from './ControllerColumn';
import { TranscriptColumn, type TranscriptLine } from './TranscriptColumn';
import { saveStoredConfig, type PlaygroundConfig } from '../lib/config-store';

interface SessionWorkspaceProps {
  config: PlaygroundConfig;
}

/** Static fallback when the TASK-587 catalog hook yields nothing (loading/empty/error). */
const FALLBACK_LANGUAGE_MODES: SttLanguageModeOption[] = [
  { id: 'en', label: 'English', kind: 'single' },
  { id: 'ml', label: 'Malayalam', kind: 'single' },
  { id: 'ml-en', label: 'Malayalam + English', kind: 'code_switch' },
  { id: 'vi', label: 'Vietnamese', kind: 'single' },
  { id: 'vi-en', label: 'Vietnamese + English', kind: 'code_switch' },
  { id: 'auto', label: 'Auto-detect', kind: 'auto' },
];

function formatTimestamp(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const minutes = Math.floor(clamped / 60);
  const seconds = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * The connected workspace — mounted INSIDE `<ArcaCompatProvider>`. It owns the
 * session state shared by columns 2 (controls) and 3 (results), and renders
 * them as a fragment so both become direct CSS-grid items (the provider emits
 * no DOM wrapper). Written the way a v1-migrating developer would: session via
 * `useArcaSessionManager`, mic via `useAudioCapture`, streaming transcript via
 * `useArcaSpeechToText`'s `onTranscript(text, isFinal, metadata)`.
 */
export function SessionWorkspace({ config }: SessionWorkspaceProps) {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [interim, setInterim] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const [languageMode, setLanguageMode] = useState(config.languageMode || 'en');

  // Capture-relative anchor for the fallback (arrival-time) timestamp used
  // when a final segment carries no numeric `meta.startTime`.
  const captureStartRef = useRef<number | null>(null);

  // TASK-587 — the backend-authoritative language-mode catalog.
  const languageModes = useArcaSttLanguageModes();
  const modes = languageModes.modes.length > 0 ? languageModes.modes : FALLBACK_LANGUAGE_MODES;

  // Metadata-simulation state (TASK-564 client-side passthrough demo).
  const [simSpeakerId, setSimSpeakerId] = useState('');
  const [simLanguage, setSimLanguage] = useState('');
  const [simMetadataJson, setSimMetadataJson] = useState('{}');
  const [lastSentMetadata, setLastSentMetadata] = useState<Record<string, unknown> | null>(null);

  const mgr = useArcaSessionManager({
    doctorId: 'compat-playground-doctor',
    doctorName: 'Compat Playground',
    patientId: 'compat-playground-patient',
    patientName: 'Demo Patient',
  });
  // Forward the end-user language selection to the capture hook too: it starts
  // the mic BEFORE `stt.startTranscription()` and wins the shared-audio start
  // race, so the language must ride along here or the pick is dropped (TASK-587).
  const capture = useAudioCapture({ language: languageMode, languageMode });
  const stt = useArcaSpeechToText({
    sessionId: mgr.session?.id ?? '',
    language: languageMode,
    // End-user language mode (TASK-587) forwarded via the frozen v1 `options`
    // bag; takes precedence over `language` on the backend path.
    options: { pipelineId: config.pipelineId.trim() || undefined, languageMode },
    onTranscript: (text, isFinal, meta) => {
      if (isFinal) {
        const startTime = typeof meta?.startTime === 'number' ? meta.startTime : undefined;
        const arrivalSeconds = captureStartRef.current !== null ? (Date.now() - captureStartRef.current) / 1000 : 0;
        setLines((prev) => [...prev, { text, meta, timestamp: formatTimestamp(startTime ?? arrivalSeconds) }]);
        setInterim('');
      } else {
        setInterim(text);
      }
    },
    onError: (err) => toast.error(`STT error: ${err.message}`),
  });

  const isPreSession = mgr.isLoading && !mgr.session;

  const start = async () => {
    if (isStarting || capture.isRecording) return;
    setIsStarting(true);
    setLines([]);
    setInterim('');
    setLastSentMetadata(null);
    captureStartRef.current = Date.now();
    try {
      // No consultation is opened: STT (recording + live transcription) does not
      // require a consultation session. We go straight to capture + streaming STT;
      // `consultationId` is simply absent on the stream.
      await capture.startRecording();
      await stt.startTranscription();
      toast.success('Recording live.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start recording');
    } finally {
      setIsStarting(false);
    }
  };

  const stop = async () => {
    await stt.stopTranscription();
    await capture.stopRecording();
    captureStartRef.current = null;
    toast.success('Recording stopped.');
  };

  const handleLanguageModeChange = (modeId: string) => {
    setLanguageMode(modeId);
    // Persist across reloads — does not touch the `connected` state in App.tsx,
    // so it never remounts `<ArcaCompatProvider>`.
    saveStoredConfig({ ...config, languageMode: modeId });
  };

  const handleSendMetadata = () => {
    let extra: Record<string, unknown> = {};
    if (simMetadataJson.trim()) {
      try {
        const parsed = JSON.parse(simMetadataJson) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('metadata JSON must be an object');
        }
        extra = parsed as Record<string, unknown>;
      } catch (err) {
        toast.error(`Invalid metadata JSON: ${err instanceof Error ? err.message : 'parse error'}`);
        return;
      }
    }
    const metadata: Record<string, unknown> = { ...extra };
    if (simSpeakerId.trim()) metadata.speaker_id = simSpeakerId.trim();
    if (simLanguage.trim()) metadata.language = simLanguage.trim();
    try {
      // Empty buffer: v2 owns capture/transport, this hook is a metadata sink
      // (TASK-564 §6 F1) — the metadata round-trips onto the NEXT onTranscript.
      stt.sendAudioData(new ArrayBuffer(0), metadata);
      setLastSentMetadata(metadata);
      toast.success('Metadata queued — check the next transcript line for the round-trip.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send metadata');
    }
  };

  return (
    <>
      <ControllerColumn
        sessionId={mgr.session?.id}
        sessionStatus={mgr.session?.status ?? 'none'}
        sessionError={mgr.error?.message ?? null}
        sttError={stt.error?.message ?? null}
        modes={modes}
        languageMode={languageMode}
        onLanguageModeChange={handleLanguageModeChange}
        catalogError={languageModes.error?.message ?? null}
        isRecording={capture.isRecording}
        isStarting={isStarting}
        onStart={start}
        onStop={stop}
        simSpeakerId={simSpeakerId}
        onSimSpeakerIdChange={setSimSpeakerId}
        simLanguage={simLanguage}
        onSimLanguageChange={setSimLanguage}
        simMetadataJson={simMetadataJson}
        onSimMetadataJsonChange={setSimMetadataJson}
        onSendMetadata={handleSendMetadata}
        lastSentMetadata={lastSentMetadata}
      />
      <TranscriptColumn lines={lines} interim={interim} isPreSession={isPreSession} />
    </>
  );
}
