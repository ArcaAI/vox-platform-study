"use client"

import { cn } from "../../lib/utils"
import { IconCpu, IconCloud } from "@tabler/icons-react"

export type WorkflowMode = "local" | "remote"

export interface WorkflowToggleProps {
  mode: WorkflowMode
  onChange: (mode: WorkflowMode) => void
  localContent?: React.ReactNode
  remoteContent?: React.ReactNode
  className?: string
}

const options: { value: WorkflowMode; label: string; icon: typeof IconCpu; description: string }[] = [
  {
    value: "local",
    label: "Local Processing",
    icon: IconCpu,
    description: "Client-side AI models for on-device data processing",
  },
  {
    value: "remote",
    label: "Remote Processing",
    icon: IconCloud,
    description: "Server-side pipeline managed by tenant administrator",
  },
]

export function WorkflowToggle({
  mode,
  onChange,
  localContent,
  remoteContent,
  className,
}: WorkflowToggleProps) {
  return (
    <div className={cn("space-y-4", className)} role="radiogroup" aria-label="Workflow mode">
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((opt) => {
          const selected = mode === opt.value
          const Icon = opt.icon
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected ? "true" : "false"}
              onClick={() => onChange(opt.value)}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                selected
                  ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                  : "border-border hover:border-muted-foreground/30 hover:bg-muted/50"
              )}
            >
              <div
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                  selected ? "border-primary" : "border-muted-foreground/40"
                )}
              >
                {selected && <div className="size-2 rounded-full bg-primary" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <Icon className={cn("size-3.5 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />
                  <span className={cn("text-sm font-medium", selected && "text-primary")}>{opt.label}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{opt.description}</p>
              </div>
            </button>
          )
        })}
      </div>

      {mode === "local" && localContent && (
        <div className="rounded-lg border bg-muted/30 p-4">{localContent}</div>
      )}

      {mode === "remote" && remoteContent && (
        <div className="rounded-lg border bg-muted/30 p-4">{remoteContent}</div>
      )}
    </div>
  )
}
