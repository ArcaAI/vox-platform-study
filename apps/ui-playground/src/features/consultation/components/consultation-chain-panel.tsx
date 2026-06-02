import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent } from '@arcaai/ui/card';
import { Skeleton } from '@arcaai/ui/skeleton';
import { useConsultationChain } from '@arcaai/vox';
import type { Consultation } from '@arcaai/vox';
import { format } from 'date-fns';
import { AlertCircle, ArrowRight, GitBranch, Link2, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';

interface ConsultationChainPanelProps {
  consultationId: string;
  /** Navigate to another consultation in the chain (router-agnostic for testability). */
  onOpen?: (consultationId: string) => void;
}

function getStatus(c: Consultation): string | undefined {
  if (c.status) return c.status;
  const meta = c.metadata as Record<string, unknown> | undefined;
  return (meta?.status as string) ?? undefined;
}

/**
 * Chain tab (TASK-329 P2) — surfaces the full multi-hop consultation chain
 * (structural root + every descendant) returned by the server walk, so linked
 * re-visits / referrals are reachable from the consultation surface.
 */
export function ConsultationChainPanel({ consultationId, onOpen }: ConsultationChainPanelProps) {
  const { chain, isLoading, error, fetchChain } = useConsultationChain();

  useEffect(() => {
    void fetchChain(consultationId);
  }, [consultationId, fetchChain]);

  if (isLoading && chain.length === 0) {
    return (
      <div className="space-y-3" data-doc="consultation-chain-loading">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/50">
        <CardContent className="flex items-center gap-3 p-4">
          <AlertCircle className="text-destructive size-5 shrink-0" />
          <p className="text-destructive text-sm">{error.message}</p>
          <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={() => void fetchChain(consultationId)}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const isLinked = chain.length > 1;

  return (
    <div className="space-y-4" data-doc="consultation-chain">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitBranch className="text-muted-foreground size-4" />
          <h3 className="text-sm font-medium">Consultation Chain</h3>
          <Badge variant="outline" className="text-xs">
            {chain.length} linked
          </Badge>
        </div>
        <Button variant="outline" size="sm" onClick={() => void fetchChain(consultationId)} disabled={isLoading}>
          <RefreshCw className="mr-1 size-3.5" />
          Refresh
        </Button>
      </div>

      {!isLinked ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Link2 className="text-muted-foreground mb-4 size-10" />
            <h3 className="mb-1 text-lg font-medium">No linked consultations</h3>
            <p className="text-muted-foreground max-w-sm text-center text-sm">
              This consultation is not part of a chain. Re-visits or referrals that reference it will appear here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ol className="space-y-2" data-doc="consultation-chain-list">
          {chain.map((c, index) => {
            const isCurrent = c.id === consultationId;
            const status = getStatus(c);
            return (
              <li key={c.id}>
                <Card className={isCurrent ? 'border-primary' : undefined}>
                  <CardContent className="flex items-center gap-3 p-3">
                    <div className="text-muted-foreground flex size-6 shrink-0 items-center justify-center text-xs font-medium">{index + 1}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{c.patientId || c.id.slice(0, 8)}</span>
                        {isCurrent && (
                          <Badge variant="default" className="text-[10px]">
                            Current
                          </Badge>
                        )}
                        {status && (
                          <Badge variant="outline" className="text-[10px]">
                            {status}
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {c.createdAt ? format(new Date(c.createdAt), 'MMM d, yyyy HH:mm') : 'Unknown date'}
                        <span className="ml-1 font-mono">· {c.id.slice(0, 8)}</span>
                      </p>
                    </div>
                    {!isCurrent && onOpen && (
                      <Button variant="ghost" size="sm" className="shrink-0" onClick={() => onOpen(c.id)} data-doc="consultation-chain-open">
                        Open
                        <ArrowRight className="ml-1 size-3.5" />
                      </Button>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
