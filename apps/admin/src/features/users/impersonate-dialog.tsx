import { Alert, AlertDescription } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Label } from '@arcaai/ui/label';
import { Spinner } from '@arcaai/ui/spinner';
import { Textarea } from '@arcaai/ui/textarea';
import { useUsers } from '@arcaai/vox';
import { useNavigate } from '@tanstack/react-router';
import { Info, VenetianMask } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { getTokenExpiryMs } from '@/lib/auth-refresh';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';

const REASON_MAX = 500;

/**
 * TASK-401 — super-admin "Impersonate" confirmation dialog (T5 act-as).
 *
 * Confirm + optional audited reason. On success the auth store swaps to the
 * time-boxed impersonated session (original retained for restore), navigation
 * lands on Consultation History (a doctor-visible surface — most admin routes
 * would immediately bounce the impersonated role), and the indigo banner takes
 * over the lifecycle (countdown / exit / expiry).
 */
export function ImpersonateDialog({
  open,
  onOpenChange,
  user,
  returnTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { id: string; username: string } | null;
  /** Route to restore to on exit — the target user's detail page. */
  returnTo: string;
}) {
  const { impersonate } = useUsers();
  const startImpersonation = useAuthStore((s) => s.startImpersonation);
  const navigate = useNavigate();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setBusy(false);
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    try {
      const res = await impersonate(user.id, { reason: reason.trim() || undefined });
      // The response's expiresAt is authoritative; decode the token exp as a
      // fallback so the countdown never renders empty.
      const expiresAt = res.expiresAt ?? new Date(Date.now() + getTokenExpiryMs(res.token)).toISOString();
      startImpersonation({
        token: res.token,
        user: {
          id: res.user.id,
          email: res.user.email ?? '',
          username: res.user.username,
          roles: res.user.roles ?? [],
          permissions: res.user.permissions ?? [],
          tenantId: res.user.tenantId,
        },
        expiresAt,
        returnTo,
      });
      onOpenChange(false);
      toast.success(`Now viewing as ${res.user.username}`);
      await navigate({ to: '/history' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start impersonation');
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-md', MOBILE_DIALOG_CONTENT)}>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <VenetianMask className="size-4" />
              Impersonate user
            </DialogTitle>
            <DialogDescription>
              {user ? (
                <>
                  Act as <span className="font-medium text-foreground">{user.username}</span> with their exact roles and tenant scope.
                </>
              ) : (
                'Act as another user.'
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <Alert>
              <Info />
              <AlertDescription>
                The session is time-boxed (30 minutes, non-refreshable) and fully audited — every action records you as the true actor. Your own
                session is restored when you exit.
              </AlertDescription>
            </Alert>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="imp-reason">Reason (optional)</Label>
              <Textarea
                id="imp-reason"
                value={reason}
                maxLength={REASON_MAX}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Investigating support ticket #4521"
                rows={2}
              />
              <span className="text-xs text-muted-foreground">Recorded on the audit trail. Never embedded in the session token.</span>
            </div>
          </div>

          <DialogFooter className={MOBILE_DIALOG_FOOTER}>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !user} data-testid="impersonate-confirm">
              {busy ? <Spinner className="size-4" /> : <VenetianMask className="size-4" />}
              Start impersonation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
