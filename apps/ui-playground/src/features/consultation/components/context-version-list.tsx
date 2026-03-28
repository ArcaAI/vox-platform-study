import { useArca } from '@arcaai/vox';
import type { ContextVersionEntry } from '@arcaai/vox';
import { Card, CardContent } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Separator } from '@arcaai/ui/separator';
import { useEffect, useState, useCallback } from 'react';
import { formatDistanceToNow } from 'date-fns';

interface ContextVersionListProps {
  contextItemId: string;
}

export function ContextVersionList({ contextItemId }: ContextVersionListProps) {
  const { context } = useArca();
  const [versions, setVersions] = useState<ContextVersionEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadVersions = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await context.getContextVersions(contextItemId);
      setVersions(result ?? []);
    } catch {
      setVersions([]);
    } finally {
      setIsLoading(false);
    }
  }, [context, contextItemId]);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  if (isLoading) {
    return <Skeleton className="h-20 w-full" />;
  }

  if (versions.length === 0) {
    return <p className="text-muted-foreground text-sm">No version history available.</p>;
  }

  return (
    <div className="space-y-2">
      <Separator />
      <h4 className="text-sm font-medium">Version History</h4>
      {versions.map((v, i) => (
        <Card key={v.versionNumber ?? i} className="bg-muted/50">
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <Badge variant="outline" className="text-xs">
                v{v.versionNumber}
              </Badge>
              <span className="text-muted-foreground text-xs">
                {v.updatedAt ? formatDistanceToNow(new Date(v.updatedAt), { addSuffix: true }) : ''}
              </span>
            </div>
            {v.changeDescription && <p className="text-muted-foreground mt-1 text-xs italic">{v.changeDescription}</p>}
            <p className="mt-1 text-xs whitespace-pre-wrap">{v.content.length > 200 ? `${v.content.slice(0, 200)}...` : v.content}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
