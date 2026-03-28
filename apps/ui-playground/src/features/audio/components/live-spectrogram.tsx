import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface LiveSpectrogramProps {
  stream: MediaStream | null;
  active: boolean;
  label?: string;
  className?: string;
}

export function LiveSpectrogram({ stream, active, label = 'Live Spectrogram', className }: LiveSpectrogramProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context2d = canvas.getContext('2d');
    if (!context2d) return;

    context2d.fillStyle = '#0b1220';
    context2d.fillRect(0, 0, canvas.width, canvas.height);

    if (!active || !stream) {
      return;
    }

    const audioContext = new AudioContext();
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.85;
    sourceNode.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let frameId = 0;
    let x = 0;

    const draw = () => {
      frameId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);

      for (let i = 0; i < data.length; i++) {
        const value = data[i] ?? 0;
        const normalized = value / 255;
        const hue = 250 - normalized * 220;
        const lightness = 12 + normalized * 58;
        context2d.fillStyle = `hsl(${hue}, 95%, ${lightness}%)`;
        const y = canvas.height - Math.floor((i / data.length) * canvas.height);
        context2d.fillRect(x, y, 1, 2);
      }

      x = (x + 1) % canvas.width;
      context2d.fillStyle = 'rgba(11, 18, 32, 0.2)';
      context2d.fillRect(x, 0, 2, canvas.height);
    };

    draw();

    return () => {
      cancelAnimationFrame(frameId);
      sourceNode.disconnect();
      analyser.disconnect();
      audioContext.close().catch(() => {});
    };
  }, [active, stream]);

  return (
    <div className={cn('rounded-lg border bg-muted/30 p-2', className)}>
      <p className="text-muted-foreground mb-2 text-[10px] font-medium">{label}</p>
      <canvas ref={canvasRef} width={640} height={180} className="bg-background h-36 w-full rounded-md" />
    </div>
  );
}
