'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Mic capture state machine for the enrollment wizard (frame 52 "REC SAMPLE"
 * flow): idle → requesting (browser permission prompt) → recording → idle,
 * with `denied` / `unsupported` as designed dead-ends that steer the user to
 * the upload path instead.
 */
export type RecorderPhase = 'idle' | 'requesting' | 'recording' | 'denied' | 'unsupported';

/** Monotonic name suffix so repeated takes never collide in the staged list. */
let recordingSequence = 0;

/** "audio/webm;codecs=opus" → "webm" (fallback for exotic recorder mimes). */
function extensionOf(mimeType: string): string {
    const subtype = mimeType.split('/')[1]?.split(';')[0];
    return subtype || 'webm';
}

export interface UseSampleRecorderResult {
    phase: RecorderPhase;
    /** Whole seconds since recording started — drives the REC clock. */
    elapsedSeconds: number;
    start: () => Promise<void>;
    stop: () => void;
}

/**
 * MediaRecorder wrapper that yields one `File` per take. The recorder's own
 * mime (typically audio/webm) is kept so the sample passes the gateway's
 * `audio/*` validator; hardware (tracks + timer) is released on stop AND on
 * unmount so the mic indicator never lingers.
 */
export function useSampleRecorder(onSample: (file: File) => void): UseSampleRecorderResult {
    const [phase, setPhase] = useState<RecorderPhase>('idle');
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    const recorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const onSampleRef = useRef(onSample);
    useEffect(() => {
        onSampleRef.current = onSample;
    }, [onSample]);

    // Unmount safety net: silence the handlers first so a forced stop cannot
    // call back into unmounted state, then release the mic.
    useEffect(
        () => () => {
            if (timerRef.current) clearInterval(timerRef.current);
            const recorder = recorderRef.current;
            if (recorder && recorder.state !== 'inactive') {
                recorder.ondataavailable = null;
                recorder.onstop = null;
                try {
                    recorder.stop();
                } catch {
                    // Recorder already stopped by the browser.
                }
            }
            streamRef.current?.getTracks().forEach((track) => track.stop());
        },
        [],
    );

    const start = async (): Promise<void> => {
        if (phase === 'recording' || phase === 'requesting') return;
        const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
        if (!getUserMedia || typeof MediaRecorder === 'undefined') {
            setPhase('unsupported');
            return;
        }
        setPhase('requesting');
        try {
            const stream = await getUserMedia({ audio: true });
            const recorder = new MediaRecorder(stream);
            chunksRef.current = [];
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) chunksRef.current.push(event.data);
            };
            recorder.onstop = () => {
                const type = recorder.mimeType || 'audio/webm';
                const blob = new Blob(chunksRef.current, { type });
                chunksRef.current = [];
                if (timerRef.current) {
                    clearInterval(timerRef.current);
                    timerRef.current = null;
                }
                streamRef.current?.getTracks().forEach((track) => track.stop());
                streamRef.current = null;
                recorderRef.current = null;
                setPhase('idle');
                recordingSequence += 1;
                onSampleRef.current(new File([blob], `recording-${recordingSequence}.${extensionOf(type)}`, { type }));
            };
            streamRef.current = stream;
            recorderRef.current = recorder;
            setElapsedSeconds(0);
            recorder.start();
            timerRef.current = setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
            setPhase('recording');
        } catch {
            streamRef.current?.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
            recorderRef.current = null;
            setPhase('denied');
        }
    };

    const stop = (): void => {
        recorderRef.current?.stop();
    };

    return { phase, elapsedSeconds, start, stop };
}
