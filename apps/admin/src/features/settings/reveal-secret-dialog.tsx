/**
 * TASK-396 — step-up re-auth modal for revealing ONE secret setting's plaintext.
 *
 * Reveal is super-admin-only AND requires the caller to re-enter their CURRENT
 * account password (verified server-side against the stored hash). This dialog
 * only collects the password and delegates the call to `onReveal`; on success it
 * hands the transient plaintext back to the parent (which shows it in the row
 * with copy / re-mask) and closes. The password lives only in local component
 * state and is wiped whenever the dialog closes — it is never persisted.
 */
import { Alert, AlertDescription } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Spinner } from '@arcaai/ui/spinner';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';

/** Discriminated reveal outcome — the route maps SDK success/errors into this. */
export type RevealSecretResult = { ok: true; value: string } | { ok: false; message: string };

export function RevealSecretDialog({
  open,
  onOpenChange,
  settingLabel,
  settingKey,
  onReveal,
  onRevealed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Human label of the setting being revealed (for the dialog copy). */
  settingLabel: string;
  /** The setting's raw key (shown as a monospace hint). */
  settingKey: string;
  /** Performs the gated reveal (step-up). Resolves to a discriminated result. */
  onReveal: (password: string) => Promise<RevealSecretResult>;
  /** Called with the transient plaintext on success (parent shows it, then this closes). */
  onRevealed: (value: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wipe the password + error every time the dialog opens/closes so nothing
  // lingers between reveals.
  useEffect(() => {
    setPassword('');
    setBusy(false);
    setError(null);
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onReveal(password);
      if (res.ok) {
        onRevealed(res.value);
        setPassword('');
        onOpenChange(false);
      } else {
        setError(res.message || 'Reveal failed — check your password and try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-md', MOBILE_DIALOG_CONTENT)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4" />
            Reveal secret
          </DialogTitle>
          <DialogDescription>
            Confirm your identity to reveal <span className="font-medium text-foreground">{settingLabel}</span>. Re-enter your current account
            password — this is logged for audit and the value is shown only transiently.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit}>
          <div className="space-y-4 py-2">
            <p className="truncate font-mono text-xs text-muted-foreground" title={settingKey}>
              {settingKey}
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reveal-step-up-password">Current password</Label>
              <Input
                id="reveal-step-up-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your account password"
              />
            </div>
            {error ? (
              <Alert variant="destructive" role="alert">
                <ShieldAlert className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <DialogFooter className={MOBILE_DIALOG_FOOTER}>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!password || busy}>
              {busy ? <Spinner className="size-4" /> : 'Reveal'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
