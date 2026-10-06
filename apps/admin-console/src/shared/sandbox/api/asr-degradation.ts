/**
 * TASK-1048 — human wording for the speech-to-text optional stages that were switched OFF.
 *
 * The core path (audio in → transcript out) always runs; an optional stage whose prerequisite is
 * missing degrades and is REPORTED, in two places: the session-creation response (`warnings`) and
 * mid-session `status` frames (`degraded` / `denoise_degraded`). Both fold into one
 * {@link AsrDegradation} list a banner renders. Codes mirror `@arcaai/types` `asr-degradation.ts`;
 * they are matched as plain strings here so an unknown/newer code still renders (generic copy).
 */
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

/** One gateway warning on a stream-session / batch-job creation response. */
export interface AsrSessionWarningWire {
  code: string;
  stage?: string;
  severity?: string;
  message?: string;
  agentSlug?: string;
  agentVersionNumber?: number;
}

/** A mid-session `status` frame, as far as degradation is concerned. */
export interface AsrStatusFrame {
  status?: string;
  reason?: string;
  engine?: string;
  detail?: string;
  message?: string;
}

export interface AsrDegradation {
  /** Dedupe key (code or reason). */
  key: string;
  /** What is off, in words. */
  label: string;
  /** Extra plain-language context (the server's own sentence when it sent one). */
  detail?: string;
}

export const GENERIC_DEGRADATION_LABEL = 'An optional processing stage is off';

const SESSION_CODE_LABELS: Record<string, string> = {
  DIARIZATION_MODEL_MISSING: 'Speaker labels are off — no speaker model is configured',
  DIARIZATION_BACKEND_UNSUPPORTED: 'Speaker labels are off — this agent’s speaker backend is no longer supported',
  VAD_MODEL_MISSING: 'Voice activity detection is off — speech is split by loudness instead',
  FALLBACK_UNRUNNABLE: 'A backup transcription engine is unavailable and will be skipped',
};

const RUNTIME_REASON_LABELS: Record<string, string> = {
  script_mismatch: 'Transcript script did not match the expected language',
  diarization_unavailable: 'Speaker labels are off — the speaker model could not load',
  voice_profiles_unavailable: 'Enrolled voices could not be loaded — speakers are labelled anonymously',
  vad_unavailable: 'Voice activity detection is off — speech is split by loudness instead',
  segmentation_unavailable: 'Turn refinement is off — speaker turns may be less precise',
  lexicon_unavailable: 'Vocabulary correction is off — raw recognised text is shown',
  gloss_unavailable: 'English gloss is off',
};

export function describeSessionWarning(warning: AsrSessionWarningWire): AsrDegradation {
  const label = SESSION_CODE_LABELS[warning.code] ?? GENERIC_DEGRADATION_LABEL;
  return { key: warning.code, label, ...(warning.message ? { detail: warning.message } : {}) };
}

/** `null` when the frame is not a degradation. */
export function describeStatusFrame(frame: AsrStatusFrame): AsrDegradation | null {
  if (frame.status === 'denoise_degraded') {
    const detail = frame.detail ?? frame.reason;
    return { key: 'denoise_degraded', label: 'Noise reduction is off', ...(detail ? { detail } : {}) };
  }
  if (frame.status === 'degraded') {
    const reason = frame.reason ?? '';
    return { key: reason || 'degraded', label: RUNTIME_REASON_LABELS[reason] ?? GENERIC_DEGRADATION_LABEL };
  }
  return null;
}

export interface AsrDegradationsApi {
  items: AsrDegradation[];
  addWarnings: (warnings: readonly AsrSessionWarningWire[] | undefined) => void;
  addStatusFrame: (frame: AsrStatusFrame) => void;
  reset: () => void;
}

/**
 * Collects degradations for ONE session, deduped by key, and raises a single `toast.warning`
 * the first time the list becomes non-empty (the persistent banner is the durable surface).
 */
export function useAsrDegradations(): AsrDegradationsApi {
  const [items, setItems] = useState<AsrDegradation[]>([]);
  const seen = useRef<Set<string>>(new Set());

  const add = useCallback((incoming: AsrDegradation[]) => {
    const wasEmpty = seen.current.size === 0;
    const unique: AsrDegradation[] = [];
    for (const entry of incoming) {
      if (seen.current.has(entry.key)) continue;
      seen.current.add(entry.key);
      unique.push(entry);
    }
    if (unique.length === 0) return;
    setItems((previous) => [...previous, ...unique]);
    if (wasEmpty) toast.warning('Some optional processing is off for this session', { description: 'Transcription is still running.' });
  }, []);

  const addWarnings = useCallback(
    (warnings: readonly AsrSessionWarningWire[] | undefined) => {
      if (warnings?.length) add(warnings.map(describeSessionWarning));
    },
    [add],
  );
  const addStatusFrame = useCallback(
    (frame: AsrStatusFrame) => {
      const described = describeStatusFrame(frame);
      if (described) add([described]);
    },
    [add],
  );
  const reset = useCallback(() => {
    seen.current = new Set();
    setItems([]);
  }, []);

  return { items, addWarnings, addStatusFrame, reset };
}
