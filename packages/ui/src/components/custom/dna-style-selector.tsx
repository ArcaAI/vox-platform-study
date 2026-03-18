import { cn } from "../../lib/utils"
import { Card, CardContent } from "../shadcn/card"
import { Button } from "../shadcn/button"
import { Badge } from "../shadcn/badge"
import { IconFingerprint, IconSparkles } from "@tabler/icons-react"

export interface DnaStyleOption {
  id: string
  name: string
  preview?: string
}

interface DnaStyleSelectorProps {
  styles: DnaStyleOption[]
  selectedStyleId?: string
  onChange: (styleId: string) => void
  onGenerate?: () => void
  isLoading?: boolean
  className?: string
}

function DnaStyleSelectorSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col gap-2 rounded-xl border p-4"
        >
          <div className="flex items-center gap-2">
            <div className="h-4 w-28 animate-pulse rounded-md bg-accent" />
            <div className="h-5 w-12 animate-pulse rounded-full bg-accent" />
          </div>
          <div className="h-4 w-full animate-pulse rounded-md bg-accent" />
          <div className="h-4 w-3/4 animate-pulse rounded-md bg-accent" />
        </div>
      ))}
    </div>
  )
}

function DnaStyleEmptyState({ onGenerate }: { onGenerate?: () => void }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-lg bg-muted">
          <IconFingerprint className="size-6 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">No DNA writing style found</p>
          <p className="text-xs text-muted-foreground">
            Generate a unique writing style based on your consultation history.
          </p>
        </div>
        {onGenerate && (
          <Button size="sm" onClick={onGenerate}>
            <IconSparkles />
            Generate DNA Style
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

export function DnaStyleSelector({
  styles,
  selectedStyleId,
  onChange,
  onGenerate,
  isLoading,
  className,
}: DnaStyleSelectorProps) {
  if (isLoading) {
    return (
      <div className={className}>
        <DnaStyleSelectorSkeleton />
      </div>
    )
  }

  if (styles.length === 0) {
    return (
      <div className={className}>
        <DnaStyleEmptyState onGenerate={onGenerate} />
      </div>
    )
  }

  return (
    <div className={cn("space-y-3", className)}>
      {styles.map((style) => {
        const isSelected = style.id === selectedStyleId

        return (
          <button
            key={style.id}
            type="button"
            onClick={() => onChange(style.id)}
            className={cn(
              "w-full cursor-pointer rounded-xl border bg-card p-4 text-left transition-colors",
              "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              isSelected && "border-primary ring-1 ring-primary/20"
            )}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{style.name}</span>
              {isSelected && <Badge variant="secondary">Active</Badge>}
            </div>
            {style.preview && (
              <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
                {style.preview}
              </p>
            )}
          </button>
        )
      })}
    </div>
  )
}
