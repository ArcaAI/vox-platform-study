import { Matrix, digits, loader, pulse, wave } from '../../../elevenlabs/matrix';

export function StaticMatrix({
  className,
  ariaLabel,
  size,
  gap,
  mode,
  levels,
}: {
  className?: string;
  ariaLabel?: string;
  size?: number;
  gap?: number;
  mode?: 'default' | 'vu';
  levels?: number[];
}) {
  return (
    <Matrix rows={7} cols={5} pattern={digits[0]} className={className} ariaLabel={ariaLabel} size={size} gap={gap} mode={mode} levels={levels} />
  );
}

export function AnimatedMatrix() {
  return <Matrix rows={7} cols={7} frames={loader} />;
}

export function SmallGridMatrix() {
  return (
    <Matrix
      rows={3}
      cols={3}
      pattern={[
        [1, 0, 1],
        [0, 1, 0],
        [1, 0, 1],
      ]}
    />
  );
}

export function DefaultModeMatrix() {
  return <Matrix rows={7} cols={5} pattern={digits[0]} mode="default" />;
}

export function VuModeMatrix() {
  return <Matrix rows={7} cols={5} mode="vu" levels={[0.2, 0.5, 0.8, 1.0, 0.6]} />;
}

export function PulseMatrix() {
  return <Matrix rows={7} cols={7} frames={pulse} />;
}

export function WaveMatrix() {
  return <Matrix rows={7} cols={7} frames={wave} />;
}

export function CssVarsMatrix() {
  return <Matrix rows={7} cols={5} pattern={digits[0]} size={12} gap={3} />;
}
