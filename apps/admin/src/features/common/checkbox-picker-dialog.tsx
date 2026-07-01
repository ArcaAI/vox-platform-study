import { Avatar, AvatarFallback } from '@arcaai/ui/avatar';
import { Button } from '@arcaai/ui/button';
import { Checkbox } from '@arcaai/ui/checkbox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Spinner } from '@arcaai/ui/spinner';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER_DEEP } from '@/lib/responsive';
import { cn, initialsOf } from '@/lib/utils';

export interface PickerOption {
    id: string;
    primary: string;
    secondary?: string;
    /** Right-aligned meta (e.g. member count). */
    meta?: string;
    disabled?: boolean;
}

/**
 * Reusable multi-select checkbox dialog (TASK-379 §5.13). Backs both the
 * department-side **Add members** picker and the user-side **Assign departments**
 * picker — search + checkbox rows + an "N selected" footer. Purely presentational:
 * the caller supplies options + initial selection and owns the SDK mutation.
 */
export function CheckboxPickerDialog({
    open,
    onOpenChange,
    title,
    subtitle,
    searchPlaceholder = 'Search…',
    options,
    initialSelected = [],
    confirmLabel,
    emptyLabel = 'No matches.',
    isSaving,
    onConfirm,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    subtitle?: string;
    searchPlaceholder?: string;
    options: PickerOption[];
    initialSelected?: string[];
    confirmLabel: (count: number) => string;
    emptyLabel?: string;
    isSaving: boolean;
    onConfirm: (selectedIds: string[]) => void;
}) {
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (!open) return;
        setQuery('');
        setSelected(new Set(initialSelected));
        // initialSelected identity changes per render; only resync on open.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return options;
        return options.filter((o) => o.primary.toLowerCase().includes(q) || (o.secondary ?? '').toLowerCase().includes(q));
    }, [options, query]);

    const toggle = (id: string) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className={cn('sm:max-w-md', MOBILE_DIALOG_CONTENT)}>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    {subtitle ? <DialogDescription>{subtitle}</DialogDescription> : null}
                </DialogHeader>
                <div className="space-y-3">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder} className="pl-8" aria-label={searchPlaceholder} />
                    </div>
                    <ScrollArea className="h-64 rounded-md border">
                        <ul className="divide-y">
                            {filtered.length === 0 ? (
                                <li className="px-3 py-8 text-center text-sm text-muted-foreground">{emptyLabel}</li>
                            ) : (
                                filtered.map((o) => {
                                    const checked = selected.has(o.id);
                                    return (
                                        <li key={o.id}>
                                            <label
                                                className={cn(
                                                    'flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/40',
                                                    o.disabled && 'cursor-not-allowed opacity-50',
                                                )}
                                            >
                                                <Checkbox checked={checked} onCheckedChange={() => toggle(o.id)} disabled={o.disabled} />
                                                <Avatar className="size-7">
                                                    <AvatarFallback className="bg-primary/10 text-[10px] font-medium text-primary">{initialsOf(o.primary)}</AvatarFallback>
                                                </Avatar>
                                                <span className="flex min-w-0 flex-1 flex-col">
                                                    <span className="truncate font-medium text-foreground">{o.primary}</span>
                                                    {o.secondary ? <span className="truncate text-xs text-muted-foreground">{o.secondary}</span> : null}
                                                </span>
                                                {o.meta ? <span className="shrink-0 text-xs text-muted-foreground">{o.meta}</span> : null}
                                            </label>
                                        </li>
                                    );
                                })
                            )}
                        </ul>
                    </ScrollArea>
                </div>
                <DialogFooter className={cn('sm:items-center sm:justify-between', MOBILE_DIALOG_FOOTER_DEEP)}>
                    <span className="text-sm text-muted-foreground">{selected.size} selected</span>
                    <div className="flex gap-2">
                        <DialogClose asChild>
                            <Button type="button" variant="outline">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="button" disabled={selected.size === 0 || isSaving} onClick={() => onConfirm([...selected])}>
                            {isSaving ? <Spinner className="size-4" /> : confirmLabel(selected.size)}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
