import { Button } from '@arcaai/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui/tooltip';
import { usePlaygroundStore } from '@/store/playground-store';
import { Bug, BugOff } from 'lucide-react';

export function DebugToggle() {
  const debugMode = usePlaygroundStore((s) => s.debugMode);
  const setDebugMode = usePlaygroundStore((s) => s.setDebugMode);

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant={debugMode ? 'default' : 'ghost'} size="icon" className="scale-95 rounded-full" onClick={() => setDebugMode(!debugMode)}>
            {debugMode ? <Bug className="size-[1.2rem]" /> : <BugOff className="size-[1.2rem]" />}
            <span className="sr-only">{debugMode ? 'Disable debug mode' : 'Enable debug mode'}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {debugMode ? 'Debug mode ON — audio config & transcripts logged to console' : 'Enable debug mode'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
