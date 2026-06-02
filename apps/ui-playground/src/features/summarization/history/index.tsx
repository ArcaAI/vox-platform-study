import { Main } from '@/components/layout/main';
import { useAuthStore } from '@/store/auth-store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Button } from '@arcaai/ui/button';
import { Badge } from '@arcaai/ui/badge';
import { Input } from '@arcaai/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui/tooltip';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { useState, useMemo, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { Clock, Copy, Download, Eye, Filter, History, Search, Sparkles, Trash2, X } from 'lucide-react';
import { SmrStatusBadge } from '../components/smr-status-badge';
import type { TokenUsage } from '../api';

interface StoredResult {
  id: string;
  type: 'pre_summary' | 'summary';
  content: string;
  provider: string;
  model: string;
  processingTimeMs: number;
  tokenUsage: TokenUsage;
  format?: string;
  dnaStyle?: string;
  template?: string;
  createdAt: string;
}

/**
 * TASK-329 X10 — base key for the summarization generation history.
 *
 * History is namespaced per `${tenantId}::${effectiveUserId}` so that
 * impersonation and tenant switching never leak one doctor's generations
 * into another's view. Mirrors the SDK `ModelRegistry` namespacing scheme
 * (`arcaai-selected-models/${tenantId}::${userId}`, TASK-317 W1.5).
 */
const HISTORY_BASE_KEY = 'arcaai-summarization-history';

/**
 * Resolve the tenant + effective-user scope from the auth store. The
 * `effectiveUserId` is the IMPERSONATED user when impersonating, otherwise
 * the logged-in user — so an admin browsing as Dr. A and then Dr. B sees two
 * isolated buckets, and neither sees the admin's own history.
 */
export function historyStorageKey(): string {
  const { tenantId, user, impersonatedUser, isImpersonating } = useAuthStore.getState();
  const scopeTenant = tenantId || 'no-tenant';
  const scopeUser = (isImpersonating ? impersonatedUser?.id : user?.id) || 'anon';
  return `${HISTORY_BASE_KEY}::${scopeTenant}::${scopeUser}`;
}

export function loadHistory(): StoredResult[] {
  try {
    const raw = localStorage.getItem(historyStorageKey());
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(items: StoredResult[]) {
  localStorage.setItem(historyStorageKey(), JSON.stringify(items));
}

export function addToHistory(entry: StoredResult) {
  const history = loadHistory();
  history.unshift(entry);
  if (history.length > 100) history.length = 100;
  saveHistory(history);
}

export default function HistoryPage() {
  // TASK-329 X10 — re-key the view when the tenant or effective user changes
  // (login, impersonation start/stop, tenant switch) so the table never shows
  // another scope's history.
  const tenantId = useAuthStore((s) => s.tenantId);
  const userId = useAuthStore((s) => s.user?.id);
  const impersonatedUserId = useAuthStore((s) => s.impersonatedUser?.id);
  const isImpersonating = useAuthStore((s) => s.isImpersonating);

  const [history, setHistory] = useState<StoredResult[]>(loadHistory);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('_all');
  const [selectedEntry, setSelectedEntry] = useState<StoredResult | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // TASK-329 X10 — reload from the now-active scope key whenever identity changes.
  useEffect(() => {
    setHistory(loadHistory());
  }, [tenantId, userId, impersonatedUserId, isImpersonating]);

  const filteredHistory = useMemo(() => {
    let result = history;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((h) => h.content.toLowerCase().includes(q) || h.provider.toLowerCase().includes(q) || h.model.toLowerCase().includes(q));
    }
    if (typeFilter !== '_all') {
      result = result.filter((h) => h.type === typeFilter);
    }
    return result;
  }, [history, search, typeFilter]);

  const handleDelete = useCallback(
    (id: string) => {
      const updated = history.filter((h) => h.id !== id);
      setHistory(updated);
      saveHistory(updated);
      toast.success('Entry removed');
    },
    [history],
  );

  const handleClearAll = useCallback(() => {
    setHistory([]);
    saveHistory([]);
    toast.success('History cleared');
  }, []);

  const handleExportAll = useCallback(() => {
    const blob = new Blob([JSON.stringify(filteredHistory, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `summarization-history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('History exported');
  }, [filteredHistory]);

  const handleCopy = useCallback((content: string) => {
    navigator.clipboard.writeText(content);
    toast.success('Copied to clipboard');
  }, []);

  const stats = useMemo(() => {
    const preSummaries = history.filter((h) => h.type === 'pre_summary').length;
    const summaries = history.filter((h) => h.type === 'summary').length;
    const totalTokens = history.reduce((sum, h) => sum + (h.tokenUsage?.total_tokens ?? 0), 0);
    const avgLatency = history.length > 0 ? history.reduce((sum, h) => sum + (h.processingTimeMs ?? 0), 0) / history.length : 0;
    return { preSummaries, summaries, totalTokens, avgLatency };
  }, [history]);

  return (
    <Main>
      <div className="mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Generation History</h1>
            <p className="text-muted-foreground mt-1">View and manage all generated pre-summaries and summaries with full metadata.</p>
          </div>
          <SmrStatusBadge />
        </div>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Pre-Summaries</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{stats.preSummaries}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Summaries</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{stats.summaries}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Tokens</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{stats.totalTokens.toLocaleString()}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Avg Latency</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{(stats.avgLatency / 1000).toFixed(1)}s</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <History className="size-5" />
              <CardTitle>History</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {filteredHistory.length}
              </Badge>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleExportAll} disabled={filteredHistory.length === 0}>
                <Download className="mr-1.5 size-3.5" />
                Export
              </Button>
              {history.length > 0 && (
                <Button variant="outline" size="sm" className="text-destructive" onClick={handleClearAll}>
                  <Trash2 className="mr-1.5 size-3.5" />
                  Clear All
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative min-w-48 flex-1">
              <Search className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
              <Input
                placeholder="Search content, provider, model…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-8"
              />
              {search && (
                <Button variant="ghost" size="icon" className="absolute right-1 top-1/2 size-6 -translate-y-1/2" onClick={() => setSearch('')}>
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-40">
                <Filter className="mr-1.5 size-4" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">All Types</SelectItem>
                <SelectItem value="pre_summary">Pre-Summary</SelectItem>
                <SelectItem value="summary">Summary</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {filteredHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Sparkles className="text-muted-foreground/50 mb-4 size-12" />
              <p className="text-muted-foreground text-sm">
                {history.length === 0
                  ? 'No generation history yet. Generate a pre-summary or summary to see results here.'
                  : 'No results match your filters.'}
              </p>
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Type</TableHead>
                    <TableHead>Content Preview</TableHead>
                    <TableHead className="w-32">Provider/Model</TableHead>
                    <TableHead className="w-24 text-right">Tokens</TableHead>
                    <TableHead className="w-24 text-right">Latency</TableHead>
                    <TableHead className="w-36">Created</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredHistory.map((entry) => (
                    <TableRow
                      key={entry.id}
                      className="cursor-pointer"
                      onClick={() => {
                        setSelectedEntry(entry);
                        setDetailOpen(true);
                      }}
                    >
                      <TableCell>
                        <Badge variant={entry.type === 'pre_summary' ? 'secondary' : 'default'} className="text-[10px]">
                          {entry.type === 'pre_summary' ? 'Pre-Summary' : 'Summary'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <p className="max-w-xs truncate text-sm">{entry.content}</p>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs">
                          {entry.provider}/{entry.model}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{entry.tokenUsage?.total_tokens?.toLocaleString() ?? '—'}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {entry.processingTimeMs ? `${(entry.processingTimeMs / 1000).toFixed(1)}s` : '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">{new Date(entry.createdAt).toLocaleString()}</TableCell>
                      <TableCell>
                        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                          <TooltipProvider delayDuration={0}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon" className="size-7" onClick={() => handleCopy(entry.content)}>
                                  <Copy className="size-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Copy</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <TooltipProvider delayDuration={0}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon" className="size-7 text-destructive" onClick={() => handleDelete(entry.id)}>
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Delete</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="size-4" />
              {selectedEntry?.type === 'pre_summary' ? 'Pre-Summary' : 'Summary'} Detail
            </DialogTitle>
            <DialogDescription>Generated on {selectedEntry?.createdAt ? new Date(selectedEntry.createdAt).toLocaleString() : '—'}</DialogDescription>
          </DialogHeader>
          {selectedEntry && (
            <ScrollArea className="max-h-[60vh]">
              <div className="space-y-4 pr-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={selectedEntry.type === 'pre_summary' ? 'secondary' : 'default'}>
                    {selectedEntry.type === 'pre_summary' ? 'Pre-Summary' : 'Summary'}
                  </Badge>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {selectedEntry.provider}/{selectedEntry.model}
                  </Badge>
                  {selectedEntry.format && (
                    <Badge variant="outline" className="text-[10px]">
                      {selectedEntry.format}
                    </Badge>
                  )}
                  {selectedEntry.dnaStyle && (
                    <Badge variant="outline" className="text-[10px]">
                      DNA: {selectedEntry.dnaStyle}
                    </Badge>
                  )}
                </div>

                <div className="bg-muted/30 grid grid-cols-3 gap-4 rounded-lg border p-4">
                  <div>
                    <p className="text-muted-foreground text-xs">Latency</p>
                    <p className="text-sm font-medium flex items-center gap-1">
                      <Clock className="size-3" />
                      {(selectedEntry.processingTimeMs / 1000).toFixed(1)}s
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Total Tokens</p>
                    <p className="text-sm font-medium">{selectedEntry.tokenUsage?.total_tokens?.toLocaleString() ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Prompt / Completion</p>
                    <p className="text-sm font-medium">
                      {selectedEntry.tokenUsage?.prompt_tokens?.toLocaleString() ?? '—'} /{' '}
                      {selectedEntry.tokenUsage?.completion_tokens?.toLocaleString() ?? '—'}
                    </p>
                  </div>
                </div>

                <div className="bg-muted/30 rounded-lg border p-4">
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{selectedEntry.content}</p>
                </div>

                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => handleCopy(selectedEntry.content)}>
                    <Copy className="mr-1.5 size-3.5" />
                    Copy
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const blob = new Blob([selectedEntry.content], { type: 'text/plain' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `${selectedEntry.type}-${selectedEntry.id.slice(0, 8)}.txt`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <Download className="mr-1.5 size-3.5" />
                    Download
                  </Button>
                </div>
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </Main>
  );
}
