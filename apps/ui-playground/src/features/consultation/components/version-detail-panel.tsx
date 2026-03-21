import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Separator } from '@arcaai/ui/separator';
import { Textarea } from '@arcaai/ui/textarea';
import { Skeleton } from '@arcaai/ui/skeleton';
import { useArca } from '@arcaai/vox';
import type { ContextItem, ContextVersionEntry, SummaryVersionEntry } from '@arcaai/vox';
import { useEffect, useState, useCallback, useRef } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
    Copy,
    Check,
    Loader2,
    Sparkles,
    Save,
    FileAudio,
    RotateCcw,
} from 'lucide-react';

interface VersionDetailPanelProps {
    contextItem: ContextItem;
    version: ContextVersionEntry | SummaryVersionEntry | null;
    onVersionCreated?: () => void;
}

function isContextVersion(v: ContextVersionEntry | SummaryVersionEntry): v is ContextVersionEntry {
    return 'changeDescription' in v && !('changeReason' in v);
}

function isSummaryVersion(v: ContextVersionEntry | SummaryVersionEntry): v is SummaryVersionEntry {
    return 'changeReason' in v;
}

function getVersionContent(version: ContextVersionEntry | SummaryVersionEntry | null, fallback: string): string {
    if (!version) return fallback;
    return version.content;
}

function getVersionDate(version: ContextVersionEntry | SummaryVersionEntry | null): string | undefined {
    if (!version) return undefined;
    if (isContextVersion(version)) return version.updatedAt;
    if (isSummaryVersion(version)) return version.createdAt;
    return undefined;
}

function getVersionDescription(version: ContextVersionEntry | SummaryVersionEntry | null): string | undefined {
    if (!version) return undefined;
    if (isContextVersion(version)) return version.changeDescription;
    if (isSummaryVersion(version)) return version.changeReason;
    return undefined;
}

type ContextItemKind = 'case_note' | 'transcription' | 'audio' | 'pre_summary' | 'summary';

function resolveKind(item: ContextItem): ContextItemKind {
    switch (item.type) {
        case 'CASE_NOTE':
            return 'case_note';
        case 'TRANSCRIPT':
            return 'transcription';
        case 'AUDIO_RECORDING':
            return 'audio';
        case 'PRE_SUMMARY':
            return 'pre_summary';
        case 'RAW_SUMMARY':
        case 'MODIFIED_SUMMARY':
            return 'summary';
        default:
            return 'case_note';
    }
}

const kindConfig: Record<ContextItemKind, {
    editable: boolean;
    canGeneratePreSummary: boolean;
    canGenerateSummary: boolean;
    canRegenerate: boolean;
    label: string;
}> = {
    case_note: {
        editable: false,
        canGeneratePreSummary: true,
        canGenerateSummary: false,
        canRegenerate: false,
        label: 'Case Note',
    },
    transcription: {
        editable: true,
        canGeneratePreSummary: false,
        canGenerateSummary: true,
        canRegenerate: false,
        label: 'Transcription',
    },
    audio: {
        editable: false,
        canGeneratePreSummary: false,
        canGenerateSummary: false,
        canRegenerate: false,
        label: 'Audio File',
    },
    pre_summary: {
        editable: true,
        canGeneratePreSummary: false,
        canGenerateSummary: false,
        canRegenerate: true,
        label: 'Pre-Summary',
    },
    summary: {
        editable: true,
        canGeneratePreSummary: false,
        canGenerateSummary: false,
        canRegenerate: true,
        label: 'Summary',
    },
};

export function VersionDetailPanel({
    contextItem,
    version,
    onVersionCreated,
}: VersionDetailPanelProps) {
    const { context, summary } = useArca();
    const contextRef = useRef(context);
    const summaryRef = useRef(summary);
    contextRef.current = context;
    summaryRef.current = summary;

    const kind = resolveKind(contextItem);
    const config = kindConfig[kind];
    const content = getVersionContent(version, contextItem.content);
    const versionDate = getVersionDate(version);
    const versionDesc = getVersionDescription(version);

    const [editedContent, setEditedContent] = useState(content);
    const [isSaving, setIsSaving] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [copiedId, setCopiedId] = useState(false);
    const isDirty = editedContent !== content;

    useEffect(() => {
        setEditedContent(content);
    }, [content]);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(editedContent);
            setCopiedId(true);
            toast.success('Copied to clipboard');
            setTimeout(() => setCopiedId(false), 2000);
        } catch {
            toast.error('Failed to copy');
        }
    }, [editedContent]);

    const handleSave = useCallback(async () => {
        if (!isDirty) return;
        setIsSaving(true);
        try {
            if (kind === 'summary' || kind === 'pre_summary') {
                await summaryRef.current.updateSummary(contextItem.id, editedContent, {
                    changeReason: 'Manual edit',
                    changeSource: 'doctor_edit',
                });
            } else {
                await contextRef.current.updateItem(contextItem.id, editedContent);
            }
            toast.success('Changes saved — new version created');
            onVersionCreated?.();
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to save';
            toast.error(message);
        } finally {
            setIsSaving(false);
        }
    }, [isDirty, kind, contextItem.id, editedContent, onVersionCreated]);

    const handleGeneratePreSummary = useCallback(async () => {
        setIsGenerating(true);
        try {
            await summaryRef.current.generatePreSummary();
            toast.success('Pre-summary generated — new version created');
            onVersionCreated?.();
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to generate pre-summary';
            toast.error(message);
        } finally {
            setIsGenerating(false);
        }
    }, [onVersionCreated]);

    const handleGenerateSummary = useCallback(async () => {
        setIsGenerating(true);
        try {
            await summaryRef.current.generateSummary();
            toast.success('Summary generated — new version created');
            onVersionCreated?.();
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to generate summary';
            toast.error(message);
        } finally {
            setIsGenerating(false);
        }
    }, [onVersionCreated]);

    const handleRegenerate = useCallback(async () => {
        setIsGenerating(true);
        try {
            if (kind === 'pre_summary') {
                await summaryRef.current.generatePreSummary();
            } else {
                await summaryRef.current.generateSummary();
            }
            toast.success('Regenerated — new version created');
            onVersionCreated?.();
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to regenerate';
            toast.error(message);
        } finally {
            setIsGenerating(false);
        }
    }, [kind, onVersionCreated]);

    if (kind === 'audio') {
        return <AudioDetailView contextItem={contextItem} version={version} />;
    }

    return (
        <div className="flex flex-col gap-4 p-4">
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <Badge variant="outline">{config.label}</Badge>
                    {version && (
                        <Badge variant="secondary" className="text-xs">
                            v{'versionNumber' in version ? version.versionNumber : '?'}
                        </Badge>
                    )}
                    {contextItem.isAiGenerated && (
                        <Badge variant="secondary" className="text-xs">AI</Badge>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    {versionDate && (
                        <span className="text-muted-foreground text-xs">
                            {formatDistanceToNow(new Date(versionDate), { addSuffix: true })}
                        </span>
                    )}
                    <Button variant="ghost" size="sm" onClick={handleCopy}>
                        {copiedId ? (
                            <Check className="size-3.5 text-green-500" />
                        ) : (
                            <Copy className="size-3.5" />
                        )}
                    </Button>
                </div>
            </div>

            {versionDesc && (
                <p className="text-muted-foreground text-xs italic">{versionDesc}</p>
            )}

            <Separator />

            {config.editable ? (
                <Textarea
                    value={editedContent}
                    onChange={(e) => setEditedContent(e.target.value)}
                    className="min-h-75 resize-y font-mono text-sm"
                />
            ) : (
                <div className="min-h-50 rounded-md border p-3">
                    <p className="text-sm whitespace-pre-wrap">{content}</p>
                </div>
            )}

            <Separator />

            <div className="flex flex-wrap items-center gap-2">
                {config.editable && (
                    <Button
                        size="sm"
                        disabled={!isDirty || isSaving}
                        onClick={handleSave}
                    >
                        {isSaving ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : (
                            <Save data-icon="inline-start" />
                        )}
                        {isSaving ? 'Saving...' : 'Save Changes'}
                    </Button>
                )}

                {config.canGeneratePreSummary && (
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={isGenerating}
                        onClick={handleGeneratePreSummary}
                    >
                        {isGenerating ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : (
                            <Sparkles data-icon="inline-start" />
                        )}
                        Generate Pre-Summary
                    </Button>
                )}

                {config.canGenerateSummary && (
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={isGenerating}
                        onClick={handleGenerateSummary}
                    >
                        {isGenerating ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : (
                            <Sparkles data-icon="inline-start" />
                        )}
                        Generate Summary
                    </Button>
                )}

                {config.canRegenerate && (
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={isGenerating}
                        onClick={handleRegenerate}
                    >
                        {isGenerating ? (
                            <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : (
                            <RotateCcw data-icon="inline-start" />
                        )}
                        Regenerate
                    </Button>
                )}
            </div>
        </div>
    );
}

function AudioDetailView({
    contextItem,
    version,
}: {
    contextItem: ContextItem;
    version: ContextVersionEntry | SummaryVersionEntry | null;
}) {
    const content = getVersionContent(version, contextItem.content);
    const versionDate = getVersionDate(version);

    return (
        <div className="flex flex-col gap-4 p-4">
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <Badge variant="outline">Audio File</Badge>
                    {version && (
                        <Badge variant="secondary" className="text-xs">
                            v{'versionNumber' in version ? version.versionNumber : '?'}
                        </Badge>
                    )}
                </div>
                {versionDate && (
                    <span className="text-muted-foreground text-xs">
                        {formatDistanceToNow(new Date(versionDate), { addSuffix: true })}
                    </span>
                )}
            </div>

            <Separator />

            <div className="flex flex-col items-center gap-4 rounded-md border p-8">
                <FileAudio className="text-muted-foreground size-12" />
                <p className="text-sm font-medium">{content}</p>
                <p className="text-muted-foreground text-xs">
                    Audio files are read-only. Playback is not yet available in the playground.
                </p>
            </div>
        </div>
    );
}

export function VersionDetailSkeleton() {
    return (
        <div className="flex flex-col gap-4 p-4">
            <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-5 w-12" />
            </div>
            <Skeleton className="h-px w-full" />
            <Skeleton className="h-75 w-full" />
            <Skeleton className="h-px w-full" />
            <div className="flex gap-2">
                <Skeleton className="h-8 w-28" />
                <Skeleton className="h-8 w-36" />
            </div>
        </div>
    );
}
