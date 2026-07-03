import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@arcaai/ui/alert-dialog';
import { Button } from '@arcaai/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@arcaai/ui/dropdown-menu';
import { Spinner } from '@arcaai/ui/spinner';
import { useTenants, type Tenant } from '@arcaai/vox';
import { Archive, MoreHorizontal, PauseCircle, RotateCcw } from 'lucide-react';
import { useState, type ReactElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { MOBILE_ALERT_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';

/**
 * Tenant lifecycle actions (TASK-387 #1 / F6): `suspend` → SUSPENDED,
 * `archive` → ARCHIVED, `restore` → ENABLED. Rendered as a dropdown (kebab on
 * list rows, "More" on the detail header) that opens a confirm dialog per action.
 *
 * These are POST (non-OCC) super-admin operator transitions. Availability is
 * status-driven; the DEF-ADM-002 system tenant is filtered out by the caller
 * (`canManageTenantLifecycle`) so this never renders for a protected tenant.
 */
export type LifecycleAction = 'suspend' | 'archive' | 'restore';

interface ActionCopy {
  menu: string;
  icon: ReactElement;
  title: (name: string) => string;
  description: string;
  confirm: string;
  success: string;
  destructive: boolean;
}

const COPY: Record<LifecycleAction, ActionCopy> = {
  suspend: {
    menu: 'Suspend',
    icon: <PauseCircle className="size-4" />,
    title: (name) => `Suspend ${name}?`,
    description:
      'Suspends the tenant and blocks its users from signing in — active sessions end immediately. This is a reversible operator hold: you can restore it any time.',
    confirm: 'Suspend tenant',
    success: 'Tenant suspended',
    destructive: true,
  },
  archive: {
    menu: 'Archive',
    icon: <Archive className="size-4" />,
    title: (name) => `Archive ${name}?`,
    description:
      'Moves the tenant to cold storage — users can’t sign in and it drops out of active views. This is recoverable: you can restore it any time.',
    confirm: 'Archive tenant',
    success: 'Tenant archived',
    destructive: true,
  },
  restore: {
    menu: 'Restore',
    icon: <RotateCcw className="size-4" />,
    title: (name) => `Restore ${name}?`,
    description: 'Restores the tenant to the enabled state so its users can sign in again.',
    confirm: 'Restore tenant',
    success: 'Tenant restored',
    destructive: false,
  },
};

/** Status-driven set of available transitions (a tenant always has at least one). */
export function availableLifecycleActions(status?: string): LifecycleAction[] {
  const s = String(status ?? '').toUpperCase();
  const actions: LifecycleAction[] = [];
  if (s !== 'SUSPENDED' && s !== 'ARCHIVED') actions.push('suspend');
  if (s !== 'ARCHIVED') actions.push('archive');
  if (s === 'SUSPENDED' || s === 'ARCHIVED') actions.push('restore');
  return actions;
}

export function TenantLifecycleMenu({
  tenant,
  onChanged,
  align = 'end',
  trigger,
}: {
  tenant: Tenant;
  /** Called with the server's updated tenant so the caller can refresh its state. */
  onChanged: (updated: Tenant) => void;
  align?: 'start' | 'center' | 'end';
  /** Custom trigger; defaults to a kebab icon button. */
  trigger?: ReactNode;
}) {
  const { suspend, archive, restore } = useTenants();
  const [pending, setPending] = useState<LifecycleAction | null>(null);
  const [busy, setBusy] = useState(false);

  const actions = availableLifecycleActions(tenant.resourceStatus);
  const runners: Record<LifecycleAction, (id: string) => Promise<Tenant>> = { suspend, archive, restore };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const updated = await runners[pending](tenant.id);
      toast.success(COPY[pending].success);
      onChanged(updated);
      setPending(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${pending} tenant`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? (
            <Button variant="ghost" size="icon" className="size-8" aria-label={`Lifecycle actions for ${tenant.name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>
          {actions.map((action) => (
            <DropdownMenuItem key={action} onClick={() => setPending(action)}>
              {COPY[action].icon}
              {COPY[action].menu}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !busy && !open && setPending(null)}>
        <AlertDialogContent className={MOBILE_ALERT_DIALOG_CONTENT}>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending ? COPY[pending].title(tenant.name) : ''}</AlertDialogTitle>
            <AlertDialogDescription>{pending ? COPY[pending].description : ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className={MOBILE_DIALOG_FOOTER}>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button variant={pending && COPY[pending].destructive ? 'destructive' : 'default'} onClick={() => void confirm()} disabled={busy}>
              {busy ? <Spinner className="size-4" /> : pending ? COPY[pending].confirm : ''}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
