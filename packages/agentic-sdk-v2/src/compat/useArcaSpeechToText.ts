'use client';

/**
 * @arcaai/vox/compat - useArcaSpeechToText
 *
 * v1 live-STT hook reproduced over v2's pull-state model (TASK-560 §5.3),
 * hardened per the frozen metadata-passthrough contract (TASK-564 §5, TASK-565).
 *
 * v1 pushed transcripts through an `onTranscript(text, isFinal, metadata)`
 * callback; v2 exposes `transcriptSegments[]` (final) + `currentTranscript`
 * (interim) in the store. This hook SYNTHESIZES the v1 callback by observing
 * those store selectors and diffing:
 *  - each NEW final segment  → `onTranscript(text, true,  meta)`
 *  - a changed interim value → `onTranscript(text, false, meta)`
 *
 * Final text is formatted through `transcriptTemplate` (default
 * `"{timestamp} {speaker_id}: {text}"` — v1 parity). Interim text is delivered
 * raw: interims carry no diarization/timestamp, so the speaker/timestamp slots
 * of the template are meaningless for them.
 *
 * `startTranscription()`/`stopTranscription()` drive the SAME `useArcaAudio()`
 * instance as `useAudioCapture`, guarded by `audio.isCapturing` (idempotent).
 *
 * `uploadAudioFile()` / `getTranscriptionStatus()` / `isUploading` /
 * `uploadProgress` are the v1 FILE-upload members. They used to throw / be
 * hardcoded; from TASK-603 they drive the real v2 batch endpoint through
 * `FileTranscriptionService`. Signatures are unchanged. For many files with
 * live per-file results, use `useArcaBatchTranscription` instead.
 *
 * `sendAudioData(data, metadata)` is a METADATA SINK (TASK-560 §5.3 / §6 F1): it
 * records `{device_id, role, chunk_id, …}`-style metadata onto a bounded,
 * capture-relative TIMELINE (E2) and NEVER pushes PCM — v2 owns capture and
 * transport. Delivered metadata is composed in the §5.2 precedence order so
 * caller keys are never silently overwritten by hook enrichments (defect F4).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useArcaAudio } from '../hooks/useArcaAudio';
import { FileTranscriptionService } from '../core/FileTranscriptionService';
import { useAgenticStore, selectApiClient, selectCurrentTranscript, selectLogger } from '../store/agenticStore';
import type { TranscriptSegment } from '../types/audio';
import type { AgenticState } from '../store/agenticStore';
import type { ErrorInfo } from './types';
import {
  applyTemplate,
  composeDeliveredMetadata,
  pickMetadataForFinal,
  pickMetadataForInterim,
  MAX_METADATA_BYTES,
  METADATA_TIMELINE_CAP,
  type TimelineEntry,
} from './speechToTextMetadata';

export interface UseArcaSpeechToTextProps {
  sessionId: string;
  language: string;
  options?: Record<string, unknown>;
  /** e.g. `"{timestamp} {speaker_id}: {text}"`. Defaults to that when absent. */
  transcriptTemplate?: string;
  onTranscript: (text: string, isFinal: boolean, metadata?: Record<string, unknown>) => void;
  onError?: (error: ErrorInfo) => void;
  onStatus?: (status: string, data?: unknown) => void;
}

export interface UseArcaSpeechToTextReturn {
  transcript: string;
  startTranscription: () => Promise<void>;
  stopTranscription: () => Promise<void>;
  /** Metadata sink — records turn metadata; NEVER pushes PCM (v2 owns transport). */
  sendAudioData: (audioData: ArrayBuffer, metadata?: Record<string, unknown>) => void;
  /**
   * Upload a pre-recorded file for batch transcription; resolves to the job id
   * (v1 resolved to its task id). `provider` — v1's `'azure' | 'whisper'` slot —
   * is honoured as a PIPELINE OVERRIDE for this upload; when omitted the
   * pipeline comes from `options.pipelineId`. See {@link useArcaBatchTranscription}
   * for the multi-file queue with live results.
   */
  uploadAudioFile: (file: File, language: string, provider?: string) => Promise<string>;
  /** Read a job back by id. Resolves to a `TranscriptionJobResponse`. */
  getTranscriptionStatus: (taskId: string) => Promise<unknown>;
  isUploading: boolean;
  uploadProgress: number;
  error: ErrorInfo | null;
}

const selectTranscriptSegments = (state: AgenticState): TranscriptSegment[] => state.transcriptSegments ?? [];

function toErrorInfo(err: unknown): ErrorInfo {
  return {
    code: 'TRANSCRIPTION_ERROR',
    message: err instanceof Error ? err.message : String(err),
    severity: 'high',
    category: 'processing',
  };
}

export function useArcaSpeechToText(props: UseArcaSpeechToTextProps): UseArcaSpeechToTextReturn {
  const { language, transcriptTemplate, onTranscript, onError, onStatus, options } = props;
  const audio = useArcaAudio();

  // v1 accepted the backend ASR pipeline via the `options` bag; v2 needs it on
  // `audio.start(...)` to build the streaming transport. Forwarding it here fixes
  // the drop found in TASK-567 §2.4 (the pipeline id was silently discarded, so
  // the compat surface always fell back to the default pipeline). Does NOT touch
  // the TASK-564/565 metadata timeline.
  const pipelineId = typeof options?.pipelineId === 'string' ? options.pipelineId : undefined;
  // End-user language mode (TASK-587) — accepted through the v1 `options` bag
  // (same additive pattern as `pipelineId`), so the frozen v1 signature is
  // unchanged. When set it is forwarded to `audio.start` and takes precedence
  // over the v1 `language` string on the backend path.
  const languageMode = typeof options?.languageMode === 'string' ? options.languageMode : undefined;

  const segments = useAgenticStore(selectTranscriptSegments);
  const currentTranscript = useAgenticStore(selectCurrentTranscript);

  // Publish the selected language + mode into the store so the choice survives
  // the compat start-coordination race. `useAudioCapture.startRecording()` and
  // this hook's `startTranscription()` both drive the SAME `useArcaAudio()` and
  // both call `audio.start(...)` guarded by `audio.isCapturing`; whichever runs
  // FIRST wins. `useAudioCapture` starts with only `{ pipelineId }` (it has no
  // language), so if it wins the language-bearing start here is skipped and the
  // selection is lost (the pipeline default language is used instead). Backing
  // the selection with the store — which `useArcaAudio.startAudio` reads as a
  // fallback — makes the outcome order-independent. (TASK-587)
  const setAudioLanguage = useAgenticStore((s) => s.setAudioLanguage);
  const setSttLanguageMode = useAgenticStore((s) => s.setSttLanguageMode);
  // Pre-start engine selection (TASK-586) chosen via `useArcaSttProvider` before
  // capture — applied to `audio.start` and cleared (order-independent with
  // `useAudioCapture`, mirroring the languageMode store-fallback pattern).
  const pendingSttProvider = useAgenticStore((s) => s.pendingSttProvider);
  const setPendingSttProvider = useAgenticStore((s) => s.setPendingSttProvider);
  // Silent-uplink watchdog signal (TASK-612 Lane D) — read from the store
  // directly (same pattern as `pendingSttProvider`); `?? 'ok'` keeps older
  // store doubles that predate the field green.
  const audioSignalState = useAgenticStore((s) => s.audioSignalState ?? 'ok');
  useEffect(() => {
    setAudioLanguage(language);
    setSttLanguageMode(languageMode);
  }, [language, languageMode, setAudioLanguage, setSttLanguageMode]);

  const [error, setError] = useState<ErrorInfo | null>(null);
  // Real upload state (TASK-603) — these two were hardcoded `false`/`0` while
  // `uploadAudioFile` threw.
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  // The batch endpoint runs through the SDK client, not the capture graph.
  const apiClient = useAgenticStore(selectApiClient);
  const logger = useAgenticStore(selectLogger);

  // Keep callbacks fresh without re-subscribing the diff effects.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  // Connection-health / provider-switch surfacing on the already-frozen-but-
  // unwired v1 `onStatus` prop (TASK-568 D-2). This is a BEHAVIOR addition on an
  // existing optional prop — zero signature change; apps that never pass
  // `onStatus` are unaffected. Reads ONLY the public v2 surface (useArcaAudio),
  // so the compat invariant holds. v1 apps could never see these transitions;
  // TASK-567 Phase F wires the underlying reconnect / provider_switched callbacks.
  const prevConnRef = useRef(audio.sttConnectionState);
  const prevIsFallbackRef = useRef<boolean>(audio.activePipeline?.isFallback ?? false);
  const prevPipelineIdRef = useRef<string | undefined>(audio.activePipeline?.id);
  useEffect(() => {
    const conn = audio.sttConnectionState;
    const pipelineId = audio.activePipeline?.id;
    const isFallback = audio.activePipeline?.isFallback ?? false;
    const emit = onStatusRef.current;
    if (emit) {
      // Reconnect transitions.
      if (conn === 'reconnecting' && prevConnRef.current !== 'reconnecting') emit('reconnecting');
      if (conn === 'connected' && prevConnRef.current === 'reconnecting') emit('reconnected');
      // Provider switch — the active pipeline flipped to the tenant fallback.
      // Payload carries only what the public v2 store surfaces (from/to pipeline
      // ids); the reason ('auto' vs 'user') is not on the store, so it is not
      // fabricated here — the richer `useArcaSttProvider.onProviderSwitched`
      // carries it. See the migration guide.
      if (isFallback && !prevIsFallbackRef.current) {
        emit('provider_switched', { fromPipeline: prevPipelineIdRef.current, toPipeline: pipelineId });
      }
    }
    prevConnRef.current = conn;
    prevIsFallbackRef.current = isFallback;
    prevPipelineIdRef.current = pipelineId;
  }, [audio.sttConnectionState, audio.activePipeline]);

  // Silent-uplink watchdog surfacing (TASK-612 Lane D, AC-4) — the same
  // additive pattern as the reconnect events above: the frozen-but-optional
  // v1 `onStatus` learns that the open socket is carrying pure silence
  // (`no_audio_signal`) and that the signal came back
  // (`audio_signal_restored`). Once per transition, nothing on mount.
  const prevAudioSignalRef = useRef<'ok' | 'silent'>('ok');
  useEffect(() => {
    const emit = onStatusRef.current;
    if (emit) {
      if (audioSignalState === 'silent' && prevAudioSignalRef.current !== 'silent') emit('no_audio_signal');
      if (audioSignalState === 'ok' && prevAudioSignalRef.current === 'silent') emit('audio_signal_restored');
    }
    prevAudioSignalRef.current = audioSignalState;
  }, [audioSignalState]);

  // Capture-relative metadata TIMELINE (E2). Replaces the single sticky bag:
  // each sendAudioData appends {atMs, metadata}; finals correlate by startTime,
  // interims use most-recent. `captureStartMs` anchors the capture-relative base.
  const metadataTimelineRef = useRef<TimelineEntry[]>([]);
  const captureStartMsRef = useRef<number | undefined>(undefined);

  // The base is anchored when CAPTURE begins — not when startTranscription runs.
  // `useAudioCapture` and this hook drive the SAME audio graph, and an app that
  // lets the user pick a microphone must start from `useAudioCapture` (the only
  // hook carrying device/source selection). In that order `audio.isCapturing` is
  // already true when `startTranscription()` runs, its idempotency guard returns
  // early, and an anchor set only inside it would never exist — every
  // `sendAudioData` would stamp `atMs = 0` and `pickMetadataForFinal` would be
  // handed `undefined`, silently collapsing per-segment attribution to sticky
  // most-recent (TASK-611). Watching `isCapturing` also covers the case where
  // this hook mounts mid-capture and `startTranscription` is never called at all.
  //
  // Anchoring only on the false→true transition AND only while unset keeps this
  // to ONE write per capture: re-renders while capturing cannot drift the base,
  // and the synchronous pre-anchor in `startTranscription` (which fires BEFORE
  // the graph reports capturing, so metadata sent in that window is already
  // placed) still owns the STT-first order — unchanged for existing consumers.
  // `stopTranscription` clears the ref, so the next capture anchors afresh.
  const wasCapturingRef = useRef(false);
  useEffect(() => {
    if (audio.isCapturing && !wasCapturingRef.current && captureStartMsRef.current === undefined) {
      captureStartMsRef.current = Date.now();
    }
    wasCapturingRef.current = audio.isCapturing;
  }, [audio.isCapturing]);

  // Diff cursor for finals already surfaced.
  const seenFinalCountRef = useRef(0);
  // Last interim value surfaced (avoids duplicate interim callbacks).
  const lastInterimRef = useRef('');

  // Final segments → onTranscript(text, true, meta).
  useEffect(() => {
    for (let i = seenFinalCountRef.current; i < segments.length; i += 1) {
      const seg = segments[i];
      if (!seg?.isFinal) continue;
      // Belt-and-braces (TASK-612 Lane F, OD-3a): useArcaAudio already suppresses
      // whitespace-only finals before they reach the store, but skip here too in
      // case some other producer writes one — the cursor below still advances
      // to `segments.length`, so a skipped segment is never re-visited.
      if (!seg.text?.trim()) continue;
      const callerMeta = pickMetadataForFinal(metadataTimelineRef.current, seg.startTime, captureStartMsRef.current);
      const text = applyTemplate(transcriptTemplate, {
        text: seg.text,
        speakerId: seg.speakerLabel,
        timestamp: String(seg.startTime ?? ''),
      });
      onTranscriptRef.current(text, true, composeDeliveredMetadata({ seg, isFinal: true, callerMeta }));
    }
    seenFinalCountRef.current = segments.length;
  }, [segments, transcriptTemplate]);

  // Interim currentTranscript → onTranscript(text, false, meta). Text stays raw
  // (interims have no speaker/timestamp to template).
  useEffect(() => {
    if (currentTranscript && currentTranscript !== lastInterimRef.current) {
      lastInterimRef.current = currentTranscript;
      const callerMeta = pickMetadataForInterim(metadataTimelineRef.current);
      onTranscriptRef.current(currentTranscript, false, composeDeliveredMetadata({ seg: {}, isFinal: false, callerMeta }));
    }
  }, [currentTranscript]);

  const startTranscription = useCallback(async (): Promise<void> => {
    if (audio.isCapturing) return; // coordinated with useAudioCapture (idempotent)
    try {
      setError(null);
      // STT-first pre-anchor: capture has not been reported yet, so the effect
      // above has nothing to see; it will not overwrite this (see TASK-611).
      if (captureStartMsRef.current === undefined) captureStartMsRef.current = Date.now();
      await audio.start({
        language,
        ...(pipelineId ? { pipelineId } : {}),
        ...(languageMode ? { languageMode } : {}),
        ...(pendingSttProvider ? { startOn: pendingSttProvider } : {}),
      });
      // Consume the pre-start selection (order-independent with useAudioCapture).
      if (pendingSttProvider) setPendingSttProvider(null);
    } catch (err) {
      const info = toErrorInfo(err);
      setError(info);
      onError?.(info);
      throw err;
    }
  }, [audio, language, pipelineId, languageMode, pendingSttProvider, setPendingSttProvider, onError]);

  const stopTranscription = useCallback(async (): Promise<void> => {
    if (!audio.isCapturing) return;
    try {
      await audio.stop();
      // Reset the timeline for a clean re-open.
      metadataTimelineRef.current = [];
      captureStartMsRef.current = undefined;
      // TASK-612 Lane F (I-2): also reset the interim dedup ref, or an identical
      // first interim in the NEXT session is silently swallowed as a "duplicate".
      lastInterimRef.current = '';
    } catch (err) {
      const info = toErrorInfo(err);
      setError(info);
      onError?.(info);
      throw err;
    }
  }, [audio, onError]);

  const sendAudioData = useCallback((_audioData: ArrayBuffer, metadata?: Record<string, unknown>): void => {
    // Metadata sink ONLY — v2 owns capture/transport, so PCM is never pushed
    // (TASK-560 §6 F1). Record the turn metadata onto the capture-relative
    // timeline for the next synthesized onTranscript(); PCM is intentionally ignored.
    if (metadata && JSON.stringify(metadata).length > MAX_METADATA_BYTES) {
      throw new Error('Audio frame metadata exceeds 8192 bytes');
    }
    const captureStart = captureStartMsRef.current;
    const atMs = captureStart !== undefined ? Date.now() - captureStart : 0;
    const timeline = metadataTimelineRef.current;
    timeline.push({ atMs, metadata });
    if (timeline.length > METADATA_TIMELINE_CAP) timeline.shift(); // drop-oldest
  }, []);

  // ---------------------------------------------------------------------------
  // The v1 file-upload members (TASK-603).
  //
  // These four were declared by v1 and, until now, were dead in compat:
  // `uploadAudioFile`/`getTranscriptionStatus` threw "not supported" and
  // `isUploading`/`uploadProgress` were hardcoded `false`/`0`. Nothing about the
  // SIGNATURES changed here — a migrating v1 app keeps compiling — only the
  // bodies, which now drive the real v2 batch endpoint through
  // `FileTranscriptionService`.
  //
  // v1's third argument was an ASR provider name (`'azure' | 'whisper'`). v2
  // expresses the engine as a PIPELINE, so `provider` is honoured as a pipeline
  // id/slug override for that one upload; absent, the pipeline comes from the
  // same `options.pipelineId` the live path uses. Neither present is a hard,
  // named error — never a silent upload against the wrong engine.
  //
  // For MANY files with live per-file results, use `useArcaBatchTranscription`;
  // this pair stays deliberately single-file, exactly as v1 shaped it.
  // ---------------------------------------------------------------------------
  const uploadAudioFile = useCallback(
    async (file: File, uploadLanguage: string, provider?: string): Promise<string> => {
      const client = apiClient;
      if (!client) {
        const info = toErrorInfo(new Error('SDK not initialized — no apiClient available. Mount <ArcaCompatProvider> before uploading.'));
        setError(info);
        onError?.(info);
        throw new Error(info.message);
      }
      const targetPipeline = provider?.trim() || pipelineId;
      if (!targetPipeline) {
        const info = toErrorInfo(
          new Error(
            'No pipelineId available for this upload. Pass one as the third argument (v1 `provider` is treated as a pipeline override) ' +
              'or configure it via useArcaSpeechToText({ options: { pipelineId } }).',
          ),
        );
        setError(info);
        onError?.(info);
        throw new Error(info.message);
      }

      const service = new FileTranscriptionService(client, logger ?? undefined);
      setIsUploading(true);
      setUploadProgress(0);
      setError(null);
      try {
        const job = await service.uploadAndTranscribeWithProgress(file, {
          pipelineId: targetPipeline,
          ...(uploadLanguage ? { language: uploadLanguage } : {}),
          onProgress: (progress) => setUploadProgress(Math.round(progress)),
        });
        setUploadProgress(100);
        return job.id;
      } catch (err) {
        const info = toErrorInfo(err);
        setError(info);
        onError?.(info);
        throw err;
      } finally {
        setIsUploading(false);
      }
    },
    [apiClient, logger, pipelineId, onError],
  );

  const getTranscriptionStatus = useCallback(
    async (taskId: string): Promise<unknown> => {
      if (!apiClient) {
        throw new Error('[@arcaai/vox/compat] SDK not initialized — no apiClient available. Mount <ArcaCompatProvider> first.');
      }
      return new FileTranscriptionService(apiClient, logger ?? undefined).getJob(taskId);
    },
    [apiClient, logger],
  );

  const transcript = useMemo(() => {
    const finals = segments.map((s) => s.text).join(' ');
    return currentTranscript ? `${finals}${finals ? ' ' : ''}${currentTranscript}` : finals;
  }, [segments, currentTranscript]);

  return {
    transcript,
    startTranscription,
    stopTranscription,
    sendAudioData,
    uploadAudioFile,
    getTranscriptionStatus,
    isUploading,
    uploadProgress,
    error,
  };
}
