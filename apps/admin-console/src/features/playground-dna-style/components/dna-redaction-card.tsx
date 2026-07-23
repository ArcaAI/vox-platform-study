'use client';

import { useState, type FormEvent } from 'react';
import { IconEraser, IconPlus, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { CodeEditor, validateJson } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useDnaSettings, useMyRedactionRules, useMyStyle, useUpdateMyReport } from '../api';
import type { RedactionMatchKind, RedactionRule, RedactionRuleType } from '../api';

const RULE_TYPES: readonly RedactionRuleType[] = ['remove', 'rewrite'];
const MATCH_KINDS: readonly RedactionMatchKind[] = ['literal', 'regex', 'category'];

function isOccError(error: unknown): boolean {
    return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/** A stable id for a freshly-added rule row. */
function newRuleId(): string {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `rule-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function blankRule(): RedactionRule {
    return { id: newRuleId(), type: 'remove', match: 'literal', pattern: '' };
}

/** Drop empty patterns and trim optional fields to a persistable rule set. */
function normalize(rules: RedactionRule[]): RedactionRule[] {
    return rules
        .filter((rule) => rule.pattern.trim() !== '')
        .map((rule) => {
            const next: RedactionRule = { id: rule.id, type: rule.type, match: rule.match, pattern: rule.pattern };
            if (rule.type === 'rewrite' && rule.replacement && rule.replacement.trim() !== '') next.replacement = rule.replacement;
            if (rule.note && rule.note.trim() !== '') next.note = rule.note;
            return next;
        });
}

/**
 * A single structured rule row. Icon-only remove control carries an aria-label;
 * every select/input is labelled for the keyboard + screen-reader passes.
 */
function RuleRow({
    rule,
    index,
    disabled,
    onChange,
    onRemove,
}: {
    rule: RedactionRule;
    index: number;
    disabled: boolean;
    onChange: (next: RedactionRule) => void;
    onRemove: () => void;
}) {
    const rowLabel = `Rule ${index + 1}`;
    return (
        <div className="border-border/60 flex flex-col gap-2 rounded-md border p-3" role="group" aria-label={rowLabel}>
            <div className="flex flex-wrap items-end gap-2">
                <div className="flex min-w-28 flex-col gap-1">
                    <Label className="text-muted-foreground text-xs" htmlFor={`rule-type-${rule.id}`}>
                        Action
                    </Label>
                    <Select value={rule.type} onValueChange={(value) => onChange({ ...rule, type: value as RedactionRuleType })} disabled={disabled}>
                        <SelectTrigger id={`rule-type-${rule.id}`} size="sm" aria-label={`${rowLabel} action`}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {RULE_TYPES.map((type) => (
                                <SelectItem key={type} value={type}>
                                    {type}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex min-w-28 flex-col gap-1">
                    <Label className="text-muted-foreground text-xs" htmlFor={`rule-match-${rule.id}`}>
                        Match
                    </Label>
                    <Select value={rule.match} onValueChange={(value) => onChange({ ...rule, match: value as RedactionMatchKind })} disabled={disabled}>
                        <SelectTrigger id={`rule-match-${rule.id}`} size="sm" aria-label={`${rowLabel} match kind`}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {MATCH_KINDS.map((kind) => (
                                <SelectItem key={kind} value={kind}>
                                    {kind}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="ms-auto"
                    onClick={onRemove}
                    disabled={disabled}
                    aria-label={`Remove ${rowLabel}`}
                >
                    <IconTrash aria-hidden />
                </Button>
            </div>
            <div className="flex flex-col gap-1">
                <Label className="text-muted-foreground text-xs" htmlFor={`rule-pattern-${rule.id}`}>
                    Pattern
                </Label>
                <Input
                    id={`rule-pattern-${rule.id}`}
                    value={rule.pattern}
                    onChange={(event) => onChange({ ...rule, pattern: event.target.value })}
                    placeholder={rule.match === 'regex' ? 'e.g. \\bMRN\\s*\\d+\\b' : rule.match === 'category' ? 'e.g. EMPLOYER' : "e.g. patient's employer"}
                    disabled={disabled}
                    className="font-mono text-sm"
                />
            </div>
            {rule.type === 'rewrite' ? (
                <div className="flex flex-col gap-1">
                    <Label className="text-muted-foreground text-xs" htmlFor={`rule-replacement-${rule.id}`}>
                        Replacement
                    </Label>
                    <Input
                        id={`rule-replacement-${rule.id}`}
                        value={rule.replacement ?? ''}
                        onChange={(event) => onChange({ ...rule, replacement: event.target.value })}
                        placeholder="Literal replacement (leave blank for a semantic AI rewrite)"
                        disabled={disabled}
                        className="text-sm"
                    />
                </div>
            ) : null}
            <div className="flex flex-col gap-1">
                <Label className="text-muted-foreground text-xs" htmlFor={`rule-note-${rule.id}`}>
                    Note
                </Label>
                <Input
                    id={`rule-note-${rule.id}`}
                    value={rule.note ?? ''}
                    onChange={(event) => onChange({ ...rule, note: event.target.value })}
                    placeholder="Why this rule (optional)"
                    disabled={disabled}
                    className="text-sm"
                />
            </div>
        </div>
    );
}

/**
 * Frame 53 — the doctor's DNA redaction/rewrite rules over
 * GET /my-style/redaction-rules + the report PATCH `redactionRules` field.
 *
 * Redaction is a SEPARATE, auditable post-generation transform (never folded
 * into the style prompt). The rules ride the doctor's DNA report row, so a
 * report must exist first. Effective redaction ALSO requires the DNA feature to
 * be on (the toggle above) and the tenant redaction gate — surfaced as status.
 */
export function DnaRedactionCard({
    myStyle,
    redaction,
    settings,
    gated,
}: {
    myStyle: ReturnType<typeof useMyStyle>;
    redaction: ReturnType<typeof useMyRedactionRules>;
    settings: ReturnType<typeof useDnaSettings>;
    gated: boolean;
}) {
    const update = useUpdateMyReport();

    // Local editing state, seeded from the server rules once loaded.
    const [enabled, setEnabled] = useState(false);
    const [rules, setRules] = useState<RedactionRule[]>([]);
    const [advanced, setAdvanced] = useState(false);
    const [rawJson, setRawJson] = useState('');
    // Re-seed local state when a fresh server snapshot arrives (report change or
    // post-save invalidation). Tracks the loaded reference to reset exactly once.
    const [seededFrom, setSeededFrom] = useState<RedactionRule[] | null>(null);
    const serverRules = redaction.data?.rules;
    if (serverRules && serverRules !== seededFrom) {
        setSeededFrom(serverRules);
        setRules(serverRules);
        setEnabled(serverRules.length > 0);
        setAdvanced(false);
    }

    const report = myStyle.data?.data ?? null;
    const etag = myStyle.data?.etag ?? (report ? `"${report.version}"` : null);
    const canSave = !gated && !!report && !!etag && !update.isPending;

    function enterAdvanced() {
        setRawJson(JSON.stringify({ rules: normalize(rules) }, null, 2));
        setAdvanced(true);
    }

    function applyAdvanced() {
        const check = validateJson(rawJson);
        if (!check.ok) {
            toast.error(`Invalid JSON: ${check.message}`);
            return;
        }
        const parsed = JSON.parse(rawJson) as { rules?: unknown };
        if (!parsed || !Array.isArray(parsed.rules)) {
            toast.error('Expected an object of shape { rules: [...] }.');
            return;
        }
        // Trust the structured editor's schema on re-entry; the gateway validates
        // the full shape on write regardless. Give each row a stable id.
        setRules(
            (parsed.rules as RedactionRule[]).map((rule) => ({
                id: typeof rule.id === 'string' && rule.id.trim() !== '' ? rule.id : newRuleId(),
                type: rule.type,
                match: rule.match,
                pattern: String(rule.pattern ?? ''),
                ...(rule.replacement !== undefined ? { replacement: String(rule.replacement) } : {}),
                ...(rule.note !== undefined ? { note: String(rule.note) } : {}),
            })),
        );
        setAdvanced(false);
    }

    function handleSave(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!report || !etag) return;
        const next = enabled ? normalize(rules) : [];
        update.mutate(
            { reportId: report.id, patch: { redactionRules: { rules: next } }, etag },
            {
                onSuccess: () => {
                    toast.success('Redaction rules saved');
                    setSeededFrom(null); // force a re-seed from the refetched snapshot
                },
                onError: (error) => {
                    if (!isOccError(error)) {
                        toast.error(error instanceof GatewayError ? error.message : 'Could not save the redaction rules.');
                    }
                },
            },
        );
    }

    let body;
    if (redaction.isPending || myStyle.isPending) {
        body = (
            <div className="flex flex-col gap-2">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-9 w-28 self-end" />
            </div>
        );
    } else if (redaction.isError) {
        body = <ErrorState title={'Couldn’t load the redaction rules'} error={redaction.error} onRetry={() => void redaction.refetch()} />;
    } else if (!report) {
        body = (
            <EmptyState
                icon={IconEraser}
                title="Generate a DNA style first"
                description="Redaction rules are stored on your DNA writing-style report. Generate a style above, then add rules here."
            />
        );
    } else {
        const effective = settings.data?.effective ?? false;
        body = (
            <form onSubmit={handleSave} className="flex flex-col gap-4">
                <OccConflictAlert
                    error={update.error}
                    onReload={() => {
                        update.reset();
                        setSeededFrom(null);
                        void redaction.refetch();
                        void myStyle.refetch();
                    }}
                />

                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <Switch
                            id="playground-dna-redaction-toggle"
                            checked={enabled}
                            onCheckedChange={setEnabled}
                            disabled={gated || update.isPending}
                            aria-label="Enable redaction rules"
                        />
                        <Label htmlFor="playground-dna-redaction-toggle">Enable redaction rules</Label>
                    </div>
                    <StatusBadge label={`Redaction ${effective ? 'READY' : 'DNA OFF'}`} colorRole={effective ? 'success' : 'neutral'} />
                </div>

                <p className="text-muted-foreground text-xs">
                    Redaction is a separate, audited transform applied after generation. It only runs when your DNA style is enabled above and your tenant
                    permits redaction.
                </p>

                {enabled ? (
                    advanced ? (
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="playground-dna-redaction-json">Raw JSON</Label>
                            <CodeEditor
                                aria-label="Redaction rules JSON"
                                value={rawJson}
                                onChange={setRawJson}
                                readOnly={gated}
                                language="json"
                                className="min-h-48"
                            />
                            <div className="flex justify-end gap-2">
                                <Button type="button" variant="outline" size="sm" onClick={() => setAdvanced(false)} disabled={gated}>
                                    Cancel
                                </Button>
                                <Button type="button" size="sm" onClick={applyAdvanced} disabled={gated}>
                                    Apply JSON
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {rules.length === 0 ? (
                                <EmptyState
                                    icon={IconEraser}
                                    title="No redaction rules"
                                    description="Add a rule to remove or rewrite matched spans from the generated note."
                                    action={
                                        <Button type="button" size="sm" onClick={() => setRules([blankRule()])} disabled={gated}>
                                            <IconPlus aria-hidden />
                                            Add rule
                                        </Button>
                                    }
                                />
                            ) : (
                                <>
                                    <ul className="flex flex-col gap-3">
                                        {rules.map((rule, index) => (
                                            <li key={rule.id}>
                                                <RuleRow
                                                    rule={rule}
                                                    index={index}
                                                    disabled={gated || update.isPending}
                                                    onChange={(next) => setRules((current) => current.map((r) => (r.id === rule.id ? next : r)))}
                                                    onRemove={() => setRules((current) => current.filter((r) => r.id !== rule.id))}
                                                />
                                            </li>
                                        ))}
                                    </ul>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="self-start"
                                        onClick={() => setRules((current) => [...current, blankRule()])}
                                        disabled={gated}
                                    >
                                        <IconPlus aria-hidden />
                                        Add rule
                                    </Button>
                                </>
                            )}
                        </div>
                    )
                ) : (
                    <p className="text-muted-foreground text-sm">Redaction is off — no rules are applied. Turn it on to add rules.</p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2">
                    {enabled && !advanced ? (
                        <Button type="button" variant="ghost" size="sm" onClick={enterAdvanced} disabled={gated}>
                            Advanced (raw JSON)
                        </Button>
                    ) : (
                        <span />
                    )}
                    <Button type="submit" size="sm" disabled={!canSave || advanced}>
                        {update.isPending ? <Spinner /> : null}
                        Save rules
                    </Button>
                </div>
            </form>
        );
    }

    return (
        <Card className="gap-4">
            <CardHeader>
                <h2 className="text-sm leading-none font-semibold">Redaction rules</h2>
                <CardAction>
                    <span aria-hidden className="text-muted-foreground font-mono text-xs">
                        GET /my-style/redaction-rules
                    </span>
                </CardAction>
            </CardHeader>
            <CardContent>{body}</CardContent>
        </Card>
    );
}
