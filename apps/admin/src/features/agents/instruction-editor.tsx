import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Spinner } from '@arcaai/ui/spinner';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { Textarea } from '@arcaai/ui/textarea';
import type { PromptTemplate, PromptVersion } from '@arcaai/vox';
import { History, Lock, RotateCcw } from 'lucide-react';
import { categoryLabel, parseVariableNames } from './instruction-draft';

function fmtDate(iso?: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function ReadOnlyField({ label, value, locked }: { label: string; value: string; locked?: boolean }) {
    return (
        <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground">{label}</Label>
            <div className="flex h-9 items-center justify-between rounded-md border border-input bg-muted/50 px-3 text-sm">
                <span className={locked ? 'font-mono text-xs text-muted-foreground' : 'truncate'} title={value}>
                    {value}
                </span>
                {locked ? <Lock className="size-3.5 shrink-0 text-muted-foreground" /> : null}
            </div>
        </div>
    );
}

/**
 * Instruction editor body (frame 31). Controlled by the route: the `content` and
 * `changeReason` state + Save/Publish actions live on the page (so the workspace
 * header can host them); this renders the locked metadata, the live-parsed
 * `{{variable}}` chips, the mono content editor, the change-reason field, and the
 * version rail with Activate (rollback). `name`/`category`/`scope` are read-only —
 * `UpdatePromptInput` cannot change them.
 */
export function InstructionEditor({
    prompt,
    versions,
    versionsLoading,
    content,
    onContentChange,
    changeReason,
    onChangeReasonChange,
    canManage,
    onActivate,
    activatingVersion,
}: {
    prompt: PromptTemplate;
    versions: PromptVersion[];
    versionsLoading?: boolean;
    content: string;
    onContentChange: (value: string) => void;
    changeReason: string;
    onChangeReasonChange: (value: string) => void;
    canManage: boolean;
    onActivate?: (versionNumber: number) => void;
    activatingVersion?: number | null;
}) {
    const variableNames = parseVariableNames(content);
    const sorted = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);

    return (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-3">
                    <ReadOnlyField label="Name" value={prompt.name} />
                    <ReadOnlyField label="Category" value={categoryLabel(prompt.category)} />
                    <ReadOnlyField label="Scope" value="DEPARTMENT_DEFAULT" locked />
                </div>

                <div className="space-y-1.5">
                    <Label className="text-muted-foreground">Variables</Label>
                    <div className="flex flex-wrap gap-1.5">
                        {variableNames.length > 0 ? (
                            variableNames.map((name) => (
                                <span key={name} className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                                    {`{{${name}}}`}
                                </span>
                            ))
                        ) : (
                            <span className="text-xs text-muted-foreground">No {`{{variables}}`} detected in the prompt body.</span>
                        )}
                    </div>
                    <p className="text-xs text-muted-foreground">Parsed from {`{{double_braces}}`} and bound at runtime from the consultation context.</p>
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="prompt-content">Prompt body</Label>
                    <Textarea
                        id="prompt-content"
                        value={content}
                        onChange={(e) => onContentChange(e.target.value)}
                        readOnly={!canManage}
                        spellCheck={false}
                        className="min-h-[360px] resize-y font-mono text-sm leading-relaxed"
                        placeholder="You are a clinical documentation assistant for this department…"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                        <span className="tabular-nums">{content.length} characters</span>
                        <span>Markdown supported</span>
                    </div>
                </div>

                {canManage ? (
                    <div className="space-y-1.5">
                        <Label htmlFor="change-reason">
                            Change reason <span className="text-destructive">*</span>
                        </Label>
                        <Input
                            id="change-reason"
                            value={changeReason}
                            onChange={(e) => onChangeReasonChange(e.target.value)}
                            placeholder="Why this revision? (recorded with the new version)"
                        />
                        <p className="text-xs text-muted-foreground">Required to save a new version.</p>
                    </div>
                ) : null}
            </div>

            <aside className="space-y-3">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                    <History className="size-4 text-muted-foreground" />
                    Version history
                </h2>
                {versionsLoading && sorted.length === 0 ? (
                    <div className="space-y-2">
                        {Array.from({ length: 3 }).map((_, i) => (
                            <Skeleton key={i} className="h-16 rounded-md" />
                        ))}
                    </div>
                ) : sorted.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No versions recorded yet.</p>
                ) : (
                    <ol className="space-y-2">
                        {sorted.map((v) => {
                            const isCurrent = v.versionNumber === prompt.currentVersionNumber;
                            const isActivating = activatingVersion === v.versionNumber;
                            return (
                                <li key={v.id} className="rounded-md border p-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="font-mono text-sm font-medium tabular-nums">v{v.versionNumber}</span>
                                        {isCurrent ? <StatusBadge label="Current" colorRole="success" /> : null}
                                    </div>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {fmtDate(v.createdAt)}
                                        {v.changedBy ? ` · ${v.changedBy}` : ''}
                                    </p>
                                    {v.changeReason ? <p className="mt-1 line-clamp-2 text-xs text-foreground/80">{v.changeReason}</p> : null}
                                    {!isCurrent && canManage && onActivate ? (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="mt-2 h-9 w-full"
                                            disabled={activatingVersion != null}
                                            onClick={() => onActivate(v.versionNumber)}
                                        >
                                            {isActivating ? <Spinner className="size-4" /> : <RotateCcw className="size-4" />}
                                            Activate
                                        </Button>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ol>
                )}
            </aside>
        </div>
    );
}
