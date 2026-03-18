import { useArca } from '@arcaai/vox';
import type { ContextItem } from '@arcaai/vox';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Separator } from '@arcaai/ui/separator';
import { useEffect, useState, useCallback, useRef } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
    FileText,
    History,
    RefreshCw,
    ChevronDown,
    ChevronUp,
    AlertCircle,
    Mic,
    ClipboardList,
    Bot,
} from 'lucide-react';
import { ContextVersionList } from './context-version-list';
import { toast } from 'sonner';

interface ContextItemListProps {
    consultationId: string;
}

const typeIcon: Record<string, React.ElementType> = {
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
    AUDIO_RECORDING: 'Audio Recording',
    RAW_SUMMARY: 'Summary',
    MODIFIED_SUMMARY: 'Edited Summary',
    PRE_SUMMARY: 'Pre-Summary',
    WORKNOTE: 'Work Note',
    ATTACHMENT: 'Attachment',
};

export function ContextItemList({ consultationId }: ContextItemListProps) {
    const { context } = useArca();
    const contextRef = useRef(context);
    contextRef.current = context;
    const [items, setItems] = useState<ContextItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [expandedContent, setExpandedContent] = useState<Set<string>>(new Set());

    const loadItems = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const [caseNotes, transcriptions] = await Promise.all([
                contextRef.current.fetchCaseNotes(),
                contextRef.current.fetchTranscriptions(),
            ]);
            const all = [...(caseNotes ?? []), ...(transcriptions ?? [])];
            all.sort((a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
            );
            setItems(all);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load context items';
            setError(message);
            setItems([]);
            toast.error(message);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        loadItems();
    }, [loadItems]);

    const toggleContent = (id: string) => {
        setExpandedContent((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    if (isLoading) {
        return (
            <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                    <Card key={i}>
                        <CardContent className="p-4">
                            <div className="flex items-center gap-2">
                                <Skeleton className="size-5 rounded" />
                                <Skeleton className="h-4 w-24" />
                                <Skeleton className="ml-auto h-4 w-16" />
                            </div>
                            <Skeleton className="mt-3 h-16 w-full" />
                        </CardContent>
                    </Card>
                ))}
            </div>
        );
    }

    if (error && items.length === 0) {
        return (
            <Card className="border-destructive/50">
                <CardContent className="flex flex-col items-center justify-center py-12">
                    <AlertCircle className="text-destructive mb-4 size-10" />
                    <h3 className="mb-1 text-lg font-medium">Failed to Load Context Items</h3>
                    <p className="text-muted-foreground mb-4 text-sm">{error}</p>
                    <Button onClick={loadItems} variant="outline">
                        <RefreshCw className="mr-1.5 size-4" />
                        Retry
                    </Button>
                </CardContent>
            </Card>
        );
    }

    if (items.length === 0) {
        return (
            <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                    <FileText className="text-muted-foreground mb-4 size-10" />
                    <h3 className="mb-1 text-lg font-medium">No context items yet</h3>
                    <p className="text-muted-foreground text-sm">
                        Switch to the "Add Context" tab to add case notes, summaries, or audio files.
                    </p>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <p className="text-muted-foreground text-sm">
                    {items.length} item{items.length !== 1 ? 's' : ''}
                </p>
                <Button variant="outline" size="sm" onClick={loadItems} disabled={isLoading}>
                    <RefreshCw className={`mr-1 size-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                    Refresh
                </Button>
            </div>

            {items.map((item) => {
                const Icon = typeIcon[item.type] ?? FileText;
                const label = typeLabel[item.type] ?? item.type;
                const isLong = item.content.length > 300;
                const isExpanded = expandedContent.has(item.id);
                const displayContent =
                    isLong && !isExpanded
                        ? `${item.content.slice(0, 300)}...`
                        : item.content;

                return (
                    <Card key={item.id}>
                        <CardHeader className="flex flex-row items-center justify-between pb-2">
                            <div className="flex items-center gap-2">
                                <Icon className="text-muted-foreground size-4" />
                                <CardTitle className="text-sm font-medium">{label}</CardTitle>
                                {item.isAiGenerated && (
                                    <Badge variant="secondary" className="text-xs">
                                        AI
                                    </Badge>
                                )}
                            </div>
                            <div className="flex items-center gap-1">
                                <span className="text-muted-foreground text-xs">
                                    {item.createdAt
                                        ? formatDistanceToNow(new Date(item.createdAt), {
                                              addSuffix: true,
                                          })
                                        : ''}
                                </span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    title="Version history"
                                    onClick={() =>
                                        setExpandedId(expandedId === item.id ? null : item.id)
                                    }
                                >
                                    <History className="size-3.5" />
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <p className="text-sm whitespace-pre-wrap">{displayContent}</p>
                            {isLong && (
                                <Button
                                    variant="link"
                                    size="sm"
                                    className="mt-1 h-auto p-0 text-xs"
                                    onClick={() => toggleContent(item.id)}
                                >
                                    {isExpanded ? (
                                        <>
                                            <ChevronUp className="mr-1 size-3" />
                                            Show less
                                        </>
                                    ) : (
                                        <>
                                            <ChevronDown className="mr-1 size-3" />
                                            Show more
                                        </>
                                    )}
                                </Button>
                            )}
                            {expandedId === item.id && (
                                <div className="mt-4">
                                    <Separator className="mb-3" />
                                    <ContextVersionList contextItemId={item.id} />
                                </div>
                            )}
                        </CardContent>
                    </Card>
                );
            })}
        </div>
    );
}
