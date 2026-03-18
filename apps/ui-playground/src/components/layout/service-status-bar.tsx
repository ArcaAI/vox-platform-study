import { useHealthCheck } from '@arcaai/vox';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Server, Mic, Brain, FileText, Activity } from 'lucide-react';
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

export function ServiceStatusBar() {
    const { services, isLoading, check, startPolling, stopPolling } = useHealthCheck();

    useEffect(() => {
        check();
        startPolling(30000);
        return () => stopPolling();
    }, []);

    const serviceEntries = Object.entries(services).filter(([name]) => name !== 'apiLive');

    return (
        <div className="grid grid-cols-5 gap-3">
            {isLoading && serviceEntries.length === 0
                ? Array.from({ length: 5 }).map((_, i) => (
                      <Card key={i} className="py-3">
                          <CardContent className="flex items-center justify-between px-4 py-0">
                              <Skeleton className="h-4 w-14" />
                              <Skeleton className="h-5 w-12" />
                          </CardContent>
                      </Card>
                  ))
                : serviceEntries.map(([name, svc]) => {
                      const Icon = serviceIcons[name] || Server;
                      return (
                          <Card key={name} className="py-3">
                              <CardContent className="flex items-center justify-between px-4 py-0">
                                  <div className="flex items-center gap-2">
                                      <Icon className="text-muted-foreground size-3.5" />
                                      <span className="text-sm font-medium capitalize">{name}</span>
                                  </div>
                                  <Badge
                                      variant="outline"
                                      className={cn('text-xs', statusColors[svc.status] || statusColors.idle)}
                                  >
                                      {svc.status}
                                  </Badge>
                              </CardContent>
                          </Card>
                      );
                  })}
        </div>
    );
}
