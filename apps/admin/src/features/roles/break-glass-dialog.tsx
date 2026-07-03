/**
 * TASK-409 — break-glass second-confirmation dialog for dangerous RBAC
 * mutations (policy delete, role delete, detach-from-role, multi-role rule
 * edits).
 *
 * Mirrors the TASK-396 `RevealSecretDialog` step-up UX: the caller re-enters
 * their CURRENT account password (verified server-side via the stored hash)
 * and additionally types the EXACT name of the policy/role being mutated —
 * the same "type the name to confirm" contract GitHub uses for repo deletion.
 * The confirm button is destructive-styled and stays disabled until the typed
 * name matches exactly and a password is present. Credentials live only in
 * local component state and are wiped whenever the dialog opens/closes.
 *
 * Server contract (pinned by the TASK-409 E2E matrix):
 *   428 → confirmation required but missing; 401 → wrong password;
 *   400 → confirmation name mismatch; 403 → protected system policy
 *   (absolutely blocked — this dialog is never offered for those).
 */
import { Alert, AlertDescription } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Spinner } from '@arcaai/ui/spinner';
import type { BreakGlassCredentials } from '@arcaai/vox';
import { ShieldAlert, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';

/** Discriminated confirm outcome — the route maps SDK success/errors into this. */
export type BreakGlassResult = { ok: true } | { ok: false; message: string };

/**
 * HTTP status carried by an SDK `AgenticError` (`context.status`), if any.
 * Used by routes to detect the 428 "break-glass required" reply and reactively
 * open this dialog (e.g. rule edits of multi-role policies).
 */
export function breakGlassStatus(err: unknown): number | undefined {
  const status = (err as { context?: { status?: unknown } } | null | undefined)?.context?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Whether an SDK error is the API's 428 "break-glass confirmation required". */
export function isBreakGlassRequired(err: unknown): boolean {
  return breakGlassStatus(err) === 428;
}

export function BreakGlassDialog({
  open,
  onOpenChange,
  title,
  description,
  expectedName,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog title, e.g. `Delete policy`. */
  title: string;
  /** Explains the blast radius of the mutation. */
  description: ReactNode;
  /** The exact name the caller must type to arm the confirm button. */
  expectedName: string;
  /** Destructive confirm button label, e.g. `Delete policy`. */
  confirmLabel: string;
  /** Performs the gated mutation. Resolves to a discriminated result. */
  onConfirm: (credentials: BreakGlassCredentials) => Promise<BreakGlassResult>;
}) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wipe credentials + error whenever the dialog opens/closes so nothing
  // lingers between confirmations (mirrors RevealSecretDialog).
  useEffect(() => {
    setName('');
    setPassword('');
    setBusy(false);
    setError(null);
  }, [open]);

  const nameMatches = name === expectedName;
  const armed = nameMatches && password.length > 0 && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onConfirm({ password, confirmationName: name });
      if (res.ok) {
        setPassword('');
        onOpenChange(false);
      } else {
        setError(res.message || 'Confirmation failed — check your password and try again.');
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
            <TriangleAlert className="size-4 text-destructive" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit}>
          <div className="space-y-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="break-glass-name">
                Type <span className="select-all font-mono text-foreground">{expectedName}</span> to confirm
              </Label>
              <Input
                id="break-glass-name"
                autoComplete="off"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={expectedName}
                aria-invalid={name.length > 0 && !nameMatches}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="break-glass-password">Current password</Label>
              <Input
                id="break-glass-password"
                type="password"
                autoComplete="current-password"
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
            <p className="text-xs text-muted-foreground">This confirmation is recorded in the audit log (your password is never stored).</p>
          </div>

          <DialogFooter className={MOBILE_DIALOG_FOOTER}>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={!armed}>
              {busy ? <Spinner className="size-4" /> : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
