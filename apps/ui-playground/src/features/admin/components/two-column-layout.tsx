import { cn } from '@/lib/utils';
import { ScrollArea } from '@arcaai/ui/scroll-area';

interface TwoColumnLayoutProps {
  leftPanel: React.ReactNode;
  rightPanel: React.ReactNode;
  leftWidthPx?: number;
  className?: string;
}

export function TwoColumnLayout({ leftPanel, rightPanel, leftWidthPx = 320, className }: TwoColumnLayoutProps) {
  return (
    <div className={cn('flex min-h-[600px] flex-col overflow-hidden rounded-lg border md:flex-row', className)}>
      <div className="w-full shrink-0 border-b md:w-auto md:border-b-0 md:border-r" style={{ width: leftWidthPx, maxWidth: '100%' }}>
        <ScrollArea className="h-full max-h-[300px] md:max-h-[calc(100vh-200px)]">{leftPanel}</ScrollArea>
      </div>
      <div className="min-w-0 flex-1">
        <ScrollArea className="h-full max-h-[calc(100vh-200px)]">{rightPanel}</ScrollArea>
      </div>
    </div>
  );
}
