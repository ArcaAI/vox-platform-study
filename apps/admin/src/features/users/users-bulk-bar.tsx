import { Button } from '@arcaai/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@arcaai/ui/dropdown-menu';
import { Check, ChevronDown, Download, FolderPlus, KeyRound, PowerOff, X } from 'lucide-react';

/**
 * 20u **bulk-selected** action bar (frame `120:9015` selected state). Rendered by
 * the grid's `actionBar` slot only when rows are selected. Disable / Assign
 * department / CSV export are REAL (a client `Promise.allSettled` loop — there is
 * no bulk server endpoint, TARGET); Reset password and Excel/PDF export are drawn
 * disabled + `Target`-flagged.
 */
export function UsersBulkBar({
    count,
    canManage,
    isBusy,
    onAssignDepartment,
    onDisable,
    onExportCsv,
    onClear,
}: {
    count: number;
    canManage: boolean;
    isBusy: boolean;
    onAssignDepartment: () => void;
    onDisable: () => void;
    onExportCsv: () => void;
    onClear: () => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Check className="size-4 text-primary" />
                {count} user{count === 1 ? '' : 's'} selected
            </span>

            <span className="mx-1 h-4 w-px bg-border" aria-hidden />

            {canManage ? (
                <Button variant="ghost" size="sm" className="h-8" disabled={isBusy} onClick={onAssignDepartment}>
                    <FolderPlus className="size-4" />
                    Assign department
                </Button>
            ) : null}

            {/* TARGET: no reset-password endpoint (email link / temp password). */}
            <Button variant="ghost" size="sm" className="h-8" disabled title="Target · password reset ships later">
                <KeyRound className="size-4" />
                Reset password
                <span className="ml-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">Target</span>
            </Button>

            {canManage ? (
                <Button variant="ghost" size="sm" className="h-8 text-destructive hover:text-destructive" disabled={isBusy} onClick={onDisable}>
                    <PowerOff className="size-4" />
                    Disable
                </Button>
            ) : null}

            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8" disabled={isBusy}>
                        <Download className="size-4" />
                        Export selected
                        <ChevronDown className="size-3.5" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={onExportCsv}>Export as CSV</DropdownMenuItem>
                    {/* TARGET: CSV is the near-term format. */}
                    <DropdownMenuItem disabled>Export as Excel · Target</DropdownMenuItem>
                    <DropdownMenuItem disabled>Export as PDF · Target</DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>

            <Button variant="ghost" size="sm" className="ml-auto h-8 text-muted-foreground" onClick={onClear}>
                Clear selection
                <X className="size-4" />
            </Button>
        </div>
    );
}
