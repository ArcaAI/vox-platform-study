import { Button } from '@arcaai/ui/button';
import { Spinner } from '@arcaai/ui/spinner';
import { useUsers } from '@arcaai/vox';
import { useRouter } from '@tanstack/react-router';
import { VenetianMask } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAuthStore } from '@/store/auth-store';

/** Clamp-to-zero remaining seconds until the ISO expiry. */
function secondsLeft(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 1000));
}

/** `m:ss` (or `h:mm:ss` above an hour) countdown label. */
function formatCountdown(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * TASK-401 — persistent indigo "act-as" banner (design `--ai` token, the T5
 * treatment from the TASK-371 review): rendered above the shell on every
 * authenticated route while an impersonation is active.
 *
 * "Viewing as {name} — ends in {countdown} · Exit". Exit revokes the
 * impersonation token server-side (audited END), restores the original
 * super-admin session from the store snapshot and lands back on the user's
 * detail page. When the countdown reaches zero the token is already dead
 * server-side (JWT exp), so expiry restores locally without the revoke call.
 */
export function ImpersonationBanner() {
  const impersonation = useAuthStore((s) => s.impersonation);
  const endImpersonationLocal = useAuthStore((s) => s.endImpersonation);
  const { endImpersonation: revokeOnServer } = useUsers();
  const router = useRouter();

  const [remaining, setRemaining] = useState(() => (impersonation.active ? secondsLeft(impersonation.expiresAt) : 0));
  const [exiting, setExiting] = useState(false);
  // Latch so the expiry path runs once even though the interval keeps ticking.
  const closingRef = useRef(false);

  const restore = (message: string) => {
    if (closingRef.current) return;
    closingRef.current = true;
    const returnTo = endImpersonationLocal();
    toast.info(message);
    // `returnTo` is a runtime-resolved path (the user detail page captured at
    // start), so it can't satisfy the router's static route-id union.
    void router.navigate({ to: (returnTo ?? '/tenants') as never });
  };

  useEffect(() => {
    if (!impersonation.active) {
      closingRef.current = false;
      setExiting(false);
      return;
    }
    setRemaining(secondsLeft(impersonation.expiresAt));
    const timer = setInterval(() => setRemaining(secondsLeft(impersonation.expiresAt)), 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impersonation.active, impersonation.expiresAt]);

  useEffect(() => {
    if (!impersonation.active || remaining > 0) return;
    // `remaining` can be a stale 0 on the very render where the impersonation
    // activates (the countdown effect's setState only lands next render), so
    // re-check the wall clock before treating this as a real expiry.
    if (secondsLeft(impersonation.expiresAt) > 0) return;
    // Token expired — no server revoke (it would 401 with the dead token).
    restore('Impersonation expired — your session was restored.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impersonation.active, remaining]);

  if (!impersonation.active) return null;

  const onExit = async () => {
    if (exiting || closingRef.current) return;
    setExiting(true);
    try {
      // Revoke while the client still sends the impersonation token — this
      // lands the audited END row and kills the jti server-side.
      await revokeOnServer();
    } catch {
      // Best-effort: the token dies at exp anyway; still restore locally.
    }
    restore('Impersonation ended — you are back as yourself.');
  };

  return (
    <div
      data-testid="impersonation-banner"
      role="status"
      className="flex min-h-10 w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-ai px-3 py-1.5 text-sm font-medium text-ai-foreground"
    >
      <VenetianMask className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        Viewing as <span className="font-semibold">{impersonation.targetName}</span>
        <span aria-hidden> — </span>
        ends in{' '}
        <span className="font-mono tabular-nums" data-testid="impersonation-countdown">
          {formatCountdown(remaining)}
        </span>
      </span>
      <Button
        size="sm"
        variant="secondary"
        className="h-7 bg-ai-foreground/15 px-2.5 text-ai-foreground hover:bg-ai-foreground/25"
        onClick={() => void onExit()}
        disabled={exiting}
        data-testid="impersonation-exit"
      >
        {exiting ? <Spinner className="size-3.5" /> : null}
        Exit
      </Button>
    </div>
  );
}
