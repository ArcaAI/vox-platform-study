import { diffWords } from 'diff';
import { useMemo } from 'react';

import { cn } from '@/lib/utils';

interface TextDiffViewerProps {
  oldText: string;
  newText: string;
  className?: string;
}

interface DiffSegment {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export function TextDiffViewer({ oldText, newText, className }: TextDiffViewerProps) {
  const segments: DiffSegment[] = useMemo(() => diffWords(oldText, newText), [oldText, newText]);

  const hasChanges = segments.some((s) => s.added || s.removed);

  if (!hasChanges) {
    return <p className={cn('text-sm whitespace-pre-wrap', className)}>{newText}</p>;
  }

  return (
    <p className={cn('text-sm whitespace-pre-wrap leading-relaxed', className)}>
      {segments.map((segment, i) => {
        if (segment.added) {
          return (
            <mark key={i} className="rounded-sm bg-green-100 text-green-900 dark:bg-green-900/30 dark:text-green-300">
              {segment.value}
            </mark>
          );
        }
        if (segment.removed) {
          return (
            <del key={i} className="rounded-sm bg-red-100 text-red-900 line-through dark:bg-red-900/30 dark:text-red-300">
              {segment.value}
            </del>
          );
        }
        return <span key={i}>{segment.value}</span>;
      })}
    </p>
  );
}

interface DiffStatsBarProps {
  oldText: string;
  newText: string;
}

export function DiffStatsBar({ oldText, newText }: DiffStatsBarProps) {
  const stats = useMemo(() => {
    const segments = diffWords(oldText, newText);
    let additions = 0;
    let deletions = 0;
    for (const seg of segments) {
      const count = seg.count ?? 1;
      if (seg.added) additions += count;
      else if (seg.removed) deletions += count;
    }
    return { additions, deletions };
  }, [oldText, newText]);

  if (stats.additions === 0 && stats.deletions === 0) {
    return <span className="text-muted-foreground text-xs">No changes</span>;
  }

  return (
    <span className="flex items-center gap-2 text-xs">
      {stats.additions > 0 && <span className="text-green-700 dark:text-green-400">+{stats.additions}</span>}
      {stats.deletions > 0 && <span className="text-red-700 dark:text-red-400">-{stats.deletions}</span>}
      <span className="text-muted-foreground">words</span>
    </span>
  );
}
