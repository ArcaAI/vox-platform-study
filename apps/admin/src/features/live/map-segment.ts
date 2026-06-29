import type { LiveTranscriptSegment, LiveTranscriptWord } from '@arcaai/ui/components/live-transcript';

/**
 * Structural shape of the SDK store's `TranscriptSegment` (types/audio.ts). Kept
 * local so this mapper stays a pure, testable function without importing the
 * heavy SDK barrel.
 */
export interface StoreTranscriptSegment {
    text: string;
    startTime: number;
    endTime: number;
    isFinal: boolean;
    speakerLabel?: string;
    confidence?: number;
    language?: string;
    words?: { word: string; start: number; end: number; confidence?: number | null }[];
}

/**
 * Adapt a store `TranscriptSegment` → `LiveTranscriptSegment`. Word-level timings
 * pass straight through `wordTimestamps` so the component renders words whether
 * they arrive via the store (D9 Option B, already plumbed in `useArcaAudio`) or
 * via `SttV2WebSocketClient.onTranscript` — both share this superset shape.
 */
export function mapTranscriptSegment(seg: StoreTranscriptSegment, index: number, overrideText?: string): LiveTranscriptSegment {
    const wordTimestamps: LiveTranscriptWord[] | undefined = seg.words?.map((w) => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence ?? null,
    }));

    return {
        id: `seg-${index}`,
        text: overrideText ?? seg.text,
        startTime: seg.startTime,
        endTime: seg.endTime,
        isFinal: seg.isFinal,
        speakerLabel: seg.speakerLabel,
        confidence: seg.confidence,
        language: seg.language,
        wordTimestamps: wordTimestamps && wordTimestamps.length > 0 ? wordTimestamps : undefined,
    };
}
