import { Alert, AlertDescription } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Spinner } from '@arcaai/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@arcaai/ui/toggle-group';
import { useUsers } from '@arcaai/vox';
import { Check, Copy, Info, KeyRound, Mail } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';
import type { ResetPasswordMode, ResetPasswordResult } from './sdk-types';

/** Human "expires in N minutes/hours" from the server's `expiresInSeconds`. */
function formatExpiry(seconds?: number): string | null {
  if (!seconds || seconds <= 0) return null;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/** Copy-to-clipboard field: read-only value + a copy button that confirms via toast. */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} copied`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed — select the value manually');
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <Input readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" size="icon" aria-label={`Copy ${label}`} onClick={() => void copy()}>
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

/**
 * Admin **Reset password** dialog (TASK-394 P0-1 · TASK-388 #8). Two REAL modes
 * driven by `useUsers().resetPassword`:
 *   - **Send reset link** (default) — mints a single-use token (emailed best-effort);
 *     the admin can copy the completion link that lands on the public
 *     `/reset-password` page (which calls `completePasswordReset`).
 *   - **Temporary password** — sets a temp password (auto-generated server-side when
 *     left blank) to convey out-of-band.
 * The result is shown once and never re-fetchable — the token/temp password are
 * copy-to-clipboard fields.
 */
export function ResetPasswordDialog({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { id: string; username: string } | null;
}) {
  const { resetPassword } = useUsers();
  const [mode, setMode] = useState<ResetPasswordMode>('link');
  const [tempPassword, setTempPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResetPasswordResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode('link');
    setTempPassword('');
    setBusy(false);
    setResult(null);
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    try {
      const res = await resetPassword(user.id, {
        mode,
        temporaryPassword: mode === 'temporary' && tempPassword.trim() ? tempPassword.trim() : undefined,
      });
      setResult(res);
      toast.success(res.mode === 'temporary' ? 'Temporary password set' : 'Reset link generated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setBusy(false);
    }
  };

  const resetLink = result?.token ? `${window.location.origin}/reset-password?token=${encodeURIComponent(result.token)}` : null;
  const expiry = formatExpiry(result?.expiresInSeconds);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-md', MOBILE_DIALOG_CONTENT)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            Reset password
          </DialogTitle>
          <DialogDescription>
            {user ? (
              <>
                Reset the password for <span className="font-medium text-foreground">{user.username}</span>.
              </>
            ) : (
              'Reset a user password.'
            )}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 py-2">
            {result.mode === 'temporary' ? (
              <>
                <Alert>
                  <Info />
                  <AlertDescription>Share this temporary password out-of-band. The user should change it on next sign-in.</AlertDescription>
                </Alert>
                <CopyField label="Temporary password" value={result.temporaryPassword ?? '—'} />
              </>
            ) : (
              <>
                <Alert>
                  {result.emailSent ? <Mail /> : <Info />}
                  <AlertDescription>
                    {result.emailSent
                      ? 'A reset email was sent to the user. You can also share the link below.'
                      : 'Email delivery is unavailable — share the reset link with the user directly.'}
                    {expiry ? <span className="block text-muted-foreground">Link expires in {expiry}.</span> : null}
                  </AlertDescription>
                </Alert>
                {resetLink ? <CopyField label="Reset link" value={resetLink} /> : null}
                {result.token ? <CopyField label="Token" value={result.token} /> : null}
              </>
            )}
            <DialogFooter className={MOBILE_DIALOG_FOOTER}>
              <DialogClose asChild>
                <Button type="button">Done</Button>
              </DialogClose>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="space-y-4 py-2">
              <div className="flex flex-col gap-1.5">
                <Label>Method</Label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={mode}
                  onValueChange={(v) => v && setMode(v as ResetPasswordMode)}
                  aria-label="Reset method"
                  className="justify-start"
                >
                  <ToggleGroupItem value="link">Send reset link</ToggleGroupItem>
                  <ToggleGroupItem value="temporary">Temporary password</ToggleGroupItem>
                </ToggleGroup>
              </div>

              {mode === 'temporary' ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rp-temp">Temporary password</Label>
                  <Input
                    id="rp-temp"
                    type="text"
                    autoComplete="off"
                    value={tempPassword}
                    onChange={(e) => setTempPassword(e.target.value)}
                    placeholder="Leave blank to auto-generate"
                  />
                  <span className="text-xs text-muted-foreground">Leave blank and a strong password is generated server-side.</span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  A single-use reset link is generated (and emailed when delivery is configured). You’ll be able to copy it on the next step.
                </p>
              )}
            </div>

            <DialogFooter className={MOBILE_DIALOG_FOOTER}>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy || !user}>
                {busy ? <Spinner className="size-4" /> : mode === 'temporary' ? 'Set temporary password' : 'Generate reset link'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
