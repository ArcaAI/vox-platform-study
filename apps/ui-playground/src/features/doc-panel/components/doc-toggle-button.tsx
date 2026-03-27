import { cn } from '@/lib/utils';
import { Button } from '@arcaai/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui/tooltip';
import { BookOpen, BookOpenCheck } from 'lucide-react';
import { useDocPanelStore } from '../store/doc-panel-store';

interface DocToggleButtonProps {
  className?: string;
}

export function DocToggleButton({ className }: DocToggleButtonProps) {
  const isOpen = useDocPanelStore((s) => s.isOpen);
  const setOpen = useDocPanelStore((s) => s.setOpen);

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={isOpen ? 'default' : 'ghost'}
            size="icon"
            className={cn('rounded-full', className)}
            onClick={() => setOpen(!isOpen)}
            aria-expanded={isOpen}
            aria-controls="doc-panel"
            aria-label={isOpen ? 'Close documentation' : 'Open documentation'}
            title={isOpen ? 'Close documentation' : 'Open documentation'}
          >
            {isOpen ? <BookOpenCheck data-icon="inline-start" className="size-4" /> : <BookOpen data-icon="inline-start" className="size-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{isOpen ? 'Close documentation' : 'Open documentation'}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
