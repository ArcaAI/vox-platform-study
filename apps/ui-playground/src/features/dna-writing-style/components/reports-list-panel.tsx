import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Skeleton } from '@arcaai/ui/skeleton';
import { CheckCircle2, Dna, Loader2, Star } from 'lucide-react';

import type { DnaReport } from '../api/dna-writing-styles';

function relativeTime(dateStr?: string | null): string {
  if (!dateStr) return '—';
  const ms = Date.now() - new Date(dateStr).getTime();
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (day > 30) return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (day >= 1) return rtf.format(-day, 'day');
  if (hr >= 1) return rtf.format(-hr, 'hour');
  if (min >= 1) return rtf.format(-min, 'minute');
  return rtf.format(-sec, 'second');
}

export interface ReportsListPanelProps {
  reports: DnaReport[];
  isLoading: boolean;
  onSetDefault: (reportId: string) => void;
  settingDefaultId?: string | null;
}

/**
 * TASK-329 P5 — Lists the doctor's DNA reports and lets them pick which one is
 * the active/default (`isLatest`). The default report carries a badge; every
 * other report exposes a "Set as default" action.
 */
export function ReportsListPanel({ reports, isLoading, onSetDefault, settingDefaultId }: ReportsListPanelProps) {
  return (
    <Card data-doc="dna-reports-list-panel">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Dna className="size-4" aria-hidden="true" />
          My DNA Reports
        </CardTitle>
        <CardDescription>Choose which generated report is your active writing style.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : reports.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Dna className="text-muted-foreground/50 mb-2 size-8" aria-hidden="true" />
            <p className="text-muted-foreground text-sm">No reports yet. Generate a writing style to get started.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {reports.map((report) => {
              const isDefault = report.isLatest;
              const isPending = settingDefaultId === report.id;
              return (
                <li
                  key={report.id}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                  data-testid={`dna-report-row-${report.id}`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono text-xs">
                        v{report.currentVersionNumber}
                      </Badge>
                      {isDefault && (
                        <Badge variant="default" className="gap-1 text-[10px]" data-testid={`dna-default-badge-${report.id}`}>
                          <Star className="size-2.5" />
                          Default
                        </Badge>
                      )}
                    </div>
                    {report.styleText && <p className="text-muted-foreground mt-1 line-clamp-1 text-xs">{report.styleText}</p>}
                    <p className="text-muted-foreground/70 mt-0.5 text-[11px]">Updated {relativeTime(report.updatedAt)}</p>
                  </div>
                  {isDefault ? (
                    <span className="text-muted-foreground flex items-center gap-1 text-xs">
                      <CheckCircle2 className="size-3.5 text-green-600" />
                      Active
                    </span>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => onSetDefault(report.id)} disabled={isPending}>
                      {isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Star className="mr-1.5 size-3.5" />}
                      Set as default
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
