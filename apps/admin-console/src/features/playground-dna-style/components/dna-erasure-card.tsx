'use client';

import { useState } from 'react';
import { IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { useDnaSettings, useEraseMyStyle, useMyReports } from '../api';
import type { DnaErasureResult } from '../api';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Idempotent route: zero counts mean there was nothing stored, still a success. */
export function erasureSummary(result: DnaErasureResult): string {
  if (result.deletedReports === 0 && result.deletedVersions === 0) {
    return 'Nothing to erase — no stored DNA profile';
  }
  return `Erased ${plural(result.deletedReports, 'report')} and ${plural(result.deletedVersions, 'version')}`;
}

/**
 * Frame 53 — the clinician-facing erasure of the whole learned DNA profile
 * (DELETE /my-style).
 *
 * Why this exists next to the on/off toggle: opting out only stops FUTURE
 * learning. The already-learned profile stays stored and keeps being injected
 * into this doctor's summary prompts, so erasure is the other half of the
 * opt-out. The two are INDEPENDENT — erasing never flips the toggle, so with
 * learning still on a fresh profile is rebuilt from the doctor's approved
 * notes. Both facts are stated in the card copy and repeated in the
 * confirmation, because this is irreversible.
 *
 * Gated exactly like generate / the toggle: the route runs
 * `assertActingAsDoctor`, so an admin who is neither clinical nor
 * impersonating gets the DESIGNED 403 gate panel, never an error toast.
 */
export function DnaErasureCard({
  reports,
  settings,
  gated,
  onGate,
}: {
  reports: ReturnType<typeof useMyReports>;
  settings: ReturnType<typeof useDnaSettings>;
  gated: boolean;
  onGate: () => void;
}) {
  const erase = useEraseMyStyle();
  const [confirming, setConfirming] = useState(false);

  const reportCount = reports.data?.length ?? null;
  const learningOn = settings.data?.effective ?? false;

  function handleErase() {
    erase.mutate(undefined, {
      onSuccess: (result) => {
        setConfirming(false);
        toast.success(erasureSummary(result));
      },
      onError: (error) => {
        setConfirming(false);
        // Designed gate state — the panel takes over, no toast.
        if (error instanceof GatewayError && error.status === 403) {
          onGate();
          return;
        }
        toast.error(error instanceof GatewayError ? error.message : 'Could not erase the DNA profile.');
      },
    });
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-medium">Erase my DNA profile</h2>
        <CardAction>
          <span aria-hidden className="text-muted-foreground font-mono text-xs">
            DELETE /my-style
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">
          Turning the DNA toggle off only stops <span className="text-foreground font-medium">future</span> learning. Everything already learned stays
          stored and keeps being injected into your summary prompts. Erasing removes every report and every version learned for your account.
        </p>
        <p className="text-muted-foreground text-sm">
          Erasing does <span className="text-foreground font-medium">not</span> change the on/off toggle above — the two are independent. If learning
          is still enabled, a fresh profile will be built from your approved notes.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {reports.isPending ? (
            <Skeleton className="h-5 w-28 rounded-full" />
          ) : reportCount !== null ? (
            <StatusBadge label={`${plural(reportCount, 'report')} stored`} colorRole={reportCount > 0 ? 'warning' : 'neutral'} />
          ) : null}
          {settings.isPending ? (
            <Skeleton className="h-5 w-32 rounded-full" />
          ) : (
            <StatusBadge label={`Learning ${learningOn ? 'ON' : 'OFF'}`} colorRole={learningOn ? 'success' : 'neutral'} />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          {gated ? <span className="text-muted-foreground text-xs">Requires acting as a doctor</span> : <span />}
          <Button variant="destructive" onClick={() => setConfirming(true)} disabled={gated || erase.isPending}>
            {erase.isPending ? <Spinner /> : <IconTrash aria-hidden />}
            Erase my profile
          </Button>
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!erase.isPending) setConfirming(open);
        }}
        title="Erase my DNA writing-style profile"
        description={
          <>
            This permanently erases <span className="text-foreground font-medium">every report and version</span> learned for your account
            {reportCount !== null ? <> ({plural(reportCount, 'report')} stored)</> : null}. It cannot be undone.{' '}
            {learningOn
              ? 'Your DNA toggle stays ON, so a fresh profile will be built from your approved notes — turn the toggle off first if you also want to stop future learning.'
              : 'Your DNA toggle stays as it is — erasing and opting out are independent.'}
          </>
        }
        confirmLabel="Erase my profile"
        destructive
        isPending={erase.isPending}
        onConfirm={handleErase}
      />
    </Card>
  );
}
