import { Button } from '@arcaai/ui/button';
import { Check, Download, FolderPlus, Power, PowerOff, ShieldPlus, Trash2, X } from 'lucide-react';
import { ConfirmDelete } from '@/features/common/confirm-delete';

/**
 * 20u **bulk-selected** action bar (frame `120:9015` selected state). Rendered by
 * the grid's `actionBar` slot only when rows are selected. TASK-394 P0-1 wired all
 * four server bulk actions (`useUsers().bulkAction`) — enable / disable / delete /
 * assign-departments — plus a client CSV export of the selected rows. TASK-398
 * P1-6 adds the fifth server arm, **Assign role** (single-select role picker).
 * The server export (xlsx/pdf/csv over the filtered set) lives on the page
 * toolbar since the bulk endpoint keys on ids, not an arbitrary selection.
 */
export function UsersBulkBar({
  count,
  canManage,
  isBusy,
  onEnable,
  onDisable,
  onDelete,
  onAssignDepartment,
  onAssignRole,
  onExportCsv,
  onClear,
}: {
  count: number;
  canManage: boolean;
  isBusy: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onDelete: () => Promise<void> | void;
  onAssignDepartment: () => void;
  onAssignRole: () => void;
  onExportCsv: () => void;
  onClear: () => void;
}) {
  return (
    <div data-testid="users-bulk-bar" className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Check className="size-4 text-primary" />
        {count} user{count === 1 ? '' : 's'} selected
      </span>

      <span className="mx-1 h-4 w-px bg-border" aria-hidden />

      {canManage ? (
        <>
          <Button variant="ghost" size="sm" className="h-8" disabled={isBusy} onClick={onEnable}>
            <Power className="size-4" />
            Enable
          </Button>
          <Button variant="ghost" size="sm" className="h-8" disabled={isBusy} onClick={onDisable}>
            <PowerOff className="size-4" />
            Disable
          </Button>
          <Button variant="ghost" size="sm" className="h-8" disabled={isBusy} onClick={onAssignDepartment}>
            <FolderPlus className="size-4" />
            Assign department
          </Button>
          <Button variant="ghost" size="sm" className="h-8" disabled={isBusy} onClick={onAssignRole}>
            <ShieldPlus className="size-4" />
            Assign role
          </Button>
          <ConfirmDelete
            title={`Delete ${count} user${count === 1 ? '' : 's'}?`}
            description="The selected users will be soft-deleted and lose access. This can be reversed by re-enabling them."
            confirmLabel={`Delete ${count}`}
            onConfirm={onDelete}
            trigger={
              <Button variant="ghost" size="sm" className="h-8 text-destructive hover:text-destructive" disabled={isBusy}>
                <Trash2 className="size-4" />
                Delete
              </Button>
            }
          />
        </>
      ) : null}

      <Button variant="ghost" size="sm" className="h-8" disabled={isBusy} onClick={onExportCsv}>
        <Download className="size-4" />
        Export CSV
      </Button>

      <Button variant="ghost" size="sm" className="ml-auto h-8 text-muted-foreground" onClick={onClear}>
        Clear selection
        <X className="size-4" />
      </Button>
    </div>
  );
}
