'use client';

import { IconAlertTriangle, IconSpy } from '@tabler/icons-react';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import type { SafeSession } from '@/shared/auth';

/**
 * Frame 53 gate panel — a DESIGNED state, not an error. DNA styles are
 * per-doctor PHI-derived artifacts, so `generate` and the settings toggle
 * reject a non-impersonating, non-clinical admin with 403
 * (`assertActingAsDoctor`). Read surfaces stay live.
 * When doctor context IS active the same slot confirms it instead.
 */
export function ImpersonationGatePanel({ session, gated }: { session: SafeSession | undefined; gated: boolean }) {
  if (!gated) {
    const actingAs = session?.impersonatingUsername ?? session?.impersonatingUserId;
    return (
      <Card className="gap-4">
        <CardHeader>
          <h2 className="text-sm leading-none font-medium">Doctor context</h2>
          <CardAction>
            <StatusBadge label="ACTIVE" colorRole="success" />
          </CardAction>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {actingAs
              ? `Acting as ${actingAs} — generate and the DNA toggle run under this doctor's account.`
              : 'You hold a clinical role — generate and the DNA toggle run under your own account.'}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-medium">Impersonation gate</h2>
        <CardAction>
          <StatusBadge label="GATE 403" colorRole="warning" />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm">
          You are signed in as an admin — not acting as a doctor. DNA writing styles are per-doctor, PHI-derived artifacts, so generating one under an
          admin account is rejected by the gateway ({'\u201c'}assertActingAsDoctor{'\u201d'}).
        </p>
        <div className="flex flex-col gap-1.5">
          <Button asChild variant="outline" size="sm" className="self-start">
            <Link href="/users">
              <IconSpy aria-hidden />
              Act as a doctor
            </Link>
          </Button>
          <p className="text-muted-foreground text-xs">
            Impersonation starts from the Users screen (view a user, then {'\u201c'}Impersonate{'\u201d'}).
          </p>
        </div>
        <p className="text-muted-foreground font-mono text-xs">
          Read surfaces stay live: my-style {'\u00b7'} mine {'\u00b7'} versions
        </p>
        <Alert>
          <IconAlertTriangle aria-hidden />
          <AlertTitle>Generate &amp; DNA toggle return 403 unless acting as a doctor</AlertTitle>
          <AlertDescription>This gate is a designed state (assertActingAsDoctor, TASK-331 doc-07 F1) — not a failure.</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
