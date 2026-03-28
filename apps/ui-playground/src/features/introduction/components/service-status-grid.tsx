import { useHealthCheck } from '@arcaai/vox';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Skeleton } from '@arcaai/ui/skeleton';
import { RefreshCw, Activity, Server, Mic, Brain, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect } from 'react';

const serviceIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  api: Server,
  tts: Mic,
  nlp: Brain,
  smr: FileText,
  stt: Activity,
};

const statusColors: Record<string, string> = {
  healthy: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  degraded: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  unhealthy: 'bg-red-500/15 text-red-700 dark:text-red-400',
  checking: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  idle: 'bg-muted text-muted-foreground',
};

export function ServiceStatusGrid() {
  const { status, services, lastChecked, isLoading, check, startPolling, stopPolling } = useHealthCheck();

  useEffect(() => {
    check();
    startPolling(30000);
    return () => stopPolling();
  }, []);

  const serviceEntries = Object.entries(services).filter(([name]) => name !== 'apiLive');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Badge variant="outline" className={cn(statusColors[status])}>
          {status}
        </Badge>
        <div className="flex items-center gap-2">
          {lastChecked && <span className="text-muted-foreground text-xs">Last checked: {lastChecked.toLocaleTimeString()}</span>}
          <Button variant="outline" size="sm" onClick={check} disabled={isLoading}>
            <RefreshCw className={cn('size-4', isLoading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-4">
        {isLoading && serviceEntries.length === 0
          ? Array.from({ length: 5 }).map((_, i) => (
              <Card key={i}>
                <CardHeader className="pb-2">
                  <Skeleton className="h-4 w-20" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-6 w-16" />
                </CardContent>
              </Card>
            ))
          : serviceEntries.map(([name, svc]) => {
              const Icon = serviceIcons[name] || Server;
              return (
                <Card key={name}>
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-sm font-medium capitalize">{name}</CardTitle>
                    <Icon className="text-muted-foreground size-4" />
                  </CardHeader>
                  <CardContent>
                    <Badge variant="outline" className={cn(statusColors[svc.status] || statusColors.idle)}>
                      {svc.status}
                    </Badge>
                  </CardContent>
                </Card>
              );
            })}
      </div>
    </div>
  );
}
