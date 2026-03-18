import {
  IconActivity,
  IconAlertCircle,
  IconHelpCircle,
  IconLoader2,
  IconRefresh,
  IconServer,
  IconWifi,
} from "@tabler/icons-react"

import { cn } from "../../lib/utils"

export interface ServiceHealth {
  name: string
  status: "healthy" | "degraded" | "down" | "unknown"
  latency?: number
}

export interface ServiceStatusBarProps {
  services?: ServiceHealth[]
  activeSessions?: number
  processingJobs?: number
  isLoading?: boolean
  onRefresh?: () => void
  className?: string
}

const statusConfig = {
  healthy: {
    label: "Operational",
    dotClass: "bg-emerald-500",
    pulseClass: "animate-pulse bg-emerald-500/40",
    textClass: "text-emerald-700 dark:text-emerald-400",
    bgClass: "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900",
    icon: null,
  },
  degraded: {
    label: "Degraded",
    dotClass: "bg-amber-500",
    pulseClass: "animate-pulse bg-amber-500/40",
    textClass: "text-amber-700 dark:text-amber-400",
    bgClass: "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900",
    icon: IconAlertCircle,
  },
  down: {
    label: "Offline",
    dotClass: "bg-red-500",
    pulseClass: "",
    textClass: "text-red-700 dark:text-red-400",
    bgClass: "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900",
    icon: IconAlertCircle,
  },
  unknown: {
    label: "Unknown",
    dotClass: "bg-muted-foreground",
    pulseClass: "",
    textClass: "text-muted-foreground",
    bgClass: "bg-muted/50 border-border",
    icon: IconHelpCircle,
  },
} as const

function StatusIndicator({ status }: { status: ServiceHealth["status"] }) {
  const config = statusConfig[status] ?? statusConfig.unknown
  return (
    <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
      {config.pulseClass && (
        <span
          className={cn(
            "absolute inline-flex size-full rounded-full",
            config.pulseClass
          )}
        />
      )}
      <span
        className={cn(
          "relative inline-flex size-2.5 rounded-full",
          config.dotClass
        )}
      />
    </span>
  )
}

export function ServiceStatusBar({
  services,
  activeSessions = 0,
  processingJobs = 0,
  isLoading = false,
  onRefresh,
  className,
}: ServiceStatusBarProps) {
  if (isLoading) {
    return (
      <div
        data-slot="service-status-bar"
        className={cn(
          "flex items-center justify-center rounded-lg border px-4 py-3",
          className
        )}
      >
        <IconLoader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">
          Checking services…
        </span>
      </div>
    )
  }

  if (!services || services.length === 0) {
    return (
      <div
        data-slot="service-status-bar"
        className={cn(
          "flex items-center gap-2 rounded-lg border px-4 py-3 text-sm text-muted-foreground",
          className
        )}
      >
        <IconServer className="size-4 shrink-0" />
        No service data available
      </div>
    )
  }

  return (
    <div data-slot="service-status-bar" className={cn("space-y-3", className)}>
      <div className="grid gap-2 sm:grid-cols-2">
        {services.map((service) => {
          const config = statusConfig[service.status] ?? statusConfig.unknown
          const Icon = config.icon
          return (
            <div
              key={service.name}
              className={cn(
                "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                config.bgClass
              )}
            >
              <StatusIndicator status={service.status} />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{service.name}</span>
                <div className={cn("flex items-center gap-1 text-xs", config.textClass)}>
                  {Icon && <Icon className="size-3 shrink-0" />}
                  <span>{config.label}</span>
                  {service.latency != null && (
                    <span className="ml-1 text-muted-foreground">
                      · {service.latency}ms
                    </span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <IconWifi className="size-3.5 shrink-0" />
          {activeSessions} active session{activeSessions !== 1 ? "s" : ""}
        </span>
        <span className="flex items-center gap-1.5">
          <IconActivity className="size-3.5 shrink-0" />
          {processingJobs} processing
        </span>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            aria-label="Refresh service status"
          >
            <IconRefresh className="size-3" />
            Refresh
          </button>
        )}
      </div>
    </div>
  )
}
