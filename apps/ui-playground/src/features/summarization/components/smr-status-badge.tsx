import { Badge } from '@arcaai/ui/badge';
import { Skeleton } from '@arcaai/ui/skeleton';
import { useSmrHealth } from '../api';
import { Activity, AlertCircle, CheckCircle2 } from 'lucide-react';

export function SmrStatusBadge() {
  const { data: health, isLoading, isError } = useSmrHealth();

  if (isLoading) {
    return <Skeleton className="h-5 w-24 rounded-full" />;
  }

  if (isError || !health) {
    return (
      <Badge variant="destructive" className="gap-1.5 text-xs">
        <AlertCircle className="size-3" />
        SMR Offline
      </Badge>
    );
  }

  const isHealthy = health.status === 'healthy' || health.status === 'ok';

  return (
    <Badge variant={isHealthy ? 'default' : 'secondary'} className="gap-1.5 text-xs">
      {isHealthy ? (
        <CheckCircle2 className="size-3" />
      ) : (
        <Activity className="size-3" />
      )}
      SMR {isHealthy ? 'Online' : 'Degraded'}
      {health.uptime_seconds != null && (
        <span className="text-[10px] opacity-70">
          ({Math.floor(health.uptime_seconds / 3600)}h)
        </span>
      )}
    </Badge>
  );
}
