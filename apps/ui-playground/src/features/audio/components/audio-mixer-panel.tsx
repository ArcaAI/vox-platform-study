import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Button } from '@arcaai/ui/button';
import { Badge } from '@arcaai/ui/badge';
import { Slider } from '@arcaai/ui/slider';
import { useAudioStore, type MicrophoneSource } from '@/store/audio-store';
import { AudioLines, Volume2, VolumeX, Play, Square } from 'lucide-react';
import { useCallback } from 'react';
import { toast } from 'sonner';

export function AudioMixerPanel() {
  const { sources, sourceType, isMixing, isCapturing, setMixing, setMixedStream, updateMicrophoneSource } = useAudioStore();

  const micSources = sources.filter((s): s is MicrophoneSource => s.type === 'microphone');

  const startMixing = useCallback(async () => {
    if (micSources.length < 2) {
      toast.warning('Add at least 2 microphone sources to mix');
      return;
    }
    if (isCapturing) {
      toast.warning('Stop capturing before changing mixer settings');
      return;
    }

    setMixedStream(null);
    setMixing(true);
    toast.success('Mixer armed. It will access microphones only when recording starts.');
  }, [micSources, isCapturing, setMixedStream, setMixing]);

  const stopMixing = useCallback(
    (options?: { silent?: boolean }) => {
      setMixedStream(null);
      setMixing(false);
      if (!options?.silent) {
        toast.info('Mixer stopped');
      }
    },
    [setMixedStream, setMixing],
  );

  const handleGainChange = useCallback(
    (id: string, gain: number) => {
      updateMicrophoneSource(id, { gain });
    },
    [updateMicrophoneSource],
  );

  const handleMuteToggle = useCallback(
    (id: string, currentMuted: boolean) => {
      updateMicrophoneSource(id, { muted: !currentMuted });
    },
    [updateMicrophoneSource],
  );

  if (sourceType !== 'microphone' || micSources.length < 2) return null;

  const activeCount = micSources.filter((s) => !s.muted).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AudioLines className="size-4" />
            <CardTitle className="text-sm">Audio Mixer</CardTitle>
            {isMixing && (
              <Badge variant="default" className="animate-pulse gap-1 text-[10px]">
                Mixing
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {activeCount}/{micSources.length} active
            </Badge>
            {!isMixing ? (
              <Button size="sm" onClick={startMixing} className="h-7 gap-1 text-xs" disabled={isCapturing}>
                <Play className="size-3" /> Mix
              </Button>
            ) : (
              <Button variant="destructive" size="sm" onClick={() => stopMixing()} className="h-7 gap-1 text-xs" disabled={isCapturing}>
                <Square className="size-3" /> Stop
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {micSources.map((src) => (
            <div key={src.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
              <button type="button" onClick={() => handleMuteToggle(src.id, src.muted)} className="shrink-0" disabled={isCapturing}>
                {src.muted ? <VolumeX className="size-4 text-red-500" /> : <Volume2 className="text-muted-foreground size-4" />}
              </button>
              <span className="min-w-0 flex-1 truncate text-xs">{src.label}</span>
              <div className="flex w-28 items-center gap-2">
                <Slider
                  value={[src.gain * 100]}
                  onValueChange={([val]) => handleGainChange(src.id, val / 100)}
                  min={0}
                  max={200}
                  step={5}
                  disabled={src.muted}
                  className="flex-1"
                />
                <span className="text-muted-foreground w-8 text-right text-[10px] tabular-nums">{(src.gain * 100).toFixed(0)}%</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
