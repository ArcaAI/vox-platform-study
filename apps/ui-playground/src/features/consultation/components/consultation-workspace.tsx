import { VersionDiffPanel } from '@/components/version-diff-panel';
import { MultiColumnLayout, type MultiColumnConfig, type MultiColumnContentConfig, type MultiColumnState } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { useDoctorContext } from '@/features/summarization/hooks/use-doctor-context';
import type { Consultation, ContextItem, ContextVersionEntry, SummaryVersionEntry } from '@arcaai/vox';
import { DEFAULT_PAGE_SIZE, useArca } from '@arcaai/vox';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { Bot, ClipboardList, FileText, History, Mic, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ElementType } from 'react';
import { toast } from 'sonner';
import { CaseNoteForm } from './case-note-form';
import { StartConsultationDialog } from './start-consultation-dialog';
import { VersionDetailPanel } from './version-detail-panel';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const statusVariant: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  OPEN: 'default',
  RECORDING: 'default',
  TRANSCRIBING: 'secondary',
  SUMMARIZING: 'secondary',
  REVIEW: 'outline',
  CLOSED: 'secondary',
  CANCELLED: 'destructive',
  active: 'default',
  completed: 'secondary',
  cancelled: 'destructive',
};

const typeIcon: Record<string, ElementType> = {
  CASE_NOTE: ClipboardList,
  TRANSCRIPT: FileText,
  AUDIO_RECORDING: Mic,
  RAW_SUMMARY: Bot,
  MODIFIED_SUMMARY: Bot,
  PRE_SUMMARY: Bot,
};

const typeLabel: Record<string, string> = {
  CASE_NOTE: 'Case Note',
  TRANSCRIPT: 'Transcript',
  AUDIO_RECORDING: 'Audio',
  RAW_SUMMARY: 'Summary',
  MODIFIED_SUMMARY: 'Edited Summary',
  PRE_SUMMARY: 'Pre-Summary',
  WORKNOTE: 'Work Note',
  ATTACHMENT: 'Attachment',
};

const contextTypeOptions: Array<{ value: string; label: string }> = [
  { value: '_all', label: 'All types' },
  { value: 'CASE_NOTE', label: typeLabel.CASE_NOTE },
  { value: 'TRANSCRIPT', label: typeLabel.TRANSCRIPT },
  { value: 'AUDIO_RECORDING', label: typeLabel.AUDIO_RECORDING },
  { value: 'RAW_SUMMARY', label: typeLabel.RAW_SUMMARY },
  { value: 'MODIFIED_SUMMARY', label: typeLabel.MODIFIED_SUMMARY },
  { value: 'PRE_SUMMARY', label: typeLabel.PRE_SUMMARY },
];

interface DoctorInfo {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
}

function getDoctorDisplayName(c: Consultation): string | undefined {
  if (c.doctorName) return c.doctorName;
  const doc = (c as Record<string, unknown>).doctor as DoctorInfo | undefined;
  if (!doc) return undefined;
  const parts = [doc.firstName, doc.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : doc.username;
}

function getConsultationStatus(c: Consultation): string | undefined {
  if (c.status) return c.status;
  const meta = c.metadata as Record<string, unknown> | undefined;
  return (meta?.status as string) ?? undefined;
}

type VersionUnion = ContextVersionEntry | SummaryVersionEntry;

function isContextVersion(v: VersionUnion): v is ContextVersionEntry {
  return 'updatedAt' in v && !('changeReason' in v);
}

function makeConsultationKeys(effectiveUserId: string) {
  const all = ['consultation-workspace', effectiveUserId] as const;
  return {
    all,
    consultationsRoot: () => [...all, 'consultations'] as const,
    consultations: (searchQuery: string) => [...all, 'consultations', searchQuery] as const,
    contextItems: (consultationId: string | null) => [...all, 'context-items', consultationId] as const,
    versionsByItem: (contextItemId: string | null) => [...all, 'versions', contextItemId] as const,
    versions: (contextItemId: string | null, type: string | undefined) => [...all, 'versions', contextItemId, type] as const,
  };
}

// ---------------------------------------------------------------------------
// Main workspace component
// ---------------------------------------------------------------------------

export function ConsultationWorkspace() {
  const { session, context, summary } = useArca();
  const { effectiveUserId } = useDoctorContext();
  const queryClient = useQueryClient();
  const sessionRef = useRef(session);
  const contextRef = useRef(context);
  const summaryRef = useRef(summary);
  sessionRef.current = session;
  contextRef.current = context;
  summaryRef.current = summary;

  const consultationKeys = useMemo(() => makeConsultationKeys(effectiveUserId), [effectiveUserId]);

  // Column 1: Consultations
  const [selectedConsultationId, setSelectedConsultationId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [consultationSortOrder, setConsultationSortOrder] = useState<'desc' | 'asc'>('desc');
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Column 2: Context items
  const [selectedContextItemId, setSelectedContextItemId] = useState<string | null>(null);
  const [contextTypeFilter, setContextTypeFilter] = useState('_all');
  const [isAddContextDialogOpen, setIsAddContextDialogOpen] = useState(false);

  // Column 3: Versions
  const [selectedVersionIds, setSelectedVersionIds] = useState<string[]>([]);

  const prevUserIdRef = useRef(effectiveUserId);
  useEffect(() => {
    if (prevUserIdRef.current === effectiveUserId) return;
    prevUserIdRef.current = effectiveUserId;
    setSelectedConsultationId(null);
    setSelectedContextItemId(null);
    setContextTypeFilter('_all');
    setSelectedVersionIds([]);
    setSearchQuery('');
  }, [effectiveUserId]);

  const consultationsQuery = useInfiniteQuery({
    queryKey: consultationKeys.consultations(searchQuery),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      return sessionRef.current.listConsultations({
        page: pageParam,
        limit: DEFAULT_PAGE_SIZE,
        ...(searchQuery && { patientId: searchQuery }),
      });
    },
    getNextPageParam: (lastPage, allPages) => {
      const total = lastPage?.total ?? lastPage?.count ?? 0;
      const loaded = allPages.reduce((sum, page) => sum + (page?.data?.length ?? 0), 0);
      if (loaded >= total) return undefined;
      return allPages.length + 1;
    },
    staleTime: 30_000,
  });

  const consultations = useMemo(() => consultationsQuery.data?.pages.flatMap((page) => page?.data ?? []) ?? [], [consultationsQuery.data?.pages]);

  const totalCount = useMemo(() => {
    const firstPage = consultationsQuery.data?.pages[0];
    return firstPage?.total ?? firstPage?.count ?? 0;
  }, [consultationsQuery.data?.pages]);

  const sortedConsultations = useMemo(() => {
    const items = [...consultations];
    items.sort((a, b) => {
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return consultationSortOrder === 'desc' ? timeB - timeA : timeA - timeB;
    });
    return items;
  }, [consultations, consultationSortOrder]);

  const contextItemsQuery = useQuery({
    queryKey: consultationKeys.contextItems(selectedConsultationId),
    enabled: !!selectedConsultationId,
    queryFn: async () => {
      const consultationId = selectedConsultationId;
      if (!consultationId) return [];
      await sessionRef.current.load(consultationId);
      const [caseNotes, transcriptions] = await Promise.all([contextRef.current.fetchCaseNotes(), contextRef.current.fetchTranscriptions()]);
      const all = [...(caseNotes ?? []), ...(transcriptions ?? [])];
      all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return all;
    },
    staleTime: 30_000,
  });

  const contextItems = contextItemsQuery.data ?? [];

  const filteredContextItems = useMemo(() => {
    if (contextTypeFilter === '_all') return contextItems;
    return contextItems.filter((item) => item.type === contextTypeFilter);
  }, [contextItems, contextTypeFilter]);

  const selectedContextItem = contextItems.find((c) => c.id === selectedContextItemId) ?? null;

  const versionsQuery = useQuery({
    queryKey: consultationKeys.versions(selectedContextItemId, selectedContextItem?.type),
    enabled: !!selectedContextItemId && !!selectedContextItem,
    queryFn: async () => {
      if (!selectedContextItemId || !selectedContextItem) return [];
      const isSummaryType = ['RAW_SUMMARY', 'MODIFIED_SUMMARY', 'PRE_SUMMARY'].includes(selectedContextItem.type);
      const result = isSummaryType
        ? await summaryRef.current.getSummaryHistory(selectedContextItemId)
        : await contextRef.current.getContextVersions(selectedContextItemId);
      const versions = [...(result ?? [])];
      versions.sort((a, b) => b.versionNumber - a.versionNumber);
      return versions;
    },
    staleTime: 30_000,
  });

  const versions = versionsQuery.data ?? [];

  const selectedVersions = useMemo(
    () => selectedVersionIds.map((id) => versions.find((v) => String(v.versionNumber) === id)).filter((v): v is VersionUnion => Boolean(v)),
    [selectedVersionIds, versions],
  );

  const selectedVersion = selectedVersions.length === 1 ? selectedVersions[0]! : null;

  useEffect(() => {
    const error = consultationsQuery.error;
    if (!error) return;
    const message = error instanceof Error ? error.message : 'Failed to load consultations';
    toast.error(message);
  }, [consultationsQuery.error]);

  useEffect(() => {
    const error = contextItemsQuery.error;
    if (!error) return;
    const message = error instanceof Error ? error.message : 'Failed to load context items';
    toast.error(message);
  }, [contextItemsQuery.error]);

  useEffect(() => {
    const error = versionsQuery.error;
    if (!error) return;
    const message = error instanceof Error ? error.message : 'Failed to load versions';
    toast.error(message);
  }, [versionsQuery.error]);

  const handleSearch = useCallback((value: string) => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setSearchQuery(value);
    }, 400);
  }, []);

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  const handleLoadMore = useCallback(() => {
    if (!consultationsQuery.hasNextPage || consultationsQuery.isFetchingNextPage) return;
    void consultationsQuery.fetchNextPage();
  }, [consultationsQuery]);

  const handleVersionSelect = useCallback((versionId: string) => {
    setSelectedVersionIds((prev) => {
      if (prev.includes(versionId)) return prev.filter((id) => id !== versionId);
      if (prev.length >= 2) return [prev[1]!, versionId];
      return [...prev, versionId];
    });
  }, []);

  const handleConsultationCreated = useCallback(
    (consultationId: string) => {
      setSelectedConsultationId(consultationId);
      setSelectedContextItemId(null);
      setContextTypeFilter('_all');
      setSelectedVersionIds([]);
      void queryClient.invalidateQueries({ queryKey: consultationKeys.consultationsRoot() });
    },
    [queryClient],
  );

  useEffect(() => {
    setSelectedContextItemId(null);
    setContextTypeFilter('_all');
    setSelectedVersionIds([]);
  }, [selectedConsultationId]);

  useEffect(() => {
    setSelectedVersionIds([]);
  }, [selectedContextItemId]);

  useEffect(() => {
    if (!selectedContextItemId) return;
    const existsInFilteredList = filteredContextItems.some((item) => item.id === selectedContextItemId);
    if (!existsInFilteredList) {
      setSelectedContextItemId(null);
      setSelectedVersionIds([]);
    }
  }, [filteredContextItems, selectedContextItemId]);

  const consultationsLoading = consultationsQuery.isPending;
  const hasMore = !!consultationsQuery.hasNextPage;
  const isLoadingMore = consultationsQuery.isFetchingNextPage;
  const contextItemsLoading = contextItemsQuery.isPending;
  const versionsLoading = versionsQuery.isPending;
  const consultationsRefreshing = consultationsQuery.isFetching;
  const contextItemsRefreshing = !!selectedConsultationId && contextItemsQuery.isFetching;
  const versionsRefreshing = !!selectedContextItemId && versionsQuery.isFetching;

  // Auto-select latest version when versions load
  useEffect(() => {
    if (versions.length > 0 && selectedVersionIds.length === 0) {
      setSelectedVersionIds([String(versions[0]!.versionNumber)]);
    }
  }, [versions, selectedVersionIds.length]);

  useEffect(() => {
    setSelectedVersionIds((prev) => {
      const next = prev.filter((id) => versions.some((v) => String(v.versionNumber) === id));
      if (next.length === prev.length && next.every((id, index) => id === prev[index])) {
        return prev;
      }
      return next;
    });
  }, [versions]);

  // -----------------------------------------------------------------------
  // Column 1 config: Consultations
  // -----------------------------------------------------------------------

  const consultationColumn: MultiColumnConfig<Consultation> = {
    id: 'consultations',
    title: 'Consultations',
    subtitle: totalCount > 0 ? `${totalCount} total` : undefined,
    width: '180px',
    // defaultSize: 20,
    minSize: 10,
    showItemCount: true,
    headerControls: (
      <div className="flex flex-col gap-1.5" data-doc="consultation-search-and-create">
        <div className="relative">
          <Search className="text-muted-foreground absolute left-2 top-1/2 size-3.5 -translate-y-1/2" />
          <Input
            placeholder="Search patient..."
            className="h-7 pl-7 text-xs"
            onChange={(e: ChangeEvent<HTMLInputElement>) => handleSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1">
          <Select value={consultationSortOrder} onValueChange={(value: string) => setConsultationSortOrder(value === 'asc' ? 'asc' : 'desc')}>
            <SelectTrigger className="h-6 flex-1 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="desc">Newest</SelectItem>
                <SelectItem value="asc">Oldest</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <StartConsultationDialog compact onSuccess={handleConsultationCreated} />
        </div>
      </div>
    ),
    onRefresh: () => {
      void queryClient.invalidateQueries({ queryKey: consultationKeys.consultationsRoot() });
    },
    isRefreshing: consultationsRefreshing,
    emptyTitle: 'No consultations',
    emptyDescription: 'Start a new consultation to get going.',
    emptyIcon: <FileText className="text-muted-foreground size-8" />,
    keyExtractor: (c: Consultation) => c.id,
    estimateItemSize: 72,
    renderItem: (c: Consultation) => {
      const status = getConsultationStatus(c);
      const doctor = getDoctorDisplayName(c);
      return (
        <div className="flex flex-col gap-1 px-3 py-2" data-doc="consultation-list-item">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{c.patientId || c.id.slice(0, 8)}</span>
            {status && (
              <Badge variant={statusVariant[status] ?? 'outline'} className="shrink-0 text-[10px]">
                {status}
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <span>{c.createdAt ? format(new Date(c.createdAt), 'MMM d, yyyy HH:mm') : 'Unknown'}</span>
          </div>
          {doctor && <span className="text-muted-foreground truncate text-xs">Dr. {doctor}</span>}
          {c.createdAt && (
            <span className="text-muted-foreground text-[11px]">{formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}</span>
          )}
        </div>
      );
    },
  };

  const consultationState: MultiColumnState<Consultation> = {
    data: sortedConsultations,
    isLoading: consultationsLoading,
    selectedId: selectedConsultationId,
    onSelect: (id: string) => {
      if (id === selectedConsultationId) return;
      setSelectedConsultationId(id);
    },
    hasMore,
    onLoadMore: handleLoadMore,
    isLoadingMore,
  };

  // -----------------------------------------------------------------------
  // Column 2 config: Context items
  // -----------------------------------------------------------------------

  const contextItemColumn: MultiColumnConfig<ContextItem> = {
    id: 'context-items',
    title: 'Context Items',
    width: '180px',
    // defaultSize: 20,
    minSize: 10,
    showItemCount: true,
    headerControls: selectedConsultationId ? (
      <div className="flex items-center gap-1" data-doc="consultation-context-filters">
        <Select value={contextTypeFilter} onValueChange={setContextTypeFilter}>
          <SelectTrigger className="h-7 flex-1 text-xs">
            <SelectValue placeholder="Filter type" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {contextTypeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Dialog open={isAddContextDialogOpen} onOpenChange={setIsAddContextDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs">
              <Plus data-icon="inline-start" />
              Add
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Add Context Item</DialogTitle>
              <DialogDescription>Add case notes, summaries, or audio files to this consultation.</DialogDescription>
            </DialogHeader>
            <CaseNoteForm
              consultationId={selectedConsultationId}
              onSuccess={() => {
                setIsAddContextDialogOpen(false);
                setContextTypeFilter('_all');
                void queryClient.invalidateQueries({
                  queryKey: consultationKeys.contextItems(selectedConsultationId),
                });
              }}
            />
          </DialogContent>
        </Dialog>
      </div>
    ) : undefined,
    onRefresh: () => {
      if (!selectedConsultationId) {
        setSelectedContextItemId(null);
        setSelectedVersionIds([]);
        return;
      }

      void queryClient.invalidateQueries({
        queryKey: consultationKeys.contextItems(selectedConsultationId),
      });
    },
    isRefreshing: contextItemsRefreshing,
    emptyTitle: selectedConsultationId ? 'No context items' : 'Select a consultation',
    emptyDescription: selectedConsultationId
      ? 'No context items found for this consultation.'
      : 'Select a consultation from the left to view its context items.',
    emptyIcon: <ClipboardList className="text-muted-foreground size-8" />,
    keyExtractor: (item: ContextItem) => item.id,
    estimateItemSize: 64,
    renderItem: (item: ContextItem) => {
      const Icon = typeIcon[item.type] ?? FileText;
      const label = typeLabel[item.type] ?? item.type;
      return (
        <div className="flex items-center gap-2 px-3 py-2" data-doc="consultation-context-item">
          <Icon className="text-muted-foreground size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{label}</span>
              {item.isAiGenerated && (
                <Badge variant="secondary" className="text-[10px]">
                  AI
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground truncate text-xs">{item.content.slice(0, 60)}</p>
          </div>
        </div>
      );
    },
  };

  const contextItemState: MultiColumnState<ContextItem> = {
    data: filteredContextItems,
    isLoading: contextItemsLoading,
    enabled: !!selectedConsultationId,
    selectedId: selectedContextItemId,
    onSelect: (id: string) => {
      if (id === selectedContextItemId) return;
      setSelectedContextItemId(id);
    },
  };

  // -----------------------------------------------------------------------
  // Column 3 config: Versions
  // -----------------------------------------------------------------------

  const versionColumn: MultiColumnConfig<VersionUnion> = {
    id: 'versions',
    title: 'Versions',
    width: '180px',
    // defaultSize: 15,
    minSize: 10,
    showItemCount: true,
    onRefresh: () => {
      if (!selectedContextItemId) {
        setSelectedVersionIds([]);
        return;
      }

      void queryClient.invalidateQueries({
        queryKey: consultationKeys.versionsByItem(selectedContextItemId),
      });
    },
    isRefreshing: versionsRefreshing,
    emptyTitle: selectedContextItemId ? 'No versions' : 'Select a context item',
    emptyDescription: selectedContextItemId ? 'Click refresh to load version history.' : 'Select a context item to view its versions.',
    emptyIcon: <History className="text-muted-foreground size-8" />,
    keyExtractor: (v: VersionUnion) => String(v.versionNumber),
    estimateItemSize: 56,
    renderItem: (v: VersionUnion) => {
      const date = isContextVersion(v) ? v.updatedAt : v.createdAt;
      const desc = isContextVersion(v) ? v.changeDescription : v.changeReason;
      return (
        <div className="flex flex-col gap-1 px-3 py-2" data-doc="consultation-version-item">
          <div className="flex items-center justify-between gap-2">
            <Badge variant="outline" className="text-xs">
              v{v.versionNumber}
            </Badge>
            <span className="text-muted-foreground text-[10px]">{date ? formatDistanceToNow(new Date(date), { addSuffix: true }) : ''}</span>
          </div>
          {desc && <p className="text-muted-foreground truncate text-xs italic">{desc}</p>}
        </div>
      );
    },
  };

  const versionState: MultiColumnState<VersionUnion> = {
    data: versions,
    isLoading: versionsLoading,
    enabled: !!selectedContextItemId,
    selectedId: selectedVersionIds[0] ?? null,
    selectedIds: selectedVersionIds,
    onSelect: handleVersionSelect,
  };

  // -----------------------------------------------------------------------
  // Column 4 config: Version detail (content column)
  // -----------------------------------------------------------------------

  const handleVersionCreated = useCallback(() => {
    if (selectedContextItemId) {
      void queryClient.invalidateQueries({
        queryKey: consultationKeys.versionsByItem(selectedContextItemId),
      });
    }
    if (selectedConsultationId) {
      void queryClient.invalidateQueries({
        queryKey: consultationKeys.contextItems(selectedConsultationId),
      });
    }
  }, [queryClient, selectedConsultationId, selectedContextItemId]);

  const detailColumn: MultiColumnContentConfig = {
    type: 'content',
    id: 'version-detail',
    title: selectedVersions.length === 2 ? 'Version Diff' : 'Details',
    defaultSize: 45,
    minSize: 25,
    headerActions: selectedContextItem ? (
      <Badge variant="outline" className="text-xs">
        {typeLabel[selectedContextItem.type] ?? selectedContextItem.type}
      </Badge>
    ) : undefined,
    onRefresh: () => {
      if (!selectedContextItemId) {
        return;
      }

      void queryClient.invalidateQueries({
        queryKey: consultationKeys.versionsByItem(selectedContextItemId),
      });
    },
    emptyTitle: 'Select a version',
    emptyDescription: 'Select one version for detail or two versions for diff.',
    renderContent: () => {
      if (!selectedContextItem) {
        return null;
      }

      if (selectedVersions.length === 2) {
        const [left, right] = [...selectedVersions].sort((a, b) => a.versionNumber - b.versionNumber);
        const leftDate = isContextVersion(left) ? left.updatedAt : (left as SummaryVersionEntry).createdAt;
        const rightDate = isContextVersion(right) ? right.updatedAt : (right as SummaryVersionEntry).createdAt;
        const leftReason = isContextVersion(left) ? left.changeDescription : (left as SummaryVersionEntry).changeReason;
        const rightReason = isContextVersion(right) ? right.changeDescription : (right as SummaryVersionEntry).changeReason;
        const useMonospaceDiffContent = ['TRANSCRIPT', 'PRE_SUMMARY', 'RAW_SUMMARY', 'MODIFIED_SUMMARY'].includes(selectedContextItem.type);
        return (
          <VersionDiffPanel
            left={{ versionNumber: left.versionNumber, date: leftDate, changeReason: leftReason }}
            right={{ versionNumber: right.versionNumber, date: rightDate, changeReason: rightReason }}
            sections={[
              {
                label: 'Content',
                oldText: left.content || '',
                newText: right.content || '',
              },
            ]}
            contentClassName={useMonospaceDiffContent ? 'font-mono text-sm' : 'text-sm'}
          />
        );
      }

      return <VersionDetailPanel contextItem={selectedContextItem} version={selectedVersion} onVersionCreated={handleVersionCreated} />;
    },
  };

  // -----------------------------------------------------------------------
  // Assemble columns
  // -----------------------------------------------------------------------

  const columns = [consultationColumn, contextItemColumn, versionColumn, detailColumn];
  const columnStates = [
    consultationState,
    contextItemState,
    versionState,
    {
      data: [],
      isLoading: false,
      enabled: selectedVersionIds.length > 0 || !!selectedContextItem,
      selectedId: null,
      onSelect: () => {},
    },
  ];

  return (
    <div data-doc="consultation-columns">
      <MultiColumnLayout columns={columns} columnStates={columnStates} height="calc(100vh - 12rem)" resizable />
    </div>
  );
}
