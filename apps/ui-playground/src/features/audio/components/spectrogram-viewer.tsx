import { useEffect, useRef, useState } from 'react';
import { Button } from '@arcaai/ui/button';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Play, Pause } from 'lucide-react';

interface SpectrogramViewerProps {
  audioUrl: string;
  label: string;
  applyFilter?: boolean;
}

export function SpectrogramViewer({ audioUrl, label, applyFilter }: SpectrogramViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const animationRef = useRef<number>(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const columnRef = useRef(0);

  const startVisualization = async () => {
    if (!canvasRef.current) return;

    setIsLoadingAudio(true);
    try {
      const ctx = new AudioContext();
      audioContextRef.current = ctx;

      const response = await fetch(audioUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch audio: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      setIsLoadingAudio(false);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      sourceRef.current = source;

      if (applyFilter) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 8000;
        source.connect(filter);
        filter.connect(analyser);
      } else {
        source.connect(analyser);
      }

      analyser.connect(ctx.destination);
      source.start();
      setIsPlaying(true);
      columnRef.current = 0;

      source.onended = () => {
        setIsPlaying(false);
        cancelAnimationFrame(animationRef.current);
      };

      drawSpectrogram();
    } catch (error) {
      setIsLoadingAudio(false);
      console.error('Failed to load audio:', error);
    }
  };

  const drawSpectrogram = () => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      const col = columnRef.current % canvas.width;
      const sliceHeight = canvas.height / bufferLength;

      for (let i = 0; i < bufferLength; i++) {
        const value = dataArray[i];
        const hue = 240 - (value / 255) * 240;
        canvasCtx.fillStyle = `hsl(${hue}, 100%, ${20 + (value / 255) * 60}%)`;
        canvasCtx.fillRect(col, canvas.height - i * sliceHeight, 1, sliceHeight);
      }

      columnRef.current++;
    };

    draw();
  };

  const stop = () => {
    sourceRef.current?.stop();
    audioContextRef.current?.close();
    cancelAnimationFrame(animationRef.current);
    setIsPlaying(false);
  };

  useEffect(() => {
    return () => {
      cancelAnimationFrame(animationRef.current);
      audioContextRef.current?.close();
    };
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <canvas ref={canvasRef} width={600} height={200} className="bg-muted w-full rounded-lg" />
        {isLoadingAudio && <Skeleton className="absolute inset-0 rounded-lg" />}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={isLoadingAudio} onClick={isPlaying ? stop : startVisualization}>
          {isPlaying ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
          {isPlaying ? 'Stop' : `Play ${label}`}
        </Button>
      </div>
    </div>
  );
}
