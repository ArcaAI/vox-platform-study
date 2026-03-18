"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { IconAlertCircle, IconRefresh, IconCircleCheck, IconCircleX, IconClock, IconHourglass } from "@tabler/icons-react"

import { cn } from "../../lib/utils"
import { Alert, AlertTitle, AlertDescription } from "../shadcn/alert"
import { Badge } from "../shadcn/badge"
import { Progress } from "../shadcn/progress"

export interface AsyncJob {
  jobId: string
  status: "pending" | "processing" | "completed" | "failed"
  progress?: number
  result?: unknown
  error?: string
  estimatedMs?: number
}

export interface AsyncJobTrackerProps {
  jobId: string | null
  pollFn: (jobId: string) => Promise<AsyncJob>
  pollIntervalMs?: number
  onComplete?: (result: unknown) => void
  onError?: (error: string) => void
  className?: string
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

const statusConfig = {
  pending: {
    icon: IconClock,
    iconClass: "text-muted-foreground",
    badgeVariant: "secondary" as const,
    label: "Pending",
  },
  processing: {
    icon: IconRefresh,
    iconClass: "text-muted-foreground animate-spin",
    badgeVariant: "secondary" as const,
    label: "Processing",
  },
  completed: {
    icon: IconCircleCheck,
    iconClass: "text-foreground",
    badgeVariant: "default" as const,
    label: "Completed",
  },
  failed: {
    icon: IconCircleX,
    iconClass: "text-destructive",
    badgeVariant: "destructive" as const,
    label: "Failed",
  },
} as const

export function AsyncJobTracker({
  jobId,
  pollFn,
  pollIntervalMs = 2000,
  onComplete,
  onError,
  className,
}: AsyncJobTrackerProps) {
  const [job, setJob] = useState<AsyncJob | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const pollRef = useRef<ReturnType<typeof setInterval>>(null)
  const timerRef = useRef<ReturnType<typeof setInterval>>(null)
  const startTimeRef = useRef<number>(0)
  const completedRef = useRef(false)
  const pollFnRef = useRef(pollFn)
  const onCompleteRef = useRef(onComplete)
  const onErrorRef = useRef(onError)

  useEffect(() => { pollFnRef.current = pollFn }, [pollFn])
  useEffect(() => { onCompleteRef.current = onComplete }, [onComplete])
  useEffect(() => { onErrorRef.current = onError }, [onError])

  const clearTimers = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!jobId) {
      clearTimers()
      setJob(null)
      setElapsedMs(0)
      completedRef.current = false
      return
    }

    completedRef.current = false
    startTimeRef.current = Date.now()
    setElapsedMs(0)
    setJob(null)

    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current)
    }, 1000)

    const poll = async () => {
      if (completedRef.current) return
      try {
        const result = await pollFnRef.current(jobId)
        setJob(result)

        if (result.status === "completed") {
          completedRef.current = true
          clearTimers()
          onCompleteRef.current?.(result.result)
        } else if (result.status === "failed") {
          completedRef.current = true
          clearTimers()
          onErrorRef.current?.(result.error ?? "Job failed")
        }
      } catch {
        // Silently retry on next poll interval
      }
    }

    poll()
    pollRef.current = setInterval(poll, pollIntervalMs)

    return clearTimers
  }, [jobId, pollIntervalMs, clearTimers])

  if (!jobId) return null

  const status = job?.status ?? "pending"
  const config = statusConfig[status] ?? statusConfig.pending
  const StatusIcon = config.icon

  const remainingMs =
    job?.estimatedMs != null ? Math.max(0, job.estimatedMs - elapsedMs) : null

  return (
    <div
      data-slot="async-job-tracker"
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-4",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusIcon className={cn("size-4", config.iconClass)} />
          <Badge variant={config.badgeVariant}>
            {config.label}
          </Badge>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <IconClock className="size-3" />
            {formatElapsed(elapsedMs)}
          </span>
          {remainingMs != null && status === "processing" && (
            <span className="flex items-center gap-1">
              <IconHourglass className="size-3" />
              ~{formatElapsed(remainingMs)} left
            </span>
          )}
        </div>
      </div>

      {job?.progress != null && status === "processing" && (
        <div className="flex flex-col gap-1">
          <Progress value={job.progress} />
          <span className="text-right text-xs text-muted-foreground">
            {Math.round(job.progress)}%
          </span>
        </div>
      )}

      {status === "failed" && job?.error && (
        <Alert variant="destructive">
          <IconAlertCircle className="size-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{job.error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
