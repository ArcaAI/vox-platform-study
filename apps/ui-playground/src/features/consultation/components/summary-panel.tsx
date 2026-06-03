import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Separator } from '@arcaai/ui/separator';
import { useArca } from '@arcaai/vox';
import type { SummaryResponse } from '@arcaai/vox';
import { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { Sparkles, RefreshCw, FileText, Clock, Loader2, AlertCircle, Copy, Check } from 'lucide-react';

interface SummaryPanelProps {
  consultationId: string;
}

// TASK-331 doc-06 F4-UI — the server's 3-tier prompt fallback
// (preferred → department → default) is echoed on
// `SummaryResponse.structuredData.promptResolvedFrom` (typed `unknown` via the
// index signature). Narrow it to a human label, or `null` when absent/unknown
// so nothing is rendered.
const PROMPT_TIER_LABELS: Record<string, string> = {
  preferred: 'Doctor preferred',
  department: 'Department',
  default: 'Default',
};

function resolvePromptTierLabel(structuredData: SummaryResponse['structuredData']): string | null {
  const tier = structuredData?.promptResolvedFrom;
  return typeof tier === 'string' ? (PROMPT_TIER_LABELS[tier] ?? null) : null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function SummaryPanel({ consultationId }: SummaryPanelProps) {
  const { summary } = useArca();
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const [summaries, setSummaries] = useState<SummaryResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadSummaries = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await summaryRef.current.loadSummaries();
      setSummaries(result ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load summaries';
      setError(message);
      setSummaries([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSummaries();
  }, [loadSummaries]);

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      await summary.generateSummary();
      toast.success('Summary generated successfully');
      loadSummaries();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate summary';
      toast.error(message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGeneratePreSummary = async () => {
    setIsGenerating(true);
    try {
      await summary.generatePreSummary();
      toast.success('Pre-summary generated successfully');
      loadSummaries();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate pre-summary';
      toast.error(message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = async (content: string, id: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(id);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex gap-2">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-40" />
        </div>
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleGenerate} disabled={isGenerating}>
            {isGenerating ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Sparkles className="mr-1.5 size-4" />}
            Generate Summary
          </Button>
          <Button variant="outline" onClick={handleGeneratePreSummary} disabled={isGenerating}>
            {isGenerating ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <FileText className="mr-1.5 size-4" />}
            Pre-Summary
          </Button>
        </div>
        <Button variant="outline" size="sm" onClick={loadSummaries} disabled={isLoading}>
          <RefreshCw className="mr-1 size-3.5" />
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-3 p-4">
            <AlertCircle className="text-destructive size-5 shrink-0" />
            <p className="text-destructive text-sm">{error}</p>
            <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={loadSummaries}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {summaries.length === 0 && !error ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Sparkles className="text-muted-foreground mb-4 size-10" />
            <h3 className="mb-1 text-lg font-medium">No summaries yet</h3>
            <p className="text-muted-foreground max-w-sm text-center text-sm">Add context items first, then generate a summary from them.</p>
          </CardContent>
        </Card>
      ) : (
        summaries.map((s) => (
          <Card key={s.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-sm font-medium">{s.type === 'pre_summary' ? 'Pre-Summary' : 'Summary'}</CardTitle>
                  {s.llmProvider && s.modelName && (
                    <Badge variant="outline" className="text-xs">
                      {s.llmProvider}/{s.modelName}
                    </Badge>
                  )}
                  {resolvePromptTierLabel(s.structuredData) && (
                    <Badge variant="secondary" className="text-xs" data-doc="summary-prompt-tier">
                      {resolvePromptTierLabel(s.structuredData)}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-xs">
                    {s.createdAt
                      ? formatDistanceToNow(new Date(s.createdAt), {
                          addSuffix: true,
                        })
                      : ''}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => handleCopy(s.content, s.id)}>
                    {copiedId === s.id ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <Separator />
            <CardContent className="pt-3">
              <p className="text-sm whitespace-pre-wrap">{s.content}</p>
              {s.processingTimeMs && (
                <div className="text-muted-foreground mt-3 flex items-center gap-1 text-xs">
                  <Clock className="size-3" />
                  Generated in {(s.processingTimeMs / 1000).toFixed(1)}s
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
