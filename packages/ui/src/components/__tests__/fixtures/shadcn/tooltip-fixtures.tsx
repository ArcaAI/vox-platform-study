import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '../../../shadcn/tooltip'
import { Button } from '../../../shadcn/button'

export function BasicTooltip() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button>Hover me</Button>
        </TooltipTrigger>
        <TooltipContent>Tooltip content</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function TooltipWithDelay({ delay = 500 }: { delay?: number }) {
  return (
    <TooltipProvider delayDuration={delay}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button>Hover me</Button>
        </TooltipTrigger>
        <TooltipContent>Delayed tooltip</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function OpenTooltip() {
  return (
    <TooltipProvider>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Button>Trigger</Button>
        </TooltipTrigger>
        <TooltipContent>Open tooltip</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
