import { Button } from '@arcaai/ui/button';
import { LiveTranscript } from '@arcaai/ui/components/live-transcript';
import { useArca } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { Loader2, Mic, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { mapTranscriptSegment, type StoreTranscriptSegment } from '@/features/live/map-segment';
import { useAppDensity } from '@/providers/density-provider';

export const Route = createFileRoute('/_authenticated/live')({
    component: LivePage,
});

function LivePage() {
    const { audio } = useArca();
    const { density } = useAppDensity();

    const [busy, setBusy] = useState(false);
    const [edits, setEdits] = useState<Record<string, string>>({});

    const segments = useMemo(
        () => audio.transcriptSegments.map((seg, index) => mapTranscriptSegment(seg as StoreTranscriptSegment, index, edits[`seg-${index}`])),
        [audio.transcriptSegments, edits],
    );

    const onToggleCapture = async () => {
        setBusy(true);
        try {
            if (audio.isCapturing) {
                await audio.stop();
            } else {
                await audio.start({ language: audio.language });
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not toggle audio capture.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            <PageHeader
                title="Live Session"
                description="Realtime transcript powered by the @arcaai/vox capture pipeline. Final and interim segments stream in; word-level timings render when the engine provides them."
                actions={
                    <Button onClick={onToggleCapture} disabled={busy} variant={audio.isCapturing ? 'destructive' : 'default'}>
                        {busy ? <Loader2 className="size-4 animate-spin" /> : audio.isCapturing ? <Square className="size-4" /> : <Mic className="size-4" />}
                        {audio.isCapturing ? 'Stop capture' : 'Start capture'}
                    </Button>
                }
            />

            <p className="mb-4 text-xs text-muted-foreground">
                Capture requests microphone access and runs the local STT pipeline. Inline edits apply to the in-view transcript; word click-to-seek is inert
                during a live session (there is no seekable recording yet).
            </p>

            <LiveTranscript
                aria-label="Live consultation transcript"
                segments={segments}
                interim={audio.currentTranscript}
                isListening={audio.isCapturing}
                showWords
                showTimestamps
                showSpeakers
                showConfidence
                editable
                editingPolicy="final-only"
                onEditSegment={(id, text) => setEdits((prev) => ({ ...prev, [id]: text }))}
                autoScroll
                density={density}
                error={audio.error ?? undefined}
                height={560}
            />
        </div>
    );
}
