import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useDnaStyle, type DnaReport, type User } from '@arcaai/vox';
import { PenLine, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDateTime } from '@/lib/utils';

const TRAIT_FIELDS: { key: keyof DnaReport['reportData']; label: string }[] = [
    { key: 'formality', label: 'Formality' },
    { key: 'sentenceLength', label: 'Sentence' },
    { key: 'medicalTermUsage', label: 'Terminology' },
    { key: 'abbreviationStyle', label: 'Abbreviations' },
];

function traitChips(report: DnaReport): { label: string; value: string }[] {
    return TRAIT_FIELDS.map(({ key, label }) => ({ label, value: report.reportData?.[key] })).filter(
        (t): t is { label: string; value: string } => typeof t.value === 'string' && t.value.length > 0,
    );
}

/**
 * 38u **DNA Style** tab. REAL read of the doctor's analyzed writing style
 * (`useDnaStyle.getByDoctor`) — the style text + descriptor traits that shape
 * their summaries. Editing it as a personal `DNA_ANALYSIS` prompt is a TARGET
 * (no `USER_PERSONAL` prompt scope), so Edit / New version are flagged.
 */
export function DnaStylePanel({ user }: { user: User }) {
    const { getByDoctor } = useDnaStyle();
    const [report, setReport] = useState<DnaReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [missing, setMissing] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setMissing(false);
        getByDoctor(user.id)
            .then((r) => !cancelled && setReport(r))
            .catch(() => !cancelled && setMissing(true))
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user.id]);

    return (
        <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">DNA writing-style instructions</h2>
                    <p className="text-sm text-muted-foreground">The personal writing-style prompt that shapes how summaries are drafted for this clinician.</p>
                </div>
                <div className="flex items-center gap-2">
                    {/* TARGET: editable USER_PERSONAL DNA_ANALYSIS prompt is not modeled. */}
                    <Button variant="outline" size="sm" disabled title="Target · editable personal style prompt ships later">
                        <PenLine className="size-4" />
                        Edit
                    </Button>
                    <Button size="sm" disabled title="Target · editable personal style prompt ships later">
                        New version
                        <span className="ml-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">Target</span>
                    </Button>
                </div>
            </div>

            {loading ? (
                <Skeleton className="h-64 w-full" />
            ) : missing || !report ? (
                <Empty>
                    <EmptyHeader>
                        <EmptyMedia variant="icon">
                            <Sparkles />
                        </EmptyMedia>
                        <EmptyTitle>No DNA writing style yet</EmptyTitle>
                        <EmptyDescription>Generate a DNA report from the DNA Reports tab to analyze this clinician’s writing style.</EmptyDescription>
                    </EmptyHeader>
                </Empty>
            ) : (
                <Card className="p-5">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold">DNA writing style</h3>
                        <StatusBadge label={`v${report.currentVersionNumber} · ${report.isLatest ? 'active' : 'archived'}`} colorRole={report.isLatest ? 'success' : 'neutral'} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">Updated {formatDateTime(report.updatedAt)}</p>

                    {traitChips(report).length > 0 ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                            {traitChips(report).map((t) => (
                                <span key={t.label} className="rounded-full border border-ai/25 bg-ai/5 px-2.5 py-1 text-xs font-medium text-ai">
                                    {t.label} · {t.value}
                                </span>
                            ))}
                        </div>
                    ) : null}

                    <div className="mt-4 border-t pt-4">
                        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Instruction</span>
                        <p className="mt-2 text-sm whitespace-pre-wrap text-foreground/90">
                            {report.styleText || <span className="text-muted-foreground">This report has no style text.</span>}
                        </p>
                    </div>
                </Card>
            )}
        </div>
    );
}
