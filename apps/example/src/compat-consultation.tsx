/**
 * HOPE v1 → v2 compat example — full consultation workflow on `@arcaai/vox/compat`.
 *
 * Demonstrates the exact workflow TASK-560 protects, written with the v1-named
 * compat hooks:
 *   1. session → `useArcaSessionManager` (createSession + startSession)
 *   2. record  → `useAudioCapture` (mic) + `useArcaSpeechToText` (live transcript)
 *   3. stop    → stopTranscription + stopRecording + endSession
 *   4. summary → `useSMR().summarizeSync` → render the Enhanced summary
 *
 * This component is deliberately framework-light (plain React + inline styles) so
 * a v1 team recognizes their own code. The ONLY structural change from a v1 app is
 * the `<ArcaCompatProvider>` wrapper in `compat-main.tsx` and the import specifier
 * below (`@arcaai/vox/compat` instead of `@arcaai/agentic-sdk`).
 *
 * See ../../../docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md
 */

import { useRef, useState } from 'react';
import {
  useArcaSessionManager,
  useAudioCapture,
  useArcaSpeechToText,
  useArcaSttProvider,
  useSMR,
  type EnhancedMedicalSummary,
  type SummaryResponse,
} from '@arcaai/vox/compat';

interface TranscriptLine {
  text: string;
  isFinal: boolean;
  /** Delivered metadata off onTranscript (TASK-564 §5.2, normalized §4.3). */
  meta?: Record<string, unknown>;
}

export function CompatConsultation() {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [interim, setInterim] = useState('');
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  // Transient banner for STT provider switches (auto OR user).
  const [switchBanner, setSwitchBanner] = useState<string | null>(null);

  // 1. Session — createSession + startSession collapse onto one idempotent open().
  //    doctorId is preserved in metadata.legacyDoctorId (server derives the doctor).
  const mgr = useArcaSessionManager({
    doctorId: 'dr-1',
    doctorName: 'Dr. Rao',
    patientId: 'pat-42',
    patientName: 'A. Kumar',
  });

  // 2a. Audio capture — onAudioData is no longer needed (v2 owns PCM/transport).
  const capture = useAudioCapture();

  // 2b. Live STT — onTranscript still fires (synthesized from v2 pull-state).
  //     The third arg is the delivered metadata: caller keys you tagged via
  //     sendAudioData (device_id/role/chunk_id), normalized with chunk_id /
  //     detected_language, plus derived speaker_id (diarization). See
  //     ../../docs/implementation/TASK-564-.../METADATA_PASSTHROUGH.md.
  const stt = useArcaSpeechToText({
    sessionId: mgr.session?.id ?? '',
    language: 'en',
    onTranscript: (text, isFinal, meta) => {
      if (isFinal) {
        setLines((prev) => [...prev, { text, isFinal: true, meta }]);
        setInterim('');
      } else {
        setInterim(text);
      }
    },
  });

  // Per-chunk metadata tagging (TASK-564). PCM is ignored in v2 (the hook is a
  // metadata sink), so pass an empty buffer and change the tag only at logical
  // TURN boundaries — the tag round-trips onto the next transcript(s).
  const chunkRef = useRef(0);
  const tagTurn = (role: 'clinician' | 'patient') => {
    stt.sendAudioData(new ArrayBuffer(0), {
      device_id: role === 'clinician' ? 'mic-1' : 'mic-2',
      role,
      chunk_id: `chunk-${(chunkRef.current += 1)}`,
      consultationId: mgr.session?.id ?? 'unknown',
    });
  };

  // Provider switching — the ONE compat import with no v1 ancestor (TASK-568).
  // It answers "which STT provider am I on?" and drives the user switch flow.
  // `onProviderSwitched` fires for BOTH the user button below AND a backend
  // auto-switch on an outage, so this one banner covers both.
  const provider = useArcaSttProvider({
    onProviderSwitched: (info) =>
      setSwitchBanner(
        `Transcription switched to ${info.toPipeline.name ?? info.toPipeline.id} (${info.reason})`,
      ),
    onSwitchFailed: (err) => setSwitchBanner(`Provider switch failed: ${err.message}`),
  });

  // 4. Summary — same path + x-api-key as v1; sends real per-turn segments.
  const smr = useSMR({ sessionId: mgr.session?.id });

  const start = async () => {
    setSummary(null);
    setLines([]);
    chunkRef.current = 0;
    await mgr.createSession();
    await mgr.startSession();
    await capture.startRecording();
    await stt.startTranscription();
  };

  // 3. Stop the recording, then close the session.
  const stop = async () => {
    await stt.stopTranscription();
    await capture.stopRecording();
    await mgr.endSession();
  };

  // 4. Generate a summary of the case note from the accumulated transcript.
  const summarize = async () => {
    const result = await smr.summarizeSync({
      // Prefer real per-turn segments (F2) — split from the transcript lines.
      segments: lines.map((l) => ({ speaker: 'provider', text: l.text })),
      text: lines.map((l) => l.text).join('\n'),
      departmentId: 'cardiology',
      visitType: 'New Referral',
      useEnhancedFormat: true,
    });
    setSummary(result);
  };

  const enhanced =
    summary && (summary.summary as Partial<EnhancedMedicalSummary>).encounter_summary
      ? (summary.summary as EnhancedMedicalSummary)
      : null;

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>HOPE v2 compat — consultation</h1>
      <p style={{ color: '#666' }}>
        Session: <strong>{mgr.session?.id ?? '—'}</strong> · status:{' '}
        <strong>{mgr.session?.status ?? 'none'}</strong>
        {mgr.isLoading ? ' · working…' : ''}
      </p>

      {mgr.error ? <p style={{ color: '#b00' }}>Session error: {mgr.error.message}</p> : null}
      {stt.error ? <p style={{ color: '#b00' }}>STT error: {stt.error.message}</p> : null}
      {switchBanner ? (
        <p style={{ background: '#eef6ff', border: '1px solid #b6d4fe', padding: '0.5rem 0.75rem', borderRadius: 4 }}>
          {switchBanner}{' '}
          <button style={{ marginLeft: '0.5rem' }} onClick={() => setSwitchBanner(null)}>
            dismiss
          </button>
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: '0.5rem', margin: '1rem 0' }}>
        <button onClick={start} disabled={capture.isRecording}>
          Start consultation
        </button>
        <button onClick={stop} disabled={!capture.isRecording}>
          Stop
        </button>
        <button onClick={summarize} disabled={capture.isRecording || lines.length === 0 || smr.loading}>
          {smr.loading ? 'Summarizing…' : 'Generate summary'}
        </button>
        {/* User provider-switch control flow (TASK-567 R4): enabled only while a
            live backend session can switch and isn't already on the fallback. */}
        <button
          onClick={() => void provider.switchToFallback().catch(() => undefined)}
          disabled={!provider.fallbackAvailable || provider.switchStatus === 'switching'}
        >
          {provider.switchStatus === 'switching' ? 'Switching…' : 'Switch provider'}
        </button>
      </div>

      <p style={{ color: '#666', fontSize: '0.85rem' }}>
        STT provider: <strong>{provider.activeProvider?.name ?? provider.activeProvider?.pipelineId ?? 'local'}</strong>
        {provider.isFallbackActive ? ' (fallback)' : ''}
      </p>

      {/* Metadata tagging — tag the CURRENT turn; it round-trips onto the next
          transcript line (TASK-564). Only enabled while recording. */}
      <div style={{ display: 'flex', gap: '0.5rem', margin: '0 0 1rem', alignItems: 'center' }}>
        <span style={{ color: '#666', fontSize: '0.85rem' }}>Tag turn:</span>
        <button onClick={() => tagTurn('clinician')} disabled={!capture.isRecording}>
          Clinician (mic-1)
        </button>
        <button onClick={() => tagTurn('patient')} disabled={!capture.isRecording}>
          Patient (mic-2)
        </button>
      </div>

      <section>
        <h2>Live transcript</h2>
        <ul>
          {lines.map((l, i) => (
            <li key={i}>
              {l.text}
              {/* device_id / chunk_id are what you tagged; speaker_id is derived
                  from diarization (the only post-mix source signal — §4/E3). */}
              <small style={{ color: '#888', marginLeft: '0.5rem' }}>
                [{String(l.meta?.device_id ?? '—')} · {String(l.meta?.chunk_id ?? '—')} ·{' '}
                {String(l.meta?.speaker_id ?? '—')}]
              </small>
            </li>
          ))}
          {interim ? <li style={{ opacity: 0.5 }}>{interim}</li> : null}
        </ul>
        {lines.length === 0 && !interim ? <p style={{ color: '#999' }}>No transcript yet.</p> : null}
      </section>

      {summary ? (
        <section>
          <h2>Summary</h2>
          {enhanced ? (
            <>
              <p>
                <strong>Chief complaint:</strong> {enhanced.encounter_summary.chief_complaint}
              </p>
              <p>
                <strong>Assessment:</strong> {enhanced.clinical_assessment.primary_diagnosis.diagnosis}
              </p>
              <p>{enhanced.clinical_summary.summary}</p>
            </>
          ) : (
            <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(summary.summary, null, 2)}</pre>
          )}
          {smr.error ? <p style={{ color: '#b00' }}>Summary error: {smr.error}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
