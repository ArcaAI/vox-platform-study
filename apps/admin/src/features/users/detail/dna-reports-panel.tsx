import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useDnaStyle, type DnaReport, type DnaStyleVersion, type User } from '@arcaai/vox';
import { Plus, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { cn, formatDateTime } from '@/lib/utils';

const DESCRIPTOR_KEYS: { key: keyof DnaReport['reportData']; label: string }[] = [
    { key: 'formality', label: 'Formality' },
    { key: 'sentenceLength', label: 'Sentence length' },
    { key: 'medicalTermUsage', label: 'Medical terminology' },
    { key: 'abbreviationStyle', label: 'Abbreviation style' },
];

function descriptorTraits(data?: DnaReport['reportData']): { label: string; value: string }[] {
    if (!data) return [];
    return DESCRIPTOR_KEYS.map(({ key, label }) => ({ label, value: data[key] })).filter(
        (t): t is { label: string; value: string } => typeof t.value === 'string' && t.value.length > 0,
    );
}

/**
 * 38u **DNA Reports** tab. REAL: the doctor's report + its version history
 * (`getByDoctor` → `getVersions`) and a side-by-side version diff
 * (`getVersionDiff`). **Generate** is self-scoped on the backend (no doctorId
 * param), so it's only enabled when an admin views their own profile — generating
 * on behalf of another clinician is flagged TARGET rather than fired at the wrong
 * account.
 */
export function DnaReportsPanel({ user, isSelf }: { user: User; isSelf: boolean }) {
    const { getByDoctor, getVersions, getVersionDiff, generate } = useDnaStyle();
    const [report, setReport] = useState<DnaReport | null>(null);
    const [versions, setVersions] = useState<DnaStyleVersion[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [missing, setMissing] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [diff, setDiff] = useState<{ left: DnaStyleVersion | null; right: DnaStyleVersion | null } | null>(null);

    const load = () => {
        setLoading(true);
        setMissing(false);
        setDiff(null);
        getByDoctor(user.id)
            .then(async (r) => {
                setReport(r);
                const v = await getVersions(r.id).catch(() => [] as DnaStyleVersion[]);
                const sorted = [...v].sort((a, b) => b.versionNumber - a.versionNumber);
                setVersions(sorted);
                setSelectedId(sorted[0]?.id ?? null);
            })
            .catch(() => setMissing(true))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user.id]);

    const selected = useMemo(() => versions.find((v) => v.id === selectedId) ?? null, [versions, selectedId]);
    const prior = useMemo(() => {
        if (!selected) return null;
        return versions.find((v) => v.versionNumber === selected.versionNumber - 1) ?? null;
    }, [versions, selected]);

    const handleGenerate = async () => {
        setGenerating(true);
        try {
            await generate();
            toast.success('DNA report generation started');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to start generation');
        } finally {
            setGenerating(false);
        }
    };

    const handleCompare = async () => {
        if (!report || !selected || !prior) return;
        try {
            const result = await getVersionDiff(report.id, prior.id, selected.id);
            setDiff(result);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to load diff');
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">DNA writing-style reports</h2>
                    <p className="text-sm text-muted-foreground">Generated analyses of this clinician’s writing style. Each run creates a new version.</p>
                </div>
                {isSelf ? (
                    <Button size="sm" disabled={generating} onClick={handleGenerate}>
                        <Plus className="size-4" />
                        Create report
                    </Button>
                ) : (
                    <Button size="sm" disabled title="Target · generating for another clinician ships later">
                        <Plus className="size-4" />
                        Create report
                        <span className="ml-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">Target</span>
                    </Button>
                )}
            </div>

            {loading ? (
                <Skeleton className="h-80 w-full" />
            ) : missing || !report ? (
                <Empty>
                    <EmptyHeader>
                        <EmptyMedia variant="icon">
                            <Sparkles />
                        </EmptyMedia>
                        <EmptyTitle>No DNA reports yet</EmptyTitle>
                        <EmptyDescription>{isSelf ? 'Generate your first DNA report to analyze your writing style.' : 'This clinician has no DNA report yet.'}</EmptyDescription>
                    </EmptyHeader>
                    {isSelf ? (
                        <EmptyContent>
                            <Button onClick={handleGenerate} disabled={generating}>
                                <Plus className="size-4" />
                                Create report
                            </Button>
                        </EmptyContent>
                    ) : null}
                </Empty>
            ) : (
                <Card className="grid grid-cols-1 gap-0 p-0 lg:grid-cols-[220px_1fr]">
                    <aside className="border-b p-3 lg:border-r lg:border-b-0">
                        <p className="px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Versions</p>
                        <ul className="space-y-1">
                            {versions.length === 0 ? (
                                <li className="px-2 py-2 text-sm text-muted-foreground">No version history.</li>
                            ) : (
                                versions.map((v) => {
                                    const isCurrent = v.versionNumber === report.currentVersionNumber;
                                    return (
                                        <li key={v.id}>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setSelectedId(v.id);
                                                    setDiff(null);
                                                }}
                                                className={cn(
                                                    'w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent/50',
                                                    selectedId === v.id && 'bg-accent',
                                                )}
                                            >
                                                <span className="font-medium">Version {v.versionNumber}</span>
                                                <span className="block text-xs text-muted-foreground">
                                                    {isCurrent ? 'Current · ' : ''}
                                                    {formatDateTime(v.createdAt)}
                                                </span>
                                            </button>
                                        </li>
                                    );
                                })
                            )}
                        </ul>
                    </aside>

                    <div className="p-5">
                        {selected ? (
                            <>
                                <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-2">
                                        <h3 className="text-sm font-semibold">DNA Style Report</h3>
                                        <StatusBadge
                                            label={`v${selected.versionNumber}${selected.versionNumber === report.currentVersionNumber ? ' · current' : ''}`}
                                            colorRole={selected.versionNumber === report.currentVersionNumber ? 'success' : 'neutral'}
                                        />
                                    </div>
                                    {prior ? (
                                        <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={handleCompare}>
                                            Compare with v{prior.versionNumber}
                                        </button>
                                    ) : null}
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">Generated {formatDateTime(selected.createdAt)}</p>

                                {diff ? (
                                    <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                                        <div>
                                            <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">v{diff.left?.versionNumber ?? '—'}</p>
                                            <p className="rounded-md border bg-muted/20 p-3 text-sm whitespace-pre-wrap text-foreground/90">{diff.left?.styleText || '—'}</p>
                                        </div>
                                        <div>
                                            <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">v{diff.right?.versionNumber ?? '—'}</p>
                                            <p className="rounded-md border bg-muted/20 p-3 text-sm whitespace-pre-wrap text-foreground/90">{diff.right?.styleText || '—'}</p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="mt-4 space-y-4">
                                        <section>
                                            <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Summary</p>
                                            <p className="text-sm whitespace-pre-wrap text-foreground/90">{selected.styleText || <span className="text-muted-foreground">No summary text.</span>}</p>
                                        </section>
                                        {descriptorTraits(selected.reportData).length > 0 ? (
                                            <section>
                                                <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Signature traits</p>
                                                <ul className="list-disc space-y-1 pl-5 text-sm text-foreground/90">
                                                    {descriptorTraits(selected.reportData).map((t) => (
                                                        <li key={t.label}>
                                                            {t.label}: {t.value}
                                                        </li>
                                                    ))}
                                                </ul>
                                            </section>
                                        ) : null}
                                    </div>
                                )}
                            </>
                        ) : (
                            <p className="text-sm text-muted-foreground">Select a version to view its analysis.</p>
                        )}
                    </div>
                </Card>
            )}
        </div>
    );
}
