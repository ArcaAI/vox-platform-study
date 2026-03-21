"use client"

import { useState } from "react"
import { IconChevronDown, IconCopy, IconCheck, IconCode } from "@tabler/icons-react"
import { cn } from "../../lib/utils"
import { Button } from "../shadcn/button"
import { Card, CardContent, CardHeader, CardTitle } from "../shadcn/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../shadcn/collapsible"

export interface CodeExampleProps {
  title: string
  code: string
  language?: string
  defaultOpen?: boolean
  className?: string
}

export function CodeExample({
  title,
  code,
  language = "typescript",
  defaultOpen = false,
  className,
}: CodeExampleProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API may fail in non-secure contexts
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="flex w-full items-center justify-between gap-2 px-2 py-1.5"
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <IconCode className="size-4 text-muted-foreground" />
            {open ? "Hide Example Code" : "Show Example Code"}
          </span>
          <IconChevronDown
            className={cn(
              "size-4 text-muted-foreground transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              {title}
              {language && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                  {language}
                </span>
              )}
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              aria-label="Copy code"
            >
              {copied ? (
                <IconCheck className="size-3.5 text-green-500" />
              ) : (
                <IconCopy className="size-3.5" />
              )}
            </Button>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-sm font-mono">
              <code data-language={language}>{code}</code>
            </pre>
          </CardContent>
        </Card>
      </CollapsibleContent>
    </Collapsible>
  )
}
