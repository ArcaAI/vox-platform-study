import { useMemo, useState } from 'react';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Skeleton } from '@arcaai/ui/skeleton';
import { CheckCircle2, Circle, History, Loader2, Wand2 } from 'lucide-react';

import type { DnaStyleVersion } from '../api/dna-writing-styles';

export interface GenerateFromHistoryPanelProps {
  versions: DnaStyleVersion[];
  isLoading: boolean;
  isGenerating: boolean;
  onGenerate: (selected: DnaStyleVersion[]) => void;
}

/**
 * TASK-329 P5 — Generate-from-history.
 *
 * Lets the doctor cherry-pick prior report-version snapshots as the learning
 * corpus and kick off a brand-new generation seeded from that selection. The
 * selected versions' text is sent as `textSamples` and their IDs as
 * `sourceIds` (persisted for explainability).
 */
export function GenerateFromHistoryPanel({ versions, isLoading, isGenerating, onGenerate }: GenerateFromHistoryPanelProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const selectableVersions = useMemo(() => versions.filter((v) => (v.styleText ?? '').trim().length > 0), [versions]);

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleGenerate = () => {
    const selected = selectableVersions.filter((v) => selectedIds.has(v.id));
    if (selected.length === 0) return;
    onGenerate(selected);
  };

  return (
    <Card data-doc="dna-generate-from-history">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4" aria-hidden="true" />
          Generate from History
        </CardTitle>
        <CardDescription>Select prior version snapshots to seed a fresh writing-style report.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : selectableVersions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <History className="text-muted-foreground/50 mb-2 size-7" aria-hidden="true" />
            <p className="text-muted-foreground text-sm">No historical snapshots with content to select yet.</p>
          </div>
        ) : (
          <ScrollArea className="max-h-56 pr-3">
            <ul className="space-y-2">
              {selectableVersions.map((version) => {
                const checked = selectedIds.has(version.id);
                return (
                  <li key={version.id}>
                    <button
                      type="button"
                      onClick={() => toggle(version.id)}
                      aria-pressed={checked}
                      data-testid={`history-item-${version.id}`}
                      className={`flex w-full items-start gap-2 rounded-lg border p-2.5 text-left transition-colors ${
                        checked ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'
                      }`}
                    >
                      <span className="mt-0.5 shrink-0">
                        {checked ? <CheckCircle2 className="size-4 text-primary" /> : <Circle className="text-muted-foreground size-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono text-[10px]">
                            v{version.versionNumber}
                          </Badge>
                          {version.changeReason && <span className="text-muted-foreground truncate text-xs italic">{version.changeReason}</span>}
                        </span>
                        <span className="text-muted-foreground mt-1 block line-clamp-2 text-xs">{version.styleText}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}

        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground text-xs">{selectedIds.size} selected</span>
          <Button onClick={handleGenerate} disabled={selectedIds.size === 0 || isGenerating}>
            {isGenerating ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Wand2 className="mr-2 size-4" />}
            Generate from selected
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
