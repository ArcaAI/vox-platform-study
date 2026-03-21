import { IconMicrophone, IconMicrophoneOff, IconBroadcast } from "@tabler/icons-react"

import { cn } from "../../lib/utils"

export interface AudioMeterProps {
  level: number
  isCapturing: boolean
  isSpeaking: boolean
  isMuted: boolean
  className?: string
}

function levelColor(level: number) {
  if (level <= 40) return "bg-green-500"
  if (level <= 70) return "bg-yellow-500"
  return "bg-red-500"
}

export function AudioMeter({
  level,
  isCapturing,
  isSpeaking,
  isMuted,
  className,
}: AudioMeterProps) {
  const clamped = Math.max(0, Math.min(100, level))

  return (
    <div
      data-slot="audio-meter"
      className={cn("flex items-center gap-3", className)}
    >
      <div className="flex shrink-0 items-center gap-2">
        {isCapturing && (
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-pulse rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
          </span>
        )}

        {isSpeaking && (
          <IconBroadcast className="size-4 text-primary" />
        )}

        {isMuted ? (
          <IconMicrophoneOff className="size-4 text-destructive" />
        ) : (
          <IconMicrophone className="size-4 text-muted-foreground" />
        )}
      </div>

      <div
        role="meter"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Audio level"
        className="relative h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-primary/20"
      >
        <div
          className={cn(
            "h-full transition-all duration-150 ease-out",
            levelColor(clamped),
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}
